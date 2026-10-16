use crate::errors::{CommandError, CommandResult};
use crate::path_guard;
use crate::project_tree;
use crate::project_types::ProjectTreeEntry;
use crate::write_ops;
use std::fs;
use std::io;
use std::path::Path;

pub(crate) fn read_project_file(root_path: &str, relative_path: &str) -> CommandResult<String> {
    let root = path_guard::resolve_project_root(root_path).map_err(CommandError::from_text)?;
    let target =
        path_guard::resolve_existing_relative_path(&root, relative_path).map_err(CommandError::from_text)?;
    fs::read_to_string(&target)
        .map_err(|error| CommandError::from_io("project_file.read", &error, "Unable to read project file"))
}

/// A file's text and the disk revision Rust mints for the exact bytes it read.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FileWithRevision {
    pub text: String,
    pub revision: String,
    /// The file's stamp, taken before the bytes were read (see [`stamp_of`]):
    /// a change during the read leaves a newer stamp, so the next check of
    /// the stamps reads the file again. `None` if it could not be taken.
    pub stamp: Option<String>,
}

/// A cheap fingerprint of a file on disk, its size and modification time, as
/// an opaque token: equal tokens mean "probably unchanged", and anything else
/// means "read it again" (track T slice T3a). Nanoseconds do not fit a
/// JavaScript number, so the frontend only ever compares tokens.
///
/// Two writes of the same size within one tick of the filesystem's clock
/// produce the same token; a save still compares the revision itself, so a
/// change the stamps miss is never overwritten.
pub(crate) fn stamp_of(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some(format!("{}:{}.{:09}", metadata.len(), modified.as_secs(), modified.subsec_nanos()))
}

/// Read a project file together with its disk revision (Project API brief
/// §4.5: Rust mints every disk revision). The revision is `disk_revision` over
/// the exact bytes read, so text registered through this path can be compared
/// for freshness against a later read of the same bytes. Semantics match
/// `read_project_file`: strict UTF-8, no BOM stripping. The separate return
/// type leaves `read_project_file`'s callers untouched (the syntax registration
/// paths use this variant — P4c, 2026-10-03).
pub(crate) fn read_project_file_with_revision(
    root_path: &str,
    relative_path: &str,
) -> CommandResult<FileWithRevision> {
    let root = path_guard::resolve_project_root(root_path).map_err(CommandError::from_text)?;
    let target =
        path_guard::resolve_existing_relative_path(&root, relative_path).map_err(CommandError::from_text)?;
    let stamp = stamp_of(&target);
    let bytes = fs::read(&target)
        .map_err(|error| CommandError::from_io("project_file.read", &error, "Unable to read project file"))?;
    let revision = crate::project_api::reader::disk_revision(&bytes);
    let text = String::from_utf8(bytes)
        .map_err(|_| CommandError::from_text("Unable to read project file: not valid UTF-8"))?;
    Ok(FileWithRevision { text, revision, stamp })
}

/// What a save expects on disk before it replaces the file (track T slice
/// T3a): the disk version the saved text was based on. The editor sends that
/// version's text (a canvas piece holds the exact text read from disk), not a
/// revision: the frontend has no synchronous hash, and a text that no longer
/// matches the disk only ever fails toward `Changed`.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum SaveBase {
    /// The disk still holds exactly this text.
    Text { text: String },
    /// Nothing has the name: the file was deleted, and the person chose to
    /// keep their version.
    Absent,
}

/// What `save_project_file` did.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "outcome", rename_all = "camelCase")]
pub(crate) enum SaveOutcome {
    /// Written. `revision` is the saved text's; `stamp` the file's afterwards,
    /// or `None` if another write landed before it could be taken.
    Saved { revision: String, stamp: Option<String> },
    /// The disk no longer holds the base, so nothing was written. `disk` is
    /// the revision there now, or `None` if nothing has the name.
    Changed { disk: Option<String> },
}

/// The revision on disk at `target`, or `None` if nothing has the name.
fn current_revision(target: &Path) -> Result<Option<String>, String> {
    match fs::read(target) {
        Ok(bytes) => Ok(Some(crate::project_api::reader::disk_revision(&bytes))),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Unable to read the file on disk: {error}")),
    }
}

