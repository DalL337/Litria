// Subprocess deadline and cancel (ADR-028 §8, F30).
//
// Every scaffold subprocess — the create CLI, add-on installs/execs, the
// Python environment step — runs through `run_with_limits`, which owns the
// child (Orchestration §1.2: one owner per spawned resource) and enforces
// two limits that the registry states per step kind:
//
//   * an **idle-output timeout** — reset by every line the child prints;
//   * an **absolute deadline** — measured from the spawn with a monotonic
//     clock; output never extends it.
//
// Either expiry, or an explicit `cancel_run`, tears the whole process tree
// down in the §1.2 order — signal intent, wait with a timeout, force kill,
// reap — and reports a distinct `StepFailure`, so the trace says *why* a
// step stopped. On Windows the child is assigned to a Job Object with
// kill-on-close (the terminal's own pattern) so descendants die with it; on
// Unix the child leads its own process group and the group is signalled.
//
// The registry of live runs is keyed by the wizard's `runId`; a run that
// never registered (unit tests, Blank) gets a private control block.

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

/// How often the wait loop re-checks cancel, idle, and deadline.
const TICK: Duration = Duration::from_millis(250);
/// How long a signalled process gets before it is force-killed.
const GRACE: Duration = Duration::from_millis(1500);

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StepLimits {
    pub idle: Duration,
    pub deadline: Duration,
}

impl StepLimits {
    pub(crate) fn from_seconds(idle: u64, deadline: u64) -> Self {
        Self { idle: Duration::from_secs(idle), deadline: Duration::from_secs(deadline) }
    }

    /// The trace line written when a step starts — the limits are part of
    /// the record, not a hidden constant.
    pub(crate) fn describe(&self) -> String {
        format!(
            "limits: idle {}s (reset by output) · deadline {}s (never extended)",
            self.idle.as_secs(),
            self.deadline.as_secs()
        )
    }
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum StepFailure {
    /// The program could not be started.
    Spawn(String),
    /// Waiting on the process failed.
    Wait(String),
    /// The process exited on its own with a non-zero status (code as text,
    /// `signal` when there is none).
    Exit(String),
    /// No output for the idle limit — torn down.
    IdleTimeout(Duration),
    /// Ran past the absolute deadline — torn down.
    Deadline(Duration),
    /// `cancel_run` was called — torn down.
    Cancelled,
}

impl StepFailure {
    /// `what` names the step as the trace shows it ("Creating Angular
    /// project", "uv"), never an executable path.
    pub(crate) fn message(&self, what: &str) -> String {
        match self {
            StepFailure::Spawn(e) => format!("{what}: failed to start: {e}"),
            StepFailure::Wait(e) => format!("{what}: failed to wait for the process: {e}"),
            StepFailure::Exit(code) => format!("{what}: exited with {code}"),
            StepFailure::IdleTimeout(d) => format!(
                "{what}: no output for {}s (idle limit) — stopped; its process tree was torn down",
                d.as_secs()
            ),
            StepFailure::Deadline(d) => format!(
                "{what}: ran past the {}s deadline — stopped; its process tree was torn down",
                d.as_secs()
            ),
            StepFailure::Cancelled => format!("{what}: cancelled — its process tree was torn down"),
        }
    }

    /// True when the runner (not the child) ended the step — the tree was
    /// torn down and the run must stop rather than continue to the next step.
    pub(crate) fn is_abort(&self) -> bool {
        matches!(self, StepFailure::IdleTimeout(_) | StepFailure::Deadline(_) | StepFailure::Cancelled)
    }

    pub(crate) fn code(&self) -> &'static str {
        match self {
            StepFailure::Cancelled => "scaffold.cancelled",
            StepFailure::IdleTimeout(_) => "scaffold.step_idle_timeout",
            StepFailure::Deadline(_) => "scaffold.step_deadline",
            _ => "scaffold.step_failed",
        }
    }
}

// ---------------------------------------------------------------------------
// Run registry
// ---------------------------------------------------------------------------

/// One run's control block, shared by the executing thread and
/// `cancel_run`. Cancellation is a flag: the executing thread — the child's
/// only owner — notices it on the next tick and performs the teardown.
#[derive(Debug, Default)]
pub(crate) struct RunControl {
    cancel: AtomicBool,
}

impl RunControl {
    pub(crate) fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    pub(crate) fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
}

fn runs() -> &'static Mutex<HashMap<String, Arc<RunControl>>> {
    static RUNS: OnceLock<Mutex<HashMap<String, Arc<RunControl>>>> = OnceLock::new();
    RUNS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Register a run so `cancel_run(run_id)` can reach it. A run without an id
