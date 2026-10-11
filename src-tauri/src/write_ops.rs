use std::fs::{self, OpenOptions};
use std::io;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(unix)]
use std::fs::File;

static WRITE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn parent_dir(path: &Path) -> Result<&Path, String> {
    path.parent()
        .ok_or_else(|| "Unable to determine target directory.".to_string())
}

fn next_temp_suffix() -> String {
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    format!("{}-{}-{counter}", std::process::id(), nanos)
}

fn temp_path_for(target: &Path) -> Result<PathBuf, String> {
    let parent = parent_dir(target)?;
    let file_name = target
        .file_name()
        .ok_or_else(|| "Unable to determine target file name.".to_string())?
        .to_string_lossy()
        .to_string();
    Ok(parent.join(format!(".{file_name}.cmtmp-{}", next_temp_suffix())))
}

#[cfg(unix)]
fn sync_parent_dir(path: &Path) -> Result<(), String> {
    let parent = parent_dir(path)?;
    let dir_handle =
        File::open(parent).map_err(|error| format!("Unable to open parent directory: {error}"))?;
    dir_handle
        .sync_all()
        .map_err(|error| format!("Unable to fsync parent directory: {error}"))
}

#[cfg(not(unix))]
fn sync_parent_dir(_: &Path) -> Result<(), String> {
    Ok(())
}

fn replace_file(temp_path: &Path, target: &Path) -> Result<(), String> {
    replace_file_with(temp_path, target, &mut |from, to| fs::rename(from, to))
}

/// Generic over the rename so tests can inject a failing replacement (the
/// same seam `project_ops::move_with_cross_device_fallback` uses); a real
/// rename failure against an existing target is not reproducible on demand.
fn replace_file_with(
    temp_path: &Path,
    target: &Path,
    rename: &mut dyn FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<(), String> {
    if target.is_dir() {
        return Err("Target path is a directory.".into());
    }

    // ADR-032 decision 4 — no delete-then-rename fallback. `fs::rename` already
    // replaces an existing target on every supported platform (POSIX
    // `rename(2)` atomically; Windows `MoveFileEx` with
    // MOVEFILE_REPLACE_EXISTING), so the fallback only ran once the rename had
    // genuinely failed — and it opened a window with NEITHER version on disk.
    // A failed rename leaves `temp_path` intact for the caller to preserve.
    rename(temp_path, target).map_err(|error| format!("Unable to replace target file: {error}"))
}

fn write_backup_copy(target: &Path, backup_path: &Path) -> Result<(), String> {
    if !target.exists() {
        return Ok(());
    }

    let backup_parent = parent_dir(backup_path)?;
    fs::create_dir_all(backup_parent)
        .map_err(|error| format!("Unable to create backup directory: {error}"))?;

    let backup_temp = temp_path_for(backup_path)?;
    let backup_result = (|| -> Result<(), String> {
        fs::copy(target, &backup_temp)
            .map_err(|error| format!("Unable to write backup temp file: {error}"))?;
        let backup_file = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&backup_temp)
            .map_err(|error| format!("Unable to open backup temp file: {error}"))?;
        backup_file
            .sync_all()
            .map_err(|error| format!("Unable to fsync backup temp file: {error}"))?;
        replace_file(&backup_temp, backup_path)?;
        sync_parent_dir(backup_path)?;
        Ok(())
    })();

    if backup_result.is_err() && backup_temp.exists() {
        let _ = fs::remove_file(&backup_temp);
    }
    backup_result
}

pub(crate) fn with_write_lock<T, E, F>(operation: F) -> Result<T, E>
where
    F: FnOnce() -> Result<T, E>,
    E: From<String>,
{
    let lock = WRITE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock
        .lock()
        .map_err(|_| E::from("Write lock was poisoned by a previous failure.".to_string()))?;
    operation()
}

pub(crate) fn atomic_write_string(path: &Path, content: &str) -> Result<(), String> {
    atomic_write_string_with_backup(path, content, None)
}

