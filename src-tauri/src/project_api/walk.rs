//! The search walker (Project API contract brief §6, §7.3).
//!
//! It yields every allowed, indexed file under a scope, in path order, and:
//! - never follows a link or a junction (a link is not walked at all);
//! - skips denied and unindexed directories, and denied files, by name,
//!   before touching what is inside them — they are never listed or counted;
//! - counts a directory it cannot list instead of aborting (unlike
//!   `list_project_tree`), and counts names the API cannot address;
//! - bounds its memory: it stops after examining a fixed number of entries.
//!
//! Path order is byte order of the forward-slash project-relative path. A
//! depth-first walk gives that order when siblings are sorted by name, with a
//! directory sorting as its name plus `/`: `a.txt` comes before `a/b`.
//!
//! The walker only proposes paths. Whoever reads a file repeats every check a
//! read makes on what it opens (`reader::read_disk_capped`): a file swapped
//! for a link after it was listed is caught there.

use std::fs;
use std::path::{Path, PathBuf};

use super::paths::is_valid_api_path;
use super::policy::{classify, classify_directory, Class};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    File,
    Directory,
}

#[derive(Debug)]
struct Child {
    name: String,
    kind: Kind,
}

impl Child {
    /// The child's sort key: a directory sorts as its name plus `/`.
    fn key(&self) -> String {
        match self.kind {
            Kind::File => self.name.clone(),
            Kind::Directory => format!("{}/", self.name),
        }
    }
}

struct Frame {
    /// The directory's project-relative path; empty for the root.
    relative: String,
    /// Children not yet visited, in REVERSE path order (the next is last).
    children: Vec<Child>,
}

pub(crate) struct Walker {
    root: PathBuf,
    /// The scope's segments; empty for the whole project. Above the scope,
    /// only the child named exactly by the next segment is followed.
    scope: Vec<String>,
    stack: Vec<Frame>,
    examined: usize,
    max_examined: usize,
    /// Files present but not addressable through the API (a name that is
    /// not UTF-8 or not a valid API path, or whose type cannot be read).
    pub(crate) unreadable_files: u32,
    /// Directories that could not be listed, or are not addressable.
    pub(crate) unreadable_directories: u32,
    /// The entry budget ran out; the walk ended early.
    pub(crate) exhausted: bool,
    /// The scope's last segment was found as a walkable file or directory.
    pub(crate) scope_found: bool,
    /// Tests: runs between a directory being listed in its parent and being
    /// entered — the window in which it can be swapped for a link.
    #[cfg(test)]
    pub(crate) before_enter: Option<Box<dyn FnMut(&str)>>,
}

impl Walker {
    /// Walk `root`, or only `scope` within it (forward-slash, already
    /// checked by the caller for syntax and policy).
    pub(crate) fn new(root: &Path, scope: Option<&str>, max_examined: usize) -> Self {
        let mut walker = Self {
            root: root.to_path_buf(),
            scope: scope.map_or_else(Vec::new, |scope| scope.split('/').map(str::to_owned).collect()),
            stack: Vec::new(),
            examined: 0,
            max_examined,
            unreadable_files: 0,
            unreadable_directories: 0,
            exhausted: false,
            scope_found: false,
            #[cfg(test)]
            before_enter: None,
        };
        walker.enter(String::new());
        walker
    }

    fn depth(relative: &str) -> usize {
        if relative.is_empty() {
            0
        } else {
            relative.split('/').count()
        }
    }

