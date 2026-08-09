//! Generic LSP stdio transport layer.
//!
//! Responsibilities:
//! - Spawn the language server process with stdin/stdout piped.
//! - Write JSON-RPC messages to the process stdin with Content-Length framing.
//! - Read Content-Length-framed messages from the process stdout.
//! - Route incoming messages to the session dispatch layer.
//!
//! This module knows nothing about any specific language.  All language-specific
//! config comes in via `LanguagePack`.

use std::collections::VecDeque;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::Value;
use tauri::AppHandle;

use crate::lsp::packs::{CwdPolicy, LanguagePack, ResolvedCommand, ResolutionTier};
use crate::lsp::types::IncomingMessage;

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/// A handle to a live transport connection.
///
/// Dropping this does NOT kill the process — call `shutdown()` first, then
/// let `LspProcess::kill_if_alive()` finish cleanup.
pub(crate) struct LspTransport {
    /// Locked stdin — all writes go through here.
    /// `pub(crate)` so `session_request` can clone the Arc and write without
    /// holding the global sessions mutex across a blocking recv_timeout.
    pub(crate) stdin: Arc<Mutex<ChildStdin>>,
    /// The child process (owned so we can wait/kill on shutdown).
    child: Arc<Mutex<Child>>,
    /// Monotonically-increasing request ID counter.
    /// `pub(crate)` for the same reason as `stdin`.
    pub(crate) next_id: Arc<Mutex<u64>>,
    /// Set to `true` before an intentional shutdown so the read-loop thread
    /// does not fire the crash handler when the process exits normally.
    is_stopping: Arc<AtomicBool>,
}

impl LspTransport {
    /// Write a JSON-RPC message to the server's stdin.
    ///
    /// Applies Content-Length framing per the LSP wire format.
    pub(crate) fn write_message(&self, value: &Value) -> Result<(), String> {
        let body = serde_json::to_string(value)
            .map_err(|e| format!("LSP serialize error: {e}"))?;
        write_message_to(&mut *self.stdin.lock().unwrap(), &body)
    }

    /// Allocate and return the next monotonically-increasing request ID.
    pub(crate) fn next_request_id(&self) -> u64 {
        let mut guard = self.next_id.lock().unwrap();
        let id = *guard;
        *guard = id + 1;
        id
    }

    /// Signal that the shutdown is intentional so the read-loop thread does
    /// not treat the subsequent EOF as a crash.  Must be called before `kill`.
    pub(crate) fn mark_stopping(&self) {
        self.is_stopping.store(true, Ordering::Relaxed);
    }

    /// Kill the server process immediately (no graceful shutdown).
    pub(crate) fn kill(&self) {
        let _ = self.child.lock().unwrap().kill();
    }

    /// Wait for the process to exit and return its exit status.
    ///
    /// Should be called after sending the LSP `shutdown` + `exit` sequence.
    // Not on any current path — teardown kills today; the graceful
    // shutdown→exit→wait cascade (Orchestration §1.2 ordering) is the
    // deferred caller.
    #[allow(dead_code)]
    pub(crate) fn wait(&self) -> Option<std::process::ExitStatus> {
        self.child.lock().unwrap().wait().ok()
    }
}

// ---------------------------------------------------------------------------
// Stderr tail — bounded ring of the server's most recent stderr lines
// ---------------------------------------------------------------------------

/// Servers write their death rattle to stderr (pyright's "EOF reading
/// headers", node stack traces) — previously discarded (`Stdio::null`),
/// which left every crash report saying only "exited unexpectedly" (#154
/// follow-up). A bounded ring keeps the recent tail cheaply; the crash
/// handler snapshots it into the `lsp:error` payload.
pub(crate) type StderrTail = Arc<Mutex<VecDeque<String>>>;

const STDERR_TAIL_MAX_LINES: usize = 30;
const STDERR_TAIL_MAX_LINE_CHARS: usize = 300;

pub(crate) fn new_stderr_tail() -> StderrTail {
    Arc::new(Mutex::new(VecDeque::new()))
}

