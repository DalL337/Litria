//! Bounded disk reads and line slicing (Project API contract brief §5).
//!
//! The bound is on the bytes actually consumed, not on a size checked
//! beforehand: a file can grow, or be replaced, between a metadata check and
//! a read. Every check that matters runs on the open handle.

use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use super::paths::is_valid_api_path;
use super::policy::{classify, Class};
use crate::path_guard::{resolve_existing_relative_path_typed, ResolveError};

/// Files larger than this are never read (brief §10).
pub(crate) const HARD_CAP_BYTES: u64 = 8 * 1024 * 1024;
/// A NUL byte in this prefix marks a file as binary.
const TEXT_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, PartialEq)]
pub(crate) enum DiskRead {
    Text { text: String, revision: String },
    NotFound,
    Denied,
    NotFile,
    NotText,
    TooLarge,
    InvalidPath,
    Unreadable,
}

/// Read a project file for the API: syntax, policy, typed resolution, policy
/// again on the canonical target, then a capped read.
pub(crate) fn read_disk(root: &Path, path: &str) -> DiskRead {
    read_disk_with(root, path, HARD_CAP_BYTES, || {}, || {}, || {})
}

/// `read_disk` with a smaller cap: search scans at most this many bytes per
/// file (brief §10), with every check a read makes.
pub(crate) fn read_disk_capped(root: &Path, path: &str, cap: u64) -> DiskRead {
    read_disk_with(root, path, cap.min(HARD_CAP_BYTES), || {}, || {}, || {})
}

/// `read_disk` with the cap and two hooks for the race windows tests probe:
/// `before_open` runs between path resolution and the open (a file or parent
/// can be swapped for a link there); `after_checks` runs between the handle's
/// checks and the read (a file can grow there).
fn read_disk_with(
    root: &Path,
    path: &str,
    cap: u64,
    before_open: impl FnOnce(),
    after_open: impl FnOnce(),
    after_checks: impl FnOnce(),
) -> DiskRead {
    if !is_valid_api_path(path) {
        return DiskRead::InvalidPath;
    }
    // Before touching the filesystem: a denied path is denied whether or not
    // it exists, so its existence is never revealed.
    if classify(path) == Class::Denied {
        return DiskRead::Denied;
    }
    let target = match resolve_existing_relative_path_typed(root, path) {
        Ok(target) => target,
        Err(ResolveError::Invalid(_)) => return DiskRead::InvalidPath,
        // A link that leaves the project is withheld like any denied path.
        Err(ResolveError::OutsideRoot) => return DiskRead::Denied,
        Err(ResolveError::Io(error)) => return io_outcome(error.kind()),
    };
    match canonical_relative(root, &target) {
        Some(canonical) if classify(&canonical) != Class::Denied => {}
        _ => return DiskRead::Denied,
    }
    // Stat the path first, so a directory or FIFO is answered without opening
    // it (opening a FIFO blocks until a writer appears)…
    match fs::metadata(&target) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return DiskRead::NotFile,
        Err(error) => return io_outcome(error.kind()),
    }
    // …then open once, and check the handle, which cannot change underneath us.
    before_open();
    let file = match open_for_read(&target) {
        Ok(file) => file,
        Err(error) => return io_outcome(error.kind()),
    };
    // Authorize what was OPENED, not what was resolved earlier: a file or a
    // parent directory can be swapped for a link between the two (the
    // classic check/use race). The handle's own path cannot change underneath
    // us, so containment and the policy run again on it.
    after_open();
    let Some(opened) = opened_path(&file) else {
        return DiskRead::Unreadable; // fail closed when the OS cannot say
    };
    // …and only while the object still has a name. Asked AFTER the path
    // query, so a file unlinked before that query shows up here: its path is
    // never trusted alone. (Linux reports such a path as "<old> (deleted)",
    // which no deny rule matches, while the handle still reads the contents —
    // Codex re-review of b85b6f0, reproduced on Linux 6.6.)
    if opened_object_is_unlinked(&file, &opened) {
        return DiskRead::Unreadable;
    }
    match canonical_relative(root, &opened) {
        Some(relative) if classify(&relative) != Class::Denied => {}
        _ => return DiskRead::Denied,
    }
    let metadata = match file.metadata() {
        Ok(metadata) => metadata,
        Err(error) => return io_outcome(error.kind()),
    };
    if !metadata.is_file() {
        return DiskRead::NotFile;
    }
    if metadata.len() > cap {
        return DiskRead::TooLarge;
    }
    after_checks();
    // Capacity from the checked size, reading at most cap + 1 bytes: the extra
    // byte means the file grew past the cap after the check.
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    if let Err(error) = file.take(cap + 1).read_to_end(&mut bytes) {
        return io_outcome(error.kind());
    }
    if bytes.len() as u64 > cap {
        return DiskRead::TooLarge;
    }
    let sniff = &bytes[..bytes.len().min(TEXT_SNIFF_BYTES)];
    if sniff.contains(&0) {
        return DiskRead::NotText;
    }
    let revision = disk_revision(&bytes);
    match String::from_utf8(bytes) {
        Ok(text) => DiskRead::Text { text, revision },
        Err(_) => DiskRead::NotText,
    }
}