    /// List one directory and push its children.
    fn enter(&mut self, relative: String) {
        let directory = if relative.is_empty() {
            self.root.clone()
        } else {
            self.root.join(&relative)
        };
        let entries = match fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(_) => {
                self.unreadable_directories += 1;
                return;
            }
        };
        let depth = Self::depth(&relative);
        let wanted = self.scope.get(depth).cloned();
        let mut children = Vec::new();
        for entry in entries {
            self.examined += 1;
            if self.examined > self.max_examined {
                self.exhausted = true;
                self.stack.clear();
                return;
            }
            let Ok(entry) = entry else {
                self.unreadable_files += 1;
                continue;
            };
            // The entry's own type: a link reports itself, never its target.
            let Ok(file_type) = entry.file_type() else {
                self.unreadable_files += 1;
                continue;
            };
            if file_type.is_symlink() {
                continue; // links and junctions are not followed
            }
            let kind = if file_type.is_dir() {
                Kind::Directory
            } else if file_type.is_file() {
                Kind::File
            } else {
                continue; // FIFOs, sockets, devices: not documents
            };
            let file_name = entry.file_name();
            let lossy = file_name.to_string_lossy();
            if let Some(wanted) = &wanted {
                if lossy != wanted.as_str() {
                    continue; // above the scope: follow only the scope's own path
                }
            }
            let path = if relative.is_empty() {
                lossy.clone().into_owned()
            } else {
                format!("{relative}/{lossy}")
            };
            // The policy first, by name: a withheld or unindexed entry is
            // never listed and never counted — not even one the API could not
            // address anyway (`.env.` is `.env` to Windows; finding F3).
            let class = match kind {
                Kind::Directory => classify_directory(&path),
                Kind::File => classify(&path),
            };
            if class != Class::Allowed {
                continue;
            }
            let Ok(name) = file_name.into_string() else {
                self.count_unaddressable(kind);
                continue;
            };
            if !is_valid_api_path(&path) {
                self.count_unaddressable(kind);
                continue;
            }
            if wanted.is_some() && depth + 1 == self.scope.len() {
                self.scope_found = true;
            } else if wanted.is_some() && kind == Kind::File {
                continue; // a file cannot contain the rest of the scope
            }
            children.push(Child { name, kind });
        }
        children.sort_by_key(|child| std::cmp::Reverse(child.key()));
        self.stack.push(Frame { relative, children });
    }

    fn count_unaddressable(&mut self, kind: Kind) {
        match kind {
            Kind::File => self.unreadable_files += 1,
            Kind::Directory => self.unreadable_directories += 1,
        }
    }
}

impl Iterator for Walker {
    type Item = String;

