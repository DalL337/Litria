// interactive_pty_repro.rs — reproduction harness for the deferred bug
// "terminal hangs on interactive npm prompts" (npm create vite freezes at
// "Ok to proceed?"). NOT part of the normal suite — every test is #[ignore];
// run explicitly with:
//
//   cargo test --test interactive_pty_repro -- --ignored --nocapture
//
// ── FINDINGS (2026-07-07 investigation) ────────────────────────────────────
// Root cause: Windows 10's in-box conhost delivers interactive prompt frames
// PARTIALLY — create-vite's clack prompt ("Which linter to use?") was cut
// mid-escape-sequence after the first `│`, so the question never rendered
// and the CLI waited forever on invisible UI. Input still worked (any
// keypress makes clack re-render, flushing the pipe). Env filtering and the
// forced TERM were exonerated (readline probes pass under all variants).
//
// Fix: sideload Microsoft's ConPTY redistributable — portable-pty prefers
// conpty.dll + OpenConsole.exe next to the executable over kernel32
// (psuedocon.rs). Staged by scripts/bundle-conpty.mjs; bundled beside
// litria.exe via tauri.conf.json resource mapping. With the sideloaded host
// the full prompt renders and the "hang" is just a visible question.
//
// To A/B here: the npm probes pick up conpty.dll/OpenConsole.exe from
// target/debug/deps/ (the test exe's dir) when present — `npm run
// bundle:conpty` mirrors into target/debug/, copy the pair into deps/ to
// test the fixed host; remove them to reproduce the OS-conhost stall.
//
// Two side findings, both load-bearing for future PTY consumers:
// - Shells block at startup on terminal queries (PowerShell emits ESC[6n
//   and waits for a cursor-position report). Any programmatic PTY consumer
//   must answer DSR/DA or nothing ever prompts. (xterm.js does this in-app.)
// - Kill-before-exit wedges ClosePseudoConsole forever; graceful `exit`
//   first (the app's teardown strategy) is mandatory. This harness hung
//   twice exactly that way before adopting it.
//
// Strategy: drive the same portable-pty spawn shape the app uses
// (terminal_pty::spawn_pty), but with the reader as a plain thread capturing
// into a buffer, and the environment built three ways to isolate the trigger:
//   app      — allowlist-filtered + forced TERM/COLORTERM (exact app behavior;
//              mirror of terminal_policy::build_pty_environment, which is
//              pub(crate) and out of reach for an integration test)
//   app_no_term — allowlist-filtered, WITHOUT the forced TERM trio
//   full     — full inherited environment (what VS Code's terminal does)

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[cfg(target_os = "windows")]
const ALLOWED_ENV_KEYS: &[&str] = &[
    "PATH", "PATHEXT", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
    "TMP", "TEMP", "USERPROFILE", "USERNAME", "HOMEDRIVE", "HOMEPATH",
    "APPDATA", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMDATA",
];

#[cfg(not(target_os = "windows"))]
const ALLOWED_ENV_KEYS: &[&str] = &[
    "PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "SHELL",
    "LANG", "LC_ALL", "LC_CTYPE", "XDG_CONFIG_HOME", "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR", "EDITOR", "VISUAL",
];

const FORCED_ENV: &[(&str, &str)] = &[
    ("TERM", "xterm-256color"),
    ("COLORTERM", "truecolor"),
    ("TERM_PROGRAM", "litria"),
];

fn filtered_env(force_term: bool) -> HashMap<String, String> {
    let current: HashMap<String, String> = std::env::vars().collect();
    let mut out: HashMap<String, String> = ALLOWED_ENV_KEYS
        .iter()
        .filter_map(|key| {
            // Windows env var names are case-insensitive; match accordingly.
            current
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| ((*key).to_string(), v.clone()))
        })
        .collect();
    if force_term {
        for (key, value) in FORCED_ENV {
            out.insert((*key).to_string(), (*value).to_string());
        }
    }
    out
}

fn full_env() -> HashMap<String, String> {
    std::env::vars().collect()
}

struct Harness {
    output: Arc<Mutex<String>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    _master: Box<dyn portable_pty::MasterPty + Send>,
    child: Box<dyn portable_pty::Child + Send + Sync>,
}

