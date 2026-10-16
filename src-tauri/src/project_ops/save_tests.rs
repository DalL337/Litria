//! `save_project_file` and the stamps (track T slice T3a): a save writes only
//! if the disk still holds the version its text was based on, so another
//! program's newer version is never overwritten.

use super::*;
use crate::project_api::reader::disk_revision;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(prefix: &str) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("litria-save-file-{prefix}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::canonicalize(dir).unwrap()
}

fn root_str(root: &Path) -> &str {
    root.to_str().unwrap()
}

fn based_on(text: &str) -> SaveBase {
    SaveBase::Text { text: text.into() }
}

fn leftovers(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.contains(".cmtmp-"))
        .collect()
}

#[test]
fn a_save_based_on_the_disk_version_writes() {
    let root = temp_root("current");
    fs::write(root.join("src/a.ts"), "ORIGINAL").unwrap();
    let outcome = save_project_file(root_str(&root), "src/a.ts", "MINE", &based_on("ORIGINAL")).unwrap();
    let SaveOutcome::Saved { revision, stamp } = outcome else { panic!("expected a save, got {outcome:?}") };
    assert_eq!(revision, disk_revision(b"MINE"));
    assert_eq!(fs::read_to_string(root.join("src/a.ts")).unwrap(), "MINE");
    // The stamp it answers is the file's stamp now.
    assert_eq!(stamp, stamp_of(&root.join("src/a.ts")));
    assert!(stamp.is_some());
    fs::remove_dir_all(&root).unwrap();
}

/// The reproduction (2026-10-15, on main): another program changed the file
/// after the tab loaded it, and the save replaced that version silently.
#[test]
fn a_save_based_on_an_older_version_writes_nothing() {
    let root = temp_root("older");
    fs::write(root.join("src/a.ts"), "THEIRS").unwrap();
    let outcome = save_project_file(root_str(&root), "src/a.ts", "MINE", &based_on("ORIGINAL")).unwrap();
    assert_eq!(outcome, SaveOutcome::Changed { disk: Some(disk_revision(b"THEIRS")) });
    assert_eq!(fs::read_to_string(root.join("src/a.ts")).unwrap(), "THEIRS");
    assert!(leftovers(&root.join("src")).is_empty());
    fs::remove_dir_all(&root).unwrap();
}

/// Another program writes while the save's content is being made durable:
/// the last check, right before the rename, sees it.
#[test]
fn a_write_while_the_save_is_in_flight_is_not_overwritten() {
    let root = temp_root("in-flight");
    let file = root.join("src/a.ts");
    fs::write(&file, "ORIGINAL").unwrap();
    let outcome = write_ops::with_write_lock(|| {
        save_project_file_with(root_str(&root), "src/a.ts", "MINE", &based_on("ORIGINAL"), &mut || {
            fs::write(&file, "THEIRS, DURING THE SAVE").unwrap();
        })
    })
    .unwrap();
    assert_eq!(outcome, SaveOutcome::Changed { disk: Some(disk_revision(b"THEIRS, DURING THE SAVE")) });
    assert_eq!(fs::read_to_string(&file).unwrap(), "THEIRS, DURING THE SAVE");
    assert!(leftovers(&root.join("src")).is_empty(), "the prepared content is removed");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_deleted_file_is_a_change_and_absent_means_absent() {
    let root = temp_root("deleted");
    let outcome = save_project_file(root_str(&root), "src/gone.ts", "MINE", &based_on("ORIGINAL")).unwrap();
    assert_eq!(outcome, SaveOutcome::Changed { disk: None }, "deleted since it was read");
    assert!(!root.join("src/gone.ts").exists(), "and not recreated");

    // The person chose to keep their version of a deleted file.
    let outcome = save_project_file(root_str(&root), "src/gone.ts", "MINE", &SaveBase::Absent).unwrap();
    assert!(matches!(outcome, SaveOutcome::Saved { .. }), "{outcome:?}");
    assert_eq!(fs::read_to_string(root.join("src/gone.ts")).unwrap(), "MINE");

    // But not over a file that has the name by then.
    let outcome = save_project_file(root_str(&root), "src/gone.ts", "AGAIN", &SaveBase::Absent).unwrap();
    assert_eq!(outcome, SaveOutcome::Changed { disk: Some(disk_revision(b"MINE")) });
    assert_eq!(fs::read_to_string(root.join("src/gone.ts")).unwrap(), "MINE");
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_save_stays_inside_the_project() {
    let root = temp_root("contained");
    for path in ["../outside.ts", "/etc/passwd"] {
        assert!(save_project_file(root_str(&root), path, "x", &SaveBase::Absent).is_err(), "{path}");
    }
    assert!(!root.parent().unwrap().join("outside.ts").exists());
    // A drive path leaves the project on Windows. Elsewhere a backslash is an
    // ordinary character, so it names a file inside the project.
    let drive = "C:\\Windows\\win.ini";
    let saved = save_project_file(root_str(&root), drive, "x", &SaveBase::Absent);
    if cfg!(windows) {
        assert!(saved.is_err(), "{drive}");
    } else {
        assert!(matches!(saved, Ok(SaveOutcome::Saved { .. })), "{saved:?}");
        assert!(root.join(drive).is_file(), "inside the project");
    }
    fs::remove_dir_all(&root).unwrap();
}

/// A read's stamp is the stamp a later check sees, until the file changes.
#[test]
fn stamps_follow_the_file() {
    let root = temp_root("stamps");
    let file = root.join("src/a.ts");
    fs::write(&file, "ONE").unwrap();
    let read = read_project_file_with_revision(root_str(&root), "src/a.ts").unwrap();
    let paths = vec!["src/a.ts".to_string(), "src/missing.ts".to_string(), "../outside.ts".to_string(), "src".to_string()];
    let stamps = project_files_stamps(root_str(&root), &paths).unwrap();
    assert_eq!(stamps[0], PathStamp { path: "src/a.ts".into(), stamp: read.stamp.clone() });
    assert!(read.stamp.is_some());
    assert_eq!(stamps[1].stamp, None, "missing");
    assert_eq!(stamps[2].stamp, None, "outside the project");
    assert_eq!(stamps[3].stamp, None, "not a file");

    // A different size changes the stamp whatever the clock does.
    fs::write(&file, "LONGER TEXT").unwrap();
    let again = project_files_stamps(root_str(&root), &paths[..1]).unwrap();
    assert_ne!(again[0].stamp, read.stamp);
    fs::remove_dir_all(&root).unwrap();
}

#[test]
fn a_check_of_too_many_paths_is_refused() {
    let root = temp_root("many");
    let paths: Vec<String> = (0..=MAX_STAMPED_PATHS).map(|n| format!("src/{n}.ts")).collect();
    assert!(project_files_stamps(root_str(&root), &paths).is_err());
    assert_eq!(project_files_stamps(root_str(&root), &paths[..MAX_STAMPED_PATHS]).unwrap().len(), MAX_STAMPED_PATHS);
    fs::remove_dir_all(&root).unwrap();
}
