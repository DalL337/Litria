//! Terminal sessions, several per project (track T slice T2a).
//!
//! A session lives until the person ends it, its shell exits by itself, its
//! project closes, the window reloads, or Litria quits. No view owns it: the
//! drawer only shows sessions (docs/Orchestration.md §1.2).
//!
//! One lock guards everything a decision needs: live sessions, starts in
//! flight (a project close or quit cancels them), sessions still ending (they
//! count toward the total cap, so a teardown that never finishes stays
//! bounded and visible), and the quit flag. Spawning and ending run outside
//! the lock; ending runs on threads of its own, never on the caller's.

use crate::errors::{CommandError, CommandResult};
use crate::terminal_policy;
use crate::terminal_pty::{self, PtySession, TerminalEvent};
use crate::terminal_types::{
    TerminalEndReport, TerminalSessionEndedPayload, TerminalSessionStartedPayload,
};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, MutexGuard, OnceLock, PoisonError};
use std::thread;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;

pub(crate) const MAX_SESSIONS_PER_PROJECT: usize = 8;
/// Live, starting and still-ending sessions together. One project is open at a
/// time, so in practice this bounds teardowns that never finished.
pub(crate) const MAX_SESSIONS_TOTAL: usize = 24;
/// How long End, a project close and end-all wait before reporting the rest as
/// still ending. It stays below the frontend's 5 s teardown timeout
/// (src/app/useProjectLaunch.js), so the frontend hears back first.
pub(crate) const END_BUDGET: Duration = Duration::from_millis(3000);
/// Quit waits this long for every teardown, including ones already running.
const QUIT_BUDGET: Duration = Duration::from_millis(4000);
const MAX_PROJECT_ID_LEN: usize = 256;
/// Shells that exited before their session was registered (a few ms window).
const EARLY_EXIT_LIMIT: usize = 64;

/// What the registry needs from a session. `PtySession` in the app; fakes in
/// the tests, so races and budgets are tested without real shells.
pub(crate) trait TerminalSession: Send + Sync + 'static {
    fn write_input(&self, data: &[u8]) -> CommandResult<()>;
    fn resize(&self, cols: u16, rows: u16) -> CommandResult<()>;
    fn pause_output(&self);
    fn resume_output(&self);
    fn is_busy(&self) -> bool;
    /// Ends the session and everything it started. Blocking and idempotent.
    fn end(&self) -> Option<i32>;
}

pub(crate) struct Registry<S: TerminalSession> {
    state: Mutex<State<S>>,
    /// Signalled whenever a start in flight resolves or a teardown finishes.
    settled: Condvar,
}

struct State<S> {
    live: HashMap<String, Live<S>>,
    pending: HashMap<u64, Pending>,
    next_token: u64,
    ending: usize,
    quitting: bool,
    early_exits: HashSet<String>,
    /// Bumped by every page (re)load. A start captures it when its command
    /// arrives; a start from a page that has since reloaded is never
    /// registered (its sweep already ran, and nothing would ever show it).
    page: u64,
}

struct Live<S> {
    project_id: String,
    root: PathBuf,
    session: Arc<S>,
}

struct Pending {
    project_id: String,
    root: PathBuf,
    cancelled: bool,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct EndReport {
    pub(crate) ended: Vec<(String, Option<i32>)>,
    pub(crate) still_ending: usize,
}

/// Releases a start's reservation if the spawn panics.
struct Reservation<'a, S: TerminalSession> {
    registry: &'a Registry<S>,
    token: u64,
    armed: bool,
}

impl<S: TerminalSession> Drop for Reservation<'_, S> {
    fn drop(&mut self) {
        if self.armed {
            self.registry.lock().pending.remove(&self.token);
            self.registry.settled.notify_all();
        }
    }
}

impl<S: TerminalSession> Registry<S> {
    pub(crate) fn new() -> Arc<Self> {
        Arc::new(Self {
            state: Mutex::new(State {
                live: HashMap::new(),
                pending: HashMap::new(),
                next_token: 0,
                ending: 0,
                quitting: false,
                early_exits: HashSet::new(),
                page: 0,
            }),
            settled: Condvar::new(),
        })
    }

    /// A poisoned lock still guards consistent data here (every critical
    /// section is a few map operations), and teardown must keep working.
    fn lock(&self) -> MutexGuard<'_, State<S>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// The current page generation (see `State::page`).
    pub(crate) fn page(&self) -> u64 {
        self.lock().page
    }

