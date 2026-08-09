use crate::errors::{CommandError, CommandResult};
use crate::terminal_policy;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const READ_BUF_SIZE: usize = 32 * 1024;
const TEARDOWN_TIMEOUT_MS: u64 = 2000;

/// ConPTY startup handshake (see HandshakeFilter): how deep into the output
/// stream we keep looking for the host's initial cursor query before giving
/// up. The query is the very first thing the host emits, so a small budget
/// guarantees zero steady-state scanning cost.
const HANDSHAKE_SCAN_BUDGET: usize = 64;
const CURSOR_QUERY: &[u8] = b"\x1b[6n";
const CURSOR_REPLY: &[u8] = b"\x1b[1;1R";

/// Answers the ConPTY INHERIT_CURSOR startup handshake at the source.
///
/// portable-pty hardcodes PSEUDOCONSOLE_INHERIT_CURSOR, which makes the
/// console host open every session by emitting ESC[6n (cursor position
/// query) and WAITING for the terminal's ESC[row;colR report before it
/// paints anything. wezterm answers in-process so upstream never feels it;
/// our reply has to round-trip xterm.js in the webview, which can defer
/// parsing a tiny first chunk long enough for the host to time out (new
/// OpenConsole, ~3.6s) or stall forever (Win10 conhost) — and a timed-out
/// host paints with desynced coordinates (prompt overwritten by typed
/// input; diagnosed live 2026-07-07).
///
/// Litria PTYs are always freshly created, so the cursor IS at 1;1 by
/// construction: the reader thread answers the query instantly and strips
/// it from the forwarded stream so xterm.js never sends a late duplicate
/// reply (which the shell would receive as junk keystrokes). Only the
/// first occurrence within HANDSHAKE_SCAN_BUDGET bytes is intercepted —
/// later ESC[6n from client apps (vim, etc.) pass through untouched.
struct HandshakeFilter {
    /// Bytes of CURSOR_QUERY matched so far at the end of the last chunk
    /// (the sequence can split across reads).
    partial: usize,
    /// Total bytes scanned; past HANDSHAKE_SCAN_BUDGET we stop looking.
    scanned: usize,
    done: bool,
}

impl HandshakeFilter {
    fn new() -> Self {
        Self { partial: 0, scanned: 0, done: false }
    }

    /// Process one read chunk. Returns (bytes to forward, reply needed?).
    fn push(&mut self, chunk: &[u8]) -> (Vec<u8>, bool) {
        if self.done {
            return (chunk.to_vec(), false);
        }

        // Reconstruct the window: any held-back partial match + this chunk.
        let mut window = Vec::with_capacity(self.partial + chunk.len());
        window.extend_from_slice(&CURSOR_QUERY[..self.partial]);
        window.extend_from_slice(chunk);

        if let Some(pos) = window
            .windows(CURSOR_QUERY.len())
            .position(|w| w == CURSOR_QUERY)
        {
            // Found the full query: forward everything around it, minus the
            // query itself, and stop filtering for good.
            self.done = true;
            let mut forward = Vec::with_capacity(window.len() - CURSOR_QUERY.len());
            forward.extend_from_slice(&window[..pos]);
            forward.extend_from_slice(&window[pos + CURSOR_QUERY.len()..]);
            return (forward, true);
        }

        // No full match. Hold back a trailing partial match (if any) and
        // forward the rest; give up entirely once the budget is spent.
        let tail = (1..CURSOR_QUERY.len().min(window.len() + 1))
            .rev()
            .find(|&n| window[window.len() - n..] == CURSOR_QUERY[..n])
            .unwrap_or(0);
        let forward = window[..window.len() - tail].to_vec();
        self.partial = tail;
        self.scanned += chunk.len();
        if self.scanned >= HANDSHAKE_SCAN_BUDGET {
            // Budget exhausted: flush anything held back and go passthrough.
            let mut flushed = forward;
            flushed.extend_from_slice(&CURSOR_QUERY[..self.partial]);
            self.partial = 0;
            self.done = true;
            return (flushed, false);
        }
        (forward, false)
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(tag = "event", content = "data")]
pub(crate) enum TerminalEvent {
    #[serde(rename_all = "camelCase")]
    Output { chunk: String },
    #[serde(rename_all = "camelCase")]
    Exited { exit_code: Option<i32> },
}

/// Flow control state shared between the reader thread and the frontend.
struct FlowControl {
    paused: Mutex<bool>,
    resume_signal: Condvar,
}

impl FlowControl {
    fn new() -> Self {
        Self {
            paused: Mutex::new(false),
            resume_signal: Condvar::new(),
        }
    }