fn holds(base: &SaveBase, current: Option<&str>) -> bool {
    match base {
        SaveBase::Text { text } => current == Some(crate::project_api::reader::disk_revision(text.as_bytes()).as_str()),
        SaveBase::Absent => current.is_none(),
    }
}

/// Save a tab's text only if the disk still holds the version that text was
/// based on (track T slice T3a). Another program's newer version is never
/// overwritten: the answer is `Changed`, and the editor offers the choice.
///
/// The disk is compared twice: before anything is written (most changes end
/// there), and again once the new content is durable beside the file,
/// immediately before it replaces it (`write_ops::replace_string_if`). The
/// app's write lock covers this process only; another program writing between
/// that last check and the rename is the residual window.
pub(crate) fn save_project_file(
    root_path: &str,
    relative_path: &str,
    contents: &str,
    base: &SaveBase,
) -> CommandResult<SaveOutcome> {
    write_ops::with_write_lock(|| save_project_file_with(root_path, relative_path, contents, base, &mut || {}))
}

/// `before_replace` runs just before the last check: the tests' window for
/// another program's write.
fn save_project_file_with(
    root_path: &str,
    relative_path: &str,
    contents: &str,
    base: &SaveBase,
    before_replace: &mut dyn FnMut(),
) -> CommandResult<SaveOutcome> {
    let root = path_guard::ensure_project_root(root_path).map_err(CommandError::from_text)?;
    let target =
        path_guard::resolve_relative_path_for_write(&root, relative_path).map_err(CommandError::from_text)?;
    let current = current_revision(&target).map_err(CommandError::from_text)?;
    if !holds(base, current.as_deref()) {
        return Ok(SaveOutcome::Changed { disk: current });
    }
    let mut seen = None;
    let replaced = write_ops::replace_string_if(&target, contents, &mut || {
        before_replace();
        let now = current_revision(&target)?;
        let still = holds(base, now.as_deref());
        seen = Some(now);
        Ok(still)
    });
    match replaced {
        Ok(()) => {}
        Err(write_ops::ReplaceError::Refused) => {
            return Ok(SaveOutcome::Changed { disk: seen.flatten() });
        }
        Err(write_ops::ReplaceError::Failed(error)) => {
            return Err(CommandError::from_text(format!("Unable to write project file: {error}")));
        }
    }
    let revision = crate::project_api::reader::disk_revision(contents.as_bytes());
    // The stamp must describe these bytes: if another write already landed,
    // record none, so the next check of the stamps reads the file again.
    let stamp = stamp_of(&target).filter(|_| current_revision(&target).ok().flatten().as_deref() == Some(&revision));
    Ok(SaveOutcome::Saved { revision, stamp })
}

/// The most paths one `project_files_stamps` call takes.
pub(crate) const MAX_STAMPED_PATHS: usize = 2048;

/// One path's stamp, for the editor's check of open files (track T T3a).
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PathStamp {
    pub path: String,
    /// `None`: nothing readable has the name (deleted, or not a file).
    pub stamp: Option<String>,
}

/// The stamps of `paths` in the project, in order. A path outside the project,
/// or one that no longer resolves, reads as missing. Reads metadata only.
pub(crate) fn project_files_stamps(root_path: &str, paths: &[String]) -> CommandResult<Vec<PathStamp>> {
    if paths.len() > MAX_STAMPED_PATHS {
        return Err(CommandError::from_text(format!(
            "Too many paths to check at once (the limit is {MAX_STAMPED_PATHS})."
        )));
    }
    let root = path_guard::resolve_project_root(root_path).map_err(CommandError::from_text)?;
    Ok(paths
        .iter()
        .map(|path| PathStamp {
            path: path.clone(),
            stamp: path_guard::resolve_existing_relative_path(&root, path)
                .ok()
                .and_then(|target| stamp_of(&target)),
        })
        .collect())
}

pub(crate) fn write_project_file(root_path: &str, relative_path: &str, contents: &str) -> CommandResult<()> {
    write_ops::with_write_lock(|| {
        let root = path_guard::ensure_project_root(root_path).map_err(CommandError::from_text)?;
        let target = path_guard::resolve_relative_path_for_write(&root, relative_path)
            .map_err(CommandError::from_text)?;
        write_ops::atomic_write_string(&target, contents)
            .map_err(|error| CommandError::from_text(format!("Unable to write project file: {error}")))
    })
}