    /// Starts a session on the current page.
    #[cfg(test)]
    pub(crate) fn start(
        self: &Arc<Self>,
        project_id: &str,
        root: PathBuf,
        spawn: impl FnOnce(&str) -> CommandResult<S>,
    ) -> CommandResult<String> {
        let page = self.page();
        self.start_on_page(page, project_id, root, spawn)
    }

    /// Starts a session. Under the lock: refuse while quitting or once the
    /// page that asked has reloaded, check the project's folder and the caps,
    /// and reserve a slot. Outside it: spawn. Then register the session,
    /// unless its project closed, the page reloaded or Litria began quitting
    /// meanwhile; such a session is ended at once.
    pub(crate) fn start_on_page(
        self: &Arc<Self>,
        page: u64,
        project_id: &str,
        root: PathBuf,
        spawn: impl FnOnce(&str) -> CommandResult<S>,
    ) -> CommandResult<String> {
        let token = self.reserve(page, project_id, &root)?;
        let mut reservation = Reservation {
            registry: self.as_ref(),
            token,
            armed: true,
        };
        let session_id = new_session_id();
        let spawned = spawn(&session_id);

        let mut state = self.lock();
        let pending = state.pending.remove(&token);
        reservation.armed = false;
        self.settled.notify_all();
        let session = Arc::new(spawned?);

        let cancelled = state.quitting || state.page != page || pending.map_or(true, |p| p.cancelled);
        let exited = state.early_exits.remove(&session_id);
        if cancelled || exited {
            state.ending += 1;
            drop(state);
            self.finish_detached(vec![(session_id.clone(), session)]);
            if cancelled {
                return Err(CommandError::conflict(
                    "terminal.project_closed",
                    "The project closed while the terminal was starting.",
                ));
            }
            // The shell already exited; its Exited event is on the channel.
            return Ok(session_id);
        }

        state.live.insert(
            session_id.clone(),
            Live {
                project_id: project_id.to_string(),
                root,
                session,
            },
        );
        Ok(session_id)
    }

    fn reserve(&self, page: u64, project_id: &str, root: &Path) -> CommandResult<u64> {
        let mut state = self.lock();
        if state.quitting {
            return Err(CommandError::conflict(
                "terminal.shutting_down",
                "Litria is closing.",
            ));
        }
        if state.page != page {
            return Err(CommandError::conflict(
                "terminal.project_closed",
                "The window reloaded while the terminal was starting.",
            ));
        }

        // One project, one folder: its sessions all run in the same root.
        let bound_root = state
            .live
            .values()
            .filter(|live| live.project_id == project_id)
            .map(|live| &live.root)
            .chain(
                state
                    .pending
                    .values()
                    .filter(|p| p.project_id == project_id && !p.cancelled)
                    .map(|p| &p.root),
            )
            .next();
        if let Some(bound_root) = bound_root {
            if bound_root.as_path() != root {
                return Err(CommandError::conflict(
                    "terminal.project_root_mismatch",
                    "This project's terminals run in another folder.",
                ));
            }
        }

        let in_project = state
            .live
            .values()
            .filter(|live| live.project_id == project_id)
            .count()
            + state
                .pending
                .values()
                .filter(|p| p.project_id == project_id)
                .count();
        if in_project >= MAX_SESSIONS_PER_PROJECT {
            return Err(CommandError::conflict(
                "terminal.session_limit",
                format!("A project can have at most {MAX_SESSIONS_PER_PROJECT} terminals."),
            ));
        }
        if state.live.len() + state.pending.len() + state.ending >= MAX_SESSIONS_TOTAL {
            return Err(CommandError::conflict(
                "terminal.session_limit",
                "Too many terminals are open or still closing.",
            ));
        }

        let token = state.next_token;
        state.next_token += 1;
        state.pending.insert(
            token,
            Pending {
                project_id: project_id.to_string(),
                root: root.to_path_buf(),
                cancelled: false,
            },
        );
        Ok(token)
    }

    /// The live session, checked against its project. The clone lets the
    /// caller use it with the registry lock released.
    pub(crate) fn session(&self, project_id: &str, session_id: &str) -> CommandResult<Arc<S>> {
        let state = self.lock();
        match state.live.get(session_id) {
            Some(live) if live.project_id == project_id => Ok(Arc::clone(&live.session)),
            Some(_) => Err(project_mismatch()),
            None => Err(CommandError::not_found(
                "terminal.session_not_found",
                "No such terminal session.",
            )),
        }
    }

