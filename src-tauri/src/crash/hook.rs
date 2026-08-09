// Rust panic hook (hook #3) — hardened per the 2026-07-06 research.
//
// The hook body must be PANIC-FREE: a panic inside a panic hook is a
// double panic → silent abort → report lost. Hence:
//   - no unwrap/expect/indexing; every Result is `let _ =` or matched
//   - no locks; reentrancy guarded by an AtomicBool
//   - minimal facts hit disk FIRST (complete valid JSON + sync), then the
//     expensive backtrace pass rewrites an enriched record over it —
//     if the enrichment dies, the minimal record survives
//   - all paths/static context were pre-resolved at init
//
// Scope honesty: this catches pure-Rust panics only. Stack overflow, C
// aborts, heap corruption, OOM-kills bypass it — that's the marker's remit.

use std::panic::PanicHookInfo;
use std::sync::atomic::{AtomicBool, Ordering};

static IN_HOOK: AtomicBool = AtomicBool::new(false);

pub fn install() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if IN_HOOK
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            write_crash_record(info);
            IN_HOOK.store(false, Ordering::SeqCst);
        }
        // Chain the default hook so dev stderr output survives.
        previous(info);
    }));
}

fn json_str(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"?\"".to_string())
}

fn panic_message(info: &PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "non-string panic payload".to_string()
    }
}

fn write_crash_record(info: &PanicHookInfo<'_>) {
    let Some(env) = super::env() else { return };

    let message = panic_message(info);
    let source = info
        .location()
        .map(|l| format!("{}:{}", l.file(), l.line()))
        .unwrap_or_else(|| "unknown".to_string());
    let thread = std::thread::current()
        .name()
        .unwrap_or("unnamed")
        .to_string();
    let timestamp = super::record::iso_now();

    // Phase 1: minimal complete record, written + synced.
    let minimal = format!(
        "{{\"schema\":1,\"timestamp\":{ts},{ctx},\"layer\":\"rust\",\"error\":{{\"message\":{msg},\"source\":{src}}},\"thread\":{thr}}}",
        ts = json_str(&timestamp),
        ctx = env.static_ctx,
        msg = json_str(&message),
        src = json_str(&source),
        thr = json_str(&thread),
    );
    let Some(path) = super::record::write_json("rust", &minimal) else {
        return;
    };

    // Phase 2: enrich with a backtrace (allocates; Display resolution is the
    // expensive part) and rewrite over the synced minimal record.
    let backtrace = format!("{}", std::backtrace::Backtrace::force_capture());
    let enriched = format!(
        "{{\"schema\":1,\"timestamp\":{ts},{ctx},\"layer\":\"rust\",\"error\":{{\"message\":{msg},\"source\":{src},\"stack\":{bt}}},\"thread\":{thr}}}",
        ts = json_str(&timestamp),
        ctx = env.static_ctx,
        msg = json_str(&message),
        src = json_str(&source),
        bt = json_str(&backtrace),
        thr = json_str(&thread),
    );
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, &enriched).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}
