// Crash record writing + retention.
//
// One FRESH file per crash — `crash-<unix_ms>-<pid>-<layer>.json`, created
// with create_new + a single write + sync_all. Never append to a shared file
// at crash time: a half-written unique file is a degraded report, not
// corruption. Pruning happens at startup only, never at crash time.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;

/// Build the path for a new crash record. Uniqueness comes from ms + pid;
/// a same-ms collision falls back to create_new failing and a `-b` suffix.
fn record_path(layer: &str, ts_ms: u64) -> Option<PathBuf> {
    let env = super::env()?;
    Some(
        env.crashes_dir
            .join(format!("crash-{ts_ms}-{}-{layer}.json", env.pid)),
    )
}

/// Write a complete JSON string as a fresh crash record. Returns the path.
/// Everything is best-effort; errors are swallowed (the crash system never
/// takes the app down).
pub fn write_json(layer: &str, json: &str) -> Option<PathBuf> {
    let ts = super::now_ms();
    let path = record_path(layer, ts)?;
    let path = if path.exists() {
        path.with_extension("b.json")
    } else {
        path
    };
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .ok()?;
    file.write_all(json.as_bytes()).ok()?;
    let _ = file.sync_all();
    Some(path)
}

/// Serialize a serde value and write it. Used by the JS-record command and
/// the scan synthesizer (NOT by the panic hook, which builds its JSON by
/// concatenation to stay simple under duress).
pub fn write_value(layer: &str, value: &serde_json::Value) -> Option<PathBuf> {
    let json = serde_json::to_string_pretty(value).ok()?;
    write_json(layer, &json)
}

/// Keep the newest `keep` crash files; delete the rest. Startup-only.
pub fn prune(keep: usize) {
    let Some(env) = super::env() else { return };
    let Ok(entries) = std::fs::read_dir(&env.crashes_dir) else {
        return;
    };
    let mut files: Vec<PathBuf> = entries
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.starts_with("crash-") && n.ends_with(".json"))
                .unwrap_or(false)
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    // Filenames embed the ms timestamp right after "crash-", so a plain
    // name sort is a chronological sort (same-width epoch ms until 2286).
    files.sort();
    let excess = files.len() - keep;
    for path in files.into_iter().take(excess) {
        let _ = std::fs::remove_file(path);
    }
}

/// Timestamp in RFC3339 for record bodies.
pub fn iso_now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}
