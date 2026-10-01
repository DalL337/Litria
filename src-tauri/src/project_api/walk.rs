//! The search walker (Project API contract brief §6, §7.3).
//!
//! It yields every allowed, indexed file under a scope, in path order, and:
//! - never follows a link or a junction (a link is not walked at all);
//! - skips denied and unindexed directories, and denied files, by name,
//!   before touching what is inside them — they are never listed or counted;
//! - counts a directory it cannot list instead of aborting (unlike
//!   `list_project_tree`), and counts names the API cannot address;
//! - bounds its memory: it stops after examining a fixed number of entries;
//! - when asked to, honours `.gitignore` (P4 gate item 1, 2026-10-01): an
//!   ignored file or directory is skipped and counted at the boundary — a
//!   directory counts once and nothing inside it is looked at.
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

use ignore::gitignore::{Gitignore, GitignoreBuilder};
use ignore::Match;

use super::paths::is_valid_api_path;
use super::policy::{classify, classify_directory, Class};
use super::reader::{read_disk_capped, DiskRead};

/// A `.gitignore` larger than this is not honoured: its rules are compiled on
/// every walk, so a hostile repository could make one arbitrarily expensive.
/// Not honouring a file only widens what search covers; it never hides one.
const MAX_GITIGNORE_BYTES: u64 = 256 * 1024;