/// Stage checkpoint straight to stderr, bypassing libtest capture, so a
/// hang identifies its exact blocking call even without --nocapture.
fn checkpoint(label: &str, stage: &str) {
    use std::io::Write as _;
    let mut err = std::io::stderr();
    let _ = writeln!(err, "[checkpoint][{label}] {stage}");
    let _ = err.flush();
}

impl Harness {
    fn spawn(label: &str, env: HashMap<String, String>, cwd: &std::path::Path) -> Self {
        checkpoint(label, "openpty: begin");
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize { rows: 30, cols: 120, pixel_width: 0, pixel_height: 0 })
            .expect("openpty");
        checkpoint(label, "openpty: done");

        #[cfg(target_os = "windows")]
        let shell = "powershell.exe";
        #[cfg(not(target_os = "windows"))]
        let shell = "bash";

        let mut cmd = CommandBuilder::new(shell);
        #[cfg(target_os = "windows")]
        cmd.arg("-NoLogo");
        cmd.cwd(cwd);
        for (key, value) in &env {
            cmd.env(key, value);
        }

        let child = pair.slave.spawn_command(cmd).expect("spawn shell");
        drop(pair.slave);
        checkpoint(label, "shell spawned");

        let mut reader = pair.master.try_clone_reader().expect("reader");
        let writer: Arc<Mutex<Box<dyn Write + Send>>> =
            Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));
        checkpoint(label, "reader/writer acquired");

        // The reader must play terminal emulator, like xterm.js does in the
        // app: shells and CLI tools inside ConPTY emit query sequences and
        // BLOCK until the terminal answers. Observed live: PowerShell startup
        // stalls forever on DSR (ESC[6n, wants a cursor-position report).
        // We answer DSR and DA1; everything else is just accumulated.
        let output = Arc::new(Mutex::new(String::new()));
        let sink = Arc::clone(&output);
        let responder = Arc::clone(&writer);
        std::thread::spawn(move || {
            let mut buf = [0u8; 16 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let chunk = String::from_utf8_lossy(&buf[..n]).to_string();
                        let mut replies = Vec::new();
                        if chunk.contains("\x1b[6n") {
                            replies.extend_from_slice(b"\x1b[1;1R"); // CPR
                        }
                        if chunk.contains("\x1b[c") || chunk.contains("\x1b[0c") {
                            replies.extend_from_slice(b"\x1b[?1;2c"); // DA1: VT100 + AVO
                        }
                        if !replies.is_empty() {
                            if let Ok(mut w) = responder.lock() {
                                let _ = w.write_all(&replies);
                                let _ = w.flush();
                            }
                        }
                        if let Ok(mut guard) = sink.lock() {
                            guard.push_str(&chunk);
                        }
                    }
                }
            }
        });

        Harness { output, writer, _master: pair.master, child }
    }

    fn send(&mut self, data: &str) {
        let mut writer = self.writer.lock().expect("writer lock");
        writer.write_all(data.as_bytes()).expect("write");
        writer.flush().expect("flush");
    }

    /// Wait until any of `markers` appears in output accumulated AFTER `from`.
    /// Returns the matched marker, or None on timeout.
    fn wait_for(&self, markers: &[&str], from: usize, timeout: Duration) -> Option<String> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            {
                let guard = self.output.lock().unwrap();
                let haystack = &guard[from.min(guard.len())..];
                for marker in markers {
                    if haystack.contains(marker) {
                        return Some((*marker).to_string());
                    }
                }
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        None
    }

    fn output_len(&self) -> usize {
        self.output.lock().unwrap().len()
    }

    fn dump(&self, label: &str) {
        let guard = self.output.lock().unwrap();
        eprintln!("──── output [{label}] ({} bytes) ────", guard.len());
        // Last 4KB is plenty; strip nothing — raw escapes help diagnosis.
        let tail_start = guard.len().saturating_sub(4096);
        eprintln!("{}", &guard[tail_start..]);
        eprintln!("──── end output [{label}] ────");
    }
}

