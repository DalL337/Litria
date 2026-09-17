// Creation ownership: marker + verified manifest (ADR-028 §7, F27, R7/R8).
//
// A new-project write proves ownership before it tolerates content:
//
//   * The root is claimed first — created by this run, or an empty folder
//     the user made, or a folder whose marker and manifest prove every
//     entry is unchanged output of an earlier attempt. Anything else is
//     refused with the first offending entry named.
//   * The marker `.litria/scaffold-attempt.json` is written under
//     `create_new`; every file Litria writes goes through `write_file`,
//     which refuses symlinks and reparse points on every component under
//     the root, opens with `create_new` (or replaces only a file the
//     manifest proves is this attempt's unchanged output), and records the
//     SHA-256 in the manifest.
//   * Subprocess output (a `.venv`, a create CLI's tree) is *unrecorded*:
//     it can never be proven, so it blocks retry and cleanup, by name.
//   * Cleanup after a cancel or timeout moves the root aside with one
//     atomic rename, verifies the moved tree against the manifest, and only
//     then deletes it. A rename that fails, an unrecorded or modified entry,
//     a symlink, or a root this run did not create leaves the directory
//     intact and reports the path and the reason. Nothing is ever re-hashed
//     into the manifest at cleanup time.
//
// ---------------------------------------------------------------------------
// Register (security-policy Rule 4) — every creation path and the checks it
// carries. An unlisted path is a bug, not an exception.
//
//   Blank   (blank_project.rs)   ownership: claim_root + marker; content:
//           manifest-verified retry, refuses foreign entries; symlinks:
//           refused on root and every written component; subprocess: none.
//   Python  (python_scaffold.rs) ownership: claim_root + marker; content:
//           manifest-verified retry, `.venv` declared unrecorded (blocks
//           retry/cleanup by name); symlinks: as Blank; subprocess: env
//           step under registry `limits.env` (idle + deadline), cancellable,
//           cleanup after abort via cleanup_after_abort.
//   npm / Angular (scaffold_runner.rs) ownership: the target must not
//           exist (the create CLI makes it); content: CLI output is
//           unrecorded, so cleanup removes the folder only while it is
//           still empty and retry requires the user to remove it; file
//           steps use project_file (relative, inside the root) and the
//           step executor; symlinks: refused by project_file's canonical
//           check; subprocess: primary under `limits.primary`, add-on and
//           backend commands under `limits.command`, cancellable.
// ---------------------------------------------------------------------------

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub(crate) const MARKER_DIR: &str = ".litria";
pub(crate) const MARKER_FILE: &str = "scaffold-attempt.json";
const MARKER_SCHEMA: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Recorded {
    /// Slash-separated path relative to the root.
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Marker {
    pub schema_version: u32,
    /// `blank` | `python` | `npm`.
    pub kind: String,
    pub started_at: String,
    /// Whether the attempt created the root (an empty pre-made folder is
    /// claimed but never removed by cleanup).
    pub created_root: bool,
    /// Files this attempt wrote, in order.
    pub files: Vec<Recorded>,
    /// Relative paths a subprocess produces — never provable, so their
    /// presence blocks retry and cleanup with a reason naming them.
    #[serde(default)]
    pub unrecorded: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ClaimError {
    /// `root.symlink` | `root.not_dir` | `root.not_empty` | `root.unverified`
    /// | `root.mkdir` | `marker.write`
    pub code: &'static str,
    pub message: String,
}

fn claim_err(code: &'static str, message: impl Into<String>) -> ClaimError {
    ClaimError { code, message: message.into() }
}

/// One creation attempt over a claimed root.
#[derive(Debug)]
pub(crate) struct Attempt {
    root: PathBuf,
    marker: Marker,
    /// False for paths whose files a CLI writes (npm): no marker on disk.
    marker_on_disk: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CleanupOutcome {
    /// The root was moved aside, proven unchanged run output, and removed.
    Removed,
    /// Left intact — the reason names the path and why.
    Retained { reason: String },
}

fn now_stamp() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

fn is_link(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}

/// A slash-separated, project-relative path: no root, no `..`, no `.`.
fn validate_rel(rel: &str) -> Result<PathBuf, String> {
    if rel.is_empty() || rel.contains('\\') {
        return Err(format!("refusing path '{rel}': must be slash-separated and relative"));
    }
    let path = Path::new(rel);
    if path.is_absolute() {
        return Err(format!("refusing path '{rel}': must be project-relative"));
    }
    for component in path.components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(format!("refusing path '{rel}': must stay inside the project"));
        }
    }
    Ok(path.to_path_buf())
}

impl Attempt {
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Claim `root` for a Litria-written project (Blank, Python). Creates
    /// it when missing; accepts an empty pre-made folder when
    /// `allow_existing_empty`; accepts an earlier attempt only when its
    /// marker and manifest prove every entry unchanged. Writes the marker.
    pub(crate) fn claim_root(root: &Path, kind: &str, allow_existing_empty: bool) -> Result<Attempt, ClaimError> {
        let mut marker = Marker {
            schema_version: MARKER_SCHEMA,
            kind: kind.to_string(),
            started_at: now_stamp(),
            created_root: false,
            files: Vec::new(),
            unrecorded: Vec::new(),
        };
        match fs::symlink_metadata(root) {
            Ok(meta) => {
                if is_link(&meta) {
                    return Err(claim_err("root.symlink", format!("Refusing to create into a link: {}", root.display())));
                }
                if !meta.is_dir() {
                    return Err(claim_err("root.not_dir", format!("Path exists but is not a directory: {}", root.display())));
                }
                match read_marker(root) {
                    Some(previous) => {
                        verify_tree(root, &previous).map_err(|reason| {
                            claim_err(
                                "root.unverified",
                                format!(
                                    "Folder already exists and is not proven to be an earlier attempt's unchanged output ({reason}): {}",
                                    root.display()
                                ),
                            )
                        })?;
                        // The earlier attempt's proof carries over; this
                        // attempt rewrites the files it proved.
                        marker.created_root = previous.created_root;
                        marker.files = previous.files;
                        marker.unrecorded = previous.unrecorded;
                    }
                    None => {
                        let empty = fs::read_dir(root)
                            .map_err(|e| claim_err("root.not_empty", format!("Unable to inspect target folder: {e}")))?
                            .next()
                            .is_none();
                        if !empty || !allow_existing_empty {
                            return Err(claim_err(
                                "root.not_empty",
                                format!("Folder already exists and is not empty: {}", root.display()),
                            ));
                        }
                    }
                }
            }
            Err(_) => {
                if let Some(parent) = root.parent() {
                    fs::create_dir_all(parent)
                        .map_err(|e| claim_err("root.mkdir", format!("Unable to create project location: {e}")))?;
                }
                fs::create_dir(root).map_err(|e| claim_err("root.mkdir", format!("Unable to create project directory: {e}")))?;
                marker.created_root = true;
            }
        }
        let mut attempt = Attempt { root: root.to_path_buf(), marker, marker_on_disk: true };
        attempt.persist_marker().map_err(|e| claim_err("marker.write", e))?;
        Ok(attempt)
    }

    /// An attempt whose files a create CLI writes (npm / Angular): the
    /// caller has proven the target does not exist; no marker is written
    /// into the tree (the CLIs refuse a non-empty target). Its output is
    /// unrecorded by construction.
    pub(crate) fn external(root: &Path, kind: &str) -> Attempt {
        Attempt {
            root: root.to_path_buf(),
            marker: Marker {
                schema_version: MARKER_SCHEMA,
                kind: kind.to_string(),
                started_at: now_stamp(),
                created_root: true,
                files: Vec::new(),
                unrecorded: vec![".".into()],
            },
            marker_on_disk: false,
        }
    }

    fn marker_path(&self) -> PathBuf {
        self.root.join(MARKER_DIR).join(MARKER_FILE)
    }

    fn persist_marker(&mut self) -> Result<(), String> {
        if !self.marker_on_disk {
            return Ok(());
        }
        let dir = self.root.join(MARKER_DIR);
        if let Ok(meta) = fs::symlink_metadata(&dir) {
            if is_link(&meta) {
                return Err(format!("refusing marker directory that is a link: {}", dir.display()));
            }
        } else {
            fs::create_dir(&dir).map_err(|e| format!("unable to create {}: {e}", dir.display()))?;
        }
        let path = self.marker_path();
        let json = serde_json::to_vec_pretty(&self.marker).map_err(|e| e.to_string())?;
        // First write is create_new; later writes replace our own marker.
        let exists = fs::symlink_metadata(&path).is_ok();
        let mut file = if exists {
            OpenOptions::new().write(true).truncate(true).open(&path)
        } else {
            OpenOptions::new().write(true).create_new(true).open(&path)
        }
        .map_err(|e| format!("unable to write {}: {e}", path.display()))?;
        file.write_all(&json).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Declare a relative path a subprocess will produce (never provable).
    pub(crate) fn note_unrecorded(&mut self, rel: &str) -> Result<(), String> {
        validate_rel(rel)?;
        if !self.marker.unrecorded.iter().any(|u| u == rel) {
            self.marker.unrecorded.push(rel.to_string());
            self.persist_marker()?;
        }
        Ok(())
    }

    /// Write one project file: symlink/reparse refusal on every component
    /// under the root, `create_new` unless the manifest proves the existing
    /// file is this attempt's unchanged output, then record its hash.
    pub(crate) fn write_file(&mut self, rel: &str, contents: &[u8]) -> Result<(), String> {
        let rel_path = validate_rel(rel)?;
        // Ancestors: create missing ones, refuse links.
        let mut dir = self.root.clone();
        if let Some(parent) = rel_path.parent() {
            for component in parent.components() {
                dir.push(component);
                match fs::symlink_metadata(&dir) {
                    Ok(meta) if is_link(&meta) => {
                        return Err(format!("refusing to write through a link: {}", dir.display()));
                    }
                    Ok(meta) if !meta.is_dir() => {
                        return Err(format!("path exists and is not a directory: {}", dir.display()));
                    }
                    Ok(_) => {}
                    Err(_) => {
                        fs::create_dir(&dir).map_err(|e| format!("unable to create {}: {e}", dir.display()))?;
                    }
                }
            }
        }
        let target = self.root.join(&rel_path);
        if let Ok(meta) = fs::symlink_metadata(&target) {
            if is_link(&meta) {
                return Err(format!("refusing to replace a link: {}", target.display()));
            }
            if !meta.is_file() {
                return Err(format!("path exists and is not a file: {}", target.display()));
            }
            // Only this attempt's proven output may be replaced.
            let proven = self.marker.files.iter().any(|r| r.path == rel)
                && fs::read(&target).map(|bytes| sha256_hex(&bytes)).ok()
                    == self.marker.files.iter().find(|r| r.path == rel).map(|r| r.sha256.clone());
            if !proven {
                return Err(format!("refusing to overwrite a file this run did not write: {}", target.display()));
            }
            fs::remove_file(&target).map_err(|e| format!("unable to replace {}: {e}", target.display()))?;
        }
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|e| format!("unable to create {}: {e}", target.display()))?;
        file.write_all(contents).map_err(|e| format!("unable to write {}: {e}", target.display()))?;
        drop(file);
        let record = Recorded { path: rel.to_string(), sha256: sha256_hex(contents), bytes: contents.len() as u64 };
        match self.marker.files.iter_mut().find(|r| r.path == rel) {
            Some(existing) => *existing = record,
            None => self.marker.files.push(record),
        }
        self.persist_marker()
    }

    /// After teardown of a cancelled or timed-out run: move the root aside
    /// atomically, prove the moved tree is nothing but this attempt's
    /// unchanged output, then remove it. Any doubt retains it.
    pub(crate) fn cleanup_after_abort(&self) -> CleanupOutcome {
        let root = &self.root;
        let retained = |reason: String| CleanupOutcome::Retained { reason };
        match fs::symlink_metadata(root) {
            Err(_) => return CleanupOutcome::Removed, // nothing was created
            Ok(meta) if is_link(&meta) => {
                return retained(format!("{} is a link; nothing was deleted", root.display()));
            }
            Ok(_) => {}
        }
        if !self.marker.created_root {
            return retained(format!(
                "{} existed before this run; its contents were left as they are",
                root.display()
            ));
        }
        let aside = aside_path(root);
        if let Err(e) = fs::rename(root, &aside) {
            return retained(format!(
                "{} could not be moved aside for verification ({e}); nothing was deleted",
                root.display()
            ));
        }
        if let Err(reason) = verify_tree(&aside, &self.marker) {
            return match fs::rename(&aside, root) {
                Ok(()) => retained(format!("{} kept: {reason}; nothing was deleted", root.display())),
                Err(e) => retained(format!(
                    "{} kept as {} ({reason}); it could not be moved back ({e})",
                    root.display(),
                    aside.display()
                )),
            };
        }
        match fs::remove_dir_all(&aside) {
            Ok(()) => CleanupOutcome::Removed,
            Err(e) => retained(format!("{} could not be removed ({e})", aside.display())),
        }
    }
}

fn aside_path(root: &Path) -> PathBuf {
    let name = root.file_name().and_then(|n| n.to_str()).unwrap_or("project");
    let stamp = chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0);
    root.with_file_name(format!("{name}.litria-abort-{}-{stamp}", std::process::id()))
}