/// Snapshot the ring oldest-first. Empty when the server never wrote stderr.
pub(crate) fn snapshot_stderr_tail(tail: &StderrTail) -> Vec<String> {
    tail.lock()
        .map(|deque| deque.iter().cloned().collect())
        .unwrap_or_default()
}

fn truncated_line(line: &str, max_chars: usize) -> String {
    if line.chars().count() <= max_chars {
        return line.to_string();
    }
    let mut out: String = line.chars().take(max_chars).collect();
    out.push('…');
    out
}

/// Drain a stderr stream line-by-line into the ring until EOF (= process
/// exit). Generic over `Read` so the ring semantics are unit-testable
/// without spawning a process.
fn drain_stderr_into_tail<R: Read>(stderr: R, tail: &StderrTail) {
    let reader = BufReader::new(stderr);
    for line in reader.lines() {
        let Ok(line) = line else { break };
        if let Ok(mut deque) = tail.lock() {
            if deque.len() == STDERR_TAIL_MAX_LINES {
                deque.pop_front();
            }
            deque.push_back(truncated_line(&line, STDERR_TAIL_MAX_LINE_CHARS));
        }
    }
}

// ---------------------------------------------------------------------------
// Process spawn
// ---------------------------------------------------------------------------

/// Spawn the language server process and start the read loop.
///
/// `resolved` is the output of the resolver — it tells us the concrete
/// executable path and how the server was found (global/managed/bundled).
///
/// Returns the transport handle.  The `on_message` callback is called from the
/// background read thread for every fully-parsed message.
///
/// `on_crash` is called once if the server process exits without
/// `mark_stopping()` having been called first (i.e. an unexpected crash).
pub(crate) fn spawn_server(
    pack: &LanguagePack,
    resolved: &ResolvedCommand,
    project_root: &str,
    app: AppHandle,
    stderr_tail: StderrTail,
    on_message: impl Fn(AppHandle, IncomingMessage) + Send + 'static,
    on_crash: impl FnOnce() + Send + 'static,
) -> Result<LspTransport, String> {
    let mut cmd = match resolved.tier {
        ResolutionTier::Global => {
            // Global tier: preserve existing Windows .cmd resolution to avoid
            // cmd.exe buffering in the stdio pipe chain.
            #[cfg(not(windows))]
            { Command::new(pack.command) }
            #[cfg(windows)]
            {
                match resolve_cmd_to_node(pack.command) {
                    Some((node_exe, script_path)) => {
                        let mut c = Command::new(node_exe);
                        c.arg(script_path);
                        c
                    }
                    None => {
                        // Fallback: try cmd /C for non-npm executables
                        let mut c = Command::new("cmd");
                        c.arg("/C").arg(pack.command);
                        c
                    }
                }
            }
        }
        ResolutionTier::Managed | ResolutionTier::Bundled => {
            // Managed/bundled: executable is a fully resolved path (e.g.
            // node.exe for JS servers).  prefix_args carries the script path.
            // No .cmd resolution needed — we already know the exact paths.
            let mut c = Command::new(&resolved.executable);
            for arg in &resolved.prefix_args {
                c.arg(arg);
            }
            c
        }
    };
    cmd.args(&pack.args);
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    // Working directory
    match &pack.cwd_policy {
        CwdPolicy::ProjectRoot => {
            cmd.current_dir(project_root);
        }
    }

    // Build a clean environment from the allowlist.
    // On Windows, cmd.exe and node require certain system vars to function.
    cmd.env_clear();
    #[cfg(windows)]
    for key in &["SystemRoot", "SystemDrive", "COMSPEC", "PATHEXT"] {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }
    for key in &pack.env_allowlist {
        if let Ok(val) = std::env::var(key) {
            cmd.env(key, val);
        }
    }

    let spawn_label = match resolved.tier {
        ResolutionTier::Global => pack.command.to_string(),
        _ => resolved.executable.display().to_string(),
    };
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {spawn_label}: {e}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or("Failed to acquire stdin handle")?;

    let stdout = child
        .stdout
        .take()
        .ok_or("Failed to acquire stdout handle")?;

    let stderr = child
        .stderr
        .take()
        .ok_or("Failed to acquire stderr handle")?;

    // Stderr must be drained even if nobody ever reads the tail — a full
    // pipe buffer would block the server. The thread exits at stderr EOF
    // (= process exit).
    thread::Builder::new()
        .name(format!("lsp-stderr:{}", pack.language_id))
        .spawn(move || drain_stderr_into_tail(stderr, &stderr_tail))
        .map_err(|e| format!("Failed to start LSP stderr thread: {e}"))?;

    let stdin_arc = Arc::new(Mutex::new(stdin));
    let child_arc = Arc::new(Mutex::new(child));
    let is_stopping = Arc::new(AtomicBool::new(false));
    let is_stopping_cb = Arc::clone(&is_stopping);

    // Spawn the blocking read loop on a dedicated OS thread.
    let reader = BufReader::new(stdout);
    thread::Builder::new()
        .name(format!("lsp-read:{}", pack.language_id))
        .spawn(move || read_loop(reader, app, is_stopping_cb, on_message, on_crash))
        .map_err(|e| format!("Failed to start LSP read thread: {e}"))?;

    Ok(LspTransport {
        stdin: stdin_arc,
        child: child_arc,
        next_id: Arc::new(Mutex::new(1)),
        is_stopping,
    })
}