/// The name the editor session would hold a document under, for an effective
/// read (build plan P2).
#[derive(Debug, PartialEq)]
pub(crate) enum Identity {
    InvalidPath,
    /// Withheld by the policy, on the requested name or on what it resolves
    /// to. Never sent to the bridge.
    Denied,
    /// The key to look the document up by: the canonical project-relative
    /// path when the file exists — so a case variant on a case-insensitive
    /// volume, or an in-project link, finds the buffer of the file it names —
    /// otherwise the requested path itself (a buffer whose file is gone).
    Key(String),
}

/// Syntax and policy exactly as `read_disk` applies them, then the canonical
/// name. Only a lookup key: the disk read, if one follows, repeats every check
/// on what it actually opens.
pub(crate) fn identity(root: &Path, path: &str) -> Identity {
    if !is_valid_api_path(path) {
        return Identity::InvalidPath;
    }
    if classify(path) == Class::Denied {
        return Identity::Denied;
    }
    match resolve_existing_relative_path_typed(root, path) {
        Ok(target) => match canonical_relative(root, &target) {
            Some(canonical) if classify(&canonical) != Class::Denied => Identity::Key(canonical),
            _ => Identity::Denied,
        },
        Err(ResolveError::Invalid(_)) => Identity::InvalidPath,
        Err(ResolveError::OutsideRoot) => Identity::Denied,
        // Not on disk (or not resolvable now): the session may still hold it
        // under exactly this name — unless the name passes through a link.
        // A link that cannot be resolved cannot be judged by what it names,
        // and its buffer may hold the text of a withheld file it used to
        // name (P3 adversarial finding F4): fail closed.
        Err(ResolveError::Io(_)) if passes_through_link(root, path) => Identity::Denied,
        Err(ResolveError::Io(_)) => Identity::Key(path.to_owned()),
    }
}

/// Whether any existing component of `path` (a valid API path) is a link or
/// a junction. Stops at the first component that does not exist: nothing
/// below it exists either.
fn passes_through_link(root: &Path, path: &str) -> bool {
    let mut current = root.to_path_buf();
    for segment in path.split('/') {
        current.push(segment);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => return true,
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => return false,
            // Cannot tell: fail closed.
            Err(_) => return true,
        }
    }
    false
}

/// Whether `path` names an existing file that resolves to exactly itself: no
/// link in any component, no other spelling. Search uses it before reporting a
/// match found on disk, so a name listed through a directory swapped for a
/// link is never reported (P3 adversarial finding F2).
pub(crate) fn resolves_to_itself(root: &Path, path: &str) -> bool {
    resolve_existing_relative_path_typed(root, path)
        .ok()
        .and_then(|target| canonical_relative(root, &target))
        .is_some_and(|canonical| canonical == path)
}

/// On Unix, open non-blocking, so a FIFO swapped in after the stat cannot
/// hang the reader; regular-file reads are unaffected by the flag.
#[cfg(unix)]
fn open_for_read(path: &Path) -> std::io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NONBLOCK)
        .open(path)
}

#[cfg(not(unix))]
fn open_for_read(path: &Path) -> std::io::Result<File> {
    File::open(path)
}