pub(crate) fn atomic_write_string_with_backup(
    path: &Path,
    content: &str,
    backup_path: Option<&Path>,
) -> Result<(), String> {
    atomic_write_string_with_options(path, content, backup_path, false)
}

fn atomic_write_string_with_options(
    path: &Path,
    content: &str,
    backup_path: Option<&Path>,
    simulate_interrupt_after_temp_fsync: bool,
) -> Result<(), String> {
    atomic_write_string_inner(
        path,
        content,
        backup_path,
        simulate_interrupt_after_temp_fsync,
        &mut |from, to| fs::rename(from, to),
    )
}

fn atomic_write_string_inner(
    path: &Path,
    content: &str,
    backup_path: Option<&Path>,
    simulate_interrupt_after_temp_fsync: bool,
    rename: &mut dyn FnMut(&Path, &Path) -> io::Result<()>,
) -> Result<(), String> {
    let parent = parent_dir(path)?;
    fs::create_dir_all(parent).map_err(|error| format!("Unable to create target directory: {error}"))?;

    if let Some(backup_target) = backup_path {
        write_backup_copy(path, backup_target)?;
    }

    let temp_path = temp_path_for(path)?;

    // Phase 1 — materialize the replacement beside the target. Nothing the user
    // can see has changed yet, so a failure here removes the temp file.
    let prepared = (|| -> Result<(), String> {
        let mut temp_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| format!("Unable to create temp file: {error}"))?;

        temp_file
            .write_all(content.as_bytes())
            .map_err(|error| format!("Unable to write temp file: {error}"))?;
        temp_file
            .sync_all()
            .map_err(|error| format!("Unable to fsync temp file: {error}"))?;

        if simulate_interrupt_after_temp_fsync {
            return Err("Simulated interrupted write after temp fsync.".into());
        }

        Ok(())
    })();

    if let Err(error) = prepared {
        if temp_path.exists() {
            let _ = fs::remove_file(&temp_path);
        }
        return Err(error);
    }

    // Phase 2 — put it in place. The temp file now holds the ONLY copy of the
    // new content, so a failure preserves it and names it in the error rather
    // than cleaning it up (ADR-032 decision 4). The previous revision is still
    // at `path`: a failed rename changes neither file.
    if let Err(error) = replace_file_with(&temp_path, path, rename) {
        return Err(format!(
            "{error} The replacement content was preserved at {}.",
            temp_path.display()
        ));
    }

    // The target already carries the new content and the temp file is gone; a
    // failed directory fsync is a durability warning, not a lost document.
    sync_parent_dir(path)
}

// ---------------------------------------------------------------------------
// Create-if-absent (Project API build plan W3a; Project API proposal R2)
// ---------------------------------------------------------------------------

/// Why `create_new_string` did not create the file.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum CreateError {
    /// Something already has the name: a file, a directory or a link, which
    /// is never followed. It was not touched.
    Exists,
    /// Anything else. Nothing was created at the target and the temp file is
    /// removed: unlike a save's, the content's only copy is not on disk (the
    /// caller still holds it).
    Failed(String),
}

/// How a no-clobber commit failed.
#[derive(Debug)]
enum CommitError {
    /// The name is taken.
    Exists,
    /// This filesystem cannot commit this way (no hard links: FAT32 or exFAT
    /// on Linux and macOS, some network shares). `create_exclusive_in_place`
    /// takes over.
    Unsupported(io::Error),
    Failed(io::Error),
}

/// Create `path` holding `content` only if nothing has that name, and never
/// replace anything.
///
/// The content is written and fsynced beside the target first, then put in
/// place by one step the filesystem performs atomically and that fails if the
/// name is taken (`commit_no_clobber`). A crash therefore leaves no file or
/// the whole file, and anything that takes the name before the commit, from
/// any process, is left alone and answered `Exists`. Filesystems without hard
/// links on Linux and macOS use `create_exclusive_in_place`, which still
/// never clobbers but can leave a partial new file if the process ends
/// mid-write.
///
/// The parent directory must exist. `before_commit` runs after the content is
/// durable and immediately before the commit: the caller's last check that
/// the parent is still the directory it resolved, and the tests' race window.
pub(crate) fn create_new_string(
    path: &Path,
    content: &str,
    before_commit: &mut dyn FnMut() -> Result<(), String>,
) -> Result<(), CreateError> {
    create_new_string_inner(path, content, before_commit, &mut commit_no_clobber)
}