// ---------------------------------------------------------------------------
// Framing — write side
// ---------------------------------------------------------------------------

/// Write a single JSON-RPC body string to any `Write` with Content-Length framing.
///
/// The Content-Length value is the byte count of `body` (UTF-8 encoded).
/// Separated from `LspTransport::write_message` so the framing logic can be
/// unit-tested against an in-memory `Vec<u8>` without spawning a process.
pub(crate) fn write_message_to<W: Write>(sink: &mut W, body: &str) -> Result<(), String> {
    let bytes = body.as_bytes();
    let header = format!("Content-Length: {}\r\n\r\n", bytes.len());
    sink.write_all(header.as_bytes())
        .map_err(|e| format!("LSP write error (header): {e}"))?;
    sink.write_all(bytes)
        .map_err(|e| format!("LSP write error (body): {e}"))?;
    sink.flush()
        .map_err(|e| format!("LSP flush error: {e}"))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Framing — read side
// ---------------------------------------------------------------------------

/// Read one Content-Length-framed message from `reader`.
///
/// Returns the raw JSON string on success, or an error string that the caller
/// should log and propagate.
///
/// `BufRead` is used for the header lines; the body is read with `read_exact`.
pub(crate) fn read_message<R: BufRead + Read>(reader: &mut R) -> Result<String, String> {
    let content_length = read_headers(reader)?;
    let body = read_body(reader, content_length)?;
    String::from_utf8(body).map_err(|e| format!("LSP body is not valid UTF-8: {e}"))
}

/// Read and parse HTTP-style headers until the blank line separator (`\r\n\r\n`).
///
/// Returns the value of the `Content-Length` header.  Any other headers are
/// silently discarded (the LSP spec allows `Content-Type`).
fn read_headers<R: BufRead>(reader: &mut R) -> Result<usize, String> {
    let mut content_length: Option<usize> = None;

    loop {
        let mut line = String::new();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|e| format!("LSP read_line error: {e}"))?;

        if bytes_read == 0 {
            return Err("LSP stream closed (EOF reading headers)".to_string());
        }

        // The blank line terminator: CRLF on its own
        if line == "\r\n" {
            break;
        }

        // Strip the trailing CRLF before parsing
        let line = line.trim_end_matches(|c| c == '\r' || c == '\n');

        if let Some(rest) = line.strip_prefix("Content-Length: ") {
            content_length = Some(
                rest.parse::<usize>()
                    .map_err(|e| format!("Invalid Content-Length value '{rest}': {e}"))?,
            );
        }
        // Ignore Content-Type and any other headers
    }

    content_length.ok_or_else(|| "LSP message missing Content-Length header".to_string())
}