    /// Ends one session. A session that already ended reports nothing ended.
    pub(crate) fn end(self: &Arc<Self>, project_id: &str, session_id: &str) -> CommandResult<EndReport> {
        let taken = {
            let mut state = self.lock();
            match state.live.get(session_id) {
                Some(live) if live.project_id != project_id => return Err(project_mismatch()),
                Some(_) => {
                    let live = state.live.remove(session_id).map(|live| live.session);
                    state.ending += 1;
                    live.map(|session| vec![(session_id.to_string(), session)])
                        .unwrap_or_default()
                }
                None => Vec::new(),
            }
        };
        Ok(self.finish(taken, END_BUDGET))
    }

    /// Ends every session of a project and cancels its starts in flight.
    pub(crate) fn end_project(self: &Arc<Self>, project_id: &str) -> EndReport {
        let taken = {
            let mut state = self.lock();
            for pending in state.pending.values_mut() {
                if pending.project_id == project_id {
                    pending.cancelled = true;
                }
            }
            let ids: Vec<String> = state
                .live
                .iter()
                .filter(|(_, live)| live.project_id == project_id)
                .map(|(id, _)| id.clone())
                .collect();
            let taken: Vec<(String, Arc<S>)> = ids
                .into_iter()
                .filter_map(|id| state.live.remove(&id).map(|live| (id, live.session)))
                .collect();
            state.ending += taken.len();
            taken
        };
        self.finish(taken, END_BUDGET)
    }

    /// Ends every session of every project and cancels every start in flight.
    pub(crate) fn end_all(self: &Arc<Self>) -> EndReport {
        let taken = self.take_all();
        self.finish(taken, END_BUDGET)
    }

    /// A page (re)load: like `end_all`, without waiting, and every start the
    /// old page asked for is refused from now on. Returns how many ended.
    pub(crate) fn end_all_for_new_page(self: &Arc<Self>) -> usize {
        self.lock().page += 1;
        let taken = self.take_all();
        let count = taken.len();
        self.finish_detached(taken);
        count
    }

    fn take_all(&self) -> Vec<(String, Arc<S>)> {
        let mut state = self.lock();
        for pending in state.pending.values_mut() {
            pending.cancelled = true;
        }
        let taken: Vec<(String, Arc<S>)> = state
            .live
            .drain()
            .map(|(id, live)| (id, live.session))
            .collect();
        state.ending += taken.len();
        taken
    }

    /// Quit: refuse new starts, end everything, and wait (bounded) for every
    /// teardown and every start in flight. Runs once; later calls return.
    pub(crate) fn quit(self: &Arc<Self>) {
        {
            let mut state = self.lock();
            if state.quitting {
                return;
            }
            state.quitting = true;
        }
        let taken = self.take_all();
        self.finish_detached(taken);

        let deadline = Instant::now() + QUIT_BUDGET;
        let mut state = self.lock();
        while state.ending > 0 || !state.pending.is_empty() {
            let now = Instant::now();
            if now >= deadline {
                eprintln!(
                    "[terminal] quit: {} teardown(s) and {} start(s) still running; leaving them",
                    state.ending,
                    state.pending.len()
                );
                break;
            }
            state = match self.settled.wait_timeout(state, deadline - now) {
                Ok((state, _)) => state,
                Err(poisoned) => poisoned.into_inner().0,
            };
        }
    }

    /// The shell exited by itself (the exit watcher calls this).
    pub(crate) fn on_self_exit(self: &Arc<Self>, session_id: &str) {
        let taken = {
            let mut state = self.lock();
            match state.live.remove(session_id) {
                Some(live) => {
                    state.ending += 1;
                    vec![(session_id.to_string(), live.session)]
                }
                None => {
                    // Not registered yet (it exited during its start), or
                    // already being ended. Ids are random, so a stale entry
                    // never matches a later session.
                    if state.early_exits.len() >= EARLY_EXIT_LIMIT {
                        state.early_exits.clear();
                    }
                    state.early_exits.insert(session_id.to_string());
                    Vec::new()
                }
            }
        };
        self.finish_detached(taken);
    }

    /// The project's sessions that are running a program (not just a prompt).
    pub(crate) fn busy(&self, project_id: &str) -> Vec<String> {
        let sessions: Vec<(String, Arc<S>)> = {
            let state = self.lock();
            state
                .live
                .iter()
                .filter(|(_, live)| live.project_id == project_id)
                .map(|(id, live)| (id.clone(), Arc::clone(&live.session)))
                .collect()
        };
        sessions
            .into_iter()
            .filter(|(_, session)| session.is_busy())
            .map(|(id, _)| id)
            .collect()
    }