impl Drop for Harness {
    // Mirror the app's teardown (terminal_pty.rs): a clean shell exit lets
    // conhost close the pipes itself. Kill-first leaves conhost waiting and
    // wedges the subsequent master drop (ClosePseudoConsole) forever —
    // observed live in this harness's first two runs.
    fn drop(&mut self) {
        checkpoint("harness", "drop: sending graceful exit");
        if let Ok(mut writer) = self.writer.lock() {
            let _ = writer.write_all(&[0x03]);
            let _ = writer.write_all(b"exit\r\n");
            let _ = writer.flush();
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        let mut exited = false;
        while Instant::now() < deadline {
            if matches!(self.child.try_wait(), Ok(Some(_))) {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if !exited {
            checkpoint("harness", "drop: graceful exit timed out; killing");
            let _ = self.child.kill();
            let _ = self.child.try_wait();
        }
        checkpoint("harness", "drop: done (master drop follows)");
    }
}

/// Cheap prompt round-trip: node readline question -> answer -> echo.
/// No network. If this fails, plain interactive stdin is broken in the
/// app's PTY configuration; if it passes, the failure is npm-specific.
fn run_readline_probe(label: &str, env: HashMap<String, String>) -> bool {
    let dir = std::env::temp_dir().join(format!("litria-pty-repro-{label}"));
    std::fs::create_dir_all(&dir).expect("temp dir");
    let script = dir.join("probe.js");
    std::fs::write(
        &script,
        "const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });\n\
         rl.question('PROBE_PROMPT? ', (answer) => { console.log('PROBE_GOT:' + answer); process.exit(0); });\n",
    )
    .expect("write probe");

    let mut h = Harness::spawn(label, env, &dir);
    // Let the shell settle, then run the probe.
    std::thread::sleep(Duration::from_millis(1500));
    checkpoint(label, "sending: node probe.js");
    h.send("node probe.js\r\n");
    checkpoint(label, "sent; waiting for prompt");

    let Some(_) = h.wait_for(&["PROBE_PROMPT?"], 0, Duration::from_secs(20)) else {
        h.dump(label);
        eprintln!("[{label}] FAIL: prompt never appeared");
        return false;
    };
    checkpoint(label, "prompt seen; answering");
    let seen = h.output_len();
    h.send("yes\r\n");
    let ok = h.wait_for(&["PROBE_GOT:yes"], seen, Duration::from_secs(15)).is_some();
    checkpoint(label, "answer round-trip evaluated");
    if !ok {
        h.dump(label);
        eprintln!("[{label}] FAIL: answer never echoed back through readline");
    } else {
        eprintln!("[{label}] OK: readline round-trip completed");
    }
    ok
}

/// The real thing: npm create vite with an empty npm cache so the
/// "Ok to proceed? (y)" confirmation is guaranteed to appear.
/// Requires network; takes ~30-90s. `answer` lets probes compare "y\r\n"
/// (what xterm.js sends for typed y + Enter) against "y\r" alone — a stray
/// LF left in the console input buffer is a suspect for wedging the
/// raw-mode reader that create-vite's clack UI installs next.
fn run_npm_create_probe(label: &str, env: HashMap<String, String>, answer: &str) -> bool {
    let dir = std::env::temp_dir().join(format!("litria-npm-repro-{label}"));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    let cache = dir.join("npm-cache");

    let mut h = Harness::spawn(label, env, &dir);
    std::thread::sleep(Duration::from_millis(1500));
    checkpoint(label, "sending npm create vite");
    h.send(&format!(
        "npm create vite@latest repro-app --cache \"{}\" -- --template react-ts\r\n",
        cache.display()
    ));

    // Empty cache forces npm exec's install confirmation.
    let hit = h.wait_for(
        &["Ok to proceed?", "Scaffolding project", "Done. Now run"],
        0,
        Duration::from_secs(120),
    );
    let Some(marker) = hit else {
        h.dump(label);
        eprintln!("[{label}] FAIL: neither the proceed prompt nor scaffold output appeared");
        return false;
    };

    if marker == "Ok to proceed?" {
        let seen = h.output_len();
        h.send(answer);
        // create-vite 9 renders progress through @clack/prompts — match its
        // strings, not just the legacy ones. Poll with a liveness trace so a
        // full stall is distinguishable from a slow drip.
        let success_markers = [
            "Scaffolding project",
            "Scaffolding",
            "Done. Now run",
            "cd repro-app",
            "npm install",
        ];
        let deadline = Instant::now() + Duration::from_secs(120);
        let started = Instant::now();
        let mut last_len = h.output_len();
        let mut last_report = Instant::now();
        let mut matched = None;
        // Stall forensics: once the stream has been silent past each
        // threshold, (a) snapshot which child processes are alive, and
        // (b) poke the PTY with fresh input — if output resumes, the
        // "wedge" is actually an invisible prompt waiting on stdin; if
        // nothing revives it, the ConPTY output pipe itself is dead.
        let mut did_snapshot = false;
        let mut did_poke_enter = false;
        let mut did_poke_key = false;
        while Instant::now() < deadline {
            if let Some(m) = h.wait_for(&success_markers, seen, Duration::from_millis(500)) {
                matched = Some(m);
                break;
            }
            let silent = started.elapsed();
            if !did_snapshot && silent >= Duration::from_secs(30) {
                did_snapshot = true;
                for image in ["node.exe", "OpenConsole.exe", "conhost.exe"] {
                    let snapshot = std::process::Command::new("tasklist")
                        .args(["/FI", &format!("IMAGENAME eq {image}"), "/FO", "CSV", "/NH"])
                        .output()
                        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
                        .unwrap_or_else(|e| format!("tasklist failed: {e}"));
                    checkpoint(label, &format!("stall snapshot {image}: {snapshot}"));
                }
                // What has the terminal actually rendered at the stall?
                // Distinguishes "question visible, waiting for an answer"
                // (healthy) from "frame cut mid-escape" (conhost bug).
                h.dump(&format!("{label}-at-stall"));
            }
            if !did_poke_enter && silent >= Duration::from_secs(45) {
                did_poke_enter = true;
                checkpoint(label, "poking with \\r");
                h.send("\r");
            }
            if !did_poke_key && silent >= Duration::from_secs(70) {
                did_poke_key = true;
                checkpoint(label, "poking with 'y' + \\r");
                h.send("y\r");
            }
            if last_report.elapsed() >= Duration::from_secs(15) {
                let len = h.output_len();
                checkpoint(label, &format!(
                    "liveness: output {} bytes ({} new in last 15s)",
                    len,
                    len.saturating_sub(last_len)
                ));
                last_len = len;
                last_report = Instant::now();
            }
        }
        let ok = matched.is_some();
        if !ok {
            h.dump(label);
            eprintln!("[{label}] FAIL: answered but scaffold never proceeded — HANG REPRODUCED");
        } else {
            eprintln!("[{label}] OK: proceed prompt answered, scaffold progressed ({})", matched.unwrap());
        }
        return ok;
    }

    eprintln!("[{label}] OK (prompt skipped — scaffold ran through): {marker}");
    true
}

// ── readline probes (offline) ──────────────────────────────────────────────

#[test]
#[ignore]
fn readline_app_env() {
    assert!(run_readline_probe("app", filtered_env(true)));
}

#[test]
#[ignore]
fn readline_app_env_without_term() {
    assert!(run_readline_probe("app-no-term", filtered_env(false)));
}

#[test]
#[ignore]
fn readline_full_env() {
    assert!(run_readline_probe("full", full_env()));
}

// ── npm create vite probes (network) ────────────────────────────────────────

#[test]
#[ignore]
fn npm_create_app_env() {
    assert!(run_npm_create_probe("app", filtered_env(true), "y\r\n"));
}

#[test]
#[ignore]
fn npm_create_app_env_cr_only() {
    assert!(run_npm_create_probe("app-cr", filtered_env(true), "y\r"));
}

#[test]
#[ignore]
fn npm_create_app_env_without_term() {
    assert!(run_npm_create_probe("app-no-term", filtered_env(false), "y\r\n"));
}

#[test]
#[ignore]
fn npm_create_full_env() {
    assert!(run_npm_create_probe("full", full_env(), "y\r\n"));
}