fn read_marker(root: &Path) -> Option<Marker> {
    let path = root.join(MARKER_DIR).join(MARKER_FILE);
    let meta = fs::symlink_metadata(&path).ok()?;
    if is_link(&meta) || !meta.is_file() {
        return None;
    }
    serde_json::from_slice(&fs::read(&path).ok()?).ok()
}

/// Prove every entry under `root` is the marker or an unchanged recorded
/// file. Symlinks, reparse points, unrecorded entries, hash mismatches, and
/// declared subprocess output all fail with the entry named.
pub(crate) fn verify_tree(root: &Path, marker: &Marker) -> Result<(), String> {
    let mut seen = 0usize;
    verify_dir(root, root, marker, &mut seen)?;
    Ok(())
}

fn verify_dir(root: &Path, dir: &Path, marker: &Marker, seen: &mut usize) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("cannot read {}: {e}", dir.display()))?;
        let path = entry.path();
        let rel = path
            .strip_prefix(root)
            .map_err(|_| format!("{} is outside the root", path.display()))?
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/");
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("cannot inspect {rel}: {e}"))?;
        if is_link(&meta) {
            return Err(format!("{rel} is a link"));
        }
        if marker.unrecorded.iter().any(|u| u == &rel || u == ".") {
            return Err(format!("{rel} is subprocess output that was never recorded"));
        }
        if meta.is_dir() {
            if rel == MARKER_DIR {
                // Only the marker may live here.
                for inner in fs::read_dir(&path).map_err(|e| format!("cannot read {rel}: {e}"))? {
                    let inner = inner.map_err(|e| format!("cannot read {rel}: {e}"))?;
                    if inner.file_name() != MARKER_FILE {
                        return Err(format!("{rel}/{} was not written by this run", inner.file_name().to_string_lossy()));
                    }
                }
                continue;
            }
            let prefix = format!("{rel}/");
            if !marker.files.iter().any(|r| r.path.starts_with(&prefix)) {
                return Err(format!("{rel}/ was not written by this run"));
            }
            verify_dir(root, &path, marker, seen)?;
            continue;
        }
        let Some(record) = marker.files.iter().find(|r| r.path == rel) else {
            return Err(format!("{rel} was not written by this run"));
        };
        let bytes = fs::read(&path).map_err(|e| format!("cannot read {rel}: {e}"))?;
        if bytes.len() as u64 != record.bytes || sha256_hex(&bytes) != record.sha256 {
            return Err(format!("{rel} was modified after it was written"));
        }
        *seen += 1;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests: run with `cargo test creation_ownership`
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    struct TempRoot(PathBuf);
    impl Drop for TempRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).ok();
        }
    }
    fn temp_root(tag: &str) -> TempRoot {
        let base = std::env::temp_dir().join(format!(
            "litria-own-{tag}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ));
        fs::create_dir_all(&base).expect("temp base");
        TempRoot(base)
    }

    fn attempt_with(root: &Path) -> Attempt {
        let mut a = Attempt::claim_root(root, "blank", true).expect("claim");
        a.write_file("README.md", b"# demo\n").unwrap();
        a.write_file("src/pkg/__init__.py", b"").unwrap();
        a
    }

    #[test]
    fn register_names_every_creation_path_and_both_limits() {
        // security-policy Rule 4: the register lives at the chokepoint.
        let source = include_str!("creation_ownership.rs");
        let register = &source[..source.find("use std::fs").unwrap()];
        for needle in ["Blank", "Python", "npm / Angular", "limits.env", "limits.primary", "limits.command", "idle + deadline", "cleanup_after_abort", "symlinks"] {
            assert!(register.contains(needle), "register must name {needle}");
        }
    }

    #[test]
    fn claim_creates_the_root_and_writes_the_marker_under_create_new() {
        let base = temp_root("claim");
        let root = base.0.join("demo");
        let a = Attempt::claim_root(&root, "blank", true).unwrap();
        assert!(a.marker.created_root);
        let marker: Marker = serde_json::from_slice(&fs::read(root.join(".litria/scaffold-attempt.json")).unwrap()).unwrap();
        assert_eq!(marker.kind, "blank");
        assert!(marker.created_root && marker.files.is_empty());
    }

    #[test]
    fn claim_accepts_an_empty_pre_made_folder_but_never_removes_it() {
        let base = temp_root("empty");
        let root = base.0.join("made-first");
        fs::create_dir(&root).unwrap();
        let a = attempt_with(&root);
        assert!(!a.marker.created_root);
        assert!(matches!(a.cleanup_after_abort(), CleanupOutcome::Retained { .. }));
        assert!(root.join("README.md").exists(), "user-made folder keeps our files too");
        assert!(matches!(Attempt::claim_root(&root, "blank", false), Err(ClaimError { code: "root.unverified", .. }) | Ok(_)));
    }

    #[test]
    fn claim_refuses_a_pre_seeded_readme_by_name() {
        let base = temp_root("seeded");
        let root = base.0.join("demo");
        fs::create_dir(&root).unwrap();
        fs::write(root.join("README.md"), "mine").unwrap();
        let err = Attempt::claim_root(&root, "blank", true).unwrap_err();
        assert_eq!(err.code, "root.not_empty");
        // A README the user pre-seeded is never overwritten even with a marker present.
        fs::write(root.join("README.md"), "").unwrap();
    }

    #[test]
    fn retry_is_proven_by_the_marker_and_manifest_not_by_file_names() {
        let base = temp_root("retry");
        let root = base.0.join("demo");
        let first = attempt_with(&root);
        drop(first);
        // Unchanged output: retry succeeds and rewrites.
        let mut again = Attempt::claim_root(&root, "blank", false).expect("proven retry");
        again.write_file("README.md", b"# demo v2\n").unwrap();
        assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "# demo v2\n");
        drop(again);
        // A modified file blocks retry, by name.
        fs::write(root.join("README.md"), "# edited by hand\n").unwrap();
        let err = Attempt::claim_root(&root, "blank", false).unwrap_err();
        assert_eq!(err.code, "root.unverified");
        assert!(err.message.contains("README.md was modified"), "{}", err.message);
        // An added file blocks retry, by name.
        fs::write(root.join("README.md"), "# demo v2\n").unwrap();
        fs::write(root.join("notes.txt"), "precious").unwrap();
        let err = Attempt::claim_root(&root, "blank", false).unwrap_err();
        assert!(err.message.contains("notes.txt was not written by this run"), "{}", err.message);
        fs::remove_file(root.join("notes.txt")).unwrap();
        // A same-named folder without a marker is not a retry.
        fs::remove_dir_all(root.join(".litria")).unwrap();
        let err = Attempt::claim_root(&root, "blank", true).unwrap_err();
        assert_eq!(err.code, "root.not_empty");
    }

    #[test]
    fn write_file_refuses_links_and_foreign_files_and_uses_create_new() {
        let base = temp_root("links");
        let root = base.0.join("demo");
        let mut a = Attempt::claim_root(&root, "python", true).unwrap();
        // A foreign file at the target is never overwritten.
        fs::write(root.join("main.py"), "user code").unwrap();
        let err = a.write_file("main.py", b"print()").unwrap_err();
        assert!(err.contains("did not write"), "{err}");
        assert_eq!(fs::read_to_string(root.join("main.py")).unwrap(), "user code");
        fs::remove_file(root.join("main.py")).unwrap();
        // A linked `src` is refused. Windows: a symlink needs a privileged
        // or developer-mode account, so fall back to a junction — also a
        // reparse point, and exactly what `is_link` must catch.
        let outside = base.0.join("outside");
        fs::create_dir(&outside).unwrap();
        #[cfg(windows)]
        let linked = std::os::windows::fs::symlink_dir(&outside, root.join("src")).is_ok()
            || crate::platform::hidden_command("cmd")
                .args(["/C", "mklink", "/J", root.join("src").to_str().unwrap(), outside.to_str().unwrap()])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
        #[cfg(not(windows))]
        let linked = std::os::unix::fs::symlink(&outside, root.join("src")).is_ok();
        assert!(linked, "the test needs a link fixture (symlink or junction)");
        let err = a.write_file("src/pkg/__init__.py", b"").unwrap_err();
        assert!(err.contains("link"), "{err}");
        assert!(!outside.join("pkg").exists(), "nothing written through the link");
        // The linked root itself is refused by claim_root and by cleanup.
        let mut marker = a.marker.clone();
        marker.files.clear();
        assert!(verify_tree(&root, &marker).unwrap_err().contains("src is a link"));
        fs::remove_dir(root.join("src")).ok();
        // Path discipline.
        assert!(a.write_file("../escape.txt", b"").is_err());
        assert!(a.write_file("/abs.txt", b"").is_err());
        assert!(a.write_file("a\\b.txt", b"").is_err());
    }

    #[test]
    fn cleanup_removes_only_proven_unchanged_output() {
        let base = temp_root("cleanup");
        let root = base.0.join("demo");
        let a = attempt_with(&root);
        assert_eq!(a.cleanup_after_abort(), CleanupOutcome::Removed);
        assert!(!root.exists());
        assert!(!base.0.read_dir().unwrap().any(|e| e.unwrap().file_name().to_string_lossy().contains("litria-abort")), "no aside folder left behind");
    }

    #[test]
    fn cleanup_preserves_added_modified_replaced_and_unrecorded_content() {
        let base = temp_root("preserve");
        let root = base.0.join("demo");
        // Added file after creation.
        let a = attempt_with(&root);
        fs::write(root.join("notes.txt"), "precious").unwrap();
        let outcome = a.cleanup_after_abort();
        assert!(matches!(&outcome, CleanupOutcome::Retained { reason } if reason.contains("notes.txt")), "{outcome:?}");
        assert!(root.join("notes.txt").exists() && root.join("README.md").exists(), "moved back intact");
        fs::remove_file(root.join("notes.txt")).unwrap();
        // Modified file.
        fs::write(root.join("README.md"), "# edited\n").unwrap();
        let outcome = a.cleanup_after_abort();
        assert!(matches!(&outcome, CleanupOutcome::Retained { reason } if reason.contains("README.md was modified")), "{outcome:?}");
        assert_eq!(fs::read_to_string(root.join("README.md")).unwrap(), "# edited\n");
        // Replaced path (file became a directory).
        fs::remove_file(root.join("README.md")).unwrap();
        fs::create_dir(root.join("README.md")).unwrap();
        let outcome = a.cleanup_after_abort();
        assert!(matches!(&outcome, CleanupOutcome::Retained { .. }), "{outcome:?}");
        assert!(root.join("README.md").is_dir());
        fs::remove_dir(root.join("README.md")).unwrap();
        fs::write(root.join("README.md"), "# demo\n").unwrap();
        // Unrecorded subprocess output.
        let mut a = a;
        a.note_unrecorded(".venv").unwrap();
        fs::create_dir(root.join(".venv")).unwrap();
        let outcome = a.cleanup_after_abort();
        assert!(matches!(&outcome, CleanupOutcome::Retained { reason } if reason.contains(".venv")), "{outcome:?}");
        assert!(root.join(".venv").exists());
        // And an unrecorded tree blocks retry too, by name.
        let err = Attempt::claim_root(&root, "python", false).unwrap_err();
        assert!(err.message.contains(".venv"), "{}", err.message);
    }

    #[test]
    fn external_attempt_cleans_up_only_an_empty_folder() {
        let base = temp_root("external");
        let root = base.0.join("demo");
        let a = Attempt::external(&root, "npm");
        assert_eq!(a.cleanup_after_abort(), CleanupOutcome::Removed, "never created: nothing to do");
        fs::create_dir(&root).unwrap();
        assert_eq!(a.cleanup_after_abort(), CleanupOutcome::Removed, "still empty: removed");
        assert!(!root.exists());
        fs::create_dir(&root).unwrap();
        fs::write(root.join("package.json"), "{}").unwrap();
        let outcome = a.cleanup_after_abort();
        assert!(matches!(&outcome, CleanupOutcome::Retained { reason } if reason.contains("never recorded")), "{outcome:?}");
        assert!(root.join("package.json").exists());
    }
}