/// What `create_project_file` did.
#[derive(Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CreateFileOutcome {
    Created,
    /// Something already has the name. Nothing was written.
    Exists,
}

/// Create a project file only if nothing has its name. Unlike
/// `write_project_file` it never overwrites (Project API build plan W3a: the
/// drawer's New file and New Node, and agent-created files).
///
/// The path is taken exactly as given. Missing directories are created; the
/// file's directory is then canonicalized and must lie within the root, and
/// it is checked again immediately before the commit, so a directory swapped
/// for a link to elsewhere in between is refused. Residual risks, all needing
/// another process racing the create (the app's write lock covers only this
/// process): a swap between that last check and the commit; a link planted in
/// a missing directory's place before it is created, which can leave empty
/// directories outside the root before the create is refused; and a swap
/// before the temp file is written, which puts the temp outside the root
/// until the refusal removes it.
pub(crate) fn create_project_file(
    root_path: &str,
    relative_path: &str,
    contents: &str,
) -> CommandResult<CreateFileOutcome> {
    write_ops::with_write_lock(|| create_project_file_with(root_path, relative_path, contents, &mut |_| Ok(())))
}

/// The windows a create crosses after its directory is resolved, for tests to
/// act in (adversarial-check Rule 4, question 7).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CreateWindow {
    /// The directory is resolved; the content is not written yet.
    BeforeWrite,
    /// The content is written beside the target; the last check and the
    /// commit come next.
    BeforeCommit,
}

fn create_project_file_with(
    root_path: &str,
    relative_path: &str,
    contents: &str,
    window: &mut dyn FnMut(CreateWindow) -> Result<(), String>,
) -> CommandResult<CreateFileOutcome> {
    let root = path_guard::resolve_project_root(root_path).map_err(CommandError::from_text)?;
    let (directory, name) = path_guard::resolve_new_file(&root, relative_path).map_err(CommandError::from_text)?;
    fs::create_dir_all(&directory).map_err(|error| {
        CommandError::from_io("project_file.create", &error, "Unable to create file directory")
    })?;
    let directory = fs::canonicalize(&directory)
        .map_err(|error| CommandError::from_text(format!("Unable to resolve path: {error}")))?;
    if !directory.starts_with(&root) {
        return Err(CommandError::from_text("Path is not within project root."));
    }
    let target = directory.join(&name);
    window(CreateWindow::BeforeWrite).map_err(CommandError::from_text)?;
    let mut still_the_same_directory = || {
        window(CreateWindow::BeforeCommit)?;
        match fs::canonicalize(&directory) {
            Ok(now) if now == directory => Ok(()),
            _ => Err("The file's directory changed while the file was being created.".to_string()),
        }
    };
    match write_ops::create_new_string(&target, contents, &mut still_the_same_directory) {
        Ok(()) => Ok(CreateFileOutcome::Created),
        Err(write_ops::CreateError::Exists) => Ok(CreateFileOutcome::Exists),
        Err(write_ops::CreateError::Failed(message)) => {
            Err(CommandError::from_text(format!("Unable to create project file: {message}")))
        }
    }
}

#[cfg(test)]
mod create_tests;
#[cfg(test)]
mod save_tests;

pub(crate) fn list_project_tree(root_path: &str) -> CommandResult<Vec<ProjectTreeEntry>> {
    let root = path_guard::resolve_project_root(root_path).map_err(CommandError::from_text)?;
    project_tree::collect_project_tree(&root).map_err(CommandError::from_text)
}

