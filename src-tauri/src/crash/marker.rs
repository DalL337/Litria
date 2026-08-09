// Clean-shutdown marker (hook #5) — "assume dirty, prove clean" polarity.
//
// One marker per instance: `session-<pid>-<startms>.json` in local app-data
// (never ~/.litria — home dirs can be synced/roaming; sync engines resurrect
// and delete files). The frontend ritual — not Rust process exit — drives the
// clean transition, so a dead webview can never look clean.
//
// AV note: deletion of fresh files can transiently fail on Windows, so the
// clean signal is the STATE REWRITE (`state:"clean"`); deletion is cleanup,
// retried briefly, and a failed delete never reads as a crash.

use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use super::CrashEnv;

/// Set once the clean transition has run. Late debounced breadcrumb flushes
/// after this point are refused — otherwise they'd recreate the mirror file
/// mark_clean just deleted, leaving an orphan (and pid-reuse bait).
static CLEANED: AtomicBool = AtomicBool::new(false);

pub fn is_cleaned() -> bool {
    CLEANED.load(Ordering::SeqCst)
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub pid: u32,
    pub start_ms: u64,
    pub phase: String,
    pub state: String, // "running" | "clean"
    pub litria_version: String,
}

fn serialize(marker: &Marker) -> String {
    serde_json::to_string(marker).unwrap_or_else(|_| "{}".to_string())
}

/// Written as one of the first acts of startup, phase `boot`. An early
/// crash then self-identifies by phase (Firefox CrashMonitor model).
pub fn write_initial(env: &CrashEnv) {
    let marker = Marker {
        pid: env.pid,
        start_ms: env.start_ms,
        phase: "boot".to_string(),
        state: "running".to_string(),
        litria_version: env.version.clone(),
    };
    let _ = super::replace_file(&env.marker_path, &serialize(&marker));
}

/// Advance the phase checkpoint (e.g. `webview-ready`). Keeps state running.
pub fn mark_phase(phase: &str) {
    let Some(env) = super::env() else { return };
    let marker = Marker {
        pid: env.pid,
        start_ms: env.start_ms,
        phase: phase.to_string(),
        state: "running".to_string(),
        litria_version: env.version.clone(),
    };
    let _ = super::replace_file(&env.marker_path, &serialize(&marker));
}

/// The clean-shutdown transition: rewrite state to clean (the signal), then
/// try to delete the marker and this session's breadcrumb mirror (cleanup).
pub fn mark_clean() {
    let Some(env) = super::env() else { return };
    CLEANED.store(true, Ordering::SeqCst);
    let marker = Marker {
        pid: env.pid,
        start_ms: env.start_ms,
        phase: "shutdown".to_string(),
        state: "clean".to_string(),
        litria_version: env.version.clone(),
    };
    let _ = super::replace_file(&env.marker_path, &serialize(&marker));
    remove_with_retry(&env.marker_path);
    remove_with_retry(&env.breadcrumbs_path);
}

pub(crate) fn remove_with_retry(path: &Path) {
    for _ in 0..3 {
        if std::fs::remove_file(path).is_ok() || !path.exists() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// Parse a marker filename of the form `session-<pid>-<startms>.json`.
pub fn parse_marker_filename(name: &str) -> Option<(u32, u64)> {
    let rest = name.strip_prefix("session-")?.strip_suffix(".json")?;
    let (pid, start) = rest.split_once('-')?;
    Some((pid.parse().ok()?, start.parse().ok()?))
}

/// Best-effort "is that process still alive". PID reuse is partially guarded
/// by the start-time in the filename; a false "alive" just defers detection
/// to that instance's own exit. On macOS we conservatively assume dead
/// (typical usage is single-instance; beta-grade tradeoff, documented).
pub fn pid_alive(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
        unsafe {
            match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
                Ok(handle) => {
                    let _ = CloseHandle(handle);
                    true
                }
                // ACCESS_DENIED means the process EXISTS but is unopenable
                // (other user session, shielded process) — that's alive.
                // Treating it as dead would delete a live instance's marker
                // out from under it and synthesize a false crash.
                Err(e) => e.code().0 as u32 == 0x8007_0005,
            }
        }
    }
    #[cfg(target_os = "linux")]
    {
        Path::new(&format!("/proc/{pid}")).exists()
    }
    #[cfg(all(not(windows), not(target_os = "linux")))]
    {
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn marker_filename_roundtrip() {
        assert_eq!(parse_marker_filename("session-1234-999.json"), Some((1234, 999)));
        assert_eq!(parse_marker_filename("session-1234.json"), None);
        assert_eq!(parse_marker_filename("breadcrumbs-1234.jsonl"), None);
        assert_eq!(parse_marker_filename("session-x-y.json"), None);
    }

    #[test]
    fn own_pid_is_alive() {
        assert!(pid_alive(std::process::id()));
    }

    #[test]
    fn marker_serializes_camel_case() {
        let m = Marker {
            pid: 1,
            start_ms: 2,
            phase: "boot".into(),
            state: "running".into(),
            litria_version: "0.9".into(),
        };
        let json = serialize(&m);
        assert!(json.contains("\"startMs\":2"));
        assert!(json.contains("\"litriaVersion\""));
    }
}