    /// The next file's project-relative path, in path order.
    fn next(&mut self) -> Option<String> {
        loop {
            let frame = self.stack.last_mut()?;
            let Some(child) = frame.children.pop() else {
                self.stack.pop();
                continue;
            };
            let path = if frame.relative.is_empty() {
                child.name
            } else {
                format!("{}/{}", frame.relative, child.name)
            };
            match child.kind {
                Kind::File => return Some(path),
                Kind::Directory => {
                    #[cfg(test)]
                    if let Some(hook) = self.before_enter.as_mut() {
                        hook(&path);
                    }
                    self.enter(path)
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("litria-api-walk-{tag}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn touch(root: &Path, path: &str) {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, "x").unwrap();
    }

    fn walk(root: &Path, scope: Option<&str>) -> Vec<String> {
        Walker::new(root, scope, 100_000).collect()
    }

    /// Byte order of the whole path: `a.txt` before `a/b`, `a/b` before `a0`.
    #[test]
    fn files_come_in_path_order() {
        let root = temp_root("order");
        for path in ["a0", "a/b", "a.txt", "B.md", "a/c/d", "a/b.txt", "z"] {
            touch(&root, path);
        }
        let walked = walk(&root, None);
        let mut sorted = walked.clone();
        sorted.sort();
        assert_eq!(walked, sorted);
        assert_eq!(walked, ["B.md", "a.txt", "a/b", "a/b.txt", "a/c/d", "a0", "z"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn denied_and_unindexed_paths_are_never_walked() {
        let root = temp_root("policy");
        for path in [
            "src/main.ts",
            ".env",
            "src/.env.local",
            ".git/config",
            "keys/server.pem",
            "node_modules/pkg/index.js",
            "packages/app/dist/bundle.js",
            "scripts/build",
        ] {
            touch(&root, path);
        }
        let mut walker = Walker::new(&root, None, 100_000);
        let walked: Vec<String> = walker.by_ref().collect();
        assert_eq!(walked, ["scripts/build", "src/main.ts"], "a FILE named like an unindexed directory is walked");
        assert_eq!((walker.unreadable_files, walker.unreadable_directories), (0, 0), "nothing withheld is counted");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_scope_walks_only_its_own_subtree_by_exact_name() {
        let root = temp_root("scope");
        for path in ["src/a.ts", "src/lib/b.ts", "srcx/c.ts", "docs/d.md", "src.md"] {
            touch(&root, path);
        }
        let mut walker = Walker::new(&root, Some("src"), 100_000);
        assert_eq!(walker.by_ref().collect::<Vec<_>>(), ["src/a.ts", "src/lib/b.ts"]);
        assert!(walker.scope_found);
        assert_eq!(walk(&root, Some("src/lib/b.ts")), ["src/lib/b.ts"], "a file scope is that file");
        let mut missing = Walker::new(&root, Some("src/nope"), 100_000);
        assert!(missing.by_ref().next().is_none());
        assert!(!missing.scope_found);
        let mut through_a_file = Walker::new(&root, Some("src.md/x"), 100_000);
        assert!(through_a_file.by_ref().next().is_none());
        assert!(!through_a_file.scope_found);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_entry_budget_ends_the_walk() {
        let root = temp_root("budget");
        for index in 0..10 {
            touch(&root, &format!("f{index}.txt"));
        }
        let mut walker = Walker::new(&root, None, 5);
        assert_eq!(walker.by_ref().count(), 0, "a directory over the budget is not listed in part");
        assert!(walker.exhausted);
        let _ = fs::remove_dir_all(&root);
    }

    /// Links are not followed, whether they point inside or outside the
    /// project, to a file or to a directory.
    #[test]
    fn links_are_not_followed() {
        let root = temp_root("links");
        let outside = temp_root("links-outside");
        touch(&root, "real/inside.ts");
        touch(&outside, "secret.ts");
        if !make_dir_link(&root.join("into-real"), &root.join("real"))
            || !make_dir_link(&root.join("out"), &outside)
        {
            eprintln!("skipped: this host cannot create directory links");
            return;
        }
        assert_eq!(walk(&root, None), ["real/inside.ts"]);
        let mut scoped = Walker::new(&root, Some("into-real"), 100_000);
        assert!(scoped.by_ref().next().is_none(), "a scope through a link finds nothing");
        assert!(!scoped.scope_found);
        remove_dir_link(&root.join("into-real"));
        remove_dir_link(&root.join("out"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[cfg(unix)]
    #[test]
    fn a_file_symlink_is_not_walked() {
        let root = temp_root("file-link");
        touch(&root, "a.ts");
        std::os::unix::fs::symlink(root.join("a.ts"), root.join("alias.ts")).unwrap();
        assert_eq!(walk(&root, None), ["a.ts"]);
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(unix)]
    #[test]
    fn an_unreadable_directory_is_counted_and_skipped() {
        use std::os::unix::fs::PermissionsExt;
        let root = temp_root("unreadable");
        touch(&root, "locked/inner.ts");
        touch(&root, "open.ts");
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o000)).unwrap();
        let mut walker = Walker::new(&root, None, 100_000);
        let walked: Vec<String> = walker.by_ref().collect();
        fs::set_permissions(root.join("locked"), fs::Permissions::from_mode(0o755)).unwrap();
        if fs::read_dir(root.join("locked")).is_ok() && walked.contains(&"locked/inner.ts".to_owned()) {
            // Running as root: permissions do not restrict listing.
            eprintln!("skipped: permissions are not enforced for this user");
        } else {
            assert_eq!(walked, ["open.ts"]);
            assert_eq!(walker.unreadable_directories, 1);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    fn make_dir_link(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|output| output.status.success())
    }

    #[cfg(unix)]
    fn make_dir_link(link: &Path, target: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    /// Removes the link itself, never what it points to.
    fn remove_dir_link(link: &Path) {
        #[cfg(windows)]
        let _ = fs::remove_dir(link);
        #[cfg(unix)]
        let _ = fs::remove_file(link);
    }
}
