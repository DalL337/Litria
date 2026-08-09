// WebView2 process-failure watcher (hook #4, Windows).
//
// When the webview's OS processes die, JS hooks are gone and no Rust panic
// fires — only the surviving Rust host can attribute it. Route (research
// 2026-07-06): with_webview → controller().CoreWebView2() → add_ProcessFailed.
//
// Per-kind policy:
//   RenderProcessExited       → record crash + auto-Reload()
//   BrowserProcessExited      → record fatal crash (window is gone)
//   FrameRenderProcessExited  → record, no recovery (single-page app; rare)
//   RenderProcessUnresponsive → re-raises ~every 15s; record a HANG only
//                               after 3 consecutive raises; never auto-reload
//                               (an IDE user may run a legitimately long
//                               script). ExitCode is meaningless (259).
//   Gpu/Utility/Ppapi/etc.    → ignore (auto-recoverable; GPU exits are the
//                               most common WebView2 failure)
//   ExitCode -1073740760      → tag as environment/code-integrity (AV or
//                               injected DLL), not an app bug.
//
// Crate pinning: webview2-com/windows versions must match tauri's own pins
// (0.38 / 0.61 — see Cargo.toml comment) or COM types won't unify.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2ProcessFailedEventArgs, ICoreWebView2ProcessFailedEventArgs2,
    COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
    COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
};
use webview2_com::ProcessFailedEventHandler;
use windows_core::Interface;

const STATUS_INVALID_IMAGE_HASH: i32 = -1073740760; // 0xC0000428

static UNRESPONSIVE_COUNT: AtomicU32 = AtomicU32::new(0);
static UNRESPONSIVE_LAST_MS: AtomicU64 = AtomicU64::new(0);
static HANG_LOGGED: AtomicBool = AtomicBool::new(false);
// Reload-loop brake: a deterministic renderer crash would otherwise reload →
// crash → reload forever, writing unbounded records (prune only runs at
// startup). After the cap, stop auto-reloading AND stop recording.
static RENDER_EXIT_COUNT: AtomicU32 = AtomicU32::new(0);
const RENDER_EXIT_CAP: u32 = 3;

/// Install the ProcessFailed handler on the main window's webview.
/// Call from `setup()`. Every failure inside is swallowed — the watcher is
/// an observer, never a source of instability.
pub fn install(window: &tauri::WebviewWindow) {
    let result = window.with_webview(|platform_webview| unsafe {
        let controller = platform_webview.controller();
        let core = match controller.CoreWebView2() {
            Ok(core) => core,
            Err(e) => {
                eprintln!("[crash] webview watcher: CoreWebView2 unavailable: {e}");
                return;
            }
        };
        let handler = ProcessFailedEventHandler::create(Box::new(on_process_failed));
        // Registration token: raw i64 in these bindings. We never remove the
        // handler (it lives as long as the webview), so the token is dropped.
        let mut token: i64 = 0;
        if let Err(e) = core.add_ProcessFailed(&handler, &mut token) {
            eprintln!("[crash] webview watcher: add_ProcessFailed failed: {e}");
        }
    });
    if let Err(e) = result {
        eprintln!("[crash] webview watcher install failed: {e}");
    }
}

fn on_process_failed(
    sender: Option<ICoreWebView2>,
    args: Option<ICoreWebView2ProcessFailedEventArgs>,
) -> windows_core::Result<()> {
    let Some(args) = args else { return Ok(()) };

    // Sentinel -1: if the COM query fails (e.g. during teardown), the value
    // must NOT stay at default() — kind 0 is BROWSER_PROCESS_EXITED, the most
    // severe classification, and would write a spurious fatal record. -1
    // matches no arm and falls through to the ignore case.
    let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND(-1);
    unsafe {
        let _ = args.ProcessFailedKind(&mut kind);
    }

    // Reason + exit code live on Args2 (best-effort; ints only, no string
    // marshaling — keeps the handler allocation-light and compile-simple).
    let (reason, exit_code) = unsafe {
        match args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
            Ok(args2) => {
                let mut reason = Default::default();
                let mut exit_code: i32 = 0;
                let _ = args2.Reason(&mut reason);
                let _ = args2.ExitCode(&mut exit_code);
                (Some(reason), Some(exit_code))
            }
            Err(_) => (None, None),
        }
    };

    let reason_raw = reason.map(|r| r.0);

    match kind {
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED => {
            let exits = RENDER_EXIT_COUNT.fetch_add(1, Ordering::SeqCst) + 1;
            if exits < RENDER_EXIT_CAP {
                write_webview_record("render-process-exited", "crash", reason_raw, exit_code);
                // Auto-reload: the frontend reboots and re-marks its phase.
                if let Some(core) = sender {
                    unsafe {
                        let _ = core.Reload();
                    }
                }
            } else if exits == RENDER_EXIT_CAP {
                // Deterministic crash loop: one final record, then stop both
                // recording and reloading — leave the error page up rather
                // than spin (prune only runs at startup).
                write_webview_record(
                    "render-process-crash-loop",
                    "crash",
                    reason_raw,
                    exit_code,
                );
            }
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED => {
            write_webview_record("browser-process-exited", "crash", reason_raw, exit_code);
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_FRAME_RENDER_PROCESS_EXITED => {
            write_webview_record("frame-render-process-exited", "crash", reason_raw, exit_code);
        }
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE => {
            handle_unresponsive(reason_raw, exit_code);
        }
        _ => {
            // GPU/utility/plugin exits (and failed kind queries): ignore.
        }
    }
    Ok(())
}

fn handle_unresponsive(reason_raw: Option<i32>, exit_code: Option<i32>) {
    let now = super::now_ms();
    let last = UNRESPONSIVE_LAST_MS.swap(now, Ordering::SeqCst);
    // Raises arrive ~every 15s while hung; a gap over 60s means a new episode.
    let count = if now.saturating_sub(last) > 60_000 {
        UNRESPONSIVE_COUNT.store(1, Ordering::SeqCst);
        HANG_LOGGED.store(false, Ordering::SeqCst);
        1
    } else {
        UNRESPONSIVE_COUNT.fetch_add(1, Ordering::SeqCst) + 1
    };
    if count >= 3
        && HANG_LOGGED
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    {
        write_webview_record("render-process-unresponsive", "hang", reason_raw, exit_code);
    }
}

fn write_webview_record(
    what: &str,
    severity: &str,
    reason_raw: Option<i32>,
    exit_code: Option<i32>,
) {
    let Some(env) = super::env() else { return };

    let code_integrity = exit_code == Some(STATUS_INVALID_IMAGE_HASH);
    let message = if code_integrity {
        format!("WebView2 {what} — code-integrity failure (likely antivirus or an injected DLL), not a Litria bug.")
    } else {
        format!("WebView2 {what} ({severity}).")
    };

    // Real-time breadcrumb attribution: the session's own mirror file.
    let breadcrumbs = super::read_breadcrumbs(&env.breadcrumbs_path);

    let value = serde_json::json!({
        "schema": 1,
        "timestamp": super::record::iso_now(),
        "litriaVersion": env.version,
        "os": super::os_string(),
        "layer": "webview",
        "error": {
            "message": message,
            "source": what,
            "kind": what,
            "severity": severity,
            "reason": reason_raw,
            "exitCode": exit_code,
            "codeIntegrity": code_integrity
        },
        "breadcrumbs": breadcrumbs,
        "session": { "pid": env.pid, "startMs": env.start_ms }
    });
    let _ = super::record::write_value("webview", &value);
}