/// Read exactly `len` bytes from `reader` into a `Vec<u8>`.
fn read_body<R: Read>(reader: &mut R, len: usize) -> Result<Vec<u8>, String> {
    let mut buf = vec![0u8; len];
    reader
        .read_exact(&mut buf)
        .map_err(|e| format!("LSP read_exact error (expected {len} bytes): {e}"))?;
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Read loop (runs on a dedicated OS thread)
// ---------------------------------------------------------------------------

fn read_loop<R: BufRead + Read>(
    mut reader: R,
    app: AppHandle,
    is_stopping: Arc<AtomicBool>,
    on_message: impl Fn(AppHandle, IncomingMessage),
    on_crash: impl FnOnce(),
) {
    loop {
        let raw = match read_message(&mut reader) {
            Ok(s) => s,
            Err(e) => {
                if is_stopping.load(Ordering::Relaxed) {
                    // Normal EOF following mark_stopping() + kill() — not a crash.
                    eprintln!("[lsp transport] read loop exiting (graceful): {e}");
                } else {
                    // Server exited without being asked to — treat as crash.
                    eprintln!("[lsp transport] server crashed: {e}");
                    on_crash();
                }
                break;
            }
        };

        let msg: IncomingMessage = match serde_json::from_str(&raw) {
            Ok(m) => m,
            Err(e) => {
                eprintln!("[lsp transport] JSON parse error: {e}\nRaw: {raw}");
                continue; // best-effort: skip malformed messages
            }
        };

        on_message(app.clone(), msg);
    }
}

// ---------------------------------------------------------------------------
// Unit tests — framing correctness
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Cursor;

    // -- stderr tail ring --

    #[test]
    fn stderr_tail_keeps_only_the_most_recent_lines() {
        let tail = new_stderr_tail();
        let lines: String = (0..40).map(|i| format!("line {i}\n")).collect();
        drain_stderr_into_tail(Cursor::new(lines), &tail);
        let snapshot = snapshot_stderr_tail(&tail);
        assert_eq!(snapshot.len(), STDERR_TAIL_MAX_LINES);
        assert_eq!(snapshot.first().unwrap(), "line 10", "oldest lines evicted");
        assert_eq!(snapshot.last().unwrap(), "line 39", "newest line kept");
    }

    #[test]
    fn stderr_tail_truncates_pathological_lines() {
        let tail = new_stderr_tail();
        let long = "x".repeat(2_000);
        drain_stderr_into_tail(Cursor::new(format!("{long}\nshort\n")), &tail);
        let snapshot = snapshot_stderr_tail(&tail);
        assert_eq!(snapshot.len(), 2);
        assert_eq!(
            snapshot[0].chars().count(),
            STDERR_TAIL_MAX_LINE_CHARS + 1,
            "long line capped with an ellipsis"
        );
        assert!(snapshot[0].ends_with('…'));
        assert_eq!(snapshot[1], "short");
    }

    #[test]
    fn stderr_tail_is_empty_for_a_silent_server() {
        let tail = new_stderr_tail();
        drain_stderr_into_tail(Cursor::new(""), &tail);
        assert!(snapshot_stderr_tail(&tail).is_empty());
    }

    // -- write_message_to --

    #[test]
    fn write_produces_correct_content_length_header() {
        let value = json!({ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} });
        let body = serde_json::to_string(&value).unwrap();
        let expected_len = body.len();

        let mut buf = Vec::new();
        write_message_to(&mut buf, &body).unwrap();

        let raw = String::from_utf8(buf).unwrap();
        let expected_header = format!("Content-Length: {expected_len}\r\n\r\n");
        assert!(
            raw.starts_with(&expected_header),
            "Expected header {expected_header:?}, got start: {:?}",
            &raw[..expected_header.len().min(raw.len())]
        );
        assert_eq!(&raw[expected_header.len()..], body);
    }

    #[test]
    fn write_uses_byte_length_not_char_length() {
        // The string "héllo" is 5 chars but 6 bytes in UTF-8.
        let body = r#"{"text":"héllo"}"#;
        assert!(body.len() > body.chars().count(), "test string must be multi-byte");

        let mut buf = Vec::new();
        write_message_to(&mut buf, body).unwrap();

        let raw = String::from_utf8(buf).unwrap();
        let header_end = raw.find("\r\n\r\n").unwrap();
        let header = &raw[..header_end];
        let cl: usize = header
            .strip_prefix("Content-Length: ")
            .unwrap()
            .parse()
            .unwrap();

        assert_eq!(cl, body.len(), "Content-Length must be byte count, not char count");
    }

    // -- read_message --

    fn make_framed(body: &str) -> Vec<u8> {
        let mut out = Vec::new();
        write_message_to(&mut out, body).unwrap();
        out
    }

    #[test]
    fn round_trip_simple_object() {
        let body = r#"{"jsonrpc":"2.0","id":1,"result":{}}"#;
        let framed = make_framed(body);
        let mut cursor = Cursor::new(framed);
        let result = read_message(&mut cursor).unwrap();
        assert_eq!(result, body);
    }

    #[test]
    fn round_trip_unicode_payload() {
        let body = r#"{"message":"안녕하세요 LSP"}"#;
        let framed = make_framed(body);
        let mut cursor = Cursor::new(framed);
        let result = read_message(&mut cursor).unwrap();
        assert_eq!(result, body);
    }

    #[test]
    fn round_trip_multiple_sequential_messages() {
        let bodies = [
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#,
            r#"{"jsonrpc":"2.0","method":"initialized","params":{}}"#,
            r#"{"jsonrpc":"2.0","id":2,"result":{"capabilities":{}}}"#,
        ];

        let mut buf = Vec::new();
        for body in &bodies {
            write_message_to(&mut buf, body).unwrap();
        }

        let mut cursor = Cursor::new(buf);
        for expected in &bodies {
            let got = read_message(&mut cursor).unwrap();
            assert_eq!(&got, expected);
        }
    }

    #[test]
    fn read_message_eof_returns_error() {
        let mut cursor = Cursor::new(Vec::<u8>::new());
        let result = read_message(&mut cursor);
        assert!(result.is_err(), "EOF should return an error");
        assert!(result.unwrap_err().contains("EOF"));
    }

    #[test]
    fn read_message_missing_content_length_returns_error() {
        // A well-formed HTTP-ish header block but without Content-Length.
        let malformed = b"Content-Type: application/vscode-jsonrpc; charset=utf-8\r\n\r\n";
        let mut cursor = Cursor::new(malformed.to_vec());
        let result = read_message(&mut cursor);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Content-Length"));
    }

    #[test]
    fn read_message_invalid_content_length_value_returns_error() {
        let malformed = b"Content-Length: not-a-number\r\n\r\n";
        let mut cursor = Cursor::new(malformed.to_vec());
        let result = read_message(&mut cursor);
        assert!(result.is_err());
    }

    #[test]
    fn read_message_content_type_header_is_ignored() {
        // Both headers present — Content-Type should be silently skipped.
        let body = r#"{"ok":true}"#;
        let mut buf = Vec::new();
        let header = format!(
            "Content-Length: {}\r\nContent-Type: application/vscode-jsonrpc\r\n\r\n",
            body.len()
        );
        buf.extend_from_slice(header.as_bytes());
        buf.extend_from_slice(body.as_bytes());

        let mut cursor = Cursor::new(buf);
        let result = read_message(&mut cursor).unwrap();
        assert_eq!(result, body);
    }

    #[test]
    fn read_message_large_payload() {
        // 64 KB body — verifies no off-by-one in read_exact
        let payload: String = std::iter::repeat('a').take(65_536).collect();
        let body = format!(r#"{{"data":"{payload}"}}"#);
        let framed = make_framed(&body);
        let mut cursor = Cursor::new(framed);
        let result = read_message(&mut cursor).unwrap();
        assert_eq!(result, body);
    }

    // -- .cmd → node resolver traversal guard (audit #4, Windows-only) --

    #[cfg(windows)]
    #[test]
    fn cmd_resolver_rejects_traversal_outside_dp0() {
        use std::fs;
        let base = std::env::temp_dir().join(format!("litria_cmdres_{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dp0 = base.join("shim"); // the .cmd's own directory
        let inside = dp0.join("node_modules").join("x");
        fs::create_dir_all(&inside).unwrap();
        fs::write(inside.join("cli.js"), b"//js").unwrap();
        let dp0s = dp0.to_str().unwrap();

        // A legit script under dp0 resolves.
        assert!(contained_script_from_line(dp0s, r#""%dp0%\node_modules\x\cli.js" %*"#).is_some());
        // A traversal escaping dp0 is refused even though the target exists.
        fs::write(base.join("evil.js"), b"//evil").unwrap();
        assert!(contained_script_from_line(dp0s, r#""%dp0%\..\evil.js" %*"#).is_none());
        // Non-.js references and lines without %dp0% are ignored.
        assert!(contained_script_from_line(dp0s, r#""%dp0%\node_modules\x\cli.txt" %*"#).is_none());
        assert!(contained_script_from_line(dp0s, "@echo off").is_none());

        let _ = fs::remove_dir_all(&base);
    }
}

// ---------------------------------------------------------------------------
// Windows .cmd → node script resolver
// ---------------------------------------------------------------------------

/// Parse one `.cmd` line for a `%dp0%\<rel>.js` reference and return the
/// absolute script path only if it exists AND canonicalizes to a location
/// under `dp0` (audit #4). A malicious wrapper referencing
/// `%dp0%\..\..\..\evil.js` is refused even when the target exists — the
/// resolved script must stay inside the `.cmd`'s own directory. Returns the
/// original (non-`\\?\`-prefixed) path once containment is proven.
#[cfg(windows)]
fn contained_script_from_line(dp0: &str, line: &str) -> Option<String> {
    let pos = line.find("%dp0%\\")?;
    let js_rel = line[pos + 6..]
        .trim_end_matches("%*")
        .trim_end()
        .trim_end_matches('"')
        .trim();
    if !js_rel.ends_with(".js") {
        return None;
    }
    let script_path = format!("{dp0}\\{js_rel}");
    if !std::path::Path::new(&script_path).exists() {
        return None;
    }
    let canon_script = std::fs::canonicalize(&script_path).ok()?;
    let canon_dir = std::fs::canonicalize(dp0).ok()?;
    canon_script.starts_with(&canon_dir).then_some(script_path)
}

/// Resolve an npm-installed .cmd wrapper to its underlying node script.
///
/// npm .cmd files are thin wrappers that run `node <script>`.  Spawning node
/// directly avoids putting cmd.exe in the stdio pipe chain, which adds
/// buffering latency fatal to LSP JSON-RPC communication.
///
/// Returns `Some((node_executable, script_path))` or `None` if resolution fails.
#[cfg(windows)]
fn resolve_cmd_to_node(command: &str) -> Option<(String, String)> {
    use std::process::Command as WhereCmd;

    // Use `where` to locate the .cmd file on PATH
    let where_output = WhereCmd::new("where")
        .arg(format!("{command}.cmd"))
        .output()
        .ok()?;

    if !where_output.status.success() {
        return None;
    }

    let cmd_path = String::from_utf8_lossy(&where_output.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();

    // Read the .cmd file and look for the node script pattern:
    // "%_prog%"  "%dp0%\node_modules\...\some.js" %*
    let contents = std::fs::read_to_string(&cmd_path).ok()?;

    let dp0 = std::path::Path::new(&cmd_path).parent()?.to_str()?;

    for line in contents.lines() {
        if let Some(script_path) = contained_script_from_line(dp0, line) {
            let local_node = format!("{dp0}\\node.exe");
            let node_exe = if std::path::Path::new(&local_node).exists() {
                local_node
            } else {
                "node".to_string()
            };
            return Some((node_exe, script_path));
        }
    }

    None
}
