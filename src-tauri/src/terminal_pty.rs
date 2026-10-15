use crate::errors::{CommandError, CommandResult};
use crate::terminal_policy;
use crate::terminal_session_manager::TerminalSession;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Condvar, Mutex, PoisonError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

const READ_BUF_SIZE: usize = 32 * 1024;
/// How long a shell gets to obey Ctrl+C and `exit` before End kills it.
const GRACEFUL_EXIT: Duration = Duration::from_millis(2000);
/// After each kill step, how long to wait for the process to be gone.
const KILL_WAIT: Duration = Duration::from_millis(500);
/// Bounded joins at the end of `end`. A thread still running after its bound
/// is left behind and logged: a hung join must never hold the caller.
const READER_JOIN: Duration = Duration::from_secs(2);
const HELPER_JOIN: Duration = Duration::from_secs(1);
/// The exit watcher polls the process this often.
const EXIT_POLL: Duration = Duration::from_millis(200);
/// After the output ends, how long the reader waits for the exit code.
const EXIT_CODE_WAIT: Duration = Duration::from_secs(2);
/// After End's Ctrl+C, how long a running program gets to stop before its
/// tree is stopped instead.
const BUSY_GRACE: Duration = Duration::from_millis(1000);
/// Input messages waiting for the writer thread. Keystrokes are tiny; a full
/// queue means the program stopped reading its input.
const INPUT_QUEUE: usize = 1024;
const WRITER_POLL: Duration = Duration::from_millis(50);
/// End's keystrokes: Ctrl+C cancels the line being edited or the program in
/// front; `exit` is typed only when the shell itself is at its prompt
/// (PowerShell, pwsh, cmd.exe, sh, bash and zsh all accept it). Text typed
/// into a running program would reach it as input.
const CTRL_C: &[u8] = b"\x03";
const SHELL_EXIT: &[u8] = b"exit\r\n";

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

/// Decodes PTY output as UTF-8 across reads.
///
/// A read can end in the middle of a multi-byte character. Decoding each read
/// on its own turned both halves into U+FFFD. This carries an incomplete
/// trailing sequence (at most 3 bytes) into the next read, and still replaces
/// bytes that are invalid wherever they occur.
struct Utf8Stream {
    carry: Vec<u8>,
}

impl Utf8Stream {
    fn new() -> Self {
        Self { carry: Vec::new() }
    }

