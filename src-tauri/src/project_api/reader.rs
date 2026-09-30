//! Bounded disk reads and line slicing (Project API contract brief §5).
//!
//! The bound is on the bytes actually consumed, not on a size checked
//! beforehand: a file can grow, or be replaced, between a metadata check and
//! a read. Every check that matters runs on the open handle.

use std::fs::{self, File};
use std::io::{ErrorKind, Read};
use std::path::{Component, Path};

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
    read_disk_with(root, path, HARD_CAP_BYTES, || {})
}

/// `read_disk` with the cap and a hook that runs after the handle's checks
/// and before the read — the window in which a file can grow. Tests use both.
fn read_disk_with(root: &Path, path: &str, cap: u64, after_checks: impl FnOnce()) -> DiskRead {
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
    let file = match open_for_read(&target) {
        Ok(file) => file,
        Err(error) => return io_outcome(error.kind()),
    };
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

/// Slice lines `start..=end` of `text` within `budget` UTF-8 bytes.
///
/// Lines keep their terminators, so text is returned as stored. A read that
/// does not fit stops at a line boundary (`truncated`). If the FIRST line
/// alone exceeds the budget, it is cut at a character boundary (`lineCut`),
/// keeping at least one character, so every read makes progress (brief §5).
pub(crate) fn slice(text: &str, start_line: u32, end_line: Option<u32>, budget: usize) -> Slice {
    let lines: Vec<&str> = text.split_inclusive('\n').collect();
    let total_lines = lines.len() as u32;
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

    let wanted = &lines[(start - 1) as usize..end as usize];
    let first = wanted[0];
    if first.len() > budget {
        let mut cut = floor_char_boundary(first, budget);
        if cut == 0 {
            // Keep at least one character even if it overshoots a tiny budget.
            cut = first.chars().next().map_or(0, char::len_utf8);
        }
        return Slice {
            text: first[..cut].to_owned(),
            range: Some((start, start)),
            total_lines,
            truncated: true,
            line_cut: true,
        };
    }

    let mut out = String::new();
    let mut last = start - 1;
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
        let outcome = read_disk_with(&root, "big.txt", 16, || reached_read.set(true));
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
        let outcome = read_disk_with(&root, "grow.txt", 16, || {
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
        // Even a budget smaller than one character returns that character.
        let tiny = slice("😀😀\n", 1, None, 1);
        assert_eq!((tiny.text.as_str(), tiny.line_cut), ("😀", true));
    }
}
