// Startup scan — the "next-launch notice" data source.
//
// Finds (a) crash records the user hasn't seen yet, and (b) stale markers
// from dead sessions. A stale marker with no crash record explaining that
// session synthesizes an `unclean-shutdown` record from the dead session's
// breadcrumb mirror ("it died and didn't say goodbye").

use serde::Serialize;
use std::path::PathBuf;

use super::marker;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CrashNotice {
    pub file_name: String,
    pub path: String,
    pub layer: String,
    pub timestamp: String,
    pub message: String,
    pub litria_version: String,
    pub os: String,
}

fn seen_path() -> Option<PathBuf> {
    Some(super::env()?.state_dir.join("seen.json"))
}

fn load_seen() -> Vec<String> {
    let Some(path) = seen_path() else {
        return Vec::new();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

pub fn mark_seen(mut file_names: Vec<String>) {
    let Some(path) = seen_path() else { return };
    let mut seen = load_seen();
    seen.append(&mut file_names);
    // Cap: only the newest 100 names matter (prune keeps 20 records anyway).
    if seen.len() > 100 {
        let start = seen.len() - 100;
        seen.drain(..start);
    }
    if let Ok(json) = serde_json::to_string(&seen) {
        let _ = super::replace_file(&path, &json);
    }
}

/// Marker-side scan: for each marker not belonging to a live process,
/// synthesize an unclean-shutdown record if nothing else explains that
/// session, then remove the marker + its breadcrumb mirror.
fn scan_stale_markers() {
    let Some(env) = super::env() else { return };
    let Ok(entries) = std::fs::read_dir(&env.state_dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()).map(String::from) else {
            continue;
        };
        let Some((pid, start_ms)) = marker::parse_marker_filename(&name) else {
            continue;
        };
        if pid == env.pid {
            continue; // our own live marker
        }
        if marker::pid_alive(pid) {
            continue; // another live instance
        }

        let contents = std::fs::read_to_string(&path).unwrap_or_default();
        let parsed: Option<marker::Marker> = serde_json::from_str(&contents).ok();
        let is_clean = parsed
            .as_ref()
            .map(|m| m.state == "clean")
            .unwrap_or(false);

        if !is_clean {
            // Only synthesize if no crash record already explains THAT
            // session — matched by the writing pid embedded in the record
            // filename plus recency. Without the pid correlation, any newer
            // record (even another marker's synthesized one earlier in this
            // very loop) would suppress genuine reports.
            if !has_record_for_session(pid, start_ms) {
                synthesize_unclean(pid, start_ms, parsed.as_ref());
            }
        }
        marker::remove_with_retry(&path);
        marker::remove_with_retry(&env.state_dir.join(format!("breadcrumbs-{pid}.jsonl")));
    }

    sweep_orphan_mirrors();
}

/// Breadcrumb mirrors can outlive their marker (a late debounced flush after
/// mark_clean recreates the file). Sweep any mirror whose pid is not a live
/// process and has no marker left — otherwise orphans accumulate and a
/// pid-reuse could attach a previous session's crumbs to a new record.
fn sweep_orphan_mirrors() {
    let Some(env) = super::env() else { return };
    let Ok(entries) = std::fs::read_dir(&env.state_dir) else {
        return;
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(pid) = name
            .strip_prefix("breadcrumbs-")
            .and_then(|r| r.strip_suffix(".jsonl"))
            .and_then(|p| p.parse::<u32>().ok())
        else {
            continue;
        };
        if pid == env.pid || marker::pid_alive(pid) {
            continue;
        }
        marker::remove_with_retry(&path);
    }
}

/// True when a crash record written by session `pid` at/after `start_ms`
/// exists. Record filenames are `crash-<ts_ms>-<pid>-<layer>.json`.
fn has_record_for_session(pid: u32, start_ms: u64) -> bool {
    let Some(env) = super::env() else { return false };
    let Ok(entries) = std::fs::read_dir(&env.crashes_dir) else {
        return false;
    };
    entries.filter_map(|e| e.ok()).any(|e| {
        let name = e.file_name();
        let Some(rest) = name.to_str().and_then(|n| n.strip_prefix("crash-")) else {
            return false;
        };
        let mut parts = rest.split('-');
        let ts_ok = parts
            .next()
            .and_then(|ts| ts.parse::<u64>().ok())
            .map(|ts| ts >= start_ms)
            .unwrap_or(false);
        let pid_ok = parts
            .next()
            .and_then(|p| p.parse::<u32>().ok())
            .map(|p| p == pid)
            .unwrap_or(false);
        ts_ok && pid_ok
    })
}

fn synthesize_unclean(pid: u32, start_ms: u64, parsed: Option<&marker::Marker>) {
    let Some(env) = super::env() else { return };
    let phase = parsed
        .map(|m| m.phase.clone())
        .unwrap_or_else(|| "unknown".to_string());
    let dead_version = parsed
        .map(|m| m.litria_version.clone())
        .unwrap_or_else(|| "unknown".to_string());

    // Breadcrumb tail from the dead session's own mirror file.
    let breadcrumbs =
        super::read_breadcrumbs(&env.state_dir.join(format!("breadcrumbs-{pid}.jsonl")));

    let value = serde_json::json!({
        "schema": 1,
        "timestamp": super::record::iso_now(),
        "litriaVersion": dead_version,
        "os": super::os_string(),
        "layer": "unclean-shutdown",
        "error": {
            "message": format!(
                "Litria did not shut down cleanly (last phase: {phase})."
            ),
            "source": format!("session pid {pid}, started {start_ms}")
        },
        "breadcrumbs": breadcrumbs,
        "session": { "pid": pid, "startMs": start_ms }
    });
    let _ = super::record::write_value("unclean-shutdown", &value);
}

/// Full startup scan: process stale markers first (may synthesize records),
/// then list unseen crash records for the banner.
pub fn startup_scan() -> Vec<CrashNotice> {
    scan_stale_markers();

    let Some(env) = super::env() else {
        return Vec::new();
    };
    let seen = load_seen();
    let Ok(entries) = std::fs::read_dir(&env.crashes_dir) else {
        return Vec::new();
    };

    let mut notices: Vec<CrashNotice> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| {
            let path = e.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !name.starts_with("crash-") || !name.ends_with(".json") {
                return None;
            }
            if seen.contains(&name) {
                return None;
            }
            let body = std::fs::read_to_string(&path).ok()?;
            let value: serde_json::Value = serde_json::from_str(&body).ok()?;
            Some(CrashNotice {
                path: path.to_string_lossy().into_owned(),
                file_name: name,
                layer: value
                    .get("layer")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                timestamp: value
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                message: value
                    .pointer("/error/message")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(200)
                    .collect(),
                litria_version: value
                    .get("litriaVersion")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
                os: value
                    .get("os")
                    .and_then(|v| v.as_str())
                    .unwrap_or("unknown")
                    .to_string(),
            })
        })
        .collect();

    notices.sort_by(|a, b| b.file_name.cmp(&a.file_name)); // newest first
    notices
}
