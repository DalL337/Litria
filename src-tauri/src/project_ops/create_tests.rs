//! `create_project_file` (Project API build plan W3a): the path taken
//! exactly, containment, missing directories, and the window in which the
//! file's directory can be swapped for a link.

use super::*;
use crate::errors::ErrorCategory;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(prefix: &str) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("litria-create-file-{prefix}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::canonicalize(dir).unwrap()
}

fn create(root: &Path, path: &str, text: &str) -> CommandResult<CreateFileOutcome> {
    create_project_file(root.to_str().unwrap(), path, text)
}

fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> =
        fs::read_dir(dir).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
    names.sort();
    names
}

/// A directory link: a junction on Windows (no privilege needed), a symlink
/// elsewhere.
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

fn unlink(link: &Path) {
    let _ = fs::remove_dir(link).or_else(|_| fs::remove_file(link));
}

#[test]
fn the_outcome_is_serialized_as_a_word() {
    assert_eq!(serde_json::to_string(&CreateFileOutcome::Created).unwrap(), "\"created\"");
    assert_eq!(serde_json::to_string(&CreateFileOutcome::Exists).unwrap(), "\"exists\"");
}

#[test]
fn creates_missing_directories_and_the_file() {
    let root = temp_root("deep");
    assert_eq!(create(&root, "src/new/deep/a.ts", "A").unwrap(), CreateFileOutcome::Created);
    assert_eq!(fs::read_to_string(root.join("src/new/deep/a.ts")).unwrap(), "A");
    assert_eq!(names(&root.join("src/new/deep")), ["a.ts"]);
    fs::remove_dir_all(root).unwrap();
}

/// The defect W3a found: "New file" named `litria.toml` replaced the project
/// configuration (the drawer's tree hides that file, so its sibling check let
/// the name through). A create never does.
#[test]
fn an_existing_file_is_exists_and_untouched() {
    let root = temp_root("existing");
    fs::write(root.join("litria.toml"), "[project]\nname = \"alice\"\n").unwrap();
    assert_eq!(create(&root, "litria.toml", "").unwrap(), CreateFileOutcome::Exists);
    assert_eq!(fs::read_to_string(root.join("litria.toml")).unwrap(), "[project]\nname = \"alice\"\n");
    fs::remove_dir_all(root).unwrap();
}

/// The file created is the file named: no trimming (adversarial-check
/// Learned Flaw 3).
#[test]
fn the_path_is_taken_exactly() {
    let root = temp_root("exact");
    fs::write(root.join("notes.txt"), "MINE").unwrap();
    assert_eq!(create(&root, " notes.txt", "NEW").unwrap(), CreateFileOutcome::Created);
    assert_eq!(fs::read_to_string(root.join("notes.txt")).unwrap(), "MINE");
    assert_eq!(fs::read_to_string(root.join(" notes.txt")).unwrap(), "NEW");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_paths_are_refused() {
    let root = temp_root("invalid");
    let outside = root.parent().unwrap().join(format!("{}-escape.ts", root.file_name().unwrap().to_string_lossy()));
    let mut paths = vec!["", "../escape.ts", "a/../../escape.ts", "a\\b/c.ts", "/escape.ts", "."];
    if cfg!(windows) {
        paths.extend(["C:/escape.ts", "C:escape.ts", "\\\\?\\C:\\escape.ts"]);
    }
    for path in paths {
        let error = create(&root, path, "X").expect_err(path);
        assert!(matches!(error.category(), ErrorCategory::InvalidPath), "{path:?}: {error:?}");
    }
    assert!(names(&root).is_empty(), "nothing was created");
    assert!(!outside.exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_directory_linked_outside_the_root_is_refused() {
    let root = temp_root("linked-dir");
    let outside = temp_root("linked-dir-outside");
    dir_link(&root.join("lnk"), &outside);
    let error = create(&root, "lnk/a.ts", "X").unwrap_err();
    assert!(matches!(error.category(), ErrorCategory::InvalidPath), "{error:?}");
    let error = create(&root, "lnk/new/a.ts", "X").unwrap_err();
    assert!(matches!(error.category(), ErrorCategory::InvalidPath), "{error:?}");
    assert!(names(&outside).is_empty(), "nothing was written outside the root");
    unlink(&root.join("lnk"));
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

/// R2: link identity changes. The file's directory is swapped for a link to
/// elsewhere after it was resolved, in each window before the commit: the
/// create is refused and nothing stays outside the root.
fn swapped_directory_is_refused(at: CreateWindow) {
    let root = temp_root(&format!("swap-{at:?}"));
    let outside = temp_root(&format!("swap-{at:?}-outside"));
    fs::create_dir(root.join("src")).unwrap();
    let mut swap = |window| {
        if window == at {
            fs::rename(root.join("src"), root.join("src-old")).unwrap();
            dir_link(&root.join("src"), &outside);
        }
        Ok(())
    };
    let error = create_project_file_with(root.to_str().unwrap(), "src/a.ts", "X", &mut swap).unwrap_err();
    assert!(error.message().contains("directory changed"), "{error:?}");
    assert!(names(&outside).is_empty(), "nothing stays outside the root: {:?}", names(&outside));
    assert!(
        !names(&root.join("src-old")).contains(&"a.ts".to_string()),
        "the file was not created in the directory it was resolved in either"
    );
    unlink(&root.join("src"));
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

/// Swapped before the content is written: the temp goes through the link,
/// outside the root, and the last check must refuse the commit (and the
/// refusal removes that temp).
#[test]
fn a_directory_swapped_before_the_write_is_refused() {
    swapped_directory_is_refused(CreateWindow::BeforeWrite);
}

/// Swapped after the content is written, just before the commit.
#[test]
fn a_directory_swapped_before_the_commit_is_refused() {
    swapped_directory_is_refused(CreateWindow::BeforeCommit);
}

/// On Windows `a.ts:evil` names a stream of `a.ts`, not a new file: a create
/// must neither touch `a.ts` nor leave anything behind.
#[cfg(windows)]
#[test]
fn an_alternate_data_stream_name_is_refused() {
    let root = temp_root("ads");
    fs::write(root.join("a.ts"), "MINE").unwrap();
    for path in ["a.ts:evil", "a.ts::$DATA", "src:evil/b.ts"] {
        let error = create(&root, path, "X").expect_err(path);
        assert!(matches!(error.category(), ErrorCategory::InvalidPath), "{path:?}: {error:?}");
    }
    assert_eq!(names(&root), ["a.ts"], "nothing was created beside it");
    assert_eq!(fs::read_to_string(root.join("a.ts")).unwrap(), "MINE");
    let streams = fs::read(root.join("a.ts:evil"));
    assert!(streams.is_err(), "no stream was added to a.ts");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_parent_that_is_a_file_is_refused() {
    let root = temp_root("file-parent");
    fs::write(root.join("a.ts"), "MINE").unwrap();
    assert!(create(&root, "a.ts/b.ts", "X").is_err());
    assert_eq!(fs::read_to_string(root.join("a.ts")).unwrap(), "MINE");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_missing_root_is_refused_and_not_created() {
    let root = temp_root("missing-root");
    let missing = root.join("nope");
    assert!(create_project_file(missing.to_str().unwrap(), "a.ts", "X").is_err());
    assert!(!missing.exists(), "unlike a write, a create never creates the project root");
    fs::remove_dir_all(root).unwrap();
}
