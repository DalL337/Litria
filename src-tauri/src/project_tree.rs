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

/// Also the Project API's "unindexed" class (contract brief §6): reused, not
/// copied, so the tree and the API skip the same directories.
pub(crate) fn is_ignored_dir(dir_name: &str) -> bool {
    IGNORED_DIRS.iter().any(|&ignored| dir_name.eq_ignore_ascii_case(ignored))
}

/// The directory names `is_ignored_dir` matches, for the Project API's policy
/// summary (`litria_project_context`).
pub(crate) fn ignored_dirs() -> &'static [&'static str] {
    IGNORED_DIRS
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

/// The most folders one tree stamp covers. Past it the stamp says so, and
/// changes beyond the first ones are not seen until a listing runs.
pub(crate) const MAX_STAMPED_FOLDERS: usize = 20_000;

/// One fingerprint of the project's folder tree (track T slice T3b): the
/// folders the tree shows, each with its modification time.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TreeStamp {
    /// Opaque: equal stamps mean the tree's entries are as they were.
    pub stamp: String,
    pub folders: usize,
    /// More than [`MAX_STAMPED_FOLDERS`] folders: the rest are not covered.
    pub truncated: bool,
}

/// A folder's modification time changes whenever an entry in it is created,
/// deleted, renamed, or moved in or out (POSIX `rename()` and `unlink()` mark
/// the parent directory's modification time; NTFS does the same, checked
/// 2026-10-15), and not when a file's contents change. So the folders' times
/// alone say whether the tree changed, without listing a single file. The
/// folders are the ones `collect_project_tree` descends: links are not
/// followed and `IGNORED_DIRS` are skipped. A folder that cannot be read is
/// counted as such instead of aborting.
pub(crate) fn tree_stamp(root_path: &Path) -> TreeStamp {
    tree_stamp_within(root_path, MAX_STAMPED_FOLDERS)
}

fn tree_stamp_within(root_path: &Path, max_folders: usize) -> TreeStamp {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    let mut folders = 0usize;
    let mut truncated = false;
    let mut stack: Vec<PathBuf> = vec![root_path.to_path_buf()];
    while let Some(current) = stack.pop() {
        if folders >= max_folders {
            truncated = true;
            break;
        }
        folders += 1;
        let relative = normalize_relative_path(root_path, &current).unwrap_or_default();
        let modified = fs::metadata(&current)
            .and_then(|metadata| metadata.modified())
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok());
        match modified {
            Some(time) => hasher.update(format!("{relative}\0{}.{:09}\n", time.as_secs(), time.subsec_nanos())),
            None => hasher.update(format!("{relative}\0?\n")),
        }
        let Ok(read_dir) = fs::read_dir(&current) else {
            hasher.update(format!("{relative}\0unreadable\n"));
            continue;
        };
        // Sorted, so the stamp does not depend on the order a folder lists in.
        let mut children: Vec<PathBuf> = read_dir
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
            .filter(|entry| !entry.file_name().to_str().is_some_and(is_ignored_dir))
            .map(|entry| entry.path())
            .collect();
        children.sort();
        stack.extend(children.into_iter().rev());
    }
    let digest = hasher.finalize();
    let stamp: String = digest[..16].iter().map(|byte| format!("{byte:02x}")).collect();
    TreeStamp { stamp, folders, truncated }
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

    // --- T3b: the tree stamp ---------------------------------------------------

    /// File times can share one tick of the system clock (about 15 ms on
    /// Windows): a test waits past it between changes.
    fn tick() {
        std::thread::sleep(std::time::Duration::from_millis(40));
    }

    #[test]
    fn the_tree_stamp_moves_with_the_tree_and_not_with_contents() {
        let root = temp_dir("tree-stamp");
        fs::create_dir_all(root.join("src/nested")).unwrap();
        fs::write(root.join("src/a.ts"), "a").unwrap();
        let first = tree_stamp(&root);
        assert_eq!(first.folders, 3, "the root, src and src/nested");
        assert!(!first.truncated);
        assert_eq!(tree_stamp(&root), first, "unchanged tree, same stamp");

        let mut last = first.stamp.clone();
        let mut moved = |label: &str| {
            let now = tree_stamp(&root).stamp;
            assert_ne!(now, last, "{label}");
            last = now;
        };
        tick();
        fs::write(root.join("src/nested/new.ts"), "n").unwrap();
        moved("a file created in a nested folder");
        tick();
        fs::rename(root.join("src/a.ts"), root.join("src/b.ts")).unwrap();
        moved("a rename");
        tick();
        fs::rename(root.join("src/b.ts"), root.join("src/nested/b.ts")).unwrap();
        moved("a move between folders");
        tick();
        fs::remove_file(root.join("src/nested/b.ts")).unwrap();
        moved("a delete");
        tick();
        fs::create_dir(root.join("src/fresh")).unwrap();
        moved("a new folder");

        tick();
        let before = tree_stamp(&root);
        fs::write(root.join("src/nested/new.ts"), "a longer text now").unwrap();
        assert_eq!(tree_stamp(&root), before, "a content change is not a tree change (T3a covers contents)");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_tree_stamp_skips_what_the_tree_skips() {
        let root = temp_dir("tree-stamp-ignored");
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::create_dir_all(root.join(".litria")).unwrap();
        let before = tree_stamp(&root);
        assert_eq!(before.folders, 1, "ignored folders are not walked");
        tick();
        fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();
        fs::write(root.join(".litria/workspace.db"), "x").unwrap();
        assert_eq!(tree_stamp(&root).stamp, before.stamp, "changes inside ignored folders are not seen");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn the_tree_stamp_says_when_it_stopped_short() {
        let root = temp_dir("tree-stamp-cap");
        for name in ["a", "b", "c", "d"] {
            fs::create_dir_all(root.join(name)).unwrap();
        }
        let capped = tree_stamp_within(&root, 3);
        assert_eq!(capped.folders, 3);
        assert!(capped.truncated);
        assert!(!tree_stamp_within(&root, 5).truncated);
        fs::remove_dir_all(root).unwrap();
    }
}
