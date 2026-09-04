use std::fs;
use std::path::{Component, Path, PathBuf};

fn is_mixed_separator_path(value: &str) -> bool {
    value.contains('/') && value.contains('\\')
}

pub(crate) fn validate_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let trimmed = relative_path.trim();
    if trimmed.is_empty() {
        return Err("Relative path is required.".into());
    }
    if is_mixed_separator_path(trimmed) {
        return Err("Invalid relative path.".into());
    }

    let rel = Path::new(trimmed);
    for component in rel.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err("Invalid relative path.".into()),
        }
    }
    Ok(rel.to_path_buf())
}

fn ensure_within_root(root: &Path, target: &Path) -> Result<(), String> {
    if target.starts_with(root) {
        Ok(())
    } else {
        Err("Path is not within project root.".into())
    }
}

pub(crate) fn resolve_project_root(root_path: &str) -> Result<PathBuf, String> {
    let trimmed = root_path.trim();
    if trimmed.is_empty() {
        return Err("Project root path is required.".into());
    }
    let root = Path::new(trimmed);
    let canonical_root =
        fs::canonicalize(root).map_err(|error| format!("Invalid project root path: {error}"))?;
    if !canonical_root.is_dir() {
        return Err("Project root path must be a directory.".into());
    }
    Ok(canonical_root)
}

pub(crate) fn ensure_project_root(root_path: &str) -> Result<PathBuf, String> {
    let trimmed = root_path.trim();
    if trimmed.is_empty() {
        return Err("Project root path is required.".into());
    }
    let root = Path::new(trimmed);
    fs::create_dir_all(root).map_err(|error| format!("Unable to create project path: {error}"))?;
    resolve_project_root(trimmed)
}

pub(crate) fn resolve_existing_relative_path(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(relative_path)?;
    let joined = root.join(relative);
    let canonical_target =
        fs::canonicalize(&joined).map_err(|error| format!("Unable to resolve path: {error}"))?;
    ensure_within_root(root, &canonical_target)?;
    Ok(canonical_target)
}

pub(crate) fn resolve_relative_path_for_write(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(relative_path)?;
    let joined = root.join(relative);

    if joined.exists() {
        let canonical_target = fs::canonicalize(&joined)
            .map_err(|error| format!("Unable to resolve path: {error}"))?;
        ensure_within_root(root, &canonical_target)?;
        return Ok(joined);
    }

    let mut ancestor = joined.parent().map(Path::to_path_buf);
    while let Some(candidate) = ancestor {
        if candidate.exists() {
            let canonical_ancestor = fs::canonicalize(&candidate)
                .map_err(|error| format!("Unable to resolve path: {error}"))?;
            ensure_within_root(root, &canonical_ancestor)?;
            return Ok(joined);
        }
        ancestor = candidate.parent().map(Path::to_path_buf);
    }

    Err("Path is not within project root.".into())
}

// ---------------------------------------------------------------------------
// Project destination resolution
//
// The single chokepoint every project-creation path resolves its destination
// through. Added 2026-08-31 after a macOS tester hit
// `Read-only file system (os error 30)` accepting the wizard's default
// location: the frontend was handing Rust the literal string
// `~/Projects/python-projects`, nothing anywhere expanded `~`, and a `.app`
// launched from Finder has cwd `/` — so the relative-looking path resolved
// against the sealed read-only system volume.
//
// The frontend now computes an absolute default, so this layer is the
// belt-and-suspenders half: both the wizard's location field and the
// Open-Existing field are free text, and a hand-typed `~/foo` must work.
// (Journal: .research/2026-08-31-macos-tilde-default-path.md)
// ---------------------------------------------------------------------------

