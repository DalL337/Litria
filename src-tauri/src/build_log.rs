// Build log writing + retention.
//
// One file per scaffold run — `build-<unix_ms>-<slug>.jsonl` under
// `~/.litria/logs/builds/`, sitting beside the crash records in
// `~/.litria/logs/crashes/` (crash/mod.rs) because both are user-facing
// artifacts meant to be readable and attachable to a bug report.
//
// Why this is NOT the crash system: a scaffold that fails is not a crash.
// The app stays healthy and the panic/marker machinery never engages, so the
// one trace that explains the failure had nowhere to live — it streamed to
// React state, got truncated to the last 80 lines, and was unmounted the
// moment the run ended. This module is that missing destination.

use serde::Serialize;
use std::io::Write;
use std::path::PathBuf;

/// Retained runs. Older files are pruned after each write.
pub(crate) const KEEP_RUNS: usize = 20;

/// Refuse a runaway trace rather than filling the disk. Matches the crash
/// record guard in commands.rs (1 MiB).
pub(crate) const MAX_BODY_BYTES: usize = 1_048_576;

/// One stored run, as listed for the log viewer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BuildLogEntry {
    /// Bare file name — the handle `read` accepts back.
    pub name: String,
    /// Epoch ms parsed out of the file name (0 when unparseable).
    pub timestamp: u64,
    /// Project slug embedded in the name, for the list label.
    pub slug: String,
    pub bytes: u64,
}

fn home_dir() -> Option<PathBuf> {
    // #[cfg] rather than `if cfg!(windows)`: the runtime form compiles both
    // arms on every platform, which is what broke the LSP transport build on
    // Linux (see ae6af88).
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

/// `~/.litria/logs/builds/`, created on demand.
pub(crate) fn builds_dir() -> Option<PathBuf> {
    let dir = home_dir()?
        .join(".litria")
        .join("logs")
        .join("builds");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Reduce arbitrary project names to a file-name-safe slug.
pub(crate) fn sanitize_slug(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .take(32)
        .collect();
    let trimmed = cleaned.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "run".to_string()
    } else {
        trimmed
    }
}

/// True only for a bare `build-<digits>-<slug>.jsonl` name.
///
/// This is the read boundary: `name` arrives from the webview, so anything
/// carrying a separator, a parent segment, or an unexpected shape is refused
/// outright instead of being joined onto the logs directory.
fn is_valid_name(name: &str) -> bool {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return false;
    }
    let Some(rest) = name.strip_prefix("build-") else {
        return false;
    };
    let Some(rest) = rest.strip_suffix(".jsonl") else {
        return false;
    };
    let Some((ts, slug)) = rest.split_once('-') else {
        return false;
    };
    !ts.is_empty()
        && ts.chars().all(|c| c.is_ascii_digit())
        && !slug.is_empty()
        && slug.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn parse_entry(path: &std::path::Path) -> Option<BuildLogEntry> {
    let name = path.file_name()?.to_str()?.to_string();
    if !is_valid_name(&name) {
        return None;
    }
    // Take owned copies before `name` moves into the struct below.
    let (timestamp, slug): (u64, String) = {
        let core = name.strip_prefix("build-")?.strip_suffix(".jsonl")?;
        let (ts, slug) = core.split_once('-')?;
        (ts.parse().unwrap_or(0), slug.to_string())
    };
    let bytes = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    Some(BuildLogEntry {
        name,
        timestamp,
        slug,
        bytes,
    })
}

/// Write one run's JSONL body as a fresh file. Returns the path.
///
/// Best-effort like the crash writer: a failure here must never take down a
/// scaffold that otherwise succeeded.
pub(crate) fn write_run(slug: &str, body: &str) -> Option<PathBuf> {
    if body.len() > MAX_BODY_BYTES {
        return None;
    }
    let dir = builds_dir()?;
    let slug = sanitize_slug(slug);
    let mut path = dir.join(format!("build-{}-{slug}.jsonl", now_ms()));
    // Same-ms collision: fall back rather than clobber a sibling run.
    let mut attempt = 1;
    while path.exists() && attempt < 10 {
        path = dir.join(format!("build-{}-{slug}{attempt}.jsonl", now_ms()));
        attempt += 1;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .ok()?;
    file.write_all(body.as_bytes()).ok()?;
    let _ = file.sync_all();
    prune(KEEP_RUNS);
    Some(path)
}

/// Newest run first.
pub(crate) fn list() -> Vec<BuildLogEntry> {
    let Some(dir) = builds_dir() else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    let mut out: Vec<BuildLogEntry> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| parse_entry(&e.path()))
        .collect();
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    out
}

/// Read one stored run by bare file name.
pub(crate) fn read(name: &str) -> Option<String> {
    if !is_valid_name(name) {
        return None;
    }
    let dir = builds_dir()?;
    std::fs::read_to_string(dir.join(name)).ok()
}

/// Keep the newest `keep` runs; delete the rest.
pub(crate) fn prune(keep: usize) {
    let Some(dir) = builds_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(is_valid_name)
                .unwrap_or(false)
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    // The ms timestamp sits at a fixed offset in every name, so a plain sort
    // is chronological (same-width epoch ms until 2286) — same reasoning as
    // crash::record::prune.
    files.sort();
    let excess = files.len() - keep;
    for path in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_falls_back_when_nothing_survives() {
        assert_eq!(sanitize_slug("///"), "run");
        assert_eq!(sanitize_slug(""), "run");
    }

    #[test]
    fn slug_keeps_alphanumerics() {
        assert_eq!(sanitize_slug("my app 2"), "my-app-2");
    }

    #[test]
    fn valid_names_round_trip() {
        assert!(is_valid_name("build-1785468653176-brandnew.jsonl"));
        assert!(is_valid_name("build-1-a.jsonl"));
    }

    #[test]
    fn traversal_and_shape_violations_are_refused() {
        assert!(!is_valid_name("../build-1-a.jsonl"));
        assert!(!is_valid_name("build-1-a.jsonl/../../etc/passwd"));
        assert!(!is_valid_name("crash-1-a.json"));
        assert!(!is_valid_name("build-abc-a.jsonl"));
        assert!(!is_valid_name("build-1-a.txt"));
        assert!(!is_valid_name("build-1-.jsonl"));
    }
}