fn create_new_string_inner(
    path: &Path,
    content: &str,
    before_commit: &mut dyn FnMut() -> Result<(), String>,
    commit: &mut dyn FnMut(&Path, &Path) -> Result<(), CommitError>,
) -> Result<(), CreateError> {
    // An early answer that saves writing the temp; the commit is the authority.
    if fs::symlink_metadata(path).is_ok() {
        return Err(CreateError::Exists);
    }
    let temp_path = temp_path_for(path).map_err(CreateError::Failed)?;
    let discard_temp = |temp: &Path| {
        let _ = fs::remove_file(temp);
    };

    // Phase 1: the content, durable beside the target. Nothing visible has
    // changed yet.
    let prepared = (|| -> Result<(), String> {
        let mut temp_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)
            .map_err(|error| format!("Unable to create temp file: {error}"))?;
        temp_file
            .write_all(content.as_bytes())
            .map_err(|error| format!("Unable to write temp file: {error}"))?;
        temp_file
            .sync_all()
            .map_err(|error| format!("Unable to fsync temp file: {error}"))
    })();
    if let Err(error) = prepared {
        discard_temp(&temp_path);
        return Err(CreateError::Failed(error));
    }
    if let Err(error) = before_commit() {
        discard_temp(&temp_path);
        return Err(CreateError::Failed(error));
    }

    // Phase 2: the commit, which never replaces anything.
    match commit(&temp_path, path) {
        Ok(()) => {}
        Err(CommitError::Exists) => {
            discard_temp(&temp_path);
            return Err(CreateError::Exists);
        }
        Err(CommitError::Unsupported(reason)) => {
            eprintln!("[write_ops] no atomic create here ({reason}); creating {} in place", path.display());
            let created = create_exclusive_in_place(path, content);
            discard_temp(&temp_path);
            created?;
        }
        Err(CommitError::Failed(error)) => {
            discard_temp(&temp_path);
            return Err(CreateError::Failed(format!("Unable to create file: {error}")));
        }
    }

    // The file exists, whole, so the create is reported. A failed directory
    // fsync only leaves the new name's durability across a power loss
    // unconfirmed; reporting a failure here would deny a file that is there.
    if let Err(error) = sync_parent_dir(path) {
        eprintln!("[write_ops] created {}, but {error}", path.display());
    }
    Ok(())
}

/// Move `temp` to `target` only if nothing has the name `target`, in one step
/// the filesystem performs atomically.
///
/// `MoveFileExW` without `MOVEFILE_REPLACE_EXISTING` fails with
/// `ERROR_ALREADY_EXISTS` if anything has the name. Every Windows filesystem
/// supports it (NTFS, ReFS, FAT32, exFAT, SMB), so Windows needs no fallback.
#[cfg(windows)]
fn commit_no_clobber(temp: &Path, target: &Path) -> Result<(), CommitError> {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_WRITE_THROUGH};

    let wide = |path: &Path| -> Vec<u16> { path.as_os_str().encode_wide().chain(std::iter::once(0)).collect() };
    let (from, to) = (wide(temp), wide(target));
    // SAFETY: both buffers are NUL-terminated and outlive the call.
    let moved = unsafe { MoveFileExW(PCWSTR(from.as_ptr()), PCWSTR(to.as_ptr()), MOVEFILE_WRITE_THROUGH) };
    match moved {
        Ok(()) => Ok(()),
        Err(error) => {
            let error = win32_io_error(&error);
            match error.kind() {
                io::ErrorKind::AlreadyExists => Err(CommitError::Exists),
                io::ErrorKind::Unsupported => Err(CommitError::Unsupported(error)),
                _ => Err(CommitError::Failed(error)),
            }
        }
    }
}

