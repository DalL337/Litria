//! Create-if-absent (Project API build plan W3a): the Project API proposal
//! R2 proofs for the no-clobber primitive. Each race is performed inside its
//! exact window, through `before_commit` or an injected commit
//! (adversarial-check Rule 3 step 3).

use super::*;

fn temp_dir(prefix: &str) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("litria-create-{prefix}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Every name in `dir`, sorted: what a create left behind, temps included.
fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

fn unchecked() -> impl FnMut() -> Result<(), String> {
    || Ok(())
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

/// Remove a link without following it.
fn unlink(link: &Path) {
    let _ = fs::remove_dir(link).or_else(|_| fs::remove_file(link));
}

#[test]
fn creates_the_file_whole_and_leaves_nothing_else() {
    let dir = temp_dir("new");
    let target = dir.join("a.ts");
    create_new_string(&target, "export const a = 1;\n", &mut unchecked()).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "export const a = 1;\n");
    assert_eq!(names(&dir), ["a.ts"], "no temp is left behind");
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn an_existing_file_is_never_replaced() {
    let dir = temp_dir("existing");
    let target = dir.join("litria.toml");
    fs::write(&target, "MINE").unwrap();
    assert_eq!(create_new_string(&target, "", &mut unchecked()), Err(CreateError::Exists));
    assert_eq!(fs::read_to_string(&target).unwrap(), "MINE");
    assert_eq!(names(&dir), ["litria.toml"]);
    fs::remove_dir_all(dir).unwrap();
}

#[test]
fn a_directory_with_the_name_is_exists() {
    let dir = temp_dir("dir-name");
    fs::create_dir(dir.join("a.ts")).unwrap();
    assert_eq!(create_new_string(&dir.join("a.ts"), "x", &mut unchecked()), Err(CreateError::Exists));
    assert!(dir.join("a.ts").is_dir());
    assert_eq!(names(&dir), ["a.ts"]);
    fs::remove_dir_all(dir).unwrap();
}

/// R2: the target appears between preparation and creation. The real
/// commit refuses, and the other writer's file is untouched.
#[test]
fn a_file_appearing_just_before_the_commit_is_never_replaced() {
    let dir = temp_dir("race-file");
    let target = dir.join("a.ts");
    let mut theirs = || fs::write(&target, "THEIRS").map_err(|error| error.to_string());
    assert_eq!(create_new_string(&target, "MINE", &mut theirs), Err(CreateError::Exists));
    assert_eq!(fs::read_to_string(&target).unwrap(), "THEIRS");
    assert_eq!(names(&dir), ["a.ts"], "the temp is removed");
    fs::remove_dir_all(dir).unwrap();
}

/// R2: link identity. A link taking the name just before the commit is the
/// name's owner: it is neither replaced nor followed.
#[test]
fn a_link_appearing_just_before_the_commit_is_never_followed() {
    let dir = temp_dir("race-link");
    let outside = temp_dir("race-link-outside");
    let target = dir.join("a.ts");
    let mut link = || {
        dir_link(&target, &outside);
        Ok(())
    };
    assert_eq!(create_new_string(&target, "MINE", &mut link), Err(CreateError::Exists));
    assert!(names(&outside).is_empty(), "nothing was written through the link");
    assert!(fs::symlink_metadata(&target).unwrap().file_type().is_symlink(), "the link is untouched");
    unlink(&target);
    fs::remove_dir_all(dir).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

/// A dangling link has the name too: the create never writes its target.
#[test]
fn a_dangling_link_with_the_name_is_exists() {
    let dir = temp_dir("dangling");
    let missing = dir.join("missing");
    let target = dir.join("a.ts");
    dir_link(&target, &missing);
    assert_eq!(create_new_string(&target, "MINE", &mut unchecked()), Err(CreateError::Exists));
    assert!(!missing.exists(), "the link's target was not created");
    unlink(&target);
    fs::remove_dir_all(dir).unwrap();
}

/// R2: the process ends around the commit. Before it, the disk holds the
/// whole content beside the target and no target, so a crash there leaves no
/// file (and a hidden temp), never a partial one.
#[test]
fn a_crash_before_the_commit_leaves_no_target() {
    let dir = temp_dir("crash");
    let target = dir.join("a.ts");
    let mut crash = || {
        assert!(fs::symlink_metadata(&target).is_err(), "no target before the commit");
        let temps: Vec<String> = names(&dir).into_iter().filter(|name| name.starts_with(".a.ts.cmtmp-")).collect();
        assert_eq!(temps.len(), 1);
        assert_eq!(fs::read_to_string(dir.join(&temps[0])).unwrap(), "WHOLE", "the content is whole beside it");
        Err("simulated end of process".to_string())
    };
    assert!(matches!(create_new_string(&target, "WHOLE", &mut crash), Err(CreateError::Failed(_))));
    assert!(names(&dir).is_empty(), "a refused create leaves nothing");
    fs::remove_dir_all(dir).unwrap();
}

/// R2: the commit fails. Nothing is created and the temp is removed (the
/// caller holds the content).
#[test]
fn a_failed_commit_leaves_nothing() {
    let dir = temp_dir("commit-fails");
    let target = dir.join("a.ts");
    let result = create_new_string_inner(&target, "MINE", &mut unchecked(), &mut |_, _| {
        Err(CommitError::Failed(io::Error::other("injected commit failure")))
    });
    match result {
        Err(CreateError::Failed(message)) => assert!(message.contains("injected commit failure")),
        other => panic!("expected a failure, got {other:?}"),
    }
    assert!(names(&dir).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

/// R2: access fails before anything is written (the directory is missing).
#[test]
fn a_failed_temp_write_leaves_nothing() {
    let dir = temp_dir("no-parent");
    let target = dir.join("missing").join("a.ts");
    assert!(matches!(create_new_string(&target, "MINE", &mut unchecked()), Err(CreateError::Failed(_))));
    assert!(names(&dir).is_empty());
    fs::remove_dir_all(dir).unwrap();
}

/// Without hard links, the in-place fallback creates the file whole.
#[test]
fn the_fallback_creates_the_file_whole() {
    let dir = temp_dir("fallback");
    let target = dir.join("a.ts");
    create_new_string_inner(&target, "WHOLE", &mut unchecked(), &mut |_, _| {
        Err(CommitError::Unsupported(io::Error::from(io::ErrorKind::Unsupported)))
    })
    .unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "WHOLE");
    assert_eq!(names(&dir), ["a.ts"], "the temp is removed");
    fs::remove_dir_all(dir).unwrap();
}

/// The fallback never clobbers either: a name taken by then is `Exists`.
#[test]
fn the_fallback_never_replaces_a_file_that_appeared() {
    let dir = temp_dir("fallback-race");
    let target = dir.join("a.ts");
    let result = create_new_string_inner(&target, "MINE", &mut unchecked(), &mut |_, to| {
        fs::write(to, "THEIRS").unwrap();
        Err(CommitError::Unsupported(io::Error::from(io::ErrorKind::Unsupported)))
    });
    assert_eq!(result, Err(CreateError::Exists));
    assert_eq!(fs::read_to_string(&target).unwrap(), "THEIRS");
    assert_eq!(names(&dir), ["a.ts"]);
    fs::remove_dir_all(dir).unwrap();
}

/// The platform commit itself: it refuses a taken name and leaves both files
/// as they were; on a free name it moves the temp into place.
#[test]
fn the_platform_commit_never_replaces() {
    let dir = temp_dir("commit");
    let temp = dir.join(".a.ts.cmtmp-test");
    let target = dir.join("a.ts");
    fs::write(&temp, "MINE").unwrap();
    fs::write(&target, "THEIRS").unwrap();
    assert!(matches!(commit_no_clobber(&temp, &target), Err(CommitError::Exists)));
    assert_eq!(fs::read_to_string(&target).unwrap(), "THEIRS");
    assert_eq!(fs::read_to_string(&temp).unwrap(), "MINE");

    fs::remove_file(&target).unwrap();
    commit_no_clobber(&temp, &target).unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "MINE");
    assert_eq!(names(&dir), ["a.ts"], "the temp's name is gone");
    fs::remove_dir_all(dir).unwrap();
}

/// On case-insensitive filesystems (Windows; macOS by default) a name that
/// differs only in case is taken.
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn a_name_differing_only_in_case_is_taken() {
    let dir = temp_dir("case");
    fs::write(dir.join("README.md"), "MINE").unwrap();
    assert_eq!(create_new_string(&dir.join("Readme.md"), "", &mut unchecked()), Err(CreateError::Exists));
    assert_eq!(names(&dir), ["README.md"]);
    assert_eq!(fs::read_to_string(dir.join("README.md")).unwrap(), "MINE");
    fs::remove_dir_all(dir).unwrap();
}