    #[cfg(test)]
    fn counts(&self) -> (usize, usize, usize) {
        let state = self.lock();
        (state.live.len(), state.pending.len(), state.ending)
    }

    /// Ends the sessions, each on a thread of its own (a shared pool would
    /// let a wedged teardown hold a slot), and waits up to `budget`.
    fn finish(self: &Arc<Self>, sessions: Vec<(String, Arc<S>)>, budget: Duration) -> EndReport {
        if sessions.is_empty() {
            return EndReport::default();
        }
        let total = sessions.len();
        let (results, received) = mpsc::channel();
        for (session_id, session) in sessions {
            self.spawn_end(session_id, session, Some(results.clone()));
        }
        drop(results);

        let deadline = Instant::now() + budget;
        let mut report = EndReport::default();
        while report.ended.len() < total {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            match received.recv_timeout(deadline - now) {
                Ok(result) => report.ended.push(result),
                Err(_) => break,
            }
        }
        report.still_ending = total - report.ended.len();
        report
    }

    fn finish_detached(self: &Arc<Self>, sessions: Vec<(String, Arc<S>)>) {
        for (session_id, session) in sessions {
            self.spawn_end(session_id, session, None);
        }
    }

    /// The caller has already counted the session in `ending`.
    fn spawn_end(
        self: &Arc<Self>,
        session_id: String,
        session: Arc<S>,
        result: Option<mpsc::Sender<(String, Option<i32>)>>,
    ) {
        let registry = Arc::clone(self);
        let spawned = thread::Builder::new()
            .name("terminal-end".into())
            .spawn(move || {
                let code = session.end();
                drop(session);
                registry.ending_finished();
                if let Some(result) = result {
                    let _ = result.send((session_id, code));
                }
            });
        if spawned.is_err() {
            // The closure was dropped with its session: PtySession's Drop
            // ends it. Only the count is left to settle.
            self.ending_finished();
        }
    }

    fn ending_finished(&self) {
        let mut state = self.lock();
        state.ending = state.ending.saturating_sub(1);
        self.settled.notify_all();
    }
}

fn project_mismatch() -> CommandError {
    CommandError::invalid_path(
        "terminal.session_project_mismatch",
        "This terminal session belongs to another project.",
    )
}

/// 128 random bits. Never a per-process counter: those restart every run
/// (adversarial-check Learned Flaw 12).
fn new_session_id() -> String {
    format!("{:032x}", rand::random::<u128>())
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub(crate) fn validate_project_id(project_id: &str) -> CommandResult<&str> {
    let trimmed = project_id.trim();
    if trimmed.is_empty() || trimmed.len() > MAX_PROJECT_ID_LEN {
        return Err(CommandError::invalid_path(
            "terminal.invalid_request",
            "A valid project id is required.",
        ));
    }
    Ok(trimmed)
}

pub(crate) fn validate_session_id(session_id: &str) -> CommandResult<&str> {
    let valid = session_id.len() == 32
        && session_id.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !valid {
        return Err(CommandError::invalid_path(
            "terminal.invalid_request",
            "A valid terminal session id is required.",
        ));
    }
    Ok(session_id)
}

// ---------------------------------------------------------------------------
// The app's registry and what the commands call
// ---------------------------------------------------------------------------

static REGISTRY: OnceLock<Arc<Registry<PtySession>>> = OnceLock::new();
/// Sessions ended by the last page reload, for the frontend to report once.
static RELOAD_ENDED: AtomicUsize = AtomicUsize::new(0);

fn registry() -> &'static Arc<Registry<PtySession>> {
    REGISTRY.get_or_init(Registry::new)
}

/// The page generation now, for `terminal_spawn` to capture on arrival.
pub(crate) fn current_page() -> u64 {
    registry().page()
}

/// Starts a shell for a project (`terminal_spawn`), on behalf of `page`.
pub(crate) fn start_pty_session(
    page: u64,
    project_id: &str,
    project_root: &str,
    executable: Option<&str>,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
) -> CommandResult<TerminalSessionStartedPayload> {
    let project_id = validate_project_id(project_id)?;
    let validated =
        terminal_policy::validate_terminal_execution_boundary(project_id, project_root, executable)?;
    // A session can start before any view has measured it.
    let (cols, rows) = if cols == 0 || rows == 0 { (80, 24) } else { (cols, rows) };

    let registry = registry();
    let session_id = registry.start_on_page(
        page,
        &validated.project_id,
        validated.project_root.clone(),
        |session_id| {
            let exit_registry = Arc::clone(registry);
            let exit_id = session_id.to_string();
            terminal_pty::spawn_pty(
                session_id,
                &validated,
                cols,
                rows,
                channel,
                Box::new(move || exit_registry.on_self_exit(&exit_id)),
            )
        },
    )?;

    Ok(TerminalSessionStartedPayload {
        session_id,
        project_id: validated.project_id,
        timestamp: now_iso(),
    })
}