/// `windows::core::Error` converts to `io::Error` by its HRESULT, which
/// `io::ErrorKind` cannot classify; recover the Win32 code it wraps.
#[cfg(windows)]
fn win32_io_error(error: &windows::core::Error) -> io::Error {
    let code = error.code().0 as u32;
    if code & 0xFFFF_0000 == 0x8007_0000 {
        io::Error::from_raw_os_error((code & 0xFFFF) as i32)
    } else {
        io::Error::other(error.message())
    }
}

/// `link(2)` never replaces: it fails with `EEXIST` if anything has the name,
/// a dangling link included. The temp's name is dropped afterwards; if the
/// process ends in between, the target is already whole and a hidden stray
/// temp with the same bytes remains.
#[cfg(unix)]
fn commit_no_clobber(temp: &Path, target: &Path) -> Result<(), CommitError> {
    match fs::hard_link(temp, target) {
        Ok(()) => {
            let _ = fs::remove_file(temp);
            Ok(())
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Err(CommitError::Exists),
        Err(error) => Err(CommitError::Unsupported(error)),
    }
}

/// The fallback where hard links are unsupported: claim the name with an
/// exclusive create (it fails if anything has the name, and never follows a
/// link), then write. It never clobbers, but a crash mid-write can leave a
/// partial new file: the residual risk of that filesystem class. A failed
/// write removes the half-written file, which this call created a moment ago.
fn create_exclusive_in_place(target: &Path, content: &str) -> Result<(), CreateError> {
    let mut file = match OpenOptions::new().write(true).create_new(true).open(target) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => return Err(CreateError::Exists),
        Err(error) => return Err(CreateError::Failed(format!("Unable to create file: {error}"))),
    };
    let written = file.write_all(content.as_bytes()).and_then(|()| file.sync_all());
    if let Err(error) = written {
        drop(file);
        let _ = fs::remove_file(target);
        return Err(CreateError::Failed(format!("Unable to write file: {error}")));
    }
    Ok(())
}