pub(crate) fn move_project_path(
    root_path: &str,
    from_relative: &str,
    to_relative: &str,
) -> CommandResult<()> {
    write_ops::with_write_lock(|| {
        let root = path_guard::resolve_project_root(root_path).map_err(CommandError::from_text)?;
        // The selected entry itself — a link moves as a link, never its target.
        let from_path =
            path_guard::resolve_entry_for_mutation(&root, from_relative).map_err(CommandError::from_text)?;
        let from_metadata = fs::symlink_metadata(&from_path)
            .map_err(|error| CommandError::from_text(format!("Unable to resolve path: {error}")))?;
        let to_path =
            path_guard::resolve_relative_path_for_write(&root, to_relative).map_err(CommandError::from_text)?;
        if let Some(parent) = to_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                CommandError::from_io("project_path.move", &error, "Unable to create file directory")
            })?;
        }
        move_entry(&from_path, &to_path, from_metadata.file_type().is_symlink(), |from, to| {
            fs::rename(from, to)
        })
        .map_err(|error| CommandError::from_io("project_path.move", &error, "Unable to move project path"))
    })
}

/// Move one entry. A link is renamed as a link; it never takes the
/// cross-device copy fallback, which would copy what it points to and so
/// turn the link into a copy of its target (or copy a whole outside tree).
fn move_entry<R>(from: &Path, to: &Path, is_link: bool, rename: R) -> io::Result<()>
where
    R: FnOnce(&Path, &Path) -> io::Result<()>,
{
    if !is_link {
        return move_with_cross_device_fallback(from, to, rename);
    }
    rename(from, to).map_err(|error| {
        if error.kind() == io::ErrorKind::CrossesDevices {
            io::Error::new(error.kind(), "a link cannot be moved to another drive")
        } else {
            error
        }
    })
}

/// Move via `fs::rename`, falling back to copy-then-delete when the OS
/// reports a cross-device move (PRD-FSM-001 §3.5, the fallback ADR-010
/// deferred). `io::ErrorKind::CrossesDevices` covers Unix `EXDEV` AND
/// Windows `ERROR_NOT_SAME_DEVICE`: the PRD scoped this to Unix on the
/// claim that Windows moves across volumes transparently, but that is
/// `MoveFileEx` with `MOVEFILE_COPY_ALLOWED` — `std::fs::rename` does not
/// pass that flag, so a C:→D: move fails identically. The fallback is
/// therefore not platform-gated. Generic over the rename so tests can
/// inject the cross-device error (not reproducible on a single-filesystem
/// test machine).
fn move_with_cross_device_fallback<R>(from: &Path, to: &Path, rename: R) -> io::Result<()>
where
    R: FnOnce(&Path, &Path) -> io::Result<()>,
{
    match rename(from, to) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::CrossesDevices => copy_then_delete(from, to),
        Err(error) => Err(error),
    }
}

fn copy_then_delete(from: &Path, to: &Path) -> io::Result<()> {
    copy_then_delete_with(from, to, |path, is_dir| {
        if is_dir {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        }
    })
}

/// Copy-then-delete core with an injectable source deleter (tests exercise
/// the rollback branch by making the delete fail).
///
/// Failure contract: on ANY error the destination copy is best-effort
/// removed, so disk state matches the reported failure — the source is
/// intact and every piece still points at it. This deliberately deviates
/// from PRD §3.5's "report partial success, file exists in both
/// locations": `CommandResult<()>` has no partial-success channel, and a
/// rolled-back failure keeps app state consistent instead of leaving a
/// stray duplicate. An existing destination is refused up front — the
/// rollback deletes the destination, so it must be ours.
///
/// Symlink simplification: sources are copied through `fs::copy` semantics
/// (link targets' content, not the links) — acceptable for project trees;
/// a symlink-to-directory source fails the copy and rolls back.
fn copy_then_delete_with<D>(from: &Path, to: &Path, delete_source: D) -> io::Result<()>
where
    D: FnOnce(&Path, bool) -> io::Result<()>,
{
    // `symlink_metadata`, not `exists()`: a dangling link at the destination
    // counts as existing, so the copy can never write THROUGH it.
    if fs::symlink_metadata(to).is_ok() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!("cross-device move destination already exists: {}", to.display()),
        ));
    }
    let is_dir = fs::metadata(from)?.is_dir();
    let remove_dest = |dir: bool| {
        let _ = if dir { fs::remove_dir_all(to) } else { fs::remove_file(to) };
    };

    let copy_result = if is_dir {
        copy_dir_recursive(from, to)
    } else {
        copy_file_verified(from, to)
    };
    if let Err(error) = copy_result {
        remove_dest(is_dir);
        return Err(error);
    }
    if let Err(error) = delete_source(from, is_dir) {
        remove_dest(is_dir);
        return Err(error);
    }
    Ok(())
}

