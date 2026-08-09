use crate::project_types::ProjectTreeEntry;
use std::fs;
use std::path::{Component, Path, PathBuf};

fn normalize_relative_path(root: &Path, target: &Path) -> Result<String, String> {
    let relative = target
        .strip_prefix(root)
        .map_err(|_| "Path is not within project root.".to_string())?;
    let normalized = relative
        .components()
        .filter_map(|component| match component {
            Component::Normal(part) => Some(part.to_string_lossy()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        return Err("Relative path is required.".into());
    }
    Ok(normalized)
}

/// File and directory names that CM should never expose in the scaffold tree.
/// These are CM-internal files that live on disk but are not user-editable project sources.
const IGNORED_NAMES: &[&str] = &[
    "litria.toml",
];

/// Directories skipped during tree collection. These are typically massive
/// dependency/build/cache directories that slow the tree to a crawl and have
/// no value in the scaffold view.
const IGNORED_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    ".litria",
    "dist",
    "build",
    "target",
    ".next",
    ".nuxt",
    ".svelte-kit",
    "__pycache__",
    ".cache",
    ".turbo",
    ".parcel-cache",
    ".vite",
    // Python env/cache dirs (ADR-020 Slice 0). A single .venv holds thousands
    // of files; without these the scaffold drawer floods on any Python project.
    ".venv",
    "venv",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    ".tox",
    ".eggs",
    ".ipynb_checkpoints",
];

fn is_ignored(file_name: &str) -> bool {
    IGNORED_NAMES.iter().any(|&ignored| file_name.eq_ignore_ascii_case(ignored))
}

fn is_ignored_dir(dir_name: &str) -> bool {
    IGNORED_DIRS.iter().any(|&ignored| dir_name.eq_ignore_ascii_case(ignored))
}

pub(crate) fn collect_project_tree(root_path: &Path) -> Result<Vec<ProjectTreeEntry>, String> {
    let mut entries = Vec::new();
    let mut stack: Vec<(PathBuf, usize)> = vec![(root_path.to_path_buf(), 0)];

    while let Some((current, depth)) = stack.pop() {
        let read_dir = fs::read_dir(&current)
            .map_err(|error| format!("Unable to read directory: {error}"))?;
        for entry in read_dir {
            let entry = entry.map_err(|error| format!("Unable to read directory entry: {error}"))?;
            let path = entry.path();
            let file_type = entry
                .file_type()
                .map_err(|error| format!("Unable to read file type: {error}"))?;

            // Skip CM-internal files
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if is_ignored(name) {
                    continue;
                }
            }

            let relative = normalize_relative_path(root_path, &path)?;

            if file_type.is_dir() {
                // Skip heavy dependency/build/cache directories.
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if is_ignored_dir(name) {
                        continue;
                    }
                }
                entries.push(ProjectTreeEntry {
                    path: relative.clone(),
                    entry_type: "dir".to_string(),
                    depth,
                });
                stack.push((path, depth + 1));
            } else {
                entries.push(ProjectTreeEntry {
                    path: relative,
                    entry_type: "file".to_string(),
                    depth,
                });
            }
        }
    }

    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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
    fn collect_project_tree_lists_nested_entries() {
        let root = temp_dir("tree");
        fs::create_dir_all(root.join("src")).expect("must create nested dir");
        fs::write(root.join("src").join("main.js"), "console.log('ok');")
            .expect("must create nested file");

        let entries = collect_project_tree(&root).expect("tree should collect");
        let paths = entries.iter().map(|entry| entry.path.clone()).collect::<Vec<_>>();
        assert!(paths.contains(&"src".to_string()));
        assert!(paths.contains(&"src/main.js".to_string()));

        fs::remove_dir_all(root).expect("must remove temp directory");
    }

    #[test]
    fn collect_project_tree_skips_python_env_and_cache_dirs() {
        let root = temp_dir("pytree");
        // A minimal venv-shaped structure plus cache dirs, alongside real sources.
        fs::create_dir_all(root.join(".venv").join("Lib").join("site-packages"))
            .expect("must create venv dirs");
        fs::write(root.join(".venv").join("pyvenv.cfg"), "home = /usr").expect("venv cfg");
        fs::create_dir_all(root.join("venv")).expect("must create bare venv dir");
        fs::create_dir_all(root.join(".pytest_cache")).expect("pytest cache");
        fs::create_dir_all(root.join(".ruff_cache")).expect("ruff cache");
        fs::create_dir_all(root.join(".mypy_cache")).expect("mypy cache");
        fs::create_dir_all(root.join(".tox")).expect("tox dir");
        fs::create_dir_all(root.join(".eggs")).expect("eggs dir");
        fs::create_dir_all(root.join(".ipynb_checkpoints")).expect("ipynb checkpoints");
        fs::write(root.join("main.py"), "print('ok')").expect("must create source file");

        let entries = collect_project_tree(&root).expect("tree should collect");
        let paths = entries.iter().map(|entry| entry.path.clone()).collect::<Vec<_>>();
        assert!(paths.contains(&"main.py".to_string()));
        assert!(
            paths.iter().all(|p| {
                !p.starts_with(".venv")
                    && !p.starts_with("venv")
                    && !p.starts_with(".pytest_cache")
                    && !p.starts_with(".ruff_cache")
                    && !p.starts_with(".mypy_cache")
                    && !p.starts_with(".tox")
                    && !p.starts_with(".eggs")
                    && !p.starts_with(".ipynb_checkpoints")
            }),
            "python env/cache dirs must not appear in the tree: {paths:?}"
        );

        fs::remove_dir_all(root).expect("must remove temp directory");
    }
}