/// Home directory, without pulling in a crate for it.
///
/// Mirrors the private helpers in `build_log.rs` and `crash/mod.rs`; those two
/// predate this one and are left alone rather than re-pointed in a bug-fix pass.
fn home_dir() -> Option<PathBuf> {
    // #[cfg] rather than `if cfg!(windows)` per implementation-policy Rule 2.
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

// `~` is a legal filename character on Unix, so only these exact prefixes mean
// "home". Backslash counts only on Windows, where it is a separator.
#[cfg(windows)]
const HOME_PREFIXES: [&str; 2] = ["~/", "~\\"];
#[cfg(not(windows))]
const HOME_PREFIXES: [&str; 1] = ["~/"];

/// Expand a leading `~` to the home directory. **Prefix only** — a `~` anywhere
/// else in the string is a literal character and is left untouched. No shell is
/// invoked and no substring replacement is performed.
pub(crate) fn expand_home_prefix(location: &str) -> Result<PathBuf, String> {
    let trimmed = location.trim();
    if trimmed.is_empty() {
        return Err("Project location is required.".into());
    }

    let rest: Option<&str> = if trimmed == "~" {
        Some("")
    } else {
        HOME_PREFIXES
            .iter()
            .find_map(|prefix| trimmed.strip_prefix(prefix))
    };

    match rest {
        Some(remainder) => {
            let home = home_dir().ok_or_else(|| {
                "Could not determine your home directory. Enter a full path instead.".to_string()
            })?;
            Ok(if remainder.is_empty() {
                home
            } else {
                home.join(remainder)
            })
        }
        None => Ok(PathBuf::from(trimmed)),
    }
}

/// Resolve the parent location a new project will be created inside.
///
/// Expands a leading `~`, then requires the result be absolute. A relative
/// location is refused rather than resolved against the process cwd — which is
/// `/` for a macOS `.app` launched from Finder, making every relative path a
/// write into the read-only system volume.
pub(crate) fn resolve_project_destination(location: &str) -> Result<PathBuf, String> {
    let expanded = expand_home_prefix(location)?;
    if !expanded.is_absolute() {
        return Err(format!(
            "Project location must be a full path, not a relative one: \"{}\"",
            location.trim()
        ));
    }
    Ok(expanded)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    #[cfg(windows)]
    use std::os::windows::fs::symlink_dir;

    fn temp_dir(prefix: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must be monotonic")
            .as_nanos();
        dir.push(format!("litria-{prefix}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).expect("must create temp directory");
        dir
    }

    #[test]
    fn validate_relative_path_rejects_parent_segments() {
        let result = validate_relative_path("../escape.txt");
        assert!(result.is_err());
    }

    #[test]
    fn validate_relative_path_rejects_mixed_separators() {
        let result = validate_relative_path("src\\nested/file.txt");
        assert!(result.is_err());
    }

    #[test]
    fn resolve_existing_relative_path_allows_files_within_root() {
        let root = temp_dir("existing");
        let nested = root.join("src");
        fs::create_dir_all(&nested).expect("must create nested");
        let file_path = nested.join("file.txt");
        fs::write(&file_path, "hello").expect("must write file");

        let canonical_root = fs::canonicalize(&root).expect("must canonicalize root");
        let resolved = resolve_existing_relative_path(&canonical_root, "src/file.txt")
            .expect("path should resolve");
        assert_eq!(resolved, fs::canonicalize(file_path).expect("must canonicalize file"));

        fs::remove_dir_all(root).expect("must remove temp directory");
    }

    #[test]
    fn resolve_relative_path_for_write_blocks_symlink_escape() {
        let root = temp_dir("symlink-root");
        let outside = temp_dir("symlink-outside");

        let link = root.join("link");
        let link_result = {
            #[cfg(unix)]
            {
                symlink(&outside, &link)
            }
            #[cfg(windows)]
            {
                symlink_dir(&outside, &link)
            }
        };

        if let Err(error) = link_result {
            let is_windows_privilege_error = error.raw_os_error() == Some(1314);
            if error.kind() == std::io::ErrorKind::PermissionDenied || is_windows_privilege_error {
                fs::remove_dir_all(root).expect("must remove temp directory");
                fs::remove_dir_all(outside).expect("must remove temp directory");
                return;
            }
            panic!("failed to create symlink: {error}");
        }

        let canonical_root = fs::canonicalize(&root).expect("must canonicalize root");
        let result = resolve_relative_path_for_write(&canonical_root, "link/escape.txt");
        assert!(result.is_err());

        fs::remove_dir_all(root).expect("must remove temp directory");
        fs::remove_dir_all(outside).expect("must remove temp directory");
    }

    // -----------------------------------------------------------------------
    // Project destination resolution (regression, 2026-08-31)
    //
    // A macOS tester accepted the wizard's default location and got
    // `Read-only file system (os error 30)`: the frontend handed Rust the
    // literal `~/Projects/python-projects`, nothing expanded `~`, and a .app
    // launched from Finder has cwd `/`.
    // Journal: .research/2026-08-31-macos-tilde-default-path.md
    // -----------------------------------------------------------------------

    /// The same source `expand_home_prefix` reads, so the assertions do not
    /// depend on any particular machine's home path.
    fn expected_home() -> Option<PathBuf> {
        #[cfg(windows)]
        {
            std::env::var("USERPROFILE").ok().map(PathBuf::from)
        }
        #[cfg(not(windows))]
        {
            std::env::var("HOME").ok().map(PathBuf::from)
        }
    }

    #[test]
    fn expands_tilde_slash_at_the_start() {
        let Some(home) = expected_home() else { return };
        let resolved = expand_home_prefix("~/Projects/demo").expect("should expand");
        assert_eq!(resolved, home.join("Projects/demo"));
        // The literal `~` must not survive anywhere in the result.
        assert!(!resolved.to_string_lossy().contains('~'));
    }

    #[test]
    fn expands_bare_tilde_to_home() {
        let Some(home) = expected_home() else { return };
        assert_eq!(expand_home_prefix("~").expect("should expand"), home);
    }

    #[test]
    fn leaves_mid_string_tilde_untouched() {
        // `~` is a legal filename character; only the prefix means "home".
        let resolved = expand_home_prefix("/tmp/back~up/demo").expect("should pass through");
        assert_eq!(resolved, PathBuf::from("/tmp/back~up/demo"));
        assert!(resolved.to_string_lossy().contains('~'));
    }

    #[test]
    fn does_not_expand_tilde_followed_by_a_name() {
        // `~alice` is another user's home in shell syntax; we do not implement
        // that, so it must stay a literal rather than silently becoming ours.
        let resolved = expand_home_prefix("/data/~alice").expect("should pass through");
        assert_eq!(resolved, PathBuf::from("/data/~alice"));
    }

    #[test]
    fn empty_location_is_refused() {
        assert!(expand_home_prefix("").is_err());
        assert!(expand_home_prefix("   ").is_err());
    }

    #[test]
    fn resolve_destination_refuses_a_relative_path() {
        // This is the macOS failure in miniature: relative resolves against cwd,
        // which is `/` for a Finder-launched .app.
        let err = resolve_project_destination("Projects/demo").expect_err("must refuse");
        assert!(
            err.contains("full path"),
            "message should name the problem, got: {err}"
        );
    }

    #[test]
    fn resolve_destination_accepts_an_absolute_path() {
        #[cfg(windows)]
        let input = "C:\\Projects\\demo";
        #[cfg(not(windows))]
        let input = "/Users/alice/Projects/demo";
        let resolved = resolve_project_destination(input).expect("absolute is fine");
        assert!(resolved.is_absolute());
    }

    #[test]
    fn resolve_destination_expands_tilde_and_yields_an_absolute_path() {
        let Some(_) = expected_home() else { return };
        let resolved = resolve_project_destination("~/Projects/demo").expect("should resolve");
        assert!(
            resolved.is_absolute(),
            "a tilde path must resolve absolute, got {}",
            resolved.display()
        );
        assert!(!resolved.to_string_lossy().contains('~'));
    }

}