/// The path of the object an open handle refers to, as the OS resolves it
/// now — links already followed. Implementation-policy Rule 2: one `#[cfg]`
/// per platform; anything else fails closed (`None`).
#[cfg(windows)]
fn opened_path(file: &File) -> Option<PathBuf> {
    use std::ffi::OsString;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{GetFinalPathNameByHandleW, FILE_NAME_NORMALIZED};

    let handle = HANDLE(file.as_raw_handle());
    let mut buffer = vec![0u16; 512];
    // At most two calls: the first reports the size needed if it is too small.
    for _ in 0..2 {
        // SAFETY: `handle` belongs to `file`, which outlives the call, and the
        // slice passes its own length. FILE_NAME_NORMALIZED | VOLUME_NAME_DOS
        // (both 0) is the form `fs::canonicalize` produces, so the result is
        // comparable with the canonical root.
        let length = unsafe { GetFinalPathNameByHandleW(handle, &mut buffer, FILE_NAME_NORMALIZED) } as usize;
        if length == 0 {
            return None;
        }
        if length < buffer.len() {
            buffer.truncate(length);
            return Some(PathBuf::from(OsString::from_wide(&buffer)));
        }
        buffer.resize(length + 1, 0);
    }
    None
}

#[cfg(target_os = "linux")]
fn opened_path(file: &File) -> Option<PathBuf> {
    use std::os::unix::io::AsRawFd;
    fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd())).ok()
}