    fn decode(&mut self, bytes: &[u8]) -> String {
        let mut input = std::mem::take(&mut self.carry);
        input.extend_from_slice(bytes);
        let mut out = String::with_capacity(input.len());
        let mut rest: &[u8] = &input;
        loop {
            match std::str::from_utf8(rest) {
                Ok(valid) => {
                    out.push_str(valid);
                    break;
                }
                Err(error) => {
                    let (valid, after) = rest.split_at(error.valid_up_to());
                    // Safe: `valid_up_to` marks the end of valid UTF-8.
                    out.push_str(std::str::from_utf8(valid).unwrap_or_default());
                    match error.error_len() {
                        Some(len) => {
                            out.push(char::REPLACEMENT_CHARACTER);
                            rest = &after[len..];
                        }
                        None => {
                            // An incomplete sequence at the end: keep it for
                            // the next read.
                            self.carry = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// Whatever is still held when the stream ends is not a whole character.
    fn finish(&mut self) -> String {
        let rest = std::mem::take(&mut self.carry);
        String::from_utf8_lossy(&rest).into_owned()
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
    /// Set when a session's last output must reach the view (a self-exit):
    /// from then on nothing can pause the reader.
    draining: AtomicBool,
}

impl FlowControl {
    fn new() -> Self {
        Self {
            paused: Mutex::new(false),
            resume_signal: Condvar::new(),
            draining: AtomicBool::new(false),
        }
    }

    fn pause(&self) {
        if self.draining.load(Ordering::SeqCst) {
            return;
        }
        *self.paused.lock().unwrap_or_else(PoisonError::into_inner) = true;
    }

    fn resume(&self) {
        *self.paused.lock().unwrap_or_else(PoisonError::into_inner) = false;
        self.resume_signal.notify_one();
    }

    /// Lift any pause for good.
    fn drain(&self) {
        self.draining.store(true, Ordering::SeqCst);
        self.resume();
    }

    fn wait_if_paused(&self, shutdown: &AtomicBool) {
        let mut guard = self.paused.lock().unwrap_or_else(PoisonError::into_inner);
        while *guard && !shutdown.load(Ordering::SeqCst) && !self.draining.load(Ordering::SeqCst) {
            guard = match self.resume_signal.wait_timeout(guard, Duration::from_millis(100)) {
                Ok((guard, _)) => guard,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }
}

/// One PTY-backed terminal session.
///
/// Every method takes `&self`. The session manager hands out `Arc` clones, so
/// input, resize and pause never wait on an End running on another thread.
/// Ending is explicit (`end`) and idempotent. Dropping a session that was
/// never ended hands the work to a new thread, never to the caller's: the
/// caller may be the UI thread, and ending can take seconds.
pub(crate) struct PtySession {
    inner: Arc<PtyInner>,
}

struct PtyInner {
    session_id: String,
    // Option so `end` can close the pseudoconsole (drop the master) once the
    // processes are gone, and so `resize` can tell the session has ended.
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    // How input reaches the writer thread. `end` takes it.
    input: Mutex<Option<SyncSender<WriterMsg>>>,
    // Writer: drop queued input from now on.
    closing: Arc<AtomicBool>,
    // Writer: the input pipe may close (after End's graceful wait).
    released: Arc<AtomicBool>,
    // Set by the exit watcher when the shell exited by itself.
    self_exited: Arc<AtomicBool>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    #[cfg(unix)]
    shell_pid: Option<u32>,
    shutdown: Arc<AtomicBool>,
    flow_control: Arc<FlowControl>,
    threads: Mutex<SessionThreads>,
    ended: AtomicBool,
    exit_code: Mutex<Option<i32>>,
    #[cfg(target_os = "windows")]
    job: Mutex<Option<win32job::Job>>,
}

#[derive(Default)]
struct SessionThreads {
    reader: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
    watcher: Option<JoinHandle<()>>,
}

/// What the writer thread writes, in the order it was queued.
enum WriterMsg {
    /// The person's typing (dropped once the session is ending).
    Input(Vec<u8>),
    /// The startup handshake reply (see HandshakeFilter).
    Reply(&'static [u8]),
    /// End's own keystrokes (Ctrl+C, `exit`): written even while ending.
    Control(&'static [u8]),
}

enum ProcessState {
    Exited(Option<i32>),
    Running,
}

impl ProcessState {
    fn code(&self) -> Option<i32> {
        match self {
            ProcessState::Exited(code) => *code,
            ProcessState::Running => None,
        }
    }
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

/// Spawns a shell in a new pseudoconsole and starts its three threads:
/// - the reader forwards output to `channel`; when the shell exits by
///   itself, it forwards everything to the end and then sends `Exited`;
/// - the writer owns the PTY input and writes queued input in order;
/// - the exit watcher notices the shell exiting by itself and calls
///   `on_exit`, which ends the session (closing the pseudoconsole is what
///   lets the reader reach the end of the output on Windows).
///
/// The exit watcher exists because the reader cannot see a self-exit on
/// Windows: the console host keeps running while it holds its reference
/// handle (the vendored crate never releases it), so the output pipe breaks
/// only when the pseudoconsole is closed.
pub(crate) fn spawn_pty(
    session_id: &str,
    validated: &crate::execution_policy::ValidatedExecutionBoundary,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
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

    // Take the reader and the writer before anything is spawned, so a failure
    // here cannot leave a shell running that nothing owns.
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
    #[cfg(unix)]
    let shell_pid = child.process_id();

    #[cfg(target_os = "windows")]
    let job = setup_job_object(child.as_ref(), session_id);

    let (input_tx, input_rx) = mpsc::sync_channel(INPUT_QUEUE);
    let shutdown = Arc::new(AtomicBool::new(false));
    let closing = Arc::new(AtomicBool::new(false));
    let released = Arc::new(AtomicBool::new(false));
    let self_exited = Arc::new(AtomicBool::new(false));
    let flow_control = Arc::new(FlowControl::new());
    let child = Arc::new(Mutex::new(child));

    // From here on the session owns everything: an early return drops it,
    // and Drop ends it on another thread.
    let session = PtySession {
        inner: Arc::new(PtyInner {
            session_id: session_id.to_string(),
            master: Mutex::new(Some(pair.master)),
            input: Mutex::new(Some(input_tx.clone())),
            closing: Arc::clone(&closing),
            released: Arc::clone(&released),
            self_exited: Arc::clone(&self_exited),
            child: Arc::clone(&child),
            #[cfg(unix)]
            shell_pid,
            shutdown: Arc::clone(&shutdown),
            flow_control: Arc::clone(&flow_control),
            threads: Mutex::new(SessionThreads::default()),
            ended: AtomicBool::new(false),
            exit_code: Mutex::new(None),
            #[cfg(target_os = "windows")]
            job: Mutex::new(job),
        }),
    };

    let short = short_id(session_id);
    let threads = SessionThreads {
        writer: Some(spawn_writer_thread(writer, input_rx, closing, released, &short).map_err(thread_error)?),
        reader: Some(
            spawn_reader_thread(
                reader,
                channel,
                Arc::clone(&shutdown),
                flow_control,
                Arc::clone(&child),
                Some(input_tx),
                &short,
            )
            .map_err(thread_error)?,
        ),
        watcher: Some(spawn_exit_watcher(child, shutdown, self_exited, on_exit, &short).map_err(thread_error)?),
    };
    *session.inner.threads.lock().unwrap_or_else(PoisonError::into_inner) = threads;
    Ok(session)
}

fn thread_error(error: std::io::Error) -> CommandError {
    CommandError::internal(
        "terminal.spawn_failed",
        format!("Failed to start a terminal thread: {error}"),
    )
}

/// The first eight characters of a session id, for thread names and logs.
fn short_id(session_id: &str) -> String {
    session_id.chars().take(8).collect()
}

/// The shell's exit code, polled with short lock holds, for up to `timeout`.
fn poll_exit_code(
    child: &Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    timeout: Duration,
) -> Option<i32> {
    let deadline = Instant::now() + timeout;
    loop {
        let status = child.lock().unwrap_or_else(PoisonError::into_inner).try_wait();
        match status {
            Ok(Some(status)) => return Some(status.exit_code() as i32),
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => return None,
        }
    }
}

fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    channel: Channel<TerminalEvent>,
    shutdown: Arc<AtomicBool>,
    flow_control: Arc<FlowControl>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    mut reply: Option<SyncSender<WriterMsg>>,
    short: &str,
) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("terminal-reader-{short}"))
        .spawn(move || {
            let mut tmp = vec![0u8; READ_BUF_SIZE];
            let mut handshake = HandshakeFilter::new();
            let mut utf8 = Utf8Stream::new();

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
                    // Unix: stop at once. This thread's duplicate of the master
                    // is what keeps the terminal from hanging up, so holding it
                    // until EOF could wait forever on a surviving background job.
                    #[cfg(unix)]
                    break;
                } else {
                    flow_control.wait_if_paused(&shutdown);
                }

                match reader.read(&mut tmp) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        // Windows, after End: keep draining until the console
                        // host exits (closing the pseudoconsole makes it), and
                        // send nothing. An undrained pipe can stall the host's
                        // shutdown, and output from a session the person ended
                        // must not reach the webview.
                        if shutdown.load(Ordering::SeqCst) {
                            continue;
                        }
                        let (forward, reply_needed) = handshake.push(&tmp[..n]);
                        if reply_needed {
                            if let Some(tx) = &reply {
                                let _ = tx.try_send(WriterMsg::Reply(CURSOR_REPLY));
                            }
                        }
                        if handshake.done {
                            // The handshake happens once; holding a sender any
                            // longer would only keep the writer's queue open.
                            reply = None;
                        }
                        if !forward.is_empty() {
                            let chunk = utf8.decode(&forward);
                            if !chunk.is_empty() {
                                let _ = channel.send(TerminalEvent::Output { chunk });
                            }
                        }
                    }
                }
            }

            // The output ended without anyone ending the session: the shell
            // exited by itself. Everything it printed has been forwarded; the
            // exit marker goes last.
            if !shutdown.load(Ordering::SeqCst) {
                let tail = utf8.finish();
                if !tail.is_empty() {
                    let _ = channel.send(TerminalEvent::Output { chunk: tail });
                }
                let exit_code = poll_exit_code(&child, EXIT_CODE_WAIT);
                if !shutdown.load(Ordering::SeqCst) {
                    let _ = channel.send(TerminalEvent::Exited { exit_code });
                }
            }
        })
}

/// The writer thread owns the PTY input outright, so nothing else ever waits on
/// a lock while a write is blocked (a full input pipe blocks until the program
/// reads). Input, the handshake reply and End's keystrokes arrive in order. The
/// input pipe stays open until End releases it, after its graceful wait:
/// closing it early can make the console host send a close event before the
/// shell has run `exit`.
fn spawn_writer_thread(
    mut writer: Box<dyn Write + Send>,
    queue: Receiver<WriterMsg>,
    closing: Arc<AtomicBool>,
    released: Arc<AtomicBool>,
    short: &str,
) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("terminal-writer-{short}"))
        .spawn(move || {
            let mut broken = false;
            loop {
                match queue.recv_timeout(WRITER_POLL) {
                    Ok(message) => {
                        let bytes: &[u8] = match &message {
                            // End's own keystrokes, written even while ending.
                            WriterMsg::Control(bytes) => bytes,
                            // Once the session is ending, queued input is
                            // dropped: a paste still waiting must not run as
                            // the shell exits.
                            _ if closing.load(Ordering::SeqCst) => continue,
                            WriterMsg::Input(bytes) => bytes,
                            WriterMsg::Reply(bytes) => bytes,
                        };
                        if !broken {
                            broken = writer.write_all(bytes).and_then(|_| writer.flush()).is_err();
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if released.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                    // Every sender is gone, and still only End's release
                    // closes the input: on Unix the close types an EOF, and a
                    // shell that exits on it hides its background jobs from
                    // End's process-group capture. Both end paths release.
                    Err(RecvTimeoutError::Disconnected) => {
                        if released.load(Ordering::SeqCst) {
                            break;
                        }
                        thread::sleep(WRITER_POLL);
                    }
                }
            }
            // Dropping the writer closes the input side. On Unix its Drop also
            // writes "\n" + VEOF, which can block on a full terminal; that is
            // this thread's problem, and its join is bounded.
            drop(writer);
        })
}

fn spawn_exit_watcher(
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send + Sync>>>,
    shutdown: Arc<AtomicBool>,
    self_exited: Arc<AtomicBool>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
    short: &str,
) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("terminal-exit-{short}"))
        .spawn(move || {
            loop {
                if shutdown.load(Ordering::SeqCst) {
                    return;
                }
                // The lock is held for one non-blocking query at a time, so
                // `end` can always take it to kill the process.
                let status = child.lock().unwrap_or_else(PoisonError::into_inner).try_wait();
                match status {
                    Ok(Some(_)) => break,
                    Ok(None) => thread::sleep(EXIT_POLL),
                    // The process can no longer be queried: treat it as gone.
                    Err(_) => break,
                }
            }
            if shutdown.load(Ordering::SeqCst) {
                return;
            }
            self_exited.store(true, Ordering::SeqCst);
            on_exit();
        })
}

#[cfg(target_os = "windows")]
fn setup_job_object(
    child: &(dyn portable_pty::Child + Send + Sync),
    session_id: &str,
) -> Option<win32job::Job> {
    // The job is what End uses to stop everything the shell started. It is
    // assigned through the child's own handle, after the shell is already
    // running: anything the shell starts in that window escapes it (a shell
    // starts nothing before it reads input; T2b's agents may need the job
    // assigned before the process runs).
    let assigned = (|| -> Result<win32job::Job, String> {
        let handle = child
            .as_raw_handle()
            .ok_or_else(|| "the process has no handle".to_string())?;
        let job = win32job::Job::create().map_err(|e| format!("{e:?}"))?;
        let mut info = job.query_extended_limit_info().map_err(|e| format!("{e:?}"))?;
        info.limit_kill_on_job_close();
        job.set_extended_limit_info(&mut info).map_err(|e| format!("{e:?}"))?;
        job.assign_process(handle as isize).map_err(|e| format!("{e:?}"))?;
        Ok(job)
    })();
    match assigned {
        Ok(job) => Some(job),
        Err(error) => {
            eprintln!(
                "[terminal_pty] session {}: no job object ({error}); ending it will stop only the shell",
                short_id(session_id)
            );
            None
        }
    }
}

impl TerminalSession for PtySession {
    /// Queues input for the writer thread. Ok means queued, not written: the
    /// writer writes in order and stops at the first failed write.
    fn write_input(&self, data: &[u8]) -> CommandResult<()> {
        let input = self.inner.input.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(queue) = input.as_ref() else {
            return Err(session_ended());
        };
        match queue.try_send(WriterMsg::Input(data.to_vec())) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => Err(CommandError::conflict(
                "terminal.input_backlog",
                "The terminal program is not reading its input.",
            )),
            Err(TrySendError::Disconnected(_)) => Err(session_ended()),
        }
    }

    fn resize(&self, cols: u16, rows: u16) -> CommandResult<()> {
        let master = self.inner.master.lock().unwrap_or_else(PoisonError::into_inner);
        let master = master.as_ref().ok_or_else(session_ended)?;
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

    fn pause_output(&self) {
        self.inner.flow_control.pause();
    }

    fn resume_output(&self) {
        self.inner.flow_control.resume();
    }

    /// Whether the shell is running something: any process of its own. A
    /// command running inside the shell process itself (a PowerShell cmdlet,
    /// a shell builtin) does not count; the frontend adds recent output.
    fn is_busy(&self) -> bool {
        if self.inner.ended.load(Ordering::SeqCst) {
            return false;
        }
        self.inner.has_child_processes()
    }

    /// Ends the session and everything it started; see `PtyInner::end`.
    fn end(&self) -> Option<i32> {
        self.inner.end()
    }
}

impl PtyInner {
    /// Ends the session. Blocking, idempotent, bounded. A shell that exited by
    /// itself takes the draining path; anything else (the person's End, a
    /// project closing, quit) takes the stopping path.
    fn end(&self) -> Option<i32> {
        if self.ended.swap(true, Ordering::SeqCst) {
            return *self.exit_code.lock().unwrap_or_else(PoisonError::into_inner);
        }
        let code = if self.self_exited.load(Ordering::SeqCst) {
            self.end_after_exit()
        } else {
            self.end_by_request()
        };
        *self.exit_code.lock().unwrap_or_else(PoisonError::into_inner) = code;
        code
    }

    /// The stopping path (docs/plans/persistence/project-switch-crash-
    /// investigation.md, and the T2a design critique and review):
    /// 1. Stop forwarding output, lift any pause, drop queued input.
    /// 2. Ctrl+C. Only when nothing but the shell is left running is `exit`
    ///    typed: text typed into a running program (an editor, an agent)
    ///    would reach it as input. A clean exit is what lets the console host
    ///    shut down promptly.
    /// 3. Whatever is still running is stopped with everything it started:
    ///    the job on Windows, the session's process groups on Unix.
    /// 4. The input pipe is released, then the pseudoconsole closed (the job
    ///    dropped first on Windows: closing while a killed client is still
    ///    attached can wedge the in-box console host), then the threads joined,
    ///    each with a bound.
    fn end_by_request(&self) -> Option<i32> {
        self.shutdown.store(true, Ordering::SeqCst);
        self.flow_control.drain();
        self.closing.store(true, Ordering::SeqCst);
        // Each part is taken out first and dropped after its lock is
        // released: a guard in the same statement would stay held through the
        // drop, and closing a pseudoconsole can take a long time.
        let control = self.input.lock().unwrap_or_else(PoisonError::into_inner).take();
        let send = |bytes: &'static [u8]| {
            if let Some(queue) = &control {
                let _ = queue.try_send(WriterMsg::Control(bytes));
            }
        };

        send(CTRL_C);
        let at_prompt = !self.has_child_processes() || self.wait_until_idle(BUSY_GRACE);
        let mut state = if at_prompt {
            send(SHELL_EXIT);
            self.wait_for_exit(GRACEFUL_EXIT)
        } else {
            self.wait_for_exit(Duration::ZERO)
        };

        if matches!(state, ProcessState::Running) {
            self.stop_process_tree();
            state = self.wait_for_exit(KILL_WAIT);
        }
        if matches!(state, ProcessState::Running) {
            let _ = self.child.lock().unwrap_or_else(PoisonError::into_inner).kill();
            state = self.wait_for_exit(KILL_WAIT);
        }

        // Only now may the input close (see the writer thread).
        self.released.store(true, Ordering::SeqCst);
        drop(control);
        self.close_and_join();
        state.code()
    }

    /// The draining path: the shell exited by itself. Nothing is suppressed
    /// until the reader has forwarded the end of the output (it sends the exit
    /// marker last); whatever the shell left running ends with it.
    fn end_after_exit(&self) -> Option<i32> {
        self.flow_control.drain();
        self.closing.store(true, Ordering::SeqCst);
        self.released.store(true, Ordering::SeqCst);
        let input = self.input.lock().unwrap_or_else(PoisonError::into_inner).take();
        drop(input);
        #[cfg(unix)]
        self.stop_process_tree();
        let state = self.wait_for_exit(Duration::ZERO);
        // On Windows, dropping the job ends what the shell left running, and
        // closing the pseudoconsole makes the console host flush and exit, so
        // the reader reaches the end of the output.
        self.close_and_join();
        self.shutdown.store(true, Ordering::SeqCst);
        state.code()
    }

    fn close_and_join(&self) {
        #[cfg(target_os = "windows")]
        {
            let job = self.job.lock().unwrap_or_else(PoisonError::into_inner).take();
            drop(job);
        }
        let master = self.master.lock().unwrap_or_else(PoisonError::into_inner).take();
        drop(master);

        let threads = std::mem::take(&mut *self.threads.lock().unwrap_or_else(PoisonError::into_inner));
        let short = short_id(&self.session_id);
        join_bounded(threads.reader, READER_JOIN, "reader", &short);
        join_bounded(threads.writer, HELPER_JOIN, "writer", &short);
        join_bounded(threads.watcher, HELPER_JOIN, "exit watcher", &short);
    }

    /// Waits up to `timeout` for the shell to have no process of its own.
    fn wait_until_idle(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if !self.has_child_processes() {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn wait_for_exit(&self, timeout: Duration) -> ProcessState {
        let deadline = Instant::now() + timeout;
        loop {
            let status = self.child.lock().unwrap_or_else(PoisonError::into_inner).try_wait();
            match status {
                Ok(Some(status)) => return ProcessState::Exited(Some(status.exit_code() as i32)),
                Ok(None) => {}
                Err(_) => return ProcessState::Exited(None),
            }
            if Instant::now() >= deadline {
                return ProcessState::Running;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    #[cfg(target_os = "windows")]
    fn stop_process_tree(&self) {
        // Kill on close: dropping the only job handle ends every process in it.
        let job = self.job.lock().unwrap_or_else(PoisonError::into_inner).take();
        if job.is_some() {
            drop(job);
        } else {
            let _ = self.child.lock().unwrap_or_else(PoisonError::into_inner).kill();
        }
    }

    /// Unix: SIGHUP, then SIGKILL to whatever is left. The groups are captured
    /// once, before any signal: once the shell dies the terminal's foreground
    /// group can no longer be read, and a job that ignores SIGHUP must still
    /// get SIGKILL even though the shell itself is gone.
    #[cfg(unix)]
    fn stop_process_tree(&self) {
        let groups = self.session_groups();
        signal_groups(&groups, libc::SIGHUP);
        let deadline = Instant::now() + Duration::from_millis(250);
        while groups.iter().any(|&g| group_alive(g)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        let survivors: Vec<libc::pid_t> = groups.into_iter().filter(|&g| group_alive(g)).collect();
        signal_groups(&survivors, libc::SIGKILL);
    }

    /// The shell's own process group (it leads its session: portable-pty calls
    /// setsid, so the group id is its pid), the terminal's foreground group,
    /// and the group of each of the shell's children (each job of a shell with
    /// job control has one). A process that left all of these (setsid, a
    /// daemon) is not reached; see track T slice T5.
    #[cfg(unix)]
    fn session_groups(&self) -> Vec<libc::pid_t> {
        let own_group = unsafe { libc::getpgrp() };
        let mut groups: Vec<libc::pid_t> = Vec::new();
        if let Some(pid) = self.shell_pid {
            groups.push(pid as libc::pid_t);
            for child in child_pids(pid).unwrap_or_default() {
                let group = unsafe { libc::getpgid(child) };
                if group > 0 {
                    groups.push(group);
                }
            }
        }
        if let Some(master) = self.master.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            if let Some(foreground) = master.process_group_leader() {
                groups.push(foreground);
            }
        }
        groups.sort_unstable();
        groups.dedup();
        // Never group 0 or 1, never Litria's own group: kill(-pgid) with a bad
        // id signals far more than this session.
        groups.retain(|&g| g > 1 && g != own_group);
        groups
    }

    #[cfg(target_os = "windows")]
    fn has_child_processes(&self) -> bool {
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        // When the answer is unknown, say busy: the cost is one extra question
        // before a switch, against ending a running program without one.
        let job = self.job.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(job) = job.as_ref() else {
            return true;
        };
        let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        // SAFETY: the job handle stays open while the guard holds it, and the
        // buffer is the structure this information class fills.
        let queried = unsafe {
            QueryInformationJobObject(
                Some(HANDLE(job.handle() as *mut core::ffi::c_void)),
                JobObjectBasicAccountingInformation,
                &mut info as *mut _ as *mut core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                None,
            )
        };
        // The shell itself is one process in its job.
        queried.is_err() || info.ActiveProcesses > 1
    }

    /// Unix: any child of the shell, running, stopped (Ctrl+Z) or in the
    /// background. Unknown says busy (see the Windows version).
    #[cfg(unix)]
    fn has_child_processes(&self) -> bool {
        match self.shell_pid.and_then(child_pids) {
            Some(children) => !children.is_empty(),
            None => true,
        }
    }
}

#[cfg(unix)]
fn signal_groups(groups: &[libc::pid_t], signal: libc::c_int) {
    for &group in groups {
        unsafe {
            libc::killpg(group, signal);
        }
    }
}

/// Whether a process group still has a member (signal 0 checks existence).
#[cfg(unix)]
fn group_alive(group: libc::pid_t) -> bool {
    unsafe { libc::killpg(group, 0) == 0 }
}

/// The direct children of a process, or None if they cannot be listed.
#[cfg(target_os = "linux")]
fn child_pids(parent: u32) -> Option<Vec<libc::pid_t>> {
    let mut children = Vec::new();
    for entry in std::fs::read_dir("/proc").ok()?.flatten() {
        let Some(pid) = entry.file_name().to_str().and_then(|name| name.parse::<libc::pid_t>().ok()) else {
            continue;
        };
        let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) else {
            continue;
        };
        // "pid (comm) state ppid ...": the command name can hold spaces and
        // parentheses, so the fields are read after the last ')'.
        let ppid = stat
            .rfind(')')
            .and_then(|end| stat[end + 1..].split_whitespace().nth(1))
            .and_then(|field| field.parse::<u32>().ok());
        if ppid == Some(parent) {
            children.push(pid);
        }
    }
    Some(children)
}

#[cfg(target_os = "macos")]
fn child_pids(parent: u32) -> Option<Vec<libc::pid_t>> {
    let mut buffer = vec![0 as libc::pid_t; 256];
    // SAFETY: the buffer is valid for its full size in bytes; libproc
    // returns the number of pids it wrote, or -1.
    let count = unsafe {
        libc::proc_listchildpids(
            parent as libc::pid_t,
            buffer.as_mut_ptr() as *mut libc::c_void,
            (buffer.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int,
        )
    };
    if count < 0 {
        return None;
    }
    buffer.truncate((count as usize).min(256));
    buffer.retain(|&pid| pid > 0);
    Some(buffer)
}

#[cfg(all(unix, not(any(target_os = "linux", target_os = "macos"))))]
fn child_pids(_parent: u32) -> Option<Vec<libc::pid_t>> {
    None
}

fn session_ended() -> CommandError {
    CommandError::not_found("terminal.session_ended", "The terminal session has ended.")
}

impl Drop for PtySession {
    /// Backstop for a session dropped without `end` (an error path, a test).
    /// The work goes to a new thread: the dropping thread may be the UI thread.
    fn drop(&mut self) {
        if self.inner.ended.load(Ordering::SeqCst) {
            return;
        }
        let inner = Arc::clone(&self.inner);
        let spawned = thread::Builder::new()
            .name(format!("terminal-drop-{}", short_id(&inner.session_id)))
            .spawn(move || {
                inner.end();
            });
        if spawned.is_err() {
            self.inner.end();
        }
    }
}

/// Joins a thread with a bound. A thread still running after its bound is left
/// behind and logged: the caller must never hang on it.
fn join_bounded(handle: Option<JoinHandle<()>>, timeout: Duration, what: &str, short: &str) {
    let Some(handle) = handle else {
        return;
    };
    let deadline = Instant::now() + timeout;
    while !handle.is_finished() {
        if Instant::now() >= deadline {
            eprintln!("[terminal_pty] session {short}: {what} thread still running after {timeout:?}; leaving it");
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _ = handle.join();
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

    // ── Utf8Stream ──────────────────────────────────────────────────────────

    #[test]
    fn utf8_stream_joins_a_character_split_across_reads() {
        let mut s = Utf8Stream::new();
        // "é" is C3 A9; "€" is E2 82 AC.
        assert_eq!(s.decode(b"caf\xC3"), "caf");
        assert_eq!(s.decode(b"\xA9 \xE2\x82"), "é ");
        assert_eq!(s.decode(b"\xAC!"), "€!");
        assert_eq!(s.finish(), "");
    }

    #[test]
    fn utf8_stream_replaces_invalid_bytes_and_keeps_going() {
        let mut s = Utf8Stream::new();
        assert_eq!(s.decode(b"a\xFFb\xC3\x28c"), "a\u{FFFD}b\u{FFFD}(c");
    }

    #[test]
    fn utf8_stream_finish_releases_an_unfinished_tail() {
        let mut s = Utf8Stream::new();
        assert_eq!(s.decode(b"ok\xE2\x82"), "ok");
        assert_eq!(s.finish(), "\u{FFFD}");
        assert_eq!(s.finish(), "");
    }

    // ── The writer thread ───────────────────────────────────────────────────

    /// A writer whose first write blocks until the test lets it go.
    struct HeldWriter {
        written: Arc<Mutex<Vec<u8>>>,
        entered: Arc<std::sync::Barrier>,
        release: Arc<std::sync::Barrier>,
        held: bool,
    }

    impl Write for HeldWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            if !self.held {
                self.held = true;
                self.entered.wait();
                self.release.wait();
            }
            self.written.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn input_still_queued_when_a_session_ends_is_never_written() {
        let written = Arc::new(Mutex::new(Vec::new()));
        let entered = Arc::new(std::sync::Barrier::new(2));
        let release = Arc::new(std::sync::Barrier::new(2));
        let writer = HeldWriter {
            written: Arc::clone(&written),
            entered: Arc::clone(&entered),
            release: Arc::clone(&release),
            held: false,
        };
        let (queue, received) = mpsc::sync_channel(INPUT_QUEUE);
        let closing = Arc::new(AtomicBool::new(false));
        let released = Arc::new(AtomicBool::new(false));
        let handle = spawn_writer_thread(
            Box::new(writer),
            received,
            Arc::clone(&closing),
            Arc::clone(&released),
            "test",
        )
        .unwrap();

        queue.send(WriterMsg::Input(b"first\r".to_vec())).unwrap();
        entered.wait();
        // Queued behind a write that is blocked, as a paste into a busy shell.
        queue.send(WriterMsg::Input(b"second\r".to_vec())).unwrap();
        // What End does: stop taking input, then its own keystrokes.
        closing.store(true, Ordering::SeqCst);
        queue.send(WriterMsg::Control(CTRL_C)).unwrap();
        queue.send(WriterMsg::Control(SHELL_EXIT)).unwrap();
        release.wait();
        // The input pipe stays open until End releases it.
        thread::sleep(WRITER_POLL * 3);
        assert!(!handle.is_finished(), "the writer holds the input open until released");
        released.store(true, Ordering::SeqCst);
        handle.join().unwrap();
        drop(queue);

        let written = String::from_utf8(written.lock().unwrap().clone()).unwrap();
        assert_eq!(written, "first\r\x03exit\r\n");
    }

    #[test]
    fn the_writer_holds_the_input_open_until_released_even_with_no_sender_left() {
        // On Unix, dropping the PTY writer types "\n" + EOF: a shell at its
        // prompt exits on it, and its background jobs stop being its children
        // before End can find them (CI, ubuntu-22.04, 2026-10-15).
        struct DropFlag(Arc<AtomicBool>);
        impl Write for DropFlag {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        impl Drop for DropFlag {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        let dropped = Arc::new(AtomicBool::new(false));
        let (queue, received) = mpsc::sync_channel::<WriterMsg>(INPUT_QUEUE);
        let released = Arc::new(AtomicBool::new(false));
        let handle = spawn_writer_thread(
            Box::new(DropFlag(Arc::clone(&dropped))),
            received,
            Arc::new(AtomicBool::new(true)),
            Arc::clone(&released),
            "test",
        )
        .unwrap();
        // End took the last sender: every sender is gone.
        drop(queue);
        thread::sleep(WRITER_POLL * 4);
        assert!(!dropped.load(Ordering::SeqCst), "the input stays open until End releases it");
        assert!(!handle.is_finished());
        released.store(true, Ordering::SeqCst);
        handle.join().unwrap();
        assert!(dropped.load(Ordering::SeqCst), "released: the input closes");
    }

    #[test]
    fn the_writer_writes_queued_input_in_order() {
        let written = Arc::new(Mutex::new(Vec::new()));
        struct Recorder(Arc<Mutex<Vec<u8>>>);
        impl Write for Recorder {
            fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(buf);
                Ok(buf.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (queue, received) = mpsc::sync_channel(INPUT_QUEUE);
        let closing = Arc::new(AtomicBool::new(false));
        let released = Arc::new(AtomicBool::new(false));
        let handle = spawn_writer_thread(
            Box::new(Recorder(Arc::clone(&written))),
            received,
            Arc::clone(&closing),
            Arc::clone(&released),
            "test",
        )
        .unwrap();
        for part in ["a", "b", "c"] {
            queue.send(WriterMsg::Input(part.as_bytes().to_vec())).unwrap();
        }
        queue.send(WriterMsg::Reply(CURSOR_REPLY)).unwrap();
        drop(queue);
        // Only End's release ends the writer (see the test above).
        released.store(true, Ordering::SeqCst);
        handle.join().unwrap();
        assert_eq!(written.lock().unwrap().as_slice(), b"abc\x1b[1;1R");
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


    // ── Real shells ─────────────────────────────────────────────────────────
    //
    // These spawn the platform's default shell in a real pseudoconsole. On
    // Windows a test executable loads the in-box console host (conpty.dll is
    // staged beside the app, not beside target/debug/deps); the app ships the
    // sideloaded host. Every test runs under a watchdog, so a wedged console
    // fails the test instead of hanging the suite.

    mod real_shells {
        use super::*;
        use crate::execution_policy::ValidatedExecutionBoundary;
        use tauri::ipc::InvokeResponseBody;

        const WATCHDOG: Duration = Duration::from_secs(45);
        const WAIT: Duration = Duration::from_secs(20);

        fn with_watchdog(body: impl FnOnce() + Send + 'static) {
            let (done, finished) = mpsc::channel::<()>();
            let handle = thread::spawn(move || {
                body();
                let _ = done.send(());
            });
            match finished.recv_timeout(WATCHDOG) {
                Ok(()) => handle.join().unwrap(),
                // The body ended without finishing: it panicked. Joining is
                // prompt, and its own message is the one to report.
                Err(RecvTimeoutError::Disconnected) => {
                    if let Err(panic) = handle.join() {
                        std::panic::resume_unwind(panic);
                    }
                }
                Err(RecvTimeoutError::Timeout) => panic!("watchdog: still running after {WATCHDOG:?}"),
            }
        }

        #[derive(Default)]
        struct Seen {
            output: String,
            exits: Vec<Option<i32>>,
            /// "O" per output chunk and "E" per exit, in arrival order.
            order: Vec<&'static str>,
        }

        fn capture() -> (Channel<TerminalEvent>, Arc<Mutex<Seen>>) {
            let seen = Arc::new(Mutex::new(Seen::default()));
            let sink = Arc::clone(&seen);
            let channel = Channel::new(move |body: InvokeResponseBody| {
                if let InvokeResponseBody::Json(json) = body {
                    let value: serde_json::Value = serde_json::from_str(&json).unwrap_or_default();
                    let mut seen = sink.lock().unwrap();
                    match value["event"].as_str() {
                        Some("Output") => {
                            seen.output.push_str(value["data"]["chunk"].as_str().unwrap_or_default());
                            seen.order.push("O");
                        }
                        Some("Exited") => {
                            seen.exits.push(value["data"]["exitCode"].as_i64().map(|c| c as i32));
                            seen.order.push("E");
                        }
                        _ => {}
                    }
                }
                Ok(())
            });
            (channel, seen)
        }

        fn boundary() -> ValidatedExecutionBoundary {
            let root = std::env::temp_dir().to_string_lossy().to_string();
            terminal_policy::validate_terminal_execution_boundary("real-shell-test", &root, None)
                .expect("the temp dir is a valid project root")
        }

        fn spawn(seen_exit: Arc<AtomicBool>) -> (PtySession, Arc<Mutex<Seen>>) {
            let (channel, seen) = capture();
            let id = format!("{:032x}", rand::random::<u128>());
            let session = spawn_pty(
                &id,
                &boundary(),
                100,
                30,
                channel,
                Box::new(move || seen_exit.store(true, Ordering::SeqCst)),
            )
            .expect("the default shell starts");
            (session, seen)
        }

        fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
            let deadline = Instant::now() + WAIT;
            while !done() {
                assert!(Instant::now() < deadline, "timed out waiting for {what}");
                thread::sleep(Duration::from_millis(50));
            }
        }

        fn output_of(seen: &Arc<Mutex<Seen>>) -> String {
            seen.lock().unwrap().output.clone()
        }

        fn chunks_of(seen: &Arc<Mutex<Seen>>) -> usize {
            seen.lock().unwrap().order.iter().filter(|kind| **kind == "O").count()
        }

        /// Wait until the shell has printed nothing for `quiet`.
        fn wait_quiet(seen: &Arc<Mutex<Seen>>, quiet: Duration) {
            let deadline = Instant::now() + WAIT;
            let mut last = chunks_of(seen);
            let mut since = Instant::now();
            while since.elapsed() < quiet {
                assert!(Instant::now() < deadline, "the shell never went quiet");
                thread::sleep(Duration::from_millis(25));
                let now = chunks_of(seen);
                if now != last {
                    last = now;
                    since = Instant::now();
                }
            }
        }

        /// After `pause_output`, the read already in progress still takes one
        /// more chunk. Spend it: make the shell print a line and wait for that
        /// chunk. From then on the reader waits, and everything the shell
        /// prints stays in the terminal until the view resumes.
        fn park_reader(session: &PtySession, seen: &Arc<Mutex<Seen>>) {
            let before = chunks_of(seen);
            type_line(session, "echo PARKED");
            wait_for("the read in progress at the pause", || chunks_of(seen) > before);
        }

        fn type_line(session: &PtySession, line: &str) {
            session.write_input(format!("{line}\r").as_bytes()).unwrap();
        }

        /// The last `<marker>=<digits>` in the output.
        fn reported_pid(output: &str, marker: &str) -> Option<u32> {
            output
                .split(&format!("{marker}="))
                .skip(1)
                .filter_map(|rest| {
                    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    digits.parse().ok()
                })
                .last()
        }

        fn pid_of(session: &PtySession, seen: &Arc<Mutex<Seen>>, marker: &str) -> u32 {
            let _ = session;
            wait_for(marker, || reported_pid(&output_of(seen), marker).is_some());
            reported_pid(&output_of(seen), marker).unwrap()
        }

        /// A process watched through a handle opened while it was known to be
        /// alive, so a reused pid can never stand in for it.
        #[cfg(windows)]
        struct Watch(windows::Win32::Foundation::HANDLE);

        #[cfg(windows)]
        impl Watch {
            fn new(pid: u32) -> Self {
                use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
                Watch(unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, pid) }.expect("the process is running"))
            }
            fn alive(&self) -> bool {
                use windows::Win32::Foundation::WAIT_TIMEOUT;
                use windows::Win32::System::Threading::WaitForSingleObject;
                unsafe { WaitForSingleObject(self.0, 0) == WAIT_TIMEOUT }
            }
        }

        #[cfg(windows)]
        impl Drop for Watch {
            fn drop(&mut self) {
                let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.0) };
            }
        }

        /// Unix: signal 0 checks existence; a zombie counts as gone (its
        /// parent shell has exited too).
        #[cfg(unix)]
        struct Watch(u32);

        #[cfg(unix)]
        impl Watch {
            fn new(pid: u32) -> Self {
                Watch(pid)
            }
            fn alive(&self) -> bool {
                let pid = self.0;
                let exists = unsafe { libc::kill(pid as libc::pid_t, 0) == 0 };
                let zombie = std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .map(|stat| stat.contains(") Z "))
                    .unwrap_or(false);
                exists && !zombie
            }
        }

        /// A long-running program that a typed Ctrl+C cannot stop, started
        /// the way each platform makes only the tree kill able to end it.
        /// Windows: a hidden console (not attached to the pseudoconsole, so
        /// neither Ctrl+C nor closing the pseudoconsole reaches it: only the
        /// Job can). Unix: SIGINT and SIGHUP ignored, so only SIGKILL to its
        /// process group can.
        fn start_stubborn_program(session: &PtySession, marker: &str) {
            #[cfg(windows)]
            type_line(
                session,
                &format!("$p = Start-Process ping -ArgumentList '-n','300','127.0.0.1' -WindowStyle Hidden -PassThru; \"{marker}=$($p.Id)\""),
            );
            #[cfg(unix)]
            type_line(session, &format!("sh -c 'trap \"\" INT HUP; echo {marker}=$$; exec sleep 300'"));
        }

        #[test]
        fn two_sessions_keep_their_own_input_and_output() {
            with_watchdog(|| {
                let (a, seen_a) = spawn(Arc::new(AtomicBool::new(false)));
                let (b, seen_b) = spawn(Arc::new(AtomicBool::new(false)));
                type_line(&a, "echo alpha-$((6*7))-done");
                type_line(&b, "echo bravo-$((6*7))-done");
                // Both shells echo the typed text, so the typed marker is
                // enough: it must reach only its own session.
                wait_for("alpha in session a", || output_of(&seen_a).contains("alpha-"));
                wait_for("bravo in session b", || output_of(&seen_b).contains("bravo-"));
                assert!(!output_of(&seen_a).contains("bravo-"));
                assert!(!output_of(&seen_b).contains("alpha-"));
                a.end();
                b.end();
            });
        }

        /// A shell that exits by itself while its view is paused: its last
        /// output still arrives, before the exit, with the exit code.
        ///
        /// The reader is parked first (`park_reader`), so the last output is
        /// surely still in the terminal when the shell exits. Before
        /// 2026-10-15 the test paused and typed straight away, and the read in
        /// progress could take the last output itself, so whether anything was
        /// left waiting depended on how the shell's writes fell into chunks.
        ///
        /// macOS differs. The shell is its terminal's controlling process, and
        /// XNU drains a controlling terminal's output before that process can
        /// finish exiting (`proc_exit` → `ttywait`, with no timeout unless the
        /// superuser sets one with `TIOCSDRAINWAIT`). So while the view is
        /// paused the exit is held, and it completes once the output is read:
        /// nothing is lost, the notice is only later. Linux and Windows let the
        /// shell exit at once. Found by intermittent macos-14 CI failures
        /// (main b70db3f, 2026-10-15).
        #[test]
        fn a_shell_exiting_by_itself_is_reported_with_its_code_after_its_output() {
            with_watchdog(|| {
                let exited = Arc::new(AtomicBool::new(false));
                let (session, seen) = spawn(Arc::clone(&exited));
                wait_quiet(&seen, Duration::from_millis(500));
                session.pause_output();
                park_reader(&session, &seen);
                #[cfg(windows)]
                type_line(&session, "Write-Output ('END' + '-MARKER'); exit 3");
                #[cfg(unix)]
                type_line(&session, "echo END''-MARKER; exit 3");
                #[cfg(target_os = "macos")]
                {
                    thread::sleep(Duration::from_secs(2));
                    assert!(
                        !exited.load(Ordering::SeqCst),
                        "macOS holds the exit while the terminal's output is unread"
                    );
                    assert!(!output_of(&seen).contains("END-MARKER"), "the last output is still queued");
                    session.resume_output();
                }
                wait_for("the exit watcher", || exited.load(Ordering::SeqCst));
                #[cfg(not(target_os = "macos"))]
                assert!(
                    !output_of(&seen).contains("END-MARKER"),
                    "the shell exited with its last output still queued"
                );
                // What the registry does on a self-exit.
                assert_eq!(session.end(), Some(3));
                let seen = seen.lock().unwrap();
                assert!(seen.output.contains("END-MARKER"), "the last output arrived");
                assert_eq!(seen.exits, vec![Some(3)]);
                assert_eq!(seen.order.last(), Some(&"E"), "the exit marker comes last");
            });
        }

        /// TEMPORARY DIAGNOSTIC (one CI run on the fix branch; removed before
        /// the pull request): where a self-exiting shell waits on macOS while
        /// the view is paused. It always fails, so CI prints its report.
        #[cfg(target_os = "macos")]
        #[test]
        fn diag_where_a_paused_self_exit_waits() {
            with_watchdog(|| {
                let ps = |pid: u32| {
                    std::process::Command::new("ps")
                        .args(["-o", "pid=,ppid=,stat=,wchan=,comm=", "-p", &pid.to_string()])
                        .output()
                        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_owned())
                        .unwrap_or_else(|error| format!("ps failed: {error}"))
                };
                let exited = Arc::new(AtomicBool::new(false));
                let (session, seen) = spawn(Arc::clone(&exited));
                wait_quiet(&seen, Duration::from_millis(500));
                let pid = session.inner.child.lock().unwrap().process_id().unwrap_or(0);
                let before = ps(pid);
                session.pause_output();
                park_reader(&session, &seen);
                type_line(&session, "echo END''-MARKER; exit 3");
                thread::sleep(Duration::from_secs(2));
                let held_exited = exited.load(Ordering::SeqCst);
                let held_has_marker = output_of(&seen).contains("END-MARKER");
                let held_ps = ps(pid);
                let resumed = Instant::now();
                session.resume_output();
                let mut exit_after = None;
                while resumed.elapsed() < Duration::from_secs(10) {
                    if exited.load(Ordering::SeqCst) {
                        exit_after = Some(resumed.elapsed());
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
                let code = session.end();
                let tail: String = output_of(&seen).chars().rev().take(300).collect::<Vec<_>>().into_iter().rev().collect();
                panic!(
                    "DIAG shell={:?} pid={pid} ps_before={before:?} held_exited={held_exited} \
                     held_has_marker={held_has_marker} ps_while_paused={held_ps:?} \
                     exit_after_resume={exit_after:?} end_code={code:?} output_tail={tail:?}",
                    std::env::var("SHELL").ok()
                );
            });
        }

        #[test]
        fn end_stops_a_program_ctrl_c_cannot_and_only_its_own_session() {
            with_watchdog(|| {
                let (a, seen_a) = spawn(Arc::new(AtomicBool::new(false)));
                let (b, seen_b) = spawn(Arc::new(AtomicBool::new(false)));
                thread::sleep(Duration::from_millis(1500));
                assert!(!a.is_busy(), "an idle shell is not busy");
                start_stubborn_program(&a, "APID");
                start_stubborn_program(&b, "BPID");
                let program_a = Watch::new(pid_of(&a, &seen_a, "APID"));
                let program_b = Watch::new(pid_of(&b, &seen_b, "BPID"));
                wait_for("session a to read as busy", || a.is_busy());

                a.end();
                wait_for("a's program to stop", || !program_a.alive());
                assert!(program_b.alive(), "b's program keeps running");
                assert!(b.is_busy(), "b is still busy");
                assert!(seen_a.lock().unwrap().exits.is_empty(), "End sends no Exited");
                b.end();
                wait_for("b's program to stop", || !program_b.alive());
            });
        }

        #[test]
        fn a_background_job_counts_as_busy_and_ends_with_its_session() {
            with_watchdog(|| {
                let (session, seen) = spawn(Arc::new(AtomicBool::new(false)));
                thread::sleep(Duration::from_millis(1500));
                #[cfg(windows)]
                type_line(
                    &session,
                    "$p = Start-Process ping -ArgumentList '-n','300','127.0.0.1' -WindowStyle Hidden -PassThru; \"JOB=$($p.Id)\"",
                );
                #[cfg(unix)]
                type_line(&session, "sleep 300 & echo JOB=$!");
                let job = Watch::new(pid_of(&session, &seen, "JOB"));
                wait_for("the shell to read as busy", || session.is_busy());
                session.end();
                wait_for("the background job to stop", || !job.alive());
            });
        }

        #[test]
        fn a_session_dropped_without_end_still_stops() {
            with_watchdog(|| {
                let (session, _seen) = spawn(Arc::new(AtomicBool::new(false)));
                let inner = Arc::clone(&session.inner);
                drop(session);
                wait_for("the backstop to end the session", || {
                    inner.ended.load(Ordering::SeqCst)
                        && matches!(inner.child.lock().unwrap().try_wait(), Ok(Some(_)))
                });
            });
        }
    }
}
