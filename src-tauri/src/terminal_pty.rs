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
/// After a self-exit, give the reader a moment to forward the program's last
/// output before the exit marker goes out.
const EXIT_SETTLE: Duration = Duration::from_millis(150);
/// Input messages waiting for the writer thread. Keystrokes are tiny; a full
/// queue means the program stopped reading its input.
const INPUT_QUEUE: usize = 1024;
const WRITER_POLL: Duration = Duration::from_millis(50);
/// Typed into the shell when the person ends the session: Ctrl+C cancels the
/// line being edited, then `exit` (PowerShell, pwsh, cmd.exe, sh, bash and zsh
/// all accept it). Track T's agent sessions (T2b) need another strategy: this
/// text would reach the agent as a prompt.
const SHELL_EXIT_SEQUENCE: &[u8] = b"\x03exit\r\n";

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
}

impl FlowControl {
    fn new() -> Self {
        Self {
            paused: Mutex::new(false),
            resume_signal: Condvar::new(),
        }
    }

    fn pause(&self) {
        *self.paused.lock().unwrap_or_else(PoisonError::into_inner) = true;
    }

    fn resume(&self) {
        *self.paused.lock().unwrap_or_else(PoisonError::into_inner) = false;
        self.resume_signal.notify_one();
    }

    fn wait_if_paused(&self, shutdown: &AtomicBool) {
        let mut guard = self.paused.lock().unwrap_or_else(PoisonError::into_inner);
        while *guard && !shutdown.load(Ordering::SeqCst) {
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
    // The only way input reaches the writer thread. `end` takes it.
    input: Mutex<Option<SyncSender<WriterMsg>>>,
    // Tells the writer thread to drop queued input and type the exit
    // sequence once its queue is drained.
    closing: Arc<AtomicBool>,
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
    Input(Vec<u8>),
    /// The startup handshake reply (see HandshakeFilter).
    Reply(&'static [u8]),
}

enum ProcessState {
    Exited(Option<i32>),
    Running,
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
/// - the reader forwards output to `channel`;
/// - the writer owns the PTY input and writes queued input in order;
/// - the exit watcher notices the shell exiting by itself, sends `Exited` and
///   calls `on_exit`.
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
        writer: Some(spawn_writer_thread(writer, input_rx, closing, &short).map_err(thread_error)?),
        reader: Some(
            spawn_reader_thread(
                reader,
                channel.clone(),
                Arc::clone(&shutdown),
                flow_control,
                Some(input_tx),
                &short,
            )
            .map_err(thread_error)?,
        ),
        watcher: Some(spawn_exit_watcher(child, shutdown, channel, on_exit, &short).map_err(thread_error)?),
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

fn spawn_reader_thread(
    mut reader: Box<dyn Read + Send>,
    channel: Channel<TerminalEvent>,
    shutdown: Arc<AtomicBool>,
    flow_control: Arc<FlowControl>,
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
                        // shutdown, and output from a session being ended must
                        // not reach the webview.
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

            if !shutdown.load(Ordering::SeqCst) {
                let tail = utf8.finish();
                if !tail.is_empty() {
                    let _ = channel.send(TerminalEvent::Output { chunk: tail });
                }
            }
        })
}

/// The writer thread owns the PTY input outright, so nothing else ever waits on
/// a lock while a write is blocked (a full input pipe blocks until the program
/// reads). Input, the handshake reply and the exit sequence all arrive in order.
fn spawn_writer_thread(
    mut writer: Box<dyn Write + Send>,
    queue: Receiver<WriterMsg>,
    closing: Arc<AtomicBool>,
    short: &str,
) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("terminal-writer-{short}"))
        .spawn(move || {
            let mut broken = false;
            loop {
                match queue.recv_timeout(WRITER_POLL) {
                    Ok(message) => {
                        // Once the session is ending, queued input is dropped:
                        // a paste still waiting must not run as the shell exits.
                        if closing.load(Ordering::SeqCst) || broken {
                            continue;
                        }
                        let bytes: &[u8] = match &message {
                            WriterMsg::Input(bytes) => bytes,
                            WriterMsg::Reply(bytes) => bytes,
                        };
                        broken = writer.write_all(bytes).and_then(|_| writer.flush()).is_err();
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        if closing.load(Ordering::SeqCst) {
                            break;
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
            if closing.load(Ordering::SeqCst) && !broken {
                let _ = writer.write_all(SHELL_EXIT_SEQUENCE);
                let _ = writer.flush();
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
    channel: Channel<TerminalEvent>,
    on_exit: Box<dyn FnOnce() + Send + 'static>,
    short: &str,
) -> std::io::Result<JoinHandle<()>> {
    thread::Builder::new()
        .name(format!("terminal-exit-{short}"))
        .spawn(move || {
            let exit_code = loop {
                if shutdown.load(Ordering::SeqCst) {
                    return;
                }
                // The lock is held for one non-blocking query at a time, so
                // `end` can always take it to kill the process.
                let status = child.lock().unwrap_or_else(PoisonError::into_inner).try_wait();
                match status {
                    Ok(Some(status)) => break Some(status.exit_code() as i32),
                    Ok(None) => thread::sleep(EXIT_POLL),
                    // The process can no longer be queried: treat it as gone.
                    Err(_) => break None,
                }
            };
            thread::sleep(EXIT_SETTLE);
            if shutdown.load(Ordering::SeqCst) {
                return;
            }
            let _ = channel.send(TerminalEvent::Exited { exit_code });
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

    /// Whether the shell is running something: a program of its own, not just
    /// its prompt. A command running inside the shell process itself (a
    /// PowerShell cmdlet, a shell builtin) does not count.
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
    /// Ends the session. Blocking, idempotent, bounded.
    ///
    /// Order (docs/plans/persistence/project-switch-crash-investigation.md,
    /// and the T2a design critique):
    /// 1. Stop forwarding output and lift any pause.
    /// 2. Let the writer type Ctrl+C and `exit`, and wait for the shell. A
    ///    clean exit is what lets the console host shut down promptly.
    /// 3. If the shell is still running, stop it and everything it started:
    ///    the job on Windows, the session's process groups on Unix.
    /// 4. Windows: drop the job (kill on close) BEFORE closing the
    ///    pseudoconsole. Closing it while a killed client is still attached
    ///    can wedge the in-box console host forever; with the job gone first,
    ///    a wedge could leak at most an idle host and a thread.
    /// 5. Close the pseudoconsole (drop the master), then join the threads,
    ///    each with a bound.
    fn end(&self) -> Option<i32> {
        if self.ended.swap(true, Ordering::SeqCst) {
            return *self.exit_code.lock().unwrap_or_else(PoisonError::into_inner);
        }

        self.shutdown.store(true, Ordering::SeqCst);
        self.flow_control.resume();
        self.closing.store(true, Ordering::SeqCst);
        // Each part is taken out first and dropped after its lock is
        // released: a guard in the same statement would stay held through the
        // drop, and closing a pseudoconsole can take a long time.
        let input = self.input.lock().unwrap_or_else(PoisonError::into_inner).take();
        drop(input);

        let mut state = self.wait_for_exit(GRACEFUL_EXIT);
        if matches!(state, ProcessState::Running) {
            self.stop_process_tree();
            state = self.wait_for_exit(KILL_WAIT);
        }
        if matches!(state, ProcessState::Running) {
            let _ = self.child.lock().unwrap_or_else(PoisonError::into_inner).kill();
            state = self.wait_for_exit(KILL_WAIT);
        }

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

        let code = match state {
            ProcessState::Exited(code) => code,
            ProcessState::Running => None,
        };
        *self.exit_code.lock().unwrap_or_else(PoisonError::into_inner) = code;
        code
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

    #[cfg(unix)]
    fn stop_process_tree(&self) {
        self.signal_process_groups(libc::SIGHUP);
        if matches!(self.wait_for_exit(Duration::from_millis(250)), ProcessState::Running) {
            self.signal_process_groups(libc::SIGKILL);
        }
    }

    /// Signals the shell's own process group and the terminal's foreground
    /// group. The shell leads its own session (portable-pty calls setsid), so
    /// its group id is its pid. A background job in a group of its own is not
    /// reached (residual, verified on macOS and Linux in track T slice T5).
    #[cfg(unix)]
    fn signal_process_groups(&self, signal: libc::c_int) {
        let own_group = unsafe { libc::getpgrp() };
        let mut groups: Vec<libc::pid_t> = Vec::new();
        if let Some(pid) = self.shell_pid {
            groups.push(pid as libc::pid_t);
        }
        if let Some(master) = self.master.lock().unwrap_or_else(PoisonError::into_inner).as_ref() {
            if let Some(foreground) = master.process_group_leader() {
                groups.push(foreground);
            }
        }
        groups.sort_unstable();
        groups.dedup();
        for group in groups {
            // Never group 0 or 1, never Litria's own group: kill(-pgid) with a
            // bad id signals far more than this session.
            if group > 1 && group != own_group {
                unsafe {
                    libc::killpg(group, signal);
                }
            }
        }
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

    #[cfg(unix)]
    fn has_child_processes(&self) -> bool {
        let master = self.master.lock().unwrap_or_else(PoisonError::into_inner);
        let foreground = master.as_ref().and_then(|m| m.process_group_leader());
        match (foreground, self.shell_pid) {
            (Some(foreground), Some(pid)) => foreground as u32 != pid,
            // Unknown: say busy (see the Windows version).
            _ => true,
        }
    }
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
        let handle = spawn_writer_thread(Box::new(writer), received, Arc::clone(&closing), "test").unwrap();

        queue.send(WriterMsg::Input(b"first\r".to_vec())).unwrap();
        entered.wait();
        // Queued behind a write that is blocked, as a paste into a busy shell.
        queue.send(WriterMsg::Input(b"second\r".to_vec())).unwrap();
        closing.store(true, Ordering::SeqCst);
        drop(queue);
        release.wait();
        handle.join().unwrap();

        let written = String::from_utf8(written.lock().unwrap().clone()).unwrap();
        assert_eq!(written, "first\r\x03exit\r\n");
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
        let handle =
            spawn_writer_thread(Box::new(Recorder(Arc::clone(&written))), received, Arc::clone(&closing), "test")
                .unwrap();
        for part in ["a", "b", "c"] {
            queue.send(WriterMsg::Input(part.as_bytes().to_vec())).unwrap();
        }
        queue.send(WriterMsg::Reply(CURSOR_REPLY)).unwrap();
        drop(queue);
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
                Err(_) if handle.is_finished() => {
                    if let Err(panic) = handle.join() {
                        std::panic::resume_unwind(panic);
                    }
                }
                Err(_) => panic!("watchdog: still running after {WATCHDOG:?}"),
            }
        }

        #[derive(Default)]
        struct Seen {
            output: String,
            exits: Vec<Option<i32>>,
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
                            seen.output.push_str(value["data"]["chunk"].as_str().unwrap_or_default())
                        }
                        Some("Exited") => seen.exits.push(value["data"]["exitCode"].as_i64().map(|c| c as i32)),
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

        fn type_line(session: &PtySession, line: &str) {
            session.write_input(format!("{line}\r").as_bytes()).unwrap();
        }

        /// The pid a line of output reports as `PID=<n>`.
        fn reported_pid(output: &str) -> Option<u32> {
            output
                .split("PID=")
                .skip(1)
                .filter_map(|rest| {
                    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
                    digits.parse().ok()
                })
                .last()
        }

        #[cfg(windows)]
        fn process_alive(pid: u32) -> bool {
            let listed = crate::platform::hidden_command("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH", "/FO", "CSV"])
                .output()
                .expect("tasklist runs");
            String::from_utf8_lossy(&listed.stdout).contains(&format!("\"{pid}\""))
        }

        #[cfg(unix)]
        fn process_alive(pid: u32) -> bool {
            // Signal 0 checks existence. A zombie counts as gone here: its
            // parent shell has exited too.
            unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
                && !std::fs::read_to_string(format!("/proc/{pid}/stat"))
                    .map(|stat| stat.contains(") Z "))
                    .unwrap_or(false)
        }

        #[test]
        fn two_sessions_keep_their_own_input_and_output() {
            with_watchdog(|| {
                let (a, seen_a) = spawn(Arc::new(AtomicBool::new(false)));
                let (b, seen_b) = spawn(Arc::new(AtomicBool::new(false)));
                type_line(&a, "echo alpha-$((6*7))-done");
                type_line(&b, "echo bravo-$((6*7))-done");
                // PowerShell has no $((...)); both shells echo the typed text,
                // so check the typed marker reached only its own session.
                wait_for("alpha in session a", || output_of(&seen_a).contains("alpha-"));
                wait_for("bravo in session b", || output_of(&seen_b).contains("bravo-"));
                assert!(!output_of(&seen_a).contains("bravo-"));
                assert!(!output_of(&seen_b).contains("alpha-"));
                a.end();
                b.end();
            });
        }

        #[test]
        fn a_shell_exiting_by_itself_is_reported_with_its_code() {
            with_watchdog(|| {
                let exited = Arc::new(AtomicBool::new(false));
                let (session, seen) = spawn(Arc::clone(&exited));
                type_line(&session, "exit 3");
                wait_for("the exit watcher", || exited.load(Ordering::SeqCst));
                assert_eq!(seen.lock().unwrap().exits, vec![Some(3)]);
                assert_eq!(session.end(), Some(3));
                // Ending sends no second exit marker.
                assert_eq!(seen.lock().unwrap().exits.len(), 1);
            });
        }

        #[test]
        fn end_stops_a_running_program_and_reports_no_exit_event() {
            with_watchdog(|| {
                let (session, seen) = spawn(Arc::new(AtomicBool::new(false)));
                // Give the shell time to reach its prompt; idle is not busy.
                thread::sleep(Duration::from_millis(1500));
                assert!(!session.is_busy(), "an idle shell is not busy");
                #[cfg(windows)]
                type_line(
                    &session,
                    "$p = Start-Process ping -ArgumentList '-n','300','127.0.0.1' -NoNewWindow -PassThru; \"PID=$($p.Id)\"",
                );
                #[cfg(unix)]
                type_line(&session, "sh -c 'echo PID=$$; exec sleep 300'");
                wait_for("the program's pid", || reported_pid(&output_of(&seen)).is_some());
                let pid = reported_pid(&output_of(&seen)).unwrap();
                assert!(process_alive(pid));
                wait_for("the session to read as busy", || session.is_busy());

                session.end();
                wait_for("the program to stop", || !process_alive(pid));
                assert!(seen.lock().unwrap().exits.is_empty(), "End sends no Exited");
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
