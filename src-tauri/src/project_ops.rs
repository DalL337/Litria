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

pub(crate) fn write_project_file(root_path: &str, relative_path: &str, contents: &str) -> CommandResult<()> {
    write_ops::with_write_lock(|| {
        let root = path_guard::ensure_project_root(root_path).map_err(CommandError::from_text)?;
        let target = path_guard::resolve_relative_path_for_write(&root, relative_path)
            .map_err(CommandError::from_text)?;
        write_ops::atomic_write_string(&target, contents)
            .map_err(|error| CommandError::from_text(format!("Unable to write project file: {error}")))
    })
}

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
        let from_path =
            path_guard::resolve_existing_relative_path(&root, from_relative).map_err(CommandError::from_text)?;
        let to_path =
            path_guard::resolve_relative_path_for_write(&root, to_relative).map_err(CommandError::from_text)?;
        if let Some(parent) = to_path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                CommandError::from_io("project_path.move", &error, "Unable to create file directory")
            })?;
        }
        move_with_cross_device_fallback(&from_path, &to_path, |from, to| fs::rename(from, to))
            .map_err(|error| CommandError::from_io("project_path.move", &error, "Unable to move project path"))
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
    if to.exists() {
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
        let relative = path_guard::validate_relative_path(relative_path).map_err(CommandError::from_text)?;
        let target = root.join(relative);
        if !target.exists() {
            return Ok(());
        }
        let target =
            path_guard::resolve_existing_relative_path(&root, relative_path).map_err(CommandError::from_text)?;
        let metadata = fs::symlink_metadata(&target)
            .map_err(|error| CommandError::from_io("project_path.delete", &error, "Unable to inspect project path"))?;
        if metadata.file_type().is_symlink() {
            fs::remove_file(&target)
                .map_err(|error| CommandError::from_io("project_path.delete", &error, "Unable to delete symlink"))
        } else if metadata.is_dir() {
            fs::remove_dir_all(&target).map_err(|error| {
                CommandError::from_io("project_path.delete", &error, "Unable to delete project directory")
            })
        } else {
            fs::remove_file(&target)
                .map_err(|error| CommandError::from_io("project_path.delete", &error, "Unable to delete project file"))
        }
    })
}

pub(crate) fn remove_empty_directory(root_path: &str, relative_path: &str) -> CommandResult<()> {
    write_ops::with_write_lock(|| {
        let root = path_guard::resolve_project_root(root_path).map_err(CommandError::from_text)?;
        let target =
            path_guard::resolve_existing_relative_path(&root, relative_path).map_err(CommandError::from_text)?;
        if !target.is_dir() {
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

