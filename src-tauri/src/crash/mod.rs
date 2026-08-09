// Crash-log system (B5) — see docs/plans/ideas/crash-log-system.md.
//
// Local-only, assisted-report crash capture across every layer:
//   hook #3  Rust panics            → hook.rs (hardened panic hook)
//   hook #4  webview process death  → webview_watch.rs (Windows ProcessFailed)
//   hook #5  whole-process death    → marker.rs (per-instance dirty marker)
//   hooks 1/2 (React/JS)            → frontend, records arrive via commands
//
// Design rules (research 2026-07-06):
//   - Everything pay-on-fire; the module does no recurring work.
//   - All paths and static context are resolved ONCE at init, while the
//     process is healthy — the panic hook only concatenates.
//   - Crash records are user-facing artifacts → ~/.litria/logs/crashes/.
//     Markers/breadcrumbs are internal state → local app-data.

pub mod hook;
pub mod marker;
pub mod record;
pub mod scan;
#[cfg(windows)]
pub mod webview_watch;

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

/// Resolved-once locations and pre-serialized context. Everything the panic
/// hook needs must be reachable from here without allocation-heavy work.
pub struct CrashEnv {
    /// `~/.litria/logs/crashes/` — user-facing crash records.
    pub crashes_dir: PathBuf,
    /// Local app-data dir for markers + breadcrumb mirrors (internal state).
    pub state_dir: PathBuf,
    /// This instance's marker file path (`session-<pid>-<startms>.json`).
    pub marker_path: PathBuf,
    /// This instance's breadcrumb mirror (`breadcrumbs-<pid>.jsonl`).
    pub breadcrumbs_path: PathBuf,
    /// Pre-serialized static JSON fragment: `"litriaVersion":"..","os":".."`.
    pub static_ctx: String,
    pub pid: u32,
    pub start_ms: u64,
    pub version: String,
}

static ENV: OnceLock<CrashEnv> = OnceLock::new();

pub fn env() -> Option<&'static CrashEnv> {
    ENV.get()
}

fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE").ok().map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME").ok().map(PathBuf::from)
    }
}

fn os_string() -> String {
    format!("{} {}", std::env::consts::OS, std::env::consts::ARCH)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Initialize the crash system. Called as one of the FIRST acts of `run()`,
/// before the Tauri builder: pre-creates directories, writes the dirty
/// marker (phase `boot`), installs the panic hook, prunes old records.
///
/// Never fails: a crash logger that can't set up must not take the app down.
pub fn init(version: &str) {
    let Some(home) = home_dir() else { return };
    let Some(state_base) = crate::db::app_db::app_data_dir().ok() else {
        return;
    };

    let crashes_dir = home.join(".litria").join("logs").join("crashes");
    let state_dir = state_base.join("crash-state");
    let _ = std::fs::create_dir_all(&crashes_dir);
    let _ = std::fs::create_dir_all(&state_dir);

    let pid = std::process::id();
    let start_ms = now_ms();
    let marker_path = state_dir.join(format!("session-{pid}-{start_ms}.json"));
    let breadcrumbs_path = state_dir.join(format!("breadcrumbs-{pid}.jsonl"));

    // Pre-serialize the static fragment (values JSON-escaped now, not at
    // panic time). serde_json::to_string on a &str yields a quoted string.
    let static_ctx = format!(
        "\"litriaVersion\":{},\"os\":{}",
        serde_json::to_string(version).unwrap_or_else(|_| "\"?\"".into()),
        serde_json::to_string(&os_string()).unwrap_or_else(|_| "\"?\"".into()),
    );

    let env = CrashEnv {
        crashes_dir,
        state_dir,
        marker_path,
        breadcrumbs_path,
        static_ctx,
        pid,
        start_ms,
        version: version.to_string(),
    };

    marker::write_initial(&env);
    let _ = ENV.set(env);

    hook::install();
    record::prune(20);
}

/// Atomic-ish write for state files that REPLACE prior contents:
/// temp file in the same dir, then rename over. (Crash records use fresh
/// unique files instead — see record.rs.)
pub(crate) fn replace_file(path: &Path, contents: &str) -> std::io::Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, contents)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Parse a breadcrumb JSONL mirror, tolerating corruption and capping the
/// line count so a damaged multi-MB mirror can't balloon a crash record.
/// Shared by the scan synthesizer and the webview watcher.
pub(crate) fn read_breadcrumbs(path: &Path) -> Vec<serde_json::Value> {
    let raw = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = raw.lines().collect();
    let start = lines.len().saturating_sub(200);
    lines[start..]
        .iter()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}