/// Git matches `.gitignore` patterns case-insensitively where the volume is
/// case-insensitive (`core.ignorecase`, set when a repository is created).
#[cfg(any(windows, target_os = "macos"))]
const GITIGNORE_CASE_INSENSITIVE: bool = true;
#[cfg(not(any(windows, target_os = "macos")))]
const GITIGNORE_CASE_INSENSITIVE: bool = false;

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
    /// This directory's own `.gitignore` rules, when honoured and present.
    ignore: Option<Gitignore>,
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
    /// Whether `.gitignore` files are honoured.
    honour_gitignore: bool,
    /// Files and directories skipped because `.gitignore` excludes them. A
    /// directory counts once: nothing inside it is looked at.
    pub(crate) ignored_files: u32,
    pub(crate) ignored_directories: u32,
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
    /// checked by the caller for syntax and policy). With `honour_gitignore`,
    /// entries below the scope that a `.gitignore` excludes are skipped and
    /// counted; the scope itself and its ancestors are walked regardless, as
    /// a path named explicitly should be.
    pub(crate) fn new(root: &Path, scope: Option<&str>, max_examined: usize, honour_gitignore: bool) -> Self {
        let mut walker = Self {
            root: root.to_path_buf(),
            scope: scope.map_or_else(Vec::new, |scope| scope.split('/').map(str::to_owned).collect()),
            stack: Vec::new(),
            examined: 0,
            max_examined,
            unreadable_files: 0,
            unreadable_directories: 0,
            honour_gitignore,
            ignored_files: 0,
            ignored_directories: 0,
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
        // Loaded for directories above the scope too: their rules apply to
        // everything below it.
        let ignore = if self.honour_gitignore { self.load_gitignore(&relative) } else { None };
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
            // Below the scope only: a path named explicitly is walked even if
            // a `.gitignore` excludes it.
            if wanted.is_none() && self.is_ignored(&path, kind == Kind::Directory, &relative, ignore.as_ref()) {
                match kind {
                    Kind::File => self.ignored_files += 1,
                    Kind::Directory => self.ignored_directories += 1,
                }
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
        self.stack.push(Frame { relative, children, ignore });
    }

    /// The `.gitignore` of one directory, read with every check an API read
    /// makes (`read_disk_capped`): a `.gitignore` swapped for a link to a
    /// withheld file is refused like any read. Lines that are not valid globs
    /// are skipped, as git skips them.
    fn load_gitignore(&self, relative: &str) -> Option<Gitignore> {
        let path = if relative.is_empty() { ".gitignore".to_owned() } else { format!("{relative}/.gitignore") };
        let DiskRead::Text { text, .. } = read_disk_capped(&self.root, &path, MAX_GITIGNORE_BYTES) else {
            return None;
        };
        let mut builder = GitignoreBuilder::new("");
        builder.case_insensitive(GITIGNORE_CASE_INSENSITIVE).ok()?;
        for line in text.lines() {
            let _ = builder.add_line(None, line);
        }
        builder.build().ok().filter(|rules| !rules.is_empty())
    }

    /// Whether a `.gitignore` excludes `path`: the nearest rules decide, as in
    /// git — this directory's own file first, then each ancestor's, deepest
    /// first. A negation (`!name`) in a nearer file re-includes the path.
    fn is_ignored(&self, path: &str, is_dir: bool, own_dir: &str, own: Option<&Gitignore>) -> bool {
        let ancestors = self.stack.iter().rev().map(|frame| (frame.relative.as_str(), frame.ignore.as_ref()));
        for (dir, rules) in std::iter::once((own_dir, own)).chain(ancestors) {
            let Some(rules) = rules else { continue };
            let candidate = if dir.is_empty() {
                path
            } else {
                match path.strip_prefix(dir).and_then(|rest| rest.strip_prefix('/')) {
                    Some(rest) => rest,
                    None => continue,
                }
            };
            match rules.matched(candidate, is_dir) {
                Match::Ignore(_) => return true,
                Match::Whitelist(_) => return false,
                Match::None => {}
            }
        }
        false
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
        Walker::new(root, scope, 100_000, false).collect()
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
        let mut walker = Walker::new(&root, None, 100_000, false);
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
        let mut walker = Walker::new(&root, Some("src"), 100_000, false);
        assert_eq!(walker.by_ref().collect::<Vec<_>>(), ["src/a.ts", "src/lib/b.ts"]);
        assert!(walker.scope_found);
        assert_eq!(walk(&root, Some("src/lib/b.ts")), ["src/lib/b.ts"], "a file scope is that file");
        let mut missing = Walker::new(&root, Some("src/nope"), 100_000, false);
        assert!(missing.by_ref().next().is_none());
        assert!(!missing.scope_found);
        let mut through_a_file = Walker::new(&root, Some("src.md/x"), 100_000, false);
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
        let mut walker = Walker::new(&root, None, 5, false);
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
        let mut scoped = Walker::new(&root, Some("into-real"), 100_000, false);
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
        let mut walker = Walker::new(&root, None, 100_000, false);
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

    // --- .gitignore (P4 gate item 1) -----------------------------------------

    fn write(root: &Path, path: &str, text: &str) {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }

    /// Walk honouring .gitignore; the paths and the ignored counts.
    fn walk_ignoring(root: &Path, scope: Option<&str>) -> (Vec<String>, u32, u32) {
        let mut walker = Walker::new(root, scope, 100_000, true);
        let walked: Vec<String> = walker.by_ref().collect();
        (walked, walker.ignored_files, walker.ignored_directories)
    }

    /// Git's rules: directory patterns, anchored patterns, globs, negation,
    /// and a nearer .gitignore overriding an outer one.
    #[test]
    fn gitignore_rules_follow_git_and_skipped_entries_are_counted_once() {
        let root = temp_root("gitignore");
        // Not `build/` or `dist/`: those are unindexed by the policy already.
        write(&root, ".gitignore", "generated/\n/release\n*.log\n!keep.log\n# a comment\n\n");
        write(&root, "src/.gitignore", "gen/\n!important.log\n");
        for path in [
            "README.md", "app.log", "keep.log", "generated/out.js", "generated/more/deep.js", "release/x.js",
            "src/a.ts", "src/release/y.js", "src/gen/z.ts", "src/important.log", "src/noise.log",
        ] {
            touch(&root, path);
        }
        let (walked, files, directories) = walk_ignoring(&root, None);
        assert_eq!(
            walked,
            [".gitignore", "README.md", "keep.log", "src/.gitignore", "src/a.ts", "src/important.log", "src/release/y.js"]
        );
        // app.log and src/noise.log; generated/, release/ and src/gen/ count
        // once each. `/release` is anchored, so src/release is walked.
        assert_eq!((files, directories), (2, 3));

        let everything = walk(&root, None);
        assert_eq!(everything.len(), 13, "{everything:?}");
        let _ = fs::remove_dir_all(&root);
    }

    /// A path named explicitly is walked even if ignored; rules still apply
    /// below it.
    #[test]
    fn an_ignored_scope_is_walked_when_named_explicitly() {
        let root = temp_root("gitignore-scope");
        write(&root, ".gitignore", "generated/\n*.log\n");
        for path in ["generated/out.js", "generated/trace.log", "src/a.ts"] {
            touch(&root, path);
        }
        let (walked, files, directories) = walk_ignoring(&root, Some("generated"));
        assert_eq!(walked, ["generated/out.js"]);
        assert_eq!((files, directories), (1, 0));
        let _ = fs::remove_dir_all(&root);
    }

    /// Denied and unindexed entries are withheld by the policy before any
    /// .gitignore is consulted, so they are never counted as ignored either.
    #[test]
    fn withheld_entries_are_never_counted_as_ignored() {
        let root = temp_root("gitignore-policy");
        write(&root, ".gitignore", ".env\nnode_modules/\n*.pem\nnotes/\n");
        for path in [".env", "node_modules/pkg/index.js", "certs/server.pem", "notes/todo.md", "src/a.ts"] {
            touch(&root, path);
        }
        let (walked, files, directories) = walk_ignoring(&root, None);
        assert_eq!(walked, [".gitignore", "src/a.ts"]);
        assert_eq!((files, directories), (0, 1), "only notes/ counts; the rest is withheld by policy");
        let _ = fs::remove_dir_all(&root);
    }

    /// An oversized .gitignore is not honoured: search covers more, never less.
    #[test]
    fn an_oversized_gitignore_is_not_honoured() {
        let root = temp_root("gitignore-large");
        let mut rules = String::from("*.ts\n");
        while (rules.len() as u64) <= MAX_GITIGNORE_BYTES {
            rules.push_str("# padding padding padding padding padding padding padding\n");
        }
        write(&root, ".gitignore", &rules);
        touch(&root, "src/a.ts");
        let (walked, files, directories) = walk_ignoring(&root, None);
        assert_eq!(walked, [".gitignore", "src/a.ts"]);
        assert_eq!((files, directories), (0, 0));
        let _ = fs::remove_dir_all(&root);
    }

    /// A .gitignore that is a link to a withheld file is refused like any read
    /// through such a link: its contents never shape a walk.
    #[cfg(unix)]
    #[test]
    fn a_gitignore_linked_to_a_denied_file_is_not_honoured() {
        let root = temp_root("gitignore-link");
        write(&root, ".env", "*.ts\n");
        std::os::unix::fs::symlink(root.join(".env"), root.join(".gitignore")).unwrap();
        touch(&root, "src/a.ts");
        let (walked, files, directories) = walk_ignoring(&root, None);
        assert_eq!(walked, ["src/a.ts"], "the link itself is not walked, and its target's rules do not apply");
        assert_eq!((files, directories), (0, 0));
        let _ = fs::remove_dir_all(&root);
    }

    /// Git ignores case where the volume does (core.ignorecase): Windows and
    /// default macOS. Each OS asserts the behaviour it should have.
    #[test]
    fn gitignore_case_matching_follows_the_platform() {
        let root = temp_root("gitignore-case");
        write(&root, ".gitignore", "Generated/\n");
        touch(&root, "generated/out.js");
        let (walked, _, directories) = walk_ignoring(&root, None);
        #[cfg(any(windows, target_os = "macos"))]
        {
            assert_eq!(walked, [".gitignore"]);
            assert_eq!(directories, 1);
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            assert_eq!(walked, [".gitignore", "generated/out.js"]);
            assert_eq!(directories, 0);
        }
        let _ = fs::remove_dir_all(&root);
    }
}