#[cfg(target_os = "macos")]
fn opened_path(file: &File) -> Option<PathBuf> {
    use std::ffi::{CStr, OsStr};
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::io::AsRawFd;

    const MAXPATHLEN: usize = 1024; // <sys/param.h>; F_GETPATH requires it
    let mut buffer = [0 as libc::c_char; MAXPATHLEN];
    // SAFETY: F_GETPATH writes a NUL-terminated path of at most MAXPATHLEN
    // bytes into `buffer`, which lives across the call.
    let status = unsafe { libc::fcntl(file.as_raw_fd(), libc::F_GETPATH, buffer.as_mut_ptr()) };
    if status == -1 {
        return None;
    }
    // SAFETY: on success the buffer holds a NUL-terminated string.
    let path = unsafe { CStr::from_ptr(buffer.as_ptr()) };
    Some(PathBuf::from(OsStr::from_bytes(path.to_bytes())))
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn opened_path(_file: &File) -> Option<PathBuf> {
    None
}

/// Whether the opened object has lost its last name (unlinked or pending
/// deletion). A path queried from such a handle is not a name the file can be
/// judged by, so the reader fails closed. Any query failure also counts as
/// unlinked.
#[cfg(unix)]
fn opened_object_is_unlinked(file: &File, opened: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    file.metadata().map_or(true, |metadata| metadata.nlink() == 0) || has_deleted_marker(opened)
}

/// Linux marks the `/proc/self/fd` link of an unlinked file with this suffix.
/// Refused even if the link count reads non-zero (a relinked file): the
/// marker says the path was taken from a nameless object. A real file whose
/// name ends this way is refused too — fail closed.
#[cfg(target_os = "linux")]
fn has_deleted_marker(opened: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    opened.as_os_str().as_bytes().ends_with(b" (deleted)")
}

#[cfg(all(unix, not(target_os = "linux")))]
fn has_deleted_marker(_opened: &Path) -> bool {
    false
}

/// Windows: a deleted file can outlive its name while a handle is open, and
/// with POSIX delete semantics its final path moves to `\$Extend\$Deleted\…`
/// on the volume — inside the project if the project is a drive root.
#[cfg(windows)]
fn opened_object_is_unlinked(file: &File, _opened: &Path) -> bool {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{FileStandardInfo, GetFileInformationByHandleEx, FILE_STANDARD_INFO};

    let mut info = FILE_STANDARD_INFO::default();
    // SAFETY: the handle belongs to `file`, alive across the call; the buffer
    // is a FILE_STANDARD_INFO and its exact size is passed.
    let queried = unsafe {
        GetFileInformationByHandleEx(
            HANDLE(file.as_raw_handle()),
            FileStandardInfo,
            (&mut info as *mut FILE_STANDARD_INFO).cast(),
            std::mem::size_of::<FILE_STANDARD_INFO>() as u32,
        )
    };
    queried.is_err() || info.NumberOfLinks == 0 || info.DeletePending
}

#[cfg(not(any(unix, windows)))]
fn opened_object_is_unlinked(_file: &File, _opened: &Path) -> bool {
    true
}

fn io_outcome(kind: ErrorKind) -> DiskRead {
    match kind {
        // A file used as a directory (`README.md/x`) is simply not there.
        ErrorKind::NotFound | ErrorKind::NotADirectory => DiskRead::NotFound,
        ErrorKind::IsADirectory => DiskRead::NotFile,
        ErrorKind::InvalidInput | ErrorKind::InvalidFilename => DiskRead::InvalidPath,
        _ => DiskRead::Unreadable,
    }
}

/// The canonical target as a forward-slash path relative to the (canonical)
/// root, or `None` if it is not inside it.
fn canonical_relative(root: &Path, target: &Path) -> Option<String> {
    let relative = target.strip_prefix(root).ok()?;
    let mut segments = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => segments.push(part.to_str()?.to_owned()),
            _ => return None,
        }
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

/// Opaque disk revision: a truncated SHA-256 of the bytes read. The format is
/// an implementation detail of the disk owner (brief §4.5); callers compare
/// revisions for equality only.
pub(crate) fn disk_revision(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let hex: String = digest[..16].iter().map(|byte| format!("{byte:02x}")).collect();
    format!("d1-{hex}")
}

// ---------------------------------------------------------------------------
// Line slicing
// ---------------------------------------------------------------------------

#[derive(Debug, PartialEq)]
pub(crate) struct Slice {
    pub text: String,
    /// `(start, end)`, 1-based inclusive; `None` when no line was returned.
    pub range: Option<(u32, u32)>,
    pub total_lines: u32,
    pub truncated: bool,
    pub line_cut: bool,
}

/// Lines as `split_inclusive('\n')` yields them, counted without collecting:
/// a file of newlines must not cost a slice per line (Codex review finding 3).
fn count_lines(text: &str) -> u32 {
    let newlines = text.bytes().filter(|byte| *byte == b'\n').count();
    let partial_last = usize::from(!text.is_empty() && !text.ends_with('\n'));
    (newlines + partial_last) as u32
}

/// Slice lines `start..=end` of `text` within `budget` UTF-8 bytes. The
/// budget is strict: nothing returned ever exceeds it.
///
/// Lines keep their terminators, so text is returned as stored. A read that
/// does not fit stops at a line boundary (`truncated`). If the FIRST line
/// alone exceeds the budget, it is cut at a character boundary (`lineCut`).
/// If not even one character fits, nothing is returned (`range: None`,
/// `truncated`); callers keep every budget at least `MIN_BYTES_PER_DOCUMENT`
/// (the largest UTF-8 character) where progress is owed (brief §5).
///
/// Memory: O(returned text). Lines are walked by iterator, never collected.
pub(crate) fn slice(text: &str, start_line: u32, end_line: Option<u32>, budget: usize) -> Slice {
    let total_lines = count_lines(text);
    let start = start_line.max(1);
    let end = end_line.unwrap_or(total_lines).min(total_lines);
    let empty = |truncated| Slice {
        text: String::new(),
        range: None,
        total_lines,
        truncated,
        line_cut: false,
    };
    if start > end {
        return empty(false);
    }

    let mut wanted = text
        .split_inclusive('\n')
        .skip((start - 1) as usize)
        .take((end - start + 1) as usize);
    let Some(first) = wanted.next() else {
        return empty(false);
    };
    if first.len() > budget {
        let cut = floor_char_boundary(first, budget);
        if cut == 0 {
            return empty(true);
        }
        return Slice {
            text: first[..cut].to_owned(),
            range: Some((start, start)),
            total_lines,
            truncated: true,
            line_cut: true,
        };
    }

    let mut out = String::from(first);
    let mut last = start;
    for line in wanted {
        if out.len() + line.len() > budget {
            break;
        }
        out.push_str(line);
        last += 1;
    }
    Slice {
        text: out,
        range: Some((start, last)),
        total_lines,
        truncated: last < end,
        line_cut: false,
    }
}

fn floor_char_boundary(text: &str, index: usize) -> usize {
    let mut index = index.min(text.len());
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;
    use std::io::Write;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> std::path::PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("litria-api-read-{tag}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    #[test]
    fn reads_text_with_a_stable_revision() {
        let root = temp_root("text");
        fs::write(root.join("a.txt"), "one\ntwo\n").unwrap();
        let first = read_disk(&root, "a.txt");
        assert_eq!(first, read_disk(&root, "a.txt"), "same bytes, same revision");
        let DiskRead::Text { text, revision } = first else { panic!("{first:?}") };
        assert_eq!(text, "one\ntwo\n");
        fs::write(root.join("a.txt"), "one\nTWO\n").unwrap();
        let DiskRead::Text { revision: changed, .. } = read_disk(&root, "a.txt") else { panic!() };
        assert_ne!(revision, changed, "the revision follows the content");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_over_the_cap_is_refused_without_being_read() {
        let root = temp_root("cap");
        fs::write(root.join("big.txt"), "0123456789ABCDEF!").unwrap(); // 17 bytes
        let reached_read = Cell::new(false);
        let outcome = read_disk_with(&root, "big.txt", 16, || {}, || {}, || reached_read.set(true));
        assert_eq!(outcome, DiskRead::TooLarge);
        assert!(!reached_read.get(), "the size check refuses before reading");
        let _ = fs::remove_dir_all(&root);
    }

    /// Growth between the handle's size check and the read: the cap holds on
    /// the bytes consumed.
    #[test]
    fn growth_after_the_size_check_is_caught_by_the_capped_read() {
        let root = temp_root("grow");
        let path = root.join("grow.txt");
        fs::write(&path, "0123456789").unwrap(); // 10 bytes, under the cap
        let outcome = read_disk_with(&root, "grow.txt", 16, || {}, || {}, || {
            let mut file = fs::OpenOptions::new().append(true).open(&path).unwrap();
            file.write_all(b"much more than six more bytes").unwrap();
        });
        assert_eq!(outcome, DiskRead::TooLarge);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_directory_is_not_a_file() {
        let root = temp_root("dir");
        fs::create_dir_all(root.join("src")).unwrap();
        assert_eq!(read_disk(&root, "src"), DiskRead::NotFile);
        let _ = fs::remove_dir_all(&root);
    }

    /// A FIFO answers `notFile` and never blocks the reader.
    #[cfg(unix)]
    #[test]
    fn a_fifo_is_not_a_file_and_does_not_block() {
        let root = temp_root("fifo");
        let status = std::process::Command::new("mkfifo").arg(root.join("pipe")).status().unwrap();
        assert!(status.success(), "mkfifo");
        assert_eq!(read_disk(&root, "pipe"), DiskRead::NotFile);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn binary_and_non_utf8_content_is_not_text() {
        let root = temp_root("binary");
        // (Not `nul.bin`: `nul` is a Windows device stem, rightly `invalidPath`.)
        fs::write(root.join("zero-byte.bin"), b"abc\0def").unwrap();
        fs::write(root.join("latin1.txt"), b"caf\xe9\n").unwrap();
        assert_eq!(read_disk(&root, "zero-byte.bin"), DiskRead::NotText);
        assert_eq!(read_disk(&root, "latin1.txt"), DiskRead::NotText);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn missing_invalid_and_denied_paths() {
        let root = temp_root("outcomes");
        fs::write(root.join("README.md"), "x").unwrap();
        assert_eq!(read_disk(&root, "missing.txt"), DiskRead::NotFound);
        assert_eq!(read_disk(&root, "README.md/child"), DiskRead::NotFound);
        assert_eq!(read_disk(&root, "../escape.txt"), DiskRead::InvalidPath);
        assert_eq!(read_disk(&root, "notes.md:stream"), DiskRead::InvalidPath);
        // Denied without touching the filesystem: the file does not exist, and
        // the answer is still `denied`, never `notFound`.
        assert_eq!(read_disk(&root, ".env"), DiskRead::Denied);
        assert_eq!(read_disk(&root, "deep/dir/id_rsa"), DiskRead::Denied);
        // An existing denied file is denied the same way.
        fs::write(root.join(".env"), "SECRET=1").unwrap();
        assert_eq!(read_disk(&root, ".env"), DiskRead::Denied);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unindexed_directories_are_readable_by_explicit_path() {
        let root = temp_root("unindexed");
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.d.ts"), "export {};\n").unwrap();
        assert!(matches!(read_disk(&root, "node_modules/pkg/index.d.ts"), DiskRead::Text { .. }));
        // …but denied wins over unindexed.
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "[core]\n").unwrap();
        assert_eq!(read_disk(&root, ".git/config"), DiskRead::Denied);
        let _ = fs::remove_dir_all(&root);
    }

    /// A link with an innocent name that resolves to a denied file is denied:
    /// the policy runs again on the canonical target.
    #[cfg(unix)]
    #[test]
    fn a_link_to_a_denied_file_is_denied() {
        let root = temp_root("link-unix");
        fs::write(root.join(".env"), "SECRET=1").unwrap();
        std::os::unix::fs::symlink(root.join(".env"), root.join("notes.txt")).unwrap();
        assert_eq!(read_disk(&root, "notes.txt"), DiskRead::Denied);
        let _ = fs::remove_dir_all(&root);
    }

    /// Windows: a directory junction (no privilege needed) to a denied
    /// directory. Reading through it resolves into `.git` and is denied.
    #[cfg(windows)]
    #[test]
    fn a_junction_into_a_denied_directory_is_denied() {
        let root = temp_root("link-windows");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "[core]\n").unwrap();
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(root.join("innocent"))
            .arg(root.join(".git"))
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J");
        assert_eq!(read_disk(&root, "innocent/config"), DiskRead::Denied);
        // Remove the junction itself before the tree, so nothing follows it.
        fs::remove_dir(root.join("innocent")).unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    // --- replacement races (Codex review of PR #86, finding 1) --------------
    //
    // The path is authorized, then something swaps a parent directory or the
    // file itself for a link BEFORE the open. The reader must authorize what
    // it actually opened, not the path it resolved earlier.

    #[cfg(windows)]
    fn junction(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J");
    }

    /// Windows: `sub/` is swapped for a junction into `.git` after `sub/config`
    /// was resolved and authorized.
    #[cfg(windows)]
    #[test]
    fn a_parent_swapped_for_a_junction_after_resolution_is_denied() {
        let root = temp_root("race-parent");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/config"), "allowed\n").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "SECRET\n").unwrap();
        let outcome = read_disk_with(
            &root,
            "sub/config",
            HARD_CAP_BYTES,
            || {
                fs::rename(root.join("sub"), root.join("sub-real")).unwrap();
                junction(&root.join("sub"), &root.join(".git"));
            },
            || {},
            || {},
        );
        fs::remove_dir(root.join("sub")).unwrap(); // the junction itself
        assert_eq!(outcome, DiskRead::Denied, "read through a swapped-in junction");
        let _ = fs::remove_dir_all(&root);
    }

    /// Windows: the same swap, into a directory OUTSIDE the project.
    #[cfg(windows)]
    #[test]
    fn a_parent_swapped_for_a_junction_outside_the_project_is_denied() {
        let root = temp_root("race-outside");
        let outside = temp_root("race-outside-target");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/notes.txt"), "allowed\n").unwrap();
        fs::write(outside.join("notes.txt"), "OUTSIDE\n").unwrap();
        let outcome = read_disk_with(
            &root,
            "sub/notes.txt",
            HARD_CAP_BYTES,
            || {
                fs::rename(root.join("sub"), root.join("sub-real")).unwrap();
                junction(&root.join("sub"), &outside);
            },
            || {},
            || {},
        );
        fs::remove_dir(root.join("sub")).unwrap();
        assert_eq!(outcome, DiskRead::Denied, "read outside the project through a swapped-in junction");
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    /// Unix: the file itself is swapped for a symlink to a denied file, and
    /// (second case) to a file outside the project.
    #[cfg(unix)]
    #[test]
    fn a_file_swapped_for_a_symlink_after_resolution_is_denied() {
        let root = temp_root("race-file");
        let outside = temp_root("race-file-outside");
        fs::write(root.join("notes.txt"), "allowed\n").unwrap();
        fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        fs::write(outside.join("secret.txt"), "OUTSIDE\n").unwrap();
        for target in [root.join(".env"), outside.join("secret.txt")] {
            fs::write(root.join("notes.txt"), "allowed\n").unwrap();
            let outcome = read_disk_with(
                &root,
                "notes.txt",
                HARD_CAP_BYTES,
                || {
                    fs::remove_file(root.join("notes.txt")).unwrap();
                    std::os::unix::fs::symlink(&target, root.join("notes.txt")).unwrap();
                },
                || {},
                || {},
            );
            assert_eq!(outcome, DiskRead::Denied, "read through a swapped-in link to {}", target.display());
            fs::remove_file(root.join("notes.txt")).unwrap();
        }
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    /// Codex re-review of `b85b6f0`: the denied file is UNLINKED between the
    /// open and the handle-path query. Linux then reports `<path> (deleted)`,
    /// a name no deny rule matches, while the handle still reads the old
    /// contents. The reader must fail closed. Covers the exact-name rule
    /// (`.env`) and the suffix rule (`.pem`), both defeated by the suffix.
    #[cfg(unix)]
    #[test]
    fn a_denied_file_unlinked_after_opening_is_still_withheld() {
        for denied in [".env", "server.pem"] {
            let root = temp_root("race-unlink");
            fs::write(root.join("notes.txt"), "allowed\n").unwrap();
            fs::write(root.join(denied), "SECRET=1\n").unwrap();
            let outcome = read_disk_with(
                &root,
                "notes.txt",
                HARD_CAP_BYTES,
                || {
                    fs::remove_file(root.join("notes.txt")).unwrap();
                    std::os::unix::fs::symlink(root.join(denied), root.join("notes.txt")).unwrap();
                },
                || fs::remove_file(root.join(denied)).unwrap(),
                || {},
            );
            assert!(
                !matches!(outcome, DiskRead::Text { .. }),
                "read {denied} after it was unlinked behind the open handle: {outcome:?}"
            );
            let _ = fs::remove_dir_all(&root);
        }
    }

    /// Windows analogue: a junction swap opens `.git/config`, which is then
    /// deleted while our handle is open (std opens with FILE_SHARE_DELETE).
    #[cfg(windows)]
    #[test]
    fn a_denied_file_deleted_after_opening_is_still_withheld() {
        let root = temp_root("race-delete");
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("sub/config"), "allowed\n").unwrap();
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "SECRET\n").unwrap();
        let outcome = read_disk_with(
            &root,
            "sub/config",
            HARD_CAP_BYTES,
            || {
                fs::rename(root.join("sub"), root.join("sub-real")).unwrap();
                junction(&root.join("sub"), &root.join(".git"));
            },
            || fs::remove_file(root.join(".git/config")).unwrap(),
            || {},
        );
        fs::remove_dir(root.join("sub")).unwrap();
        assert!(!matches!(outcome, DiskRead::Text { .. }), "read a deleted denied file: {outcome:?}");
        let _ = fs::remove_dir_all(&root);
    }

    /// The name check itself: a file deleted while our handle is open reads
    /// as unlinked on every platform; a live file does not.
    #[test]
    fn a_file_deleted_behind_an_open_handle_reads_as_unlinked() {
        let root = temp_root("unlinked");
        let path = root.join("doomed.txt");
        fs::write(&path, "x").unwrap();
        let file = open_for_read(&path).unwrap();
        let opened = opened_path(&file).expect("the OS names an open file");
        assert!(!opened_object_is_unlinked(&file, &opened), "a live file is not unlinked");
        fs::remove_file(&path).unwrap(); // std opens with FILE_SHARE_DELETE on Windows
        assert!(opened_object_is_unlinked(&file, &opened), "a deleted file must read as unlinked");
        drop(file);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_linux_deleted_marker_is_refused() {
        assert!(has_deleted_marker(Path::new("/p/.env (deleted)")));
        assert!(!has_deleted_marker(Path::new("/p/notes.txt")));
    }

    // --- exact names (Codex review finding 2) -------------------------------

    /// A leading space is part of the filename. The API reads exactly what
    /// was requested, never a trimmed neighbour.
    #[test]
    fn leading_whitespace_selects_exactly_that_file() {
        let root = temp_root("exact");
        fs::write(root.join("notes.txt"), "plain\n").unwrap();
        fs::write(root.join(" notes.txt"), "spaced\n").unwrap();
        let DiskRead::Text { text, .. } = read_disk(&root, " notes.txt") else { panic!() };
        assert_eq!(text, "spaced\n");
        let DiskRead::Text { text, .. } = read_disk(&root, "notes.txt") else { panic!() };
        assert_eq!(text, "plain\n");
        let _ = fs::remove_dir_all(&root);
    }

    /// ` .env` is a different (missing) file. The answer must not depend on
    /// whether the denied `.env` exists, or existence would leak.
    #[test]
    fn a_whitespace_prefixed_denied_name_does_not_reveal_existence() {
        let root = temp_root("exact-denied");
        let absent = read_disk(&root, " .env");
        fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        let present = read_disk(&root, " .env");
        assert_eq!(absent, present, "the answer changed with the denied file's existence");
        assert_eq!(present, DiskRead::NotFound);
        let _ = fs::remove_dir_all(&root);
    }

    // --- slicing -----------------------------------------------------------

    #[test]
    fn slices_ranges_and_reports_totals() {
        let text = "a\nb\nc\nd\n";
        let all = slice(text, 1, None, 1024);
        assert_eq!((all.text.as_str(), all.range, all.total_lines, all.truncated), (text, Some((1, 4)), 4, false));
        let middle = slice(text, 2, Some(3), 1024);
        assert_eq!((middle.text.as_str(), middle.range, middle.truncated), ("b\nc\n", Some((2, 3)), false));
        let past_end = slice(text, 9, None, 1024);
        assert_eq!((past_end.text.as_str(), past_end.range, past_end.truncated), ("", None, false));
        let reversed = slice(text, 3, Some(2), 1024);
        assert_eq!(reversed.range, None, "an end before the start returns no lines");
        let empty = slice("", 1, None, 1024);
        assert_eq!((empty.range, empty.total_lines), (None, 0));
        let no_newline = slice("x\ny", 1, None, 1024);
        assert_eq!((no_newline.text.as_str(), no_newline.total_lines), ("x\ny", 2));
    }

    #[test]
    fn truncation_stops_at_a_line_boundary() {
        let text = "aaaa\nbbbb\ncccc\n"; // 5 bytes per line
        let part = slice(text, 1, None, 12);
        assert_eq!((part.text.as_str(), part.range, part.truncated, part.line_cut), ("aaaa\nbbbb\n", Some((1, 2)), true, false));
        // Continuing from the next line makes progress.
        let rest = slice(text, 3, None, 12);
        assert_eq!((rest.text.as_str(), rest.truncated), ("cccc\n", false));
    }

    /// A single line larger than the budget is cut, not refused: a 300 KiB
    /// one-line file still returns text, and the next line is reachable.
    #[test]
    fn an_oversized_line_is_cut_and_reading_progresses() {
        let long = format!("{}\nnext\n", "é".repeat(150 * 1024)); // 300 KiB line
        let cut = slice(&long, 1, None, 256 * 1024);
        assert!(cut.line_cut && cut.truncated);
        assert_eq!(cut.range, Some((1, 1)));
        assert!(cut.text.len() <= 256 * 1024 && !cut.text.is_empty());
        assert!(cut.text.chars().all(|c| c == 'é'), "cut at a character boundary");
        let next = slice(&long, 2, None, 256 * 1024);
        assert_eq!(next.text, "next\n");
    }

    /// Budgets are strict (Codex review finding 4): a character that does not
    /// fit is not returned, whatever its size.
    #[test]
    fn a_character_that_does_not_fit_the_budget_is_not_returned() {
        let tiny = slice("😀😀\n", 1, None, 3);
        assert!(tiny.text.len() <= 3, "returned {} bytes against a 3-byte budget", tiny.text.len());
        assert_eq!((tiny.range, tiny.truncated), (None, true), "nothing fit, and it says so");
        let exact = slice("😀😀\n", 1, None, 4);
        assert_eq!((exact.text.as_str(), exact.line_cut), ("😀", true));
    }

    /// Codex review finding 3: many short lines are counted and sliced
    /// without a per-line allocation, and the answers stay exact.
    #[test]
    fn many_short_lines_slice_correctly() {
        let text = "\n".repeat(1_000_000) + "last";
        let tail = slice(&text, 1_000_000, None, 1024);
        assert_eq!(tail.total_lines, 1_000_001);
        assert_eq!((tail.text.as_str(), tail.range, tail.truncated), ("\nlast", Some((1_000_000, 1_000_001)), false));
        let head = slice(&text, 1, Some(3), 1024);
        assert_eq!((head.text.as_str(), head.range), ("\n\n\n", Some((1, 3))));
        assert_eq!(count_lines(""), 0);
        assert_eq!(count_lines("\n"), 1);
        assert_eq!(count_lines("a\nb"), 2);
        assert_eq!(count_lines("a\nb\n"), 2);
    }

    /// Brief §15 Q3: `.env.example` is readable, but a link that only wears
    /// the name is judged by its target (P4 gate item 1, 2026-10-01).
    #[test]
    fn an_env_template_is_readable_and_a_link_named_like_one_is_not() {
        let root = temp_root("env-template");
        fs::write(root.join(".env.example"), "API_URL=\n").unwrap();
        let DiskRead::Text { text, .. } = read_disk(&root, ".env.example") else {
            panic!("the template is readable");
        };
        assert_eq!(text, "API_URL=\n");
        assert!(matches!(read_disk(&root, ".env.local.example"), DiskRead::Denied));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn a_link_named_like_an_env_template_is_judged_by_its_target() {
        let root = temp_root("env-template-link");
        fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        std::os::unix::fs::symlink(root.join(".env"), root.join(".env.sample")).unwrap();
        assert!(matches!(read_disk(&root, ".env.sample"), DiskRead::Denied));
        let _ = fs::remove_dir_all(&root);
    }
}