pub(crate) fn write_input(project_id: &str, session_id: &str, data: &[u8]) -> CommandResult<()> {
    let session = registry().session(project_id.trim(), validate_session_id(session_id)?)?;
    session.write_input(data)
}

pub(crate) fn resize_pty(project_id: &str, session_id: &str, cols: u16, rows: u16) -> CommandResult<()> {
    let session = registry().session(project_id.trim(), validate_session_id(session_id)?)?;
    session.resize(cols, rows)
}

pub(crate) fn pause_output(project_id: &str, session_id: &str) -> CommandResult<()> {
    let session = registry().session(project_id.trim(), validate_session_id(session_id)?)?;
    session.pause_output();
    Ok(())
}

pub(crate) fn resume_output(project_id: &str, session_id: &str) -> CommandResult<()> {
    let session = registry().session(project_id.trim(), validate_session_id(session_id)?)?;
    session.resume_output();
    Ok(())
}

/// The person ended a session (`terminal_session_end`).
pub(crate) fn end_session(project_id: &str, session_id: &str) -> CommandResult<TerminalSessionEndedPayload> {
    let project_id = validate_project_id(project_id)?;
    let session_id = validate_session_id(session_id)?;
    let report = registry().end(project_id, session_id)?;
    Ok(TerminalSessionEndedPayload {
        session_id: session_id.to_string(),
        project_id: project_id.to_string(),
        exit_code: report.ended.first().and_then(|(_, code)| *code),
        still_ending: report.still_ending > 0,
        timestamp: now_iso(),
    })
}

/// A project closed (`terminal_end_project`).
pub(crate) fn end_project(project_id: &str) -> CommandResult<TerminalEndReport> {
    let project_id = validate_project_id(project_id)?;
    Ok(report_of(registry().end_project(project_id)))
}

/// Every session of every project (`terminal_teardown_all`).
pub(crate) fn teardown_all_sessions() -> TerminalEndReport {
    report_of(registry().end_all())
}

pub(crate) fn busy_sessions(project_id: &str) -> CommandResult<Vec<String>> {
    Ok(registry().busy(validate_project_id(project_id)?))
}

/// The page is (re)loading: whatever it showed is gone, and a reload lands on
/// the launcher with no project open, so every session ends.
pub(crate) fn end_all_for_page_load() {
    let ended = registry().end_all_for_new_page();
    if ended > 0 {
        RELOAD_ENDED.fetch_add(ended, Ordering::SeqCst);
    }
}

/// How many sessions the last page reload ended, reported once.
pub(crate) fn take_reload_report() -> usize {
    RELOAD_ENDED.swap(0, Ordering::SeqCst)
}

pub(crate) fn quit() {
    registry().quit();
}