/// Byte-length-verified copy — PRD §3.5's cheap integrity check.
fn copy_file_verified(from: &Path, to: &Path) -> io::Result<()> {
    let expected = fs::metadata(from)?.len();
    let copied = fs::copy(from, to)?;
    if copied != expected {
        return Err(io::Error::other(format!(
            "cross-device copy wrote {copied} of {expected} bytes for {}",
            from.display()
        )));
    }
    Ok(())
}

fn copy_dir_recursive(from: &Path, to: &Path) -> io::Result<()> {
    fs::create_dir_all(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let dest = to.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &dest)?;
        } else {
            copy_file_verified(&entry.path(), &dest)?;
        }
    }
    Ok(())
}

pub(crate) fn create_project_directory(root_path: &str, relative_path: &str) -> CommandResult<()> {
    write_ops::with_write_lock(|| {
        let root = path_guard::resolve_project_root(root_path).map_err(CommandError::from_text)?;
        let target = path_guard::resolve_relative_path_for_write(&root, relative_path)
            .map_err(CommandError::from_text)?;
        fs::create_dir_all(&target).map_err(|error| {
            CommandError::from_io("project_dir.create", &error, "Unable to create project directory")
        })
    })
}

pub(crate) fn delete_project_path(root_path: &str, relative_path: &str) -> CommandResult<()> {
    write_ops::with_write_lock(|| {
        let root = path_guard::resolve_project_root(root_path).map_err(CommandError::from_text)?;
        // The selected entry itself, inspected WITHOUT following it: a link
        // (dangling or not) is deleted as a link; its target is untouched.
        let target =
            path_guard::resolve_entry_for_mutation(&root, relative_path).map_err(CommandError::from_text)?;
        let metadata = match fs::symlink_metadata(&target) {
            Ok(metadata) => metadata,
            // Already gone: deleting a missing path stays idempotent.
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            Err(error) => {
                return Err(CommandError::from_io(
                    "project_path.delete",
                    &error,
                    "Unable to inspect project path",
                ))
            }
        };
        if metadata.file_type().is_symlink() {
            remove_link(&target, &metadata)
                .map_err(|error| CommandError::from_io("project_path.delete", &error, "Unable to delete link"))
        } else if metadata.is_dir() {
            // std's remove_dir_all does not follow links inside the tree.
            fs::remove_dir_all(&target).map_err(|error| {
                CommandError::from_io("project_path.delete", &error, "Unable to delete project directory")
            })
        } else {
            fs::remove_file(&target)
                .map_err(|error| CommandError::from_io("project_path.delete", &error, "Unable to delete project file"))
        }
    })
}

/// Remove a link itself. On Windows a directory link or junction is removed
/// with `remove_dir` (which never touches the target); elsewhere a link is a
/// file entry whatever it points to.
#[cfg(windows)]
fn remove_link(link: &Path, metadata: &fs::Metadata) -> io::Result<()> {
    use std::os::windows::fs::FileTypeExt;
    if metadata.file_type().is_symlink_dir() {
        fs::remove_dir(link)
    } else {
        fs::remove_file(link)
    }
}

#[cfg(not(windows))]
fn remove_link(link: &Path, _metadata: &fs::Metadata) -> io::Result<()> {
    fs::remove_file(link)
}

