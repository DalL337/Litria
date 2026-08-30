// Crash record writing + retention.
//
// One FRESH file per crash — `crash-<unix_ms>-<pid>-<layer>.json`, created
// with create_new + a single write + sync_all. Never append to a shared file
// at crash time: a half-written unique file is a degraded report, not
// corruption. Pruning happens at startup only, never at crash time.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

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

/// Serialize a serde value and write it. Used by the scan synthesizer and the
/// webview watcher (NOT by the panic hook, which builds its JSON by
/// concatenation to stay simple under duress; NOT by the renderer command,
/// which goes through `write_js_value` for its budget).
pub fn write_value(layer: &str, value: &serde_json::Value) -> Option<PathBuf> {
    let json = serde_json::to_string_pretty(value).ok()?;
    write_json(layer, &json)
}

// ---------------------------------------------------------------------------
// Renderer budget (audit #19)
// ---------------------------------------------------------------------------
//
// Every other writer here fires at most once per event the OS or the process
// hands us: one panic, one webview death, one startup synthesis. The renderer
// path is the only one a caller can drive in a loop, and `prune` deliberately
// runs at startup only (no directory I/O at crash time) — so within a session
// nothing bounded it.
//
// The budget is therefore SESSION-scoped and needs no directory I/O at all:
// counters start at zero each process start, and a process start is exactly
// when `prune` runs. Total disk cost is this session's budget plus the pruned
// carry-over. The panic hook's allocation-light path is untouched.

/// Max renderer-originated records per session.
const MAX_JS_RECORDS: usize = 16;
/// Max total renderer-originated bytes per session. Comfortably above the
/// 1 MiB single-record cap in `crash_write_js_record`, so an honest report is
/// never the thing that trips this.
const MAX_JS_BYTES: u64 = 4 * 1024 * 1024;

/// Count + bytes reserved together, so two concurrent commands cannot both
/// pass the check and then both spend.
static JS_BUDGET: Mutex<(usize, u64)> = Mutex::new((0, 0));

/// Outcome of asking the budget for room.
enum Reservation {
    Granted,
    Denied(&'static str),
}

fn reserve_js(bytes: u64) -> Reservation {
    let Ok(mut budget) = JS_BUDGET.lock() else {
        // Poisoned by a panic inside the budget: fail closed. The crash system
        // refusing to write one record is strictly better than it looping.
        return Reservation::Denied("budget lock poisoned");
    };
    let (count, spent) = *budget;
    if count >= MAX_JS_RECORDS {
        return Reservation::Denied("per-session record count");
    }
    if spent.saturating_add(bytes) > MAX_JS_BYTES {
        return Reservation::Denied("per-session byte budget");
    }
    *budget = (count + 1, spent.saturating_add(bytes));
    Reservation::Granted
}

/// Give back a reservation whose write did not land, so a transient disk
/// failure does not silently consume the session's allowance.
fn refund_js(bytes: u64) {
    if let Ok(mut budget) = JS_BUDGET.lock() {
        let (count, spent) = *budget;
        *budget = (count.saturating_sub(1), spent.saturating_sub(bytes));
    }
}

/// Write a renderer-originated crash record, subject to this session's budget.
///
/// Returns `None` when the budget is exhausted — same shape the caller already
/// uses for an over-size record, so the frontend needs no new handling. The
/// refusal is logged rather than silent (security-policy Rule 4).
pub fn write_js_value(layer: &str, value: &serde_json::Value) -> Option<PathBuf> {
    let json = serde_json::to_string_pretty(value).ok()?;
    let bytes = json.len() as u64;

    if let Reservation::Denied(reason) = reserve_js(bytes) {
        eprintln!(
            "[crash] renderer record refused: {reason} reached ({MAX_JS_RECORDS} records / {MAX_JS_BYTES} bytes per session)"
        );
        return None;
    }

    match write_json(layer, &json) {
        Some(path) => Some(path),
        None => {
            refund_js(bytes);
            None
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn reset_js_budget() {
        *JS_BUDGET.lock().unwrap() = (0, 0);
    }

    fn granted(bytes: u64) -> bool {
        matches!(reserve_js(bytes), Reservation::Granted)
    }

    /// One test, three phases: `JS_BUDGET` is process-global, so splitting
    /// these would let cargo's parallel runner interleave them.
    #[test]
    fn js_budget_bounds_count_bytes_and_refunds() {
        // -- count cap -------------------------------------------------------
        reset_js_budget();
        for i in 0..MAX_JS_RECORDS {
            assert!(granted(1), "record {i} should fit the count budget");
        }
        assert!(
            !granted(1),
            "record {MAX_JS_RECORDS} must be refused once the count cap is reached"
        );

        // -- byte cap, well inside the count cap ------------------------------
        reset_js_budget();
        assert!(granted(MAX_JS_BYTES - 1));
        assert!(
            !granted(2),
            "a reservation crossing the byte budget must be refused"
        );
        assert!(granted(1), "a reservation landing exactly on the cap fits");

        // -- refund restores exactly what a failed write reserved --------------
        reset_js_budget();
        for _ in 0..MAX_JS_RECORDS {
            assert!(granted(10));
        }
        assert!(!granted(10), "at the count cap");
        refund_js(10);
        assert!(granted(10), "refund must free the slot a failed write took");

        reset_js_budget();
    }

    #[test]
    fn byte_budget_leaves_room_for_several_max_size_records() {
        // `crash_write_js_record` refuses any single record over 1 MiB. The
        // session budget must not be tighter than that, or one honest report
        // would exhaust it.
        const SINGLE_RECORD_CAP: u64 = 1_048_576;
        assert!(
            MAX_JS_BYTES >= SINGLE_RECORD_CAP * 2,
            "byte budget must hold more than a single max-size record"
        );
        assert!(MAX_JS_RECORDS >= 2);
    }
}