    fn pause(&self) {
        if let Ok(mut guard) = self.paused.lock() {
            *guard = true;
        }
    }

    fn resume(&self) {
        if let Ok(mut guard) = self.paused.lock() {
            *guard = false;
            self.resume_signal.notify_one();
        }
    }

    fn wait_if_paused(&self, shutdown: &AtomicBool) {
        if let Ok(mut guard) = self.paused.lock() {
            while *guard && !shutdown.load(Ordering::SeqCst) {
                let result = self
                    .resume_signal
                    .wait_timeout(guard, Duration::from_millis(100))
                    .expect("flow control lock must not be poisoned");
                guard = result.0;
            }
        }
    }
}

pub(crate) struct PtySession {
    // master and writer are wrapped in Option so teardown() can drop them
    // BEFORE joining the reader thread. This is required on Windows ConPTY:
    // the reader thread blocks in `read()` on the master pipe and the read
    // syscall does not observe our `shutdown` flag, so the only way to make
    // the reader exit is to close the host side of the pipe by dropping the
    // master. Without this, `reader_handle.join()` could hang indefinitely.
    // See docs/plans/persistence/project-switch-crash-investigation.md.
    master: Option<Box<dyn MasterPty + Send>>,
    // Arc-shared with the reader thread, which answers the ConPTY startup
    // cursor handshake (see HandshakeFilter) on this same writer.
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    reader_handle: Option<JoinHandle<()>>,
    shutdown: Arc<AtomicBool>,
    flow_control: Arc<FlowControl>,
    #[cfg(target_os = "windows")]
    _job: Option<win32job::Job>,
}

/// Convert a Windows verbatim path (\\?\C:\... or \\?\UNC\server\share\...)
/// back to its plain form for display-facing consumers (the shell's cwd).
/// Non-verbatim paths pass through untouched.
fn de_verbatim(path: &std::path::Path) -> std::path::PathBuf {
    use std::path::{Component, PathBuf, Prefix};
    let mut components = path.components();
    let Some(Component::Prefix(prefix)) = components.next() else {
        return path.to_path_buf();
    };
    let root = match prefix.kind() {
        Prefix::VerbatimDisk(disk) => PathBuf::from(format!("{}:\\", disk as char)),
        Prefix::VerbatimUNC(server, share) => PathBuf::from(format!(
            "\\\\{}\\{}",
            server.to_string_lossy(),
            share.to_string_lossy()
        )),
        _ => return path.to_path_buf(),
    };
    components.fold(root, |mut acc, component| {
        if let Component::Normal(part) = component {
            acc.push(part);
        }
        acc
    })
}

pub(crate) fn spawn_pty(
    _session_id: &str,
    validated: &crate::execution_policy::ValidatedExecutionBoundary,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
) -> CommandResult<PtySession> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| {
            CommandError::internal(
                "terminal.pty_unavailable",
                format!("Failed to open PTY: {e}"),
            )
        })?;

    let mut cmd = CommandBuilder::new(&validated.executable);
    // Suppress the startup banner for PowerShell
    let exe_lower = validated.executable.to_lowercase();
    if exe_lower.contains("powershell") || exe_lower.contains("pwsh") {
        cmd.arg("-NoLogo");
    }
    // path_guard canonicalizes the root, which on Windows yields a verbatim
    // \\?\C:\... path — PowerShell started there renders its prompt as
    // "Microsoft.PowerShell.Core\FileSystem::\\?\C:\...". Hand the shell a
    // plain path; the security validation already happened on the verbatim.
    cmd.cwd(de_verbatim(&validated.project_root));

    let filtered_env = terminal_policy::build_pty_environment();
    for (key, value) in &filtered_env {
        cmd.env(key, value);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| {
        CommandError::internal(
            "terminal.spawn_failed",
            format!("Failed to spawn terminal process: {e}"),
        )
    })?;
    drop(pair.slave);

    #[cfg(target_os = "windows")]
    let job = setup_job_object(&child);

    let reader = pair.master.try_clone_reader().map_err(|e| {
        CommandError::internal(
            "terminal.io_failed",
            format!("Failed to clone PTY reader: {e}"),
        )
    })?;

    let writer = pair.master.take_writer().map_err(|e| {
        CommandError::internal(
            "terminal.io_failed",
            format!("Failed to take PTY writer: {e}"),
        )
    })?;

    let shutdown = Arc::new(AtomicBool::new(false));
    let flow_control = Arc::new(FlowControl::new());
    let child = Arc::new(Mutex::new(child));
    let writer: Arc<Mutex<Option<Box<dyn Write + Send>>>> = Arc::new(Mutex::new(Some(writer)));
    let reader_handle = spawn_reader_thread(
        reader,
        channel,
        Arc::clone(&shutdown),
        Arc::clone(&flow_control),
        Arc::clone(&child),
        Arc::clone(&writer),
    );

    Ok(PtySession {
        master: Some(pair.master),
        writer,
        child,
        reader_handle: Some(reader_handle),
        shutdown,
        flow_control,
        #[cfg(target_os = "windows")]
        _job: job,
    })
}

fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    channel: Channel<TerminalEvent>,
    shutdown: Arc<AtomicBool>,
    flow_control: Arc<FlowControl>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    writer: Arc<Mutex<Option<Box<dyn Write + Send>>>>,
) -> JoinHandle<()> {
    std::thread::spawn(move || {
        let mut tmp = vec![0u8; READ_BUF_SIZE];
        let mut handshake = HandshakeFilter::new();

        // Send per read, no coalescing. The old 5ms coalesce buffer could
        // only flush ON a subsequent read — bytes arriving <5ms after a send
        // sat stranded until the NEXT output event. The sideloaded ConPTY
        // host splits each keystroke repaint into several quick writes, so
        // the tail of every echo stranded until the following keystroke:
        // rendering ran one action behind the user (owner-reported). The OS
        // pipe already batches floods naturally — while we send one chunk,
        // the next read drains everything that accumulated — so per-read
        // sends cost nothing during heavy output and are latency-free while
        // typing.
        loop {
            if shutdown.load(Ordering::SeqCst) {
                break;
            }
            flow_control.wait_if_paused(&shutdown);

            match reader.read(&mut tmp) {
                Ok(0) => break,
                Ok(n) => {
                    let (forward, reply_needed) = handshake.push(&tmp[..n]);
                    if reply_needed {
                        if let Ok(mut guard) = writer.lock() {
                            if let Some(w) = guard.as_mut() {
                                let _ = w.write_all(CURSOR_REPLY);
                                let _ = w.flush();
                            }
                        }
                    }
                    if !forward.is_empty() {
                        let chunk = String::from_utf8_lossy(&forward).to_string();
                        let _ = channel.send(TerminalEvent::Output { chunk });
                    }
                }
                Err(_) => break,
            }
        }

        // Send exit event — try to reap exit code from the child process
        let exit_code = child
            .lock()
            .ok()
            .and_then(|mut c| c.try_wait().ok().flatten())
            .map(|status| status.exit_code() as i32);
        let _ = channel.send(TerminalEvent::Exited { exit_code });
    })
}