pub(crate) fn remove_empty_directory(root_path: &str, relative_path: &str) -> CommandResult<()> {
    write_ops::with_write_lock(|| {
        let root = path_guard::resolve_project_root(root_path).map_err(CommandError::from_text)?;
        // The selected entry itself: a link to an empty directory is not an
        // empty directory, and its target must never be the one removed.
        let target =
            path_guard::resolve_entry_for_mutation(&root, relative_path).map_err(CommandError::from_text)?;
        let is_real_directory = fs::symlink_metadata(&target)
            .map_err(|error| CommandError::from_text(format!("Unable to resolve path: {error}")))?
            .is_dir();
        if !is_real_directory {
            return Err(CommandError::invalid_path(
                "project_dir.not_directory",
                "Path is not a directory.",
            ));
        }
        fs::remove_dir(&target).map_err(|error| {
            CommandError::from_io(
                "project_dir.remove_empty",
                &error,
                "Unable to remove directory (it may not be empty)",
            )
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must be monotonic")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("litria-{prefix}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).expect("must create temp dir");
        dir
    }

    fn cross_device_error() -> io::Error {
        io::Error::new(io::ErrorKind::CrossesDevices, "simulated cross-device move")
    }

    #[test]
    fn move_prefers_rename_when_it_succeeds() {
        let dir = temp_dir("move-rename");
        let from = dir.join("a.txt");
        let to = dir.join("b.txt");
        fs::write(&from, "alpha").expect("must seed source");

        move_with_cross_device_fallback(&from, &to, |a, b| fs::rename(a, b))
            .expect("rename path should succeed");

        assert!(!from.exists(), "source renamed away");
        assert_eq!(fs::read_to_string(&to).expect("must read dest"), "alpha");
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn cross_device_file_move_falls_back_to_copy_delete() {
        let dir = temp_dir("move-exdev-file");
        let from = dir.join("a.txt");
        let to = dir.join("moved").join("a.txt");
        fs::create_dir_all(to.parent().expect("dest parent")).expect("must create dest parent");
        fs::write(&from, "payload").expect("must seed source");

        move_with_cross_device_fallback(&from, &to, |_, _| Err(cross_device_error()))
            .expect("fallback should succeed");

        assert!(!from.exists(), "source deleted after verified copy");
        assert_eq!(fs::read_to_string(&to).expect("must read dest"), "payload");
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn cross_device_dir_move_copies_recursively() {
        let dir = temp_dir("move-exdev-dir");
        let from = dir.join("src_tree");
        fs::create_dir_all(from.join("nested")).expect("must create tree");
        fs::write(from.join("top.txt"), "top").expect("must seed");
        fs::write(from.join("nested").join("deep.txt"), "deep").expect("must seed");
        let to = dir.join("dest_tree");

        move_with_cross_device_fallback(&from, &to, |_, _| Err(cross_device_error()))
            .expect("fallback should succeed");

        assert!(!from.exists(), "source tree deleted");
        assert_eq!(fs::read_to_string(to.join("top.txt")).expect("read"), "top");
        assert_eq!(
            fs::read_to_string(to.join("nested").join("deep.txt")).expect("read"),
            "deep"
        );
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn non_cross_device_errors_propagate_without_copying() {
        let dir = temp_dir("move-other-err");
        let from = dir.join("a.txt");
        let to = dir.join("b.txt");
        fs::write(&from, "alpha").expect("must seed source");

        let error = move_with_cross_device_fallback(&from, &to, |_, _| {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "file locked"))
        })
        .expect_err("must propagate");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(from.exists(), "source untouched");
        assert!(!to.exists(), "no fallback copy attempted");
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn fallback_refuses_existing_destination() {
        let dir = temp_dir("move-exdev-exists");
        let from = dir.join("a.txt");
        let to = dir.join("b.txt");
        fs::write(&from, "alpha").expect("must seed source");
        fs::write(&to, "occupied").expect("must seed dest");

        let error = move_with_cross_device_fallback(&from, &to, |_, _| Err(cross_device_error()))
            .expect_err("must refuse existing destination");

        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert!(from.exists(), "source untouched");
        assert_eq!(
            fs::read_to_string(&to).expect("must read dest"),
            "occupied",
            "destination untouched"
        );
        fs::remove_dir_all(&dir).expect("cleanup");
    }

    #[test]
    fn failed_source_delete_rolls_back_the_copy() {
        let dir = temp_dir("move-exdev-rollback");
        let from = dir.join("a.txt");
        let to = dir.join("b.txt");
        fs::write(&from, "alpha").expect("must seed source");

        let error = copy_then_delete_with(&from, &to, |_, _| {
            Err(io::Error::new(io::ErrorKind::PermissionDenied, "source locked"))
        })
        .expect_err("must surface the delete failure");

        assert_eq!(error.kind(), io::ErrorKind::PermissionDenied);
        assert!(from.exists(), "source intact");
        assert!(!to.exists(), "copied destination rolled back");
        fs::remove_dir_all(&dir).expect("cleanup");
    }
}

/// Link entries: delete, move and remove act on the link the user selected,
/// never on what it points to (2026-09-30; reproduced on Windows junctions
/// and Linux symlinks before the fix — see Agents/docs/adversarial-check-policy.md).
#[cfg(test)]
mod link_entry_tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(prefix: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("litria-links-{prefix}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn root_str(root: &Path) -> &str {
        root.to_str().unwrap()
    }

    /// A directory link: a junction on Windows (no privilege needed), a
    /// symlink elsewhere.
    fn dir_link(link: &Path, target: &Path) {
        #[cfg(windows)]
        {
            let status = std::process::Command::new("cmd")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .stdout(std::process::Stdio::null())
                .status()
                .unwrap();
            assert!(status.success(), "mklink /J");
        }
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    fn entry_exists(path: &Path) -> bool {
        fs::symlink_metadata(path).is_ok()
    }

    fn is_link(path: &Path) -> bool {
        fs::symlink_metadata(path).is_ok_and(|metadata| metadata.file_type().is_symlink())
    }

    /// Remove a test tree without following any link inside it (the junction
    /// hazard): unlink links first, then the rest.
    fn cleanup(root: &Path, links: &[&str]) {
        for link in links {
            let path = root.join(link);
            if is_link(&path) {
                let _ = fs::remove_dir(&path).or_else(|_| fs::remove_file(&path));
            }
        }
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn deleting_a_directory_link_removes_only_the_link() {
        let root = temp_root("delete-dir-link");
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("real/keep.txt"), "keep").unwrap();
        dir_link(&root.join("alias"), &root.join("real"));

        delete_project_path(root_str(&root), "alias").unwrap();

        assert!(!entry_exists(&root.join("alias")), "the link itself is gone");
        assert_eq!(fs::read_to_string(root.join("real/keep.txt")).unwrap(), "keep", "the target is untouched");
        cleanup(&root, &["alias"]);
    }

    /// A link back to the project root passes containment (the root is
    /// "within" itself); deleting it must not delete the project.
    #[test]
    fn deleting_a_link_to_the_project_root_removes_only_the_link() {
        let root = temp_root("delete-root-link");
        fs::write(root.join("sentinel.txt"), "project").unwrap();
        dir_link(&root.join("up"), &root);

        delete_project_path(root_str(&root), "up").unwrap();

        assert!(!entry_exists(&root.join("up")), "the link itself is gone");
        assert_eq!(fs::read_to_string(root.join("sentinel.txt")).unwrap(), "project", "the project survives");
        cleanup(&root, &["up"]);
    }

    #[test]
    fn deleting_a_dangling_link_removes_it() {
        let root = temp_root("delete-dangling");
        fs::create_dir_all(root.join("gone")).unwrap();
        dir_link(&root.join("alias"), &root.join("gone"));
        fs::remove_dir(root.join("gone")).unwrap();
        assert!(entry_exists(&root.join("alias")), "the dangling link exists before the delete");

        delete_project_path(root_str(&root), "alias").unwrap();

        assert!(!entry_exists(&root.join("alias")), "a dangling link is actually removed, not reported gone");
        cleanup(&root, &["alias"]);
    }

    #[test]
    fn moving_a_directory_link_moves_the_link() {
        let root = temp_root("move-dir-link");
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("real/keep.txt"), "keep").unwrap();
        dir_link(&root.join("alias"), &root.join("real"));

        move_project_path(root_str(&root), "alias", "renamed").unwrap();

        assert!(is_link(&root.join("renamed")), "the destination is the link");
        assert!(!entry_exists(&root.join("alias")), "the old link name is gone");
        assert_eq!(fs::read_to_string(root.join("real/keep.txt")).unwrap(), "keep", "the target never moved");
        cleanup(&root, &["renamed", "alias"]);
    }

    #[test]
    fn removing_an_empty_directory_through_a_link_leaves_the_target() {
        let root = temp_root("remove-empty-link");
        fs::create_dir_all(root.join("empty")).unwrap();
        dir_link(&root.join("alias"), &root.join("empty"));

        let result = remove_empty_directory(root_str(&root), "alias");

        assert!(result.is_err(), "a link is not an empty directory");
        assert!(root.join("empty").is_dir(), "the link's target survives");
        cleanup(&root, &["alias"]);
    }

    #[test]
    fn a_link_leaving_the_project_is_still_refused() {
        let root = temp_root("outside-link");
        let outside = temp_root("outside-target");
        fs::write(outside.join("precious.txt"), "outside").unwrap();
        dir_link(&root.join("out"), &outside);

        assert!(delete_project_path(root_str(&root), "out/precious.txt").is_err());
        assert!(move_project_path(root_str(&root), "out/precious.txt", "taken.txt").is_err());
        assert_eq!(fs::read_to_string(outside.join("precious.txt")).unwrap(), "outside");
        cleanup(&root, &["out"]);
        let _ = fs::remove_dir_all(&outside);
    }

    /// A link facing a cross-device rename is refused, not copied: the copy
    /// fallback would duplicate what it points to.
    #[test]
    fn a_link_never_takes_the_cross_device_copy_path() {
        let root = temp_root("exdev-link");
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("real/keep.txt"), "keep").unwrap();
        dir_link(&root.join("alias"), &root.join("real"));

        let result = move_entry(&root.join("alias"), &root.join("moved"), true, |_, _| {
            Err(io::Error::new(io::ErrorKind::CrossesDevices, "simulated cross-device move"))
        });

        assert!(result.is_err(), "a link is not copied across devices");
        assert!(is_link(&root.join("alias")), "the link stays where it was");
        assert!(!entry_exists(&root.join("moved")), "nothing was copied to the destination");
        assert_eq!(fs::read_to_string(root.join("real/keep.txt")).unwrap(), "keep");
        cleanup(&root, &["alias"]);
    }

    #[test]
    fn ordinary_entries_still_delete_and_move() {
        let root = temp_root("ordinary");
        fs::create_dir_all(root.join("dir/nested")).unwrap();
        fs::write(root.join("dir/nested/a.txt"), "a").unwrap();
        fs::write(root.join("file.txt"), "f").unwrap();

        move_project_path(root_str(&root), "file.txt", "dir/file.txt").unwrap();
        assert_eq!(fs::read_to_string(root.join("dir/file.txt")).unwrap(), "f");
        delete_project_path(root_str(&root), "dir").unwrap();
        assert!(!entry_exists(&root.join("dir")), "a real directory is deleted recursively");
        delete_project_path(root_str(&root), "never-existed").expect("deleting a missing path stays idempotent");
        cleanup(&root, &[]);
    }

    #[cfg(unix)]
    #[test]
    fn deleting_and_moving_a_file_symlink_act_on_the_link() {
        let root = temp_root("file-link");
        fs::write(root.join("real.txt"), "keep").unwrap();
        std::os::unix::fs::symlink(root.join("real.txt"), root.join("alias.txt")).unwrap();

        move_project_path(root_str(&root), "alias.txt", "moved.txt").unwrap();
        assert!(is_link(&root.join("moved.txt")), "the moved entry is still the link");
        delete_project_path(root_str(&root), "moved.txt").unwrap();

        assert!(!entry_exists(&root.join("moved.txt")), "the link is gone");
        assert_eq!(fs::read_to_string(root.join("real.txt")).unwrap(), "keep", "the target is untouched");
        cleanup(&root, &[]);
    }

    /// The cross-device fallback must not write THROUGH a dangling link at
    /// the destination (possibly to a file outside the project).
    #[cfg(unix)]
    #[test]
    fn a_cross_device_copy_refuses_a_dangling_link_at_the_destination() {
        let root = temp_root("exdev-dest-link");
        let outside = temp_root("exdev-outside");
        fs::write(root.join("a.txt"), "payload").unwrap();
        std::os::unix::fs::symlink(outside.join("planted.txt"), root.join("b.txt")).unwrap();

        let result = copy_then_delete(&root.join("a.txt"), &root.join("b.txt"));

        assert!(result.is_err(), "an existing entry (even a dangling link) is refused");
        assert!(!outside.join("planted.txt").exists(), "nothing was written through the link");
        assert_eq!(fs::read_to_string(root.join("a.txt")).unwrap(), "payload", "the source is intact");
        cleanup(&root, &[]);
        let _ = fs::remove_dir_all(&outside);
    }
}