fn report_of(report: EndReport) -> TerminalEndReport {
    TerminalEndReport {
        ended: report.ended.len(),
        still_ending: report.still_ending,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;
    use std::sync::Barrier;

    /// Opens once; `wait` blocks until then.
    struct Gate {
        open: Mutex<bool>,
        changed: Condvar,
    }

    impl Gate {
        fn closed() -> Arc<Self> {
            Arc::new(Self {
                open: Mutex::new(false),
                changed: Condvar::new(),
            })
        }
        fn open(&self) {
            *self.open.lock().unwrap() = true;
            self.changed.notify_all();
        }
        fn wait(&self) {
            let mut open = self.open.lock().unwrap();
            while !*open {
                open = self.changed.wait(open).unwrap();
            }
        }
    }

    #[derive(Default)]
    struct Fake {
        end_gate: Option<Arc<Gate>>,
        ends: AtomicUsize,
        busy: AtomicBool,
        paused: AtomicBool,
        inputs: Mutex<Vec<Vec<u8>>>,
    }

    impl TerminalSession for Fake {
        fn write_input(&self, data: &[u8]) -> CommandResult<()> {
            self.inputs.lock().unwrap().push(data.to_vec());
            Ok(())
        }
        fn resize(&self, _cols: u16, _rows: u16) -> CommandResult<()> {
            Ok(())
        }
        fn pause_output(&self) {
            self.paused.store(true, Ordering::SeqCst);
        }
        fn resume_output(&self) {
            self.paused.store(false, Ordering::SeqCst);
        }
        fn is_busy(&self) -> bool {
            self.busy.load(Ordering::SeqCst)
        }
        fn end(&self) -> Option<i32> {
            if let Some(gate) = &self.end_gate {
                gate.wait();
            }
            self.ends.fetch_add(1, Ordering::SeqCst);
            Some(0)
        }
    }

    fn root(name: &str) -> PathBuf {
        PathBuf::from(format!("/projects/{name}"))
    }

    fn start(registry: &Arc<Registry<Fake>>, project: &str) -> CommandResult<String> {
        registry.start(project, root(project), |_| Ok(Fake::default()))
    }

    fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            thread::sleep(Duration::from_millis(5));
        }
    }

    #[test]
    fn a_project_holds_several_sessions_with_distinct_random_ids() {
        let registry = Registry::new();
        let a = start(&registry, "p").unwrap();
        let b = start(&registry, "p").unwrap();
        assert_ne!(a, b);
        for id in [&a, &b] {
            assert!(validate_session_id(id).is_ok(), "{id} is not 32 hex chars");
        }
        assert_eq!(registry.counts(), (2, 0, 0));
    }

    #[test]
    fn the_per_project_cap_refuses_the_ninth_session() {
        let registry = Registry::new();
        for _ in 0..MAX_SESSIONS_PER_PROJECT {
            start(&registry, "p").unwrap();
        }
        let refused = start(&registry, "p").unwrap_err();
        assert_eq!(refused.code(), "terminal.session_limit");
        // Another project is not affected.
        assert!(start(&registry, "q").is_ok());
    }

    #[test]
    fn concurrent_starts_never_exceed_the_per_project_cap() {
        let registry = Registry::new();
        let release = Gate::closed();
        let starts = 2 * MAX_SESSIONS_PER_PROJECT;
        let go = Arc::new(Barrier::new(starts));
        let handles: Vec<_> = (0..starts)
            .map(|_| {
                let registry = Arc::clone(&registry);
                let release = Arc::clone(&release);
                let go = Arc::clone(&go);
                thread::spawn(move || {
                    go.wait();
                    registry.start("p", root("p"), |_| {
                        release.wait();
                        Ok(Fake::default())
                    })
                })
            })
            .collect();
        // Every start holding a reservation is parked in its spawn; the rest
        // were refused at once.
        wait_until("the reservations", || registry.counts().1 == MAX_SESSIONS_PER_PROJECT);
        wait_until("the refusals", || {
            handles.iter().filter(|h| h.is_finished()).count() == starts - MAX_SESSIONS_PER_PROJECT
        });
        release.open();
        let started = handles
            .into_iter()
            .map(|h| h.join().unwrap())
            .filter(|r| r.is_ok())
            .count();
        assert_eq!(started, MAX_SESSIONS_PER_PROJECT);
        assert_eq!(registry.counts(), (MAX_SESSIONS_PER_PROJECT, 0, 0));
    }

    #[test]
    fn a_project_keeps_one_folder_while_it_has_sessions() {
        let registry = Registry::new();
        start(&registry, "p").unwrap();
        let other = registry
            .start("p", root("elsewhere"), |_| Ok(Fake::default()))
            .unwrap_err();
        assert_eq!(other.code(), "terminal.project_root_mismatch");
        registry.end_project("p");
        assert!(registry.start("p", root("elsewhere"), |_| Ok(Fake::default())).is_ok());
    }

    #[test]
    fn closing_a_project_during_a_start_ends_the_new_session() {
        let registry = Registry::new();
        let entered = Gate::closed();
        let release = Gate::closed();
        let starting = {
            let registry = Arc::clone(&registry);
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            thread::spawn(move || {
                registry.start("p", root("p"), |_| {
                    entered.open();
                    release.wait();
                    Ok(Fake::default())
                })
            })
        };
        entered.wait();
        assert_eq!(registry.counts(), (0, 1, 0));
        registry.end_project("p");
        release.open();
        let refused = starting.join().unwrap().unwrap_err();
        assert_eq!(refused.code(), "terminal.project_closed");
        wait_until("the cancelled session to end", || registry.counts() == (0, 0, 0));
    }

    #[test]
    fn ending_everything_during_a_start_leaves_nothing_behind() {
        let registry = Registry::new();
        let entered = Gate::closed();
        let release = Gate::closed();
        let starting = {
            let registry = Arc::clone(&registry);
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            thread::spawn(move || {
                registry.start("p", root("p"), |_| {
                    entered.open();
                    release.wait();
                    Ok(Fake::default())
                })
            })
        };
        entered.wait();
        registry.end_all();
        release.open();
        assert!(starting.join().unwrap().is_err());
        wait_until("the registry to empty", || registry.counts() == (0, 0, 0));
    }

    #[test]
    fn quit_during_a_start_ends_the_new_session_and_waits_for_it() {
        let registry = Registry::new();
        let entered = Gate::closed();
        let release = Gate::closed();
        let starting = {
            let registry = Arc::clone(&registry);
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            thread::spawn(move || {
                registry.start("p", root("p"), |_| {
                    entered.open();
                    release.wait();
                    Ok(Fake::default())
                })
            })
        };
        entered.wait();
        let quitting = {
            let registry = Arc::clone(&registry);
            thread::spawn(move || registry.quit())
        };
        // Quit waits for the start in flight.
        thread::sleep(Duration::from_millis(100));
        assert!(!quitting.is_finished());
        release.open();
        assert_eq!(starting.join().unwrap().unwrap_err().code(), "terminal.project_closed");
        quitting.join().unwrap();
        assert_eq!(registry.counts(), (0, 0, 0));
    }

    #[test]
    fn a_start_asked_for_by_a_page_that_has_reloaded_is_refused() {
        let registry = Registry::<Fake>::new();
        let old_page = registry.page();
        registry.end_all_for_new_page();
        let refused = registry
            .start_on_page(old_page, "p", root("p"), |_| Ok(Fake::default()))
            .unwrap_err();
        assert_eq!(refused.code(), "terminal.project_closed");
        assert_eq!(registry.counts(), (0, 0, 0));
        // The new page starts sessions as usual.
        assert!(start(&registry, "p").is_ok());
    }

    #[test]
    fn a_reload_during_a_start_ends_the_new_session() {
        let registry = Registry::new();
        let entered = Gate::closed();
        let release = Gate::closed();
        let page = registry.page();
        let starting = {
            let registry = Arc::clone(&registry);
            let entered = Arc::clone(&entered);
            let release = Arc::clone(&release);
            thread::spawn(move || {
                registry.start_on_page(page, "p", root("p"), |_| {
                    entered.open();
                    release.wait();
                    Ok(Fake::default())
                })
            })
        };
        entered.wait();
        registry.end_all_for_new_page();
        release.open();
        assert_eq!(starting.join().unwrap().unwrap_err().code(), "terminal.project_closed");
        wait_until("the registry to empty", || registry.counts() == (0, 0, 0));
    }

    #[test]
    fn the_total_cap_counts_a_session_that_is_still_ending() {
        let registry = Registry::new();
        let gate = Gate::closed();
        let wedged = {
            let gate = Arc::clone(&gate);
            registry
                .start("w", root("w"), move |_| {
                    Ok(Fake {
                        end_gate: Some(gate),
                        ..Fake::default()
                    })
                })
                .unwrap()
        };
        assert_eq!(registry.end("w", &wedged).unwrap().still_ending, 1);
        // Fill every other slot, project by project.
        for n in 0..MAX_SESSIONS_TOTAL - 1 {
            start(&registry, &format!("p{}", n / MAX_SESSIONS_PER_PROJECT)).unwrap();
        }
        assert_eq!(registry.counts(), (MAX_SESSIONS_TOTAL - 1, 0, 1));
        let refused = start(&registry, "fresh").unwrap_err();
        assert_eq!(refused.code(), "terminal.session_limit");
        gate.open();
        wait_until("the wedged teardown to finish", || registry.counts().2 == 0);
        assert!(start(&registry, "fresh").is_ok());
    }

    #[test]
    fn quit_refuses_new_starts_and_waits_for_teardowns() {
        let registry = Registry::new();
        start(&registry, "p").unwrap();
        registry.quit();
        assert_eq!(registry.counts(), (0, 0, 0));
        assert_eq!(start(&registry, "p").unwrap_err().code(), "terminal.shutting_down");
        // A second quit (RunEvent::Exit after ExitRequested) returns at once.
        registry.quit();
    }

    #[test]
    fn ending_an_unknown_session_reports_nothing_ended() {
        let registry = Registry::<Fake>::new();
        let report = registry.end("p", &"0".repeat(32)).unwrap();
        assert_eq!(report, EndReport::default());
    }

    #[test]
    fn a_session_cannot_be_reached_through_another_project() {
        let registry = Registry::new();
        let id = start(&registry, "p").unwrap();
        assert_eq!(
            registry.session("q", &id).err().unwrap().code(),
            "terminal.session_project_mismatch"
        );
        assert_eq!(registry.end("q", &id).unwrap_err().code(), "terminal.session_project_mismatch");
        assert!(registry.session("p", &id).is_ok());
    }

    #[test]
    fn a_wedged_teardown_returns_within_the_budget_and_still_counts() {
        let registry = Registry::new();
        let gate = Gate::closed();
        let wedged = {
            let gate = Arc::clone(&gate);
            registry
                .start("p", root("p"), move |_| {
                    Ok(Fake {
                        end_gate: Some(gate),
                        ..Fake::default()
                    })
                })
                .unwrap()
        };
        let began = Instant::now();
        let report = registry.end("p", &wedged).unwrap();
        assert!(began.elapsed() < END_BUDGET + Duration::from_millis(500));
        assert_eq!(report.still_ending, 1);
        // Still ending: it holds a slot in the total cap until it finishes.
        assert_eq!(registry.counts(), (0, 0, 1));
        gate.open();
        wait_until("the wedged teardown to finish", || registry.counts() == (0, 0, 0));
    }

    #[test]
    fn other_sessions_stay_responsive_while_one_is_ending() {
        let registry = Registry::new();
        let gate = Gate::closed();
        let slow = {
            let gate = Arc::clone(&gate);
            registry
                .start("p", root("p"), move |_| {
                    Ok(Fake {
                        end_gate: Some(gate),
                        ..Fake::default()
                    })
                })
                .unwrap()
        };
        let other = start(&registry, "p").unwrap();
        let ending = {
            let registry = Arc::clone(&registry);
            thread::spawn(move || registry.end("p", &slow))
        };
        wait_until("the slow session to leave the registry", || registry.counts().0 == 1);
        let began = Instant::now();
        let session = registry.session("p", &other).unwrap();
        session.write_input(b"x").unwrap();
        session.pause_output();
        session.resume_output();
        assert!(registry.busy("p").is_empty());
        assert!(began.elapsed() < Duration::from_millis(100));
        gate.open();
        ending.join().unwrap().unwrap();
    }

    #[test]
    fn a_self_exit_removes_the_session() {
        let registry = Registry::new();
        let id = start(&registry, "p").unwrap();
        registry.on_self_exit(&id);
        wait_until("the exited session to end", || registry.counts() == (0, 0, 0));
        assert!(registry.session("p", &id).is_err());
    }

    #[test]
    fn a_shell_that_exits_during_its_start_is_not_registered() {
        let registry = Registry::new();
        let observer = Arc::clone(&registry);
        let id = registry
            .start("p", root("p"), move |session_id| {
                observer.on_self_exit(session_id);
                Ok(Fake::default())
            })
            .unwrap();
        wait_until("the early-exited session to end", || registry.counts() == (0, 0, 0));
        assert!(registry.session("p", &id).is_err());
    }

    #[test]
    fn busy_lists_only_the_projects_busy_sessions() {
        let registry = Registry::new();
        let busy = registry
            .start("p", root("p"), |_| {
                let fake = Fake::default();
                fake.busy.store(true, Ordering::SeqCst);
                Ok(fake)
            })
            .unwrap();
        start(&registry, "p").unwrap();
        registry
            .start("q", root("q"), |_| {
                let fake = Fake::default();
                fake.busy.store(true, Ordering::SeqCst);
                Ok(fake)
            })
            .unwrap();
        assert_eq!(registry.busy("p"), vec![busy]);
    }

    #[test]
    fn a_failed_spawn_releases_its_reservation() {
        let registry = Registry::<Fake>::new();
        let failed = registry.start("p", root("p"), |_| {
            Err(CommandError::internal("terminal.spawn_failed", "no"))
        });
        assert!(failed.is_err());
        assert_eq!(registry.counts(), (0, 0, 0));
    }

    #[test]
    fn ids_are_validated_before_any_lookup() {
        assert!(validate_session_id("term-1").is_err());
        assert!(validate_session_id(&"A".repeat(32)).is_err());
        assert!(validate_session_id(&"a".repeat(32)).is_ok());
        assert!(validate_project_id("  ").is_err());
        assert!(validate_project_id(&"x".repeat(MAX_PROJECT_ID_LEN + 1)).is_err());
        assert_eq!(validate_project_id(" litria-1 ").unwrap(), "litria-1");
    }
}