#[cfg(target_os = "windows")]
fn setup_job_object(
    child: &Box<dyn portable_pty::Child + Send + Sync>,
) -> Option<win32job::Job> {
    let pid = match child.process_id() {
        Some(pid) => pid,
        None => return None,
    };

    let job = match win32job::Job::create() {
        Ok(j) => j,
        Err(_) => return None,
    };

    let mut info = match job.query_extended_limit_info() {
        Ok(i) => i,
        Err(_) => return None,
    };
    info.limit_kill_on_job_close();
    if job.set_extended_limit_info(&mut info).is_err() {
        return None;
    }

    // Open the child process handle and assign to job.
    unsafe {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_ALL_ACCESS};
        use windows::Win32::Foundation::CloseHandle;
        let handle = match OpenProcess(PROCESS_ALL_ACCESS, false, pid) {
            Ok(h) => h,
            Err(_) => return None,
        };
        let assign_result = job.assign_process(handle.0 as isize);
        let _ = CloseHandle(handle);
        if assign_result.is_err() {
            return None;
        }
    }

    Some(job)
}

impl PtySession {
    pub(crate) fn write_input(&self, data: &[u8]) -> CommandResult<()> {
        let mut writer_guard = self.writer.lock().map_err(|_| {
            CommandError::internal("terminal.internal.lock_poisoned", "Terminal writer lock is poisoned.")
        })?;
        let writer = writer_guard.as_mut().ok_or_else(|| {
            CommandError::internal(
                "terminal.writer_unavailable",
                "Terminal writer has been torn down.",
            )
        })?;
        writer.write_all(data).map_err(|e| {
            CommandError::internal(
                "terminal.io_failed",
                format!("Failed to write to PTY: {e}"),
            )
        })?;
        writer.flush().map_err(|e| {
            CommandError::internal(
                "terminal.io_failed",
                format!("Failed to flush PTY writer: {e}"),
            )
        })
    }

