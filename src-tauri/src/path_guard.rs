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
}