/// gets a private control block nothing else can cancel.
pub(crate) fn register_run(run_id: Option<&str>) -> Arc<RunControl> {
    let control = Arc::new(RunControl::default());
    if let Some(id) = run_id.map(str::trim).filter(|id| !id.is_empty()) {
        if let Ok(mut map) = runs().lock() {
            map.insert(id.to_string(), Arc::clone(&control));
        }
    }
    control
}

/// Forget a finished run (lock, remove, release — §1.2 rule 3).
pub(crate) fn finish_run(run_id: Option<&str>) {
    if let Some(id) = run_id {
        if let Ok(mut map) = runs().lock() {
            map.remove(id);
        }
    }
}

/// Request cancellation. Returns false when no such run is live.
pub(crate) fn cancel_run(run_id: &str) -> bool {
    let control = runs().lock().ok().and_then(|map| map.get(run_id).cloned());
    match control {
        Some(control) => {
            control.cancel();
            true
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Process tree
// ---------------------------------------------------------------------------

/// Handle on the child's process tree for teardown.
struct ProcessTree {
    pid: u32,
    #[cfg(windows)]
    job: Option<win32job::Job>,
}

impl ProcessTree {
    fn adopt(child: &Child) -> Self {
        let pid = child.id();
        #[cfg(windows)]
        {
            Self { pid, job: windows_job_for(pid) }
        }
        #[cfg(not(windows))]
        {
            Self { pid }
        }
    }

    /// Orchestration §1.2: signal intent → wait with timeout → force kill →
    /// reap. Returns once the direct child is reaped; descendants are killed
    /// through the job (Windows) or the process group (Unix).
    fn teardown(self, child: &mut Child) {
        signal_tree(self.pid);
        let until = Instant::now() + GRACE;
        while Instant::now() < until {
            if matches!(child.try_wait(), Ok(Some(_))) {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        force_kill_tree(self.pid);
        #[cfg(windows)]
        {
            // Closing the last job handle kills every process still in it.
            drop(self.job);
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[cfg(windows)]
fn windows_job_for(pid: u32) -> Option<win32job::Job> {
    let job = win32job::Job::create().ok()?;
    let mut info = job.query_extended_limit_info().ok()?;
    info.limit_kill_on_job_close();
    job.set_extended_limit_info(&mut info).ok()?;
    // SAFETY: OpenProcess/CloseHandle on a pid we just spawned; the handle is
    // closed on every path.
    unsafe {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_ALL_ACCESS};
        let handle = OpenProcess(PROCESS_ALL_ACCESS, false, pid).ok()?;
        let assigned = job.assign_process(handle.0 as isize);
        let _ = CloseHandle(handle);
        assigned.ok()?;
    }
    Some(job)
}

#[cfg(windows)]
fn signal_tree(pid: u32) {
    // No SIGTERM on Windows: `taskkill /T` without /F asks each process in
    // the tree to close (WM_CLOSE / console control). Console tools mostly
    // ignore it; the force step below is what actually ends them.
    let _ = crate::platform::hidden_command("taskkill")
        .args(["/PID", &pid.to_string(), "/T"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(windows)]
fn force_kill_tree(pid: u32) {
    let _ = crate::platform::hidden_command("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn signal_tree(pid: u32) {
    // The child leads its own process group (see `run_with_limits`), so a
    // negative pid reaches every descendant that stayed in the group.
    let _ = crate::platform::hidden_command("kill")
        .args(["-TERM", &format!("-{pid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(windows))]
fn force_kill_tree(pid: u32) {
    let _ = crate::platform::hidden_command("kill")
        .args(["-KILL", &format!("-{pid}")])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

// ---------------------------------------------------------------------------
// The run loop
// ---------------------------------------------------------------------------

/// Spawn `command`, stream its merged stdout/stderr lines to `on_line`, and
/// enforce `limits` and `control`. Output resets the idle timer only; the
/// deadline runs from the spawn. On any abort the whole tree is torn down
/// and the child reaped before this returns.
pub(crate) fn run_with_limits(
    mut command: Command,
    limits: StepLimits,
    control: &RunControl,
    mut on_line: impl FnMut(String),
) -> Result<(), StepFailure> {
    command.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    // The output is a trace and a build log, never a terminal: ask every
    // tool for plain text (the Angular CLI coloured the trace with raw
    // escape codes — owner live pass 2026-09-17). Both conventions, since
    // libraries differ in which one they honour.
    command.env("NO_COLOR", "1").env("FORCE_COLOR", "0");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    if control.is_cancelled() {
        return Err(StepFailure::Cancelled);
    }
    let mut child = command.spawn().map_err(|e| StepFailure::Spawn(e.to_string()))?;
    let tree = ProcessTree::adopt(&child);

    let (tx, rx) = mpsc::channel::<String>();
    let mut readers = Vec::new();
    if let Some(stdout) = child.stdout.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        }));
    }
    if let Some(stderr) = child.stderr.take() {
        let tx = tx.clone();
        readers.push(std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                let _ = tx.send(line);
            }
        }));
    }
    drop(tx);

    let started = Instant::now();
    let mut last_output = started;
    let outcome = loop {
        if control.is_cancelled() {
            break Err(StepFailure::Cancelled);
        }
        let now = Instant::now();
        if now.duration_since(started) >= limits.deadline {
            break Err(StepFailure::Deadline(limits.deadline));
        }
        if now.duration_since(last_output) >= limits.idle {
            break Err(StepFailure::IdleTimeout(limits.idle));
        }
        match rx.recv_timeout(TICK) {
            Ok(line) => {
                last_output = Instant::now();
                on_line(line);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            // Both pipes closed: the process (and whatever inherited its
            // pipes) has exited.
            Err(mpsc::RecvTimeoutError::Disconnected) => break Ok(()),
        }
    };

    match outcome {
        Ok(()) => {
            for reader in readers {
                let _ = reader.join();
            }
            let status = child.wait().map_err(|e| StepFailure::Wait(e.to_string()))?;
            if status.success() {
                Ok(())
            } else {
                Err(StepFailure::Exit(
                    status.code().map_or("signal".to_string(), |c| c.to_string()),
                ))
            }
        }
        Err(reason) => {
            tree.teardown(&mut child);
            // The pipes close with the tree; drain what arrived meanwhile.
            for reader in readers {
                let _ = reader.join();
            }
            for line in rx.try_iter() {
                on_line(line);
            }
            Err(reason)
        }
    }
}

// ---------------------------------------------------------------------------
// Tests: run with `cargo test process_control`
// ---------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn node() -> Command {
        crate::platform::hidden_command("node")
    }

    /// Whether a pid is still alive (descendant checks after teardown).
    fn is_alive(pid: u32) -> bool {
        #[cfg(windows)]
        {
            let out = crate::platform::hidden_command("tasklist")
                .args(["/FI", &format!("PID eq {pid}"), "/NH"])
                .output()
                .expect("tasklist");
            String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
        }
        #[cfg(not(windows))]
        {
            Command::new("kill").args(["-0", &pid.to_string()]).status().map(|s| s.success()).unwrap_or(false)
        }
    }

    fn pid_file(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "litria-pc-{tag}-{}-{}.pid",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)
        ))
    }

    /// A node child that spawns a grandchild (sleeping forever), writes the
    /// grandchild's pid to `file`, then sleeps forever itself — silent unless
    /// `chatty`.
    fn family(file: &PathBuf, chatty: bool) -> Command {
        let tick = if chatty { "setInterval(() => console.log('tick'), 40);" } else { "" };
        let script = format!(
            "const cp = require('child_process'); const fs = require('fs');\
             const g = cp.spawn(process.execPath, ['-e', 'setInterval(() => {{}}, 1000)'], {{ stdio: 'ignore' }});\
             fs.writeFileSync(process.argv[1], String(g.pid)); {tick} setInterval(() => {{}}, 1000);"
        );
        let mut cmd = node();
        cmd.arg("-e").arg(script).arg(file);
        cmd
    }

    fn grandchild_pid(file: &PathBuf) -> u32 {
        let until = Instant::now() + Duration::from_secs(10);
        while Instant::now() < until {
            if let Ok(text) = std::fs::read_to_string(file) {
                if let Ok(pid) = text.trim().parse() {
                    return pid;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("grandchild pid never appeared in {}", file.display());
    }

    fn wait_dead(pid: u32) -> bool {
        let until = Instant::now() + Duration::from_secs(5);
        while Instant::now() < until {
            if !is_alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    #[test]
    fn clean_exit_streams_output_and_reports_ok() {
        let mut cmd = node();
        cmd.args(["-e", "console.log('hi'); console.error('err line')"]);
        let mut lines = Vec::new();
        let result = run_with_limits(cmd, StepLimits::from_seconds(10, 30), &RunControl::default(), |l| lines.push(l));
        assert_eq!(result, Ok(()));
        assert!(lines.contains(&"hi".to_string()) && lines.contains(&"err line".to_string()), "{lines:?}");
    }

    #[test]
    fn every_subprocess_is_asked_for_plain_output() {
        let mut cmd = node();
        cmd.args(["-e", "console.log(process.env.NO_COLOR + '/' + process.env.FORCE_COLOR)"]);
        let mut lines = Vec::new();
        run_with_limits(cmd, StepLimits::from_seconds(10, 30), &RunControl::default(), |l| lines.push(l)).unwrap();
        assert_eq!(lines, vec!["1/0".to_string()]);
    }

    #[test]
    fn failure_messages_name_the_step_not_an_executable() {
        assert_eq!(StepFailure::Cancelled.message("Creating Angular project"), "Creating Angular project: cancelled — its process tree was torn down");
        assert_eq!(StepFailure::Exit("2".into()).message("uv"), "uv: exited with 2");
        assert!(StepFailure::IdleTimeout(Duration::from_secs(300)).message("addon:tailwind: install tailwindcss").starts_with("addon:tailwind: install tailwindcss: no output for 300s"));
    }

    #[test]
    fn non_zero_exit_is_reported_with_its_code() {
        let mut cmd = node();
        cmd.args(["-e", "process.exit(3)"]);
        let result = run_with_limits(cmd, StepLimits::from_seconds(10, 30), &RunControl::default(), |_| {});
        assert_eq!(result, Err(StepFailure::Exit("3".into())));
        assert!(!StepFailure::Exit("3".into()).is_abort());
    }

    #[test]
    fn silent_child_hits_the_idle_timeout_and_its_descendants_die() {
        let file = pid_file("idle");
        let limits = StepLimits { idle: Duration::from_millis(600), deadline: Duration::from_secs(30) };
        let started = Instant::now();
        let result = run_with_limits(family(&file, false), limits, &RunControl::default(), |_| {});
        assert_eq!(result, Err(StepFailure::IdleTimeout(limits.idle)));
        assert!(started.elapsed() < Duration::from_secs(20), "teardown must not hang");
        let grandchild = grandchild_pid(&file);
        assert!(wait_dead(grandchild), "grandchild {grandchild} must be terminated with the tree");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn chatty_child_hits_the_absolute_deadline_and_its_descendants_die() {
        let file = pid_file("deadline");
        // Output every 40ms keeps the idle timer fresh; the deadline still fires.
        let limits = StepLimits { idle: Duration::from_secs(5), deadline: Duration::from_millis(900) };
        let mut lines = 0usize;
        let result = run_with_limits(family(&file, true), limits, &RunControl::default(), |_| lines += 1);
        assert_eq!(result, Err(StepFailure::Deadline(limits.deadline)));
        assert!(lines > 3, "output was flowing ({lines} lines) — the deadline is what stopped it");
        let grandchild = grandchild_pid(&file);
        assert!(wait_dead(grandchild), "grandchild {grandchild} must be terminated with the tree");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn explicit_cancel_tears_the_tree_down() {
        let file = pid_file("cancel");
        let control = register_run(Some("test-cancel-run"));
        let canceller = {
            let file = file.clone();
            std::thread::spawn(move || {
                let _ = grandchild_pid(&file); // the family is up
                assert!(cancel_run("test-cancel-run"), "the run is registered");
                assert!(!cancel_run("no-such-run"));
            })
        };
        let limits = StepLimits::from_seconds(30, 60);
        let result = run_with_limits(family(&file, false), limits, &control, |_| {});
        let _ = canceller.join();
        assert_eq!(result, Err(StepFailure::Cancelled));
        let grandchild = grandchild_pid(&file);
        assert!(wait_dead(grandchild), "grandchild {grandchild} must be terminated with the tree");
        finish_run(Some("test-cancel-run"));
        assert!(!cancel_run("test-cancel-run"), "a finished run is forgotten");
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn a_cancelled_control_never_spawns() {
        let control = RunControl::default();
        control.cancel();
        let mut cmd = node();
        cmd.args(["-e", "console.log('never')"]);
        assert_eq!(run_with_limits(cmd, StepLimits::from_seconds(5, 5), &control, |_| panic!("no output")), Err(StepFailure::Cancelled));
    }

    #[test]
    fn limits_describe_themselves_for_the_trace() {
        assert_eq!(
            StepLimits::from_seconds(300, 1800).describe(),
            "limits: idle 300s (reset by output) · deadline 1800s (never extended)"
        );
        assert_eq!(StepFailure::Cancelled.code(), "scaffold.cancelled");
        assert_eq!(StepFailure::IdleTimeout(Duration::from_secs(1)).code(), "scaffold.step_idle_timeout");
        assert_eq!(StepFailure::Deadline(Duration::from_secs(1)).code(), "scaffold.step_deadline");
    }
}