    pub(crate) fn resize(&self, cols: u16, rows: u16) -> CommandResult<()> {
        let master = self.master.as_ref().ok_or_else(|| {
            CommandError::internal(
                "terminal.master_unavailable",
                "PTY master has been torn down.",
            )
        })?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| {
                CommandError::internal(
                    "terminal.io_failed",
                    format!("Failed to resize PTY: {e}"),
                )
            })
    }

    pub(crate) fn pause_output(&self) {
        self.flow_control.pause();
    }

    pub(crate) fn resume_output(&self) {
        self.flow_control.resume();
    }

    pub(crate) fn teardown(&mut self) -> Option<i32> {
        self.shutdown.store(true, Ordering::SeqCst);
        self.flow_control.resume();

        // STEP 1: Tell the shell to exit GRACEFULLY by sending it commands.
        //
        // Why: on Windows, force-killing PowerShell via TerminateProcess does
        // NOT cause conhost.exe (the console host that brokers between
        // PowerShell and the ConPTY pipes) to clean up reliably. conhost
        // lingers, the pipes stay alive, the reader thread stays blocked
        // in `read()`, and we leak both the reader thread and conhost.exe
        // on every project switch. After 3-4 leaks the renderer hangs
        // because the IPC bridge / message pump can't keep up.
        //
        // The fix is to make the shell exit CLEANLY. A clean PowerShell
        // exit triggers conhost to detect the dead child and exit itself,
        // which closes ALL handles to the read pipe, which causes the
        // reader's blocking read() to return EOF, which lets the reader
        // thread join in milliseconds.
        //
        // The two-byte sequence:
        //   0x03           — Ctrl+C, cancels any in-progress command line
        //   "exit\r\n"     — runs the exit cmdlet (works for PowerShell,
        //                    pwsh, cmd.exe, and most other Windows shells)
        //
        // If the shell ignores these or is in a bad state, wait_or_kill
        // below will force-kill it after 2 seconds and the Job-object
        // drop in step 5 will sweep up any remaining processes.
        //
        // See docs/plans/persistence/project-switch-crash-investigation.md.
        if let Ok(mut writer_guard) = self.writer.lock() {
            if let Some(writer) = writer_guard.as_mut() {
                let _ = writer.write_all(&[0x03]);
                let _ = writer.write_all(b"exit\r\n");
                let _ = writer.flush();
            }
        }

        // STEP 2: Wait for the shell to exit (up to 2 seconds), then force
        // kill if it hasn't. With the graceful exit sent above, normal
        // PowerShell exits in 50-200ms.
        let exit_code = self.wait_or_kill();

        // STEP 3: Drop the writer (closes host stdin write side).
        if let Ok(mut writer_guard) = self.writer.lock() {
            let _ = writer_guard.take();
        }

        // STEP 4: Drop the master pipe (closes host master handles).
        drop(self.master.take());

        // STEP 5: Drop the Job object (Windows). With `kill_on_job_close`
        // set during construction, this immediately kills any remaining
        // processes assigned to the job — a no-op if the graceful exit
        // and wait_or_kill above already cleaned up, but a hard backstop
        // if anything is still alive.
        #[cfg(target_os = "windows")]
        {
            let _ = self._job.take();
        }

        // STEP 6: Join the reader thread, bounded by a 2-second timeout
        // backstop. With a clean shell exit, this should complete in a
        // few milliseconds because conhost.exe has detected the dead
        // child and closed the read pipe naturally.
        if let Some(handle) = self.reader_handle.take() {
            join_with_timeout(handle, Duration::from_secs(2));
        }

        exit_code
    }

    fn wait_or_kill(&self) -> Option<i32> {
        let mut child = match self.child.lock() {
            Ok(c) => c,
            Err(_) => return None,
        };

        // Try to wait with a timeout by polling.
        let deadline = Instant::now() + Duration::from_millis(TEARDOWN_TIMEOUT_MS);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    return Some(status.exit_code() as i32);
                }
                Ok(None) => {
                    if Instant::now() >= deadline {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(_) => break,
            }
        }

        // Timeout — force kill.
        let _ = child.kill();

        // One final wait to reap.
        match child.try_wait() {
            Ok(Some(status)) => Some(status.exit_code() as i32),
            _ => None,
        }
    }
}

impl Drop for PtySession {
    /// Backstop for any code path that constructs a `PtySession` but forgets
    /// to call `teardown()` explicitly. Detected via `reader_handle.is_some()`
    /// — `teardown()` takes the handle, so a Some value means teardown hasn't
    /// run. Without this Drop impl, the reader thread would leak (the OS Job
    /// object kills the child process, but the reader thread has no way to
    /// know it should exit until the master pipe is dropped).
    fn drop(&mut self) {
        if self.reader_handle.is_some() {
            let _ = self.teardown();
        }
    }
}