#[cfg(test)]
mod create_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_file_path(prefix: &str, file_name: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must be monotonic")
            .as_nanos();
        dir.push(format!("litria-{prefix}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).expect("must create temp directory");
        dir.join(file_name)
    }

    fn remove_temp_artifacts(path: &Path) {
        let Some(parent) = path.parent() else {
            return;
        };
        let file_name = path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default();
        let prefix = format!(".{file_name}.cmtmp-");
        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.flatten() {
                let entry_name = entry.file_name().to_string_lossy().to_string();
                if entry_name.starts_with(&prefix) {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    // ── ADR-032 D2 reproduction ────────────────────────────────────────────
    // A rename that fails against an EXISTING target is the branch the rest of
    // this suite never enters: `atomic_write_string_retry_succeeds_after_
    // simulated_interruption` injects its failure before `replace_file` is
    // reached. These two assert the invariant from ADR-032 decision 4 — no
    // write path may leave zero readable versions of a document.

    /// Every rename fails, as a locked target on Windows behaves.
    fn always_failing_rename() -> impl FnMut(&Path, &Path) -> io::Result<()> {
        |_from, _to| Err(io::Error::other("injected rename failure"))
    }

    #[test]
    fn replace_file_preserves_the_target_when_replacement_fails() {
        let target = temp_file_path("d2-target", "source.js");
        fs::write(&target, "ORIGINAL").expect("must seed target");
        let temp = temp_path_for(&target).expect("must derive temp path");
        fs::write(&temp, "REPLACEMENT").expect("must seed temp");

        let result = replace_file_with(&temp, &target, &mut always_failing_rename());

        assert!(result.is_err(), "replacement must report failure");
        assert!(
            target.exists(),
            "D2: the original file was destroyed by the replacement attempt"
        );
        assert_eq!(
            fs::read_to_string(&target).expect("must read target"),
            "ORIGINAL",
            "the previous revision must survive a failed replacement"
        );

        let parent = target.parent().expect("must have parent");
        fs::remove_dir_all(parent).expect("must remove temp directory");
    }

    #[test]
    fn failed_replacement_leaves_a_readable_version_on_disk() {
        let target = temp_file_path("d2-loss", "source.js");
        fs::write(&target, "ORIGINAL").expect("must seed target");

        let error = atomic_write_string_inner(
            &target,
            "REPLACEMENT",
            None,
            false,
            &mut always_failing_rename(),
        )
        .expect_err("a failing rename must surface as an error");

        let original_survived =
            target.exists() && fs::read_to_string(&target).ok().as_deref() == Some("ORIGINAL");

        let parent = target.parent().expect("must have parent");
        let prefix = ".source.js.cmtmp-";
        let preserved: Vec<_> = fs::read_dir(parent)
            .expect("must read parent")
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
            .collect();
        let replacement_recoverable = preserved
            .iter()
            .any(|entry| fs::read_to_string(entry.path()).ok().as_deref() == Some("REPLACEMENT"));

        assert!(
            original_survived || replacement_recoverable,
            "D2: both the previous revision and the replacement content were              destroyed. error was: {error}"
        );
        assert!(
            original_survived,
            "the previous revision must remain in place when replacement fails"
        );

        fs::remove_dir_all(parent).expect("must remove temp directory");
    }

    #[test]
    fn atomic_write_string_creates_file() {
        let target = temp_file_path("atomic-create", "manifest.json");
        atomic_write_string(&target, "alpha").expect("atomic write should succeed");
        let content = fs::read_to_string(&target).expect("must read target");
        assert_eq!(content, "alpha");
        let parent = target.parent().expect("must have parent");
        fs::remove_dir_all(parent).expect("must remove temp directory");
    }

    #[test]
    fn atomic_write_string_replaces_existing_file() {
        let target = temp_file_path("atomic-replace", "manifest.json");
        fs::write(&target, "old").expect("must seed file");
        atomic_write_string(&target, "new").expect("atomic write should succeed");
        let content = fs::read_to_string(&target).expect("must read target");
        assert_eq!(content, "new");
        let parent = target.parent().expect("must have parent");
        fs::remove_dir_all(parent).expect("must remove temp directory");
    }

    #[test]
    fn atomic_write_string_with_backup_preserves_previous_revision() {
        let target = temp_file_path("atomic-backup", "litria.project.json");
        let backup = temp_file_path("atomic-backup", "litria.project.json.bak");
        let backup_parent = backup.parent().expect("must have backup parent").to_path_buf();
        if backup_parent.exists() {
            fs::remove_dir_all(&backup_parent).expect("must clean backup parent");
        }
        fs::create_dir_all(&backup_parent).expect("must create backup parent");

        fs::write(&target, "{\"version\":1}").expect("must seed manifest");
        atomic_write_string_with_backup(&target, "{\"version\":2}", Some(&backup))
            .expect("atomic write with backup should succeed");

        let current = fs::read_to_string(&target).expect("must read target");
        let previous = fs::read_to_string(&backup).expect("must read backup");
        assert_eq!(current, "{\"version\":2}");
        assert_eq!(previous, "{\"version\":1}");

        let parent = target.parent().expect("must have parent");
        fs::remove_dir_all(parent).expect("must remove temp directory");
        fs::remove_dir_all(backup_parent).expect("must remove backup directory");
    }

    #[test]
    fn atomic_write_string_retry_succeeds_after_simulated_interruption() {
        let target = temp_file_path("atomic-retry", "litria.project.json");
        fs::write(&target, "stable-v1").expect("must seed file");

        let interrupted = atomic_write_string_with_options(&target, "stable-v2", None, true);

        assert!(interrupted.is_err());
        let unchanged = fs::read_to_string(&target).expect("must read unchanged file");
        assert_eq!(unchanged, "stable-v1");

        atomic_write_string(&target, "stable-v2").expect("retry should succeed");
        let recovered = fs::read_to_string(&target).expect("must read recovered file");
        assert_eq!(recovered, "stable-v2");

        remove_temp_artifacts(&target);
        let parent = target.parent().expect("must have parent");
        fs::remove_dir_all(parent).expect("must remove temp directory");
    }
}
