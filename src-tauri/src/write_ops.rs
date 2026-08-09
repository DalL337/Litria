use std::fs::{self, OpenOptions};
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
    if target.is_dir() {
        return Err("Target path is a directory.".into());
    }

    match fs::rename(temp_path, target) {
        Ok(()) => Ok(()),
        Err(first_error) => {
            if target.exists() {
                fs::remove_file(target)
                    .map_err(|error| format!("Unable to replace existing file: {error}"))?;
                fs::rename(temp_path, target)
                    .map_err(|error| format!("Unable to move replacement file: {error}"))?;
                Ok(())
            } else {
                Err(format!("Unable to replace target file: {first_error}"))
            }
        }
    }
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
    let parent = parent_dir(path)?;
    fs::create_dir_all(parent).map_err(|error| format!("Unable to create target directory: {error}"))?;

    if let Some(backup_target) = backup_path {
        write_backup_copy(path, backup_target)?;
    }

    let temp_path = temp_path_for(path)?;
    let write_result = (|| -> Result<(), String> {
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

        replace_file(&temp_path, path)?;
        sync_parent_dir(path)?;
        Ok(())
    })();

    if write_result.is_err() && temp_path.exists() {
        let _ = fs::remove_file(&temp_path);
    }

    write_result
}

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