/// Join a thread with a timeout backstop. If the join exceeds the timeout,
/// detach the joiner and log a warning. This is the safety net for
/// `PtySession::teardown` to prevent an unbounded join from hanging callers
/// when the OS pipe doesn't break cleanly after the child is killed.
///
/// Worst case: one leaked joiner thread per timeout, which itself blocks
/// until the original reader thread eventually exits (usually at process
/// teardown). Acceptable trade-off vs panicking or aborting.
fn join_with_timeout(handle: JoinHandle<()>, timeout: Duration) {
    let (tx, rx) = std::sync::mpsc::channel::<()>();
    std::thread::spawn(move || {
        let _ = handle.join();
        let _ = tx.send(());
    });
    if rx.recv_timeout(timeout).is_err() {
        eprintln!(
            "[terminal_pty] reader thread join timed out after {:?}, detaching",
            timeout
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_event_output_serializes_correctly() {
        let event = TerminalEvent::Output {
            chunk: "hello".to_string(),
        };
        let json = serde_json::to_string(&event).expect("should serialize");
        assert!(json.contains("\"event\":\"Output\""));
        assert!(json.contains("\"chunk\":\"hello\""));
    }

    #[test]
    fn terminal_event_exited_serializes_correctly() {
        let event = TerminalEvent::Exited {
            exit_code: Some(0),
        };
        let json = serde_json::to_string(&event).expect("should serialize");
        assert!(json.contains("\"event\":\"Exited\""));
        assert!(json.contains("\"exitCode\":0"));
    }

    #[test]
    fn flow_control_pause_resume_cycle() {
        let fc = FlowControl::new();
        assert!(!*fc.paused.lock().unwrap());
        fc.pause();
        assert!(*fc.paused.lock().unwrap());
        fc.resume();
        assert!(!*fc.paused.lock().unwrap());
    }

    // ── HandshakeFilter (ConPTY INHERIT_CURSOR startup query) ──────────────

    #[test]
    fn handshake_answers_and_strips_query_in_single_chunk() {
        let mut f = HandshakeFilter::new();
        let (forward, reply) = f.push(b"\x1b[6nhello");
        assert!(reply);
        assert_eq!(forward, b"hello");
        // Later queries pass through untouched.
        let (forward, reply) = f.push(b"\x1b[6n");
        assert!(!reply);
        assert_eq!(forward, b"\x1b[6n");
    }

    #[test]
    fn handshake_handles_query_split_across_chunks() {
        let mut f = HandshakeFilter::new();
        let (forward, reply) = f.push(b"\x1b[");
        assert!(!reply);
        assert!(forward.is_empty());
        let (forward, reply) = f.push(b"6nPS>");
        assert!(reply);
        assert_eq!(forward, b"PS>");
    }

    #[test]
    fn handshake_releases_false_partial_match() {
        let mut f = HandshakeFilter::new();
        let (forward, reply) = f.push(b"\x1b[6");
        assert!(!reply);
        assert!(forward.is_empty());
        // \x1b[6m (SGR), not \x1b[6n — held bytes must be released intact.
        let (forward, reply) = f.push(b"mrest");
        assert!(!reply);
        assert_eq!(forward, b"\x1b[6mrest");
    }

    #[test]
    fn handshake_gives_up_after_scan_budget() {
        let mut f = HandshakeFilter::new();
        let noise = vec![b'x'; HANDSHAKE_SCAN_BUDGET];
        let (forward, reply) = f.push(&noise);
        assert!(!reply);
        assert_eq!(forward, noise);
        // Past the budget the query is no longer intercepted.
        let (forward, reply) = f.push(b"\x1b[6n");
        assert!(!reply);
        assert_eq!(forward, b"\x1b[6n");
    }

    #[test]
    fn handshake_query_mid_chunk_preserves_surrounding_bytes() {
        let mut f = HandshakeFilter::new();
        let (forward, reply) = f.push(b"ab\x1b[6ncd");
        assert!(reply);
        assert_eq!(forward, b"abcd");
    }

    // ── de_verbatim ─────────────────────────────────────────────────────────

    #[cfg(windows)]
    #[test]
    fn de_verbatim_strips_disk_prefix() {
        use std::path::Path;
        assert_eq!(
            de_verbatim(Path::new(r"\\?\C:\Projects1\test")),
            Path::new(r"C:\Projects1\test")
        );
        assert_eq!(
            de_verbatim(Path::new(r"C:\already\plain")),
            Path::new(r"C:\already\plain")
        );
    }

    #[cfg(windows)]
    #[test]
    fn de_verbatim_strips_unc_prefix() {
        use std::path::Path;
        assert_eq!(
            de_verbatim(Path::new(r"\\?\UNC\server\share\dir")),
            Path::new(r"\\server\share\dir")
        );
    }
}
