//! LSP session state and lifecycle management.
//!
//! Each session corresponds to one running language server process, scoped to a
//! (project_id, language_id) pair.  Sessions are stored in a global
//! `OnceLock<Mutex<HashMap>>` so they survive across Tauri command invocations.
//!
//! The `on_message` callback captures the session's pending-request map directly
//! via an `Arc` clone, so the read thread never needs to look up the session from
//! the global registry.  This avoids a deadlock window during the initialize
//! handshake, before the session is inserted into the registry.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::AppHandle;

use crate::errors::{CommandError, CommandResult};
use crate::lsp::ipc_bridge;
use crate::lsp::packs::{get_pack, LanguagePack};
use crate::lsp::resolver;
use crate::lsp::transport::{self, LspTransport};
use crate::lsp::types::{
    IncomingMessage, LspNotification, LspPrerequisitesPayload, LspRequest,
    LspSessionEndedPayload, LspSessionStartedPayload, PrerequisiteProbeResult,
};

// ---------------------------------------------------------------------------
// Global session registry
// ---------------------------------------------------------------------------

/// Session key: a structured `(project_id, language_id)` tuple — collision-free
/// across ids that contain the old `::` string delimiter (audit #7).
type SessionKey = (String, String);

/// Per-request response channel.
type ResponseSender = std::sync::mpsc::SyncSender<Result<Value, String>>;

/// Shared pending-request map (request_id → one-shot sender).
type PendingMap = Arc<Mutex<HashMap<u64, ResponseSender>>>;

static SESSIONS: OnceLock<Mutex<HashMap<SessionKey, LspSession>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<SessionKey, LspSession>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_key(project_id: &str, language_id: &str) -> SessionKey {
    (project_id.to_string(), language_id.to_string())
}

// ---------------------------------------------------------------------------
// Session quotas (audit #21)
// ---------------------------------------------------------------------------
//
// Dedupe keys on the caller-supplied `(project_id, language_id)`. Both ids are
// length-capped (#5) and the key is collision-free (#7), but `project_root` was
// validated and then dropped — so N different `project_id`s named one directory
// and got N servers for it. These bound the blast radius of a renderer that
// varies the id, which in a local IDE means an XSS in Litria's own UI first.

/// Five packs exist today (python, typescript, rust, cpp, go). Per-root headroom
/// for a couple more; a root legitimately wanting nine servers does not exist.
const MAX_SESSIONS_PER_ROOT: usize = 8;
/// Generous even for the multi-session future (~3 projects × every pack).
/// Twenty-four language servers is already far past any real workspace.
const MAX_SESSIONS_TOTAL: usize = 24;
/// A start holds a spawned child through a ~1–2s handshake before it is ever
/// registered, so the registry caps above cannot see it. This is the cap that
/// actually bounds a burst.
const MAX_CONCURRENT_STARTS: usize = 4;

// ---------------------------------------------------------------------------
// Start reservations — closes the check-then-insert race (2026-07-17 dev
// crash-loop). `start` registers the session only AFTER resolve + spawn +
// handshake (~1-2s); two concurrent starts for the same key both passed the
// registry check, and the second insert REPLACED the first — dropping it
// closed the healthy child's stdin, whose EOF fired the crash handler, whose
// unconditional remove dropped the successor: a self-sustaining cascade.
// A key must now be reserved for the whole start; the loser fails fast with
// `already_active`.
//
// The claim carries the canonical root as well as the key (audit #21): the
// registry checks cannot see an in-flight start, so without this a second
// `project_id` for the same directory sails through the whole window.
// ---------------------------------------------------------------------------

/// In-flight starts: session key → the canonical root that start is claiming.
static STARTING: OnceLock<Mutex<HashMap<SessionKey, PathBuf>>> = OnceLock::new();

fn starting_keys() -> &'static Mutex<HashMap<SessionKey, PathBuf>> {
    STARTING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// RAII reservation of a session key for the duration of a start attempt.
/// Dropping it (any exit path — error or success) releases the key.
struct StartReservation {
    key: SessionKey,
}

impl Drop for StartReservation {
    fn drop(&mut self) {
        starting_keys().lock().unwrap().remove(&self.key);
    }
}

/// Why a start could not be reserved. Each maps to a distinct error message so
/// a refusal is diagnosable rather than a generic "already active".
#[derive(Debug)]
enum StartRefusal {
    KeyInFlight,
    RootInFlight,
    TooManyConcurrent,
}

/// Reserve `key` for a start attempt against `canonical_root`.
fn try_reserve_start(
    key: &SessionKey,
    canonical_root: &Path,
) -> Result<StartReservation, StartRefusal> {
    let mut starting = starting_keys().lock().unwrap();

    if starting.contains_key(key) {
        return Err(StartRefusal::KeyInFlight);
    }
    // Same directory, same language, different project_id — the #21 shape,
    // caught inside the window where the registry is still blind to it.
    if starting
        .iter()
        .any(|(k, root)| k.1 == key.1 && root == canonical_root)
    {
        return Err(StartRefusal::RootInFlight);
    }
    if starting.len() >= MAX_CONCURRENT_STARTS {
        return Err(StartRefusal::TooManyConcurrent);
    }

    starting.insert(key.clone(), canonical_root.to_path_buf());
    Ok(StartReservation { key: key.clone() })
}

// Input bounds for LSP command identifiers (audit #5). In the desktop model the
// "attacker" is a webview compromise; these cap memory pressure / DoS from
// oversized IPC strings. A language_id that names no pack is already rejected by
// get_pack / the session lookup — the length cap is cheap belt-and-suspenders.
const MAX_LANGUAGE_ID_LEN: usize = 64;
const MAX_PROJECT_ID_LEN: usize = 256;
const MAX_METHOD_LEN: usize = 128;
const MAX_TIMEOUT_MS: u64 = 30_000;

fn ensure_len(value: &str, max: usize, field: &str) -> CommandResult<()> {
    if value.len() > max {
        return Err(CommandError::invalid_path(
            "lsp.input_too_long",
            format!("{field} exceeds the {max}-byte limit."),
        ));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Session struct
// ---------------------------------------------------------------------------

pub(crate) struct LspSession {
    pub session_id: String,
    // Identity mirrored from the session key. Read by the audit #21 quota
    // checks in `start_session`; the `#[allow(dead_code)]` these carried is
    // gone now that a consumer landed (implementation-policy Rule 5).
    pub language_id: String,
    pub project_id: String,
    /// The canonicalized `project_root` this server was spawned into. Read by
    /// the quota checks in `start_session` (audit #21) so one directory cannot
    /// be claimed by an unbounded number of `project_id`s. Comparison only —
    /// the original, un-canonicalized `project_root` is what reaches
    /// `current_dir` and `rootUri`.
    canonical_root: PathBuf,
    transport: LspTransport,
    pending: PendingMap,
}

impl LspSession {
    /// Send a JSON-RPC request and block until the response arrives or times out.
    pub(crate) fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let id = self.transport.next_request_id();
        let (tx, rx) = std::sync::mpsc::sync_channel::<Result<Value, String>>(1);
        self.pending.lock().unwrap().insert(id, tx);

        let req = LspRequest::new(id, method, params);
        self.transport
            .write_message(&serde_json::to_value(&req).unwrap())?;

        rx.recv_timeout(timeout)
            .map_err(|_| format!("LSP '{method}' timed out after {}ms", timeout.as_millis()))?
    }

    /// Send a JSON-RPC notification (fire-and-forget).
    pub(crate) fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let notif = LspNotification::new(method, params);
        self.transport
            .write_message(&serde_json::to_value(&notif).unwrap())
    }
}

// ---------------------------------------------------------------------------
// Session start
// ---------------------------------------------------------------------------

/// The identity fields the quota policy reasons about, lifted out of the
/// registry so the policy is a pure function over a slice — testable without a
/// spawned language server behind every entry.
struct SessionIdentity<'a> {
    project_id: &'a str,
    language_id: &'a str,
    canonical_root: &'a Path,
}

/// Why a start was refused, with the context its message needs.
enum QuotaRefusal {
    KeyActive,
    RootActive { holder: String },
    ProjectIdRebound { other_root: String },
    RootQuota { count: usize },
    GlobalQuota { count: usize },
}

/// The audit #21 policy, in one place and free of locks and I/O.
fn evaluate_start_quotas(
    existing: &[SessionIdentity<'_>],
    project_id: &str,
    language_id: &str,
    canonical_root: &Path,
) -> Result<(), QuotaRefusal> {
    if existing
        .iter()
        .any(|s| s.project_id == project_id && s.language_id == language_id)
    {
        return Err(QuotaRefusal::KeyActive);
    }

    // The finding itself: one directory, one server per language. Reaching here
    // with a matching root means a DIFFERENT project_id named it, because the
    // exact key missed above.
    if let Some(holder) = existing
        .iter()
        .find(|s| s.canonical_root == canonical_root && s.language_id == language_id)
    {
        return Err(QuotaRefusal::RootActive {
            holder: holder.project_id.to_string(),
        });
    }

    // The inverse confusion: one project_id claiming two directories. Cheap to
    // check here and it keeps the id↔root binding one-to-one in both
    // directions, which is what makes the check above trustworthy.
    if let Some(other) = existing
        .iter()
        .find(|s| s.project_id == project_id && s.canonical_root != canonical_root)
    {
        return Err(QuotaRefusal::ProjectIdRebound {
            other_root: other.canonical_root.display().to_string(),
        });
    }

    let per_root = existing
        .iter()
        .filter(|s| s.canonical_root == canonical_root)
        .count();
    if per_root >= MAX_SESSIONS_PER_ROOT {
        return Err(QuotaRefusal::RootQuota { count: per_root });
    }

    if existing.len() >= MAX_SESSIONS_TOTAL {
        return Err(QuotaRefusal::GlobalQuota {
            count: existing.len(),
        });
    }

    Ok(())
}

/// Registry-side half of the audit #21 quotas: snapshot the identities under one
/// lock so every answer is consistent with the others, then apply the policy.
///
/// The bindings are DERIVED from the session registry rather than kept in a
/// second map: a parallel index of root → project_id is one more thing that can
/// drift out of step with the sessions it describes.
fn check_start_quotas(
    canonical_root: &Path,
    project_id: &str,
    language_id: &str,
    pack: &LanguagePack,
) -> CommandResult<()> {
    let sessions = sessions().lock().unwrap();
    let identities: Vec<SessionIdentity<'_>> = sessions
        .values()
        .map(|s| SessionIdentity {
            project_id: &s.project_id,
            language_id: &s.language_id,
            canonical_root: &s.canonical_root,
        })
        .collect();

    let prefix = &pack.error_prefix;
    evaluate_start_quotas(&identities, project_id, language_id, canonical_root).map_err(|refusal| {
        match refusal {
            QuotaRefusal::KeyActive => CommandError::conflict(
                &format!("{prefix}.session.already_active"),
                format!(
                    "LSP session already active for project '{project_id}' language '{language_id}'"
                ),
            ),
            QuotaRefusal::RootActive { holder } => CommandError::conflict(
                &format!("{prefix}.session.root_already_active"),
                format!(
                    "An LSP session for language '{language_id}' is already active on this project root under project id '{holder}'."
                ),
            ),
            QuotaRefusal::ProjectIdRebound { other_root } => CommandError::conflict(
                &format!("{prefix}.session.project_root_mismatch"),
                format!(
                    "Project id '{project_id}' is already bound to a different project root ('{other_root}')."
                ),
            ),
            QuotaRefusal::RootQuota { count } => CommandError::conflict(
                &format!("{prefix}.session.root_quota"),
                format!(
                    "This project root already has {count} language servers running (limit {MAX_SESSIONS_PER_ROOT})."
                ),
            ),
            QuotaRefusal::GlobalQuota { count } => CommandError::conflict(
                &format!("{prefix}.session.global_quota"),
                format!(
                    "{count} language servers are already running (limit {MAX_SESSIONS_TOTAL})."
                ),
            ),
        }
    })
}

/// Start a new LSP session for the given language + project.
///
/// Spawns the language server process, performs the `initialize` handshake, and
/// registers the session.  Blocks until `initialize` completes or the pack's
/// `startup_timeout_ms` elapses.
pub(crate) fn start_session(
    app: &AppHandle,
    language_id: &str,
    project_id: &str,
    project_root: &str,
) -> CommandResult<LspSessionStartedPayload> {
    let pack = get_pack(language_id).ok_or_else(|| {
        CommandError::not_found(
            &format!("{language_id}.pack.not_found"),
            format!("No language pack registered for '{language_id}'"),
        )
    })?;

    ensure_len(language_id, MAX_LANGUAGE_ID_LEN, "language_id")?;
    ensure_len(project_id, MAX_PROJECT_ID_LEN, "project_id")?;

    // Validate the working directory before the server is spawned into it
    // (audit #6): it must resolve to an existing directory, not be handed
    // straight to Command::current_dir unchecked.
    let root_meta = std::fs::metadata(project_root).map_err(|e| {
        CommandError::invalid_path(
            &format!("{}.invalid_project_root", pack.error_prefix),
            format!("Project root '{project_root}' is not accessible: {e}"),
        )
    })?;
    if !root_meta.is_dir() {
        return Err(CommandError::invalid_path(
            &format!("{}.invalid_project_root", pack.error_prefix),
            format!("Project root '{project_root}' is not a directory."),
        ));
    }

    // Audit #21: the root was validated above and then dropped, so the session
    // key said nothing about which directory it named. Canonicalize it once and
    // use it as the identity the quotas below are enforced against — symlinks,
    // `.`/`..` and case differences all collapse to one answer, so varying the
    // spelling is not a way around them. COMPARISON ONLY: `project_root` itself
    // is what still reaches `current_dir` and `rootUri` (on Windows this yields
    // a `\\?\` verbatim path, which some servers dislike as a root).
    let canonical_root = std::fs::canonicalize(project_root).map_err(|e| {
        CommandError::invalid_path(
            &format!("{}.invalid_project_root", pack.error_prefix),
            format!("Project root '{project_root}' could not be resolved: {e}"),
        )
    })?;

    let key = session_key(project_id, language_id);
    check_start_quotas(&canonical_root, project_id, language_id, &pack)?;

    // Hold a start reservation for the whole resolve/spawn/handshake window —
    // a concurrent second start fails fast here instead of replacing the
    // first session at insert time. The claim carries the canonical root, so a
    // second `project_id` for the same directory is refused inside the window
    // too. Released on every exit path via Drop.
    let _start_reservation = try_reserve_start(&key, &canonical_root).map_err(|refusal| {
        let prefix = &pack.error_prefix;
        match refusal {
            StartRefusal::KeyInFlight => CommandError::conflict(
                &format!("{prefix}.session.already_active"),
                format!(
                    "LSP session start already in progress for project '{project_id}' language '{language_id}'"
                ),
            ),
            StartRefusal::RootInFlight => CommandError::conflict(
                &format!("{prefix}.session.root_already_active"),
                format!(
                    "An LSP session for language '{language_id}' is already starting for this project root."
                ),
            ),
            StartRefusal::TooManyConcurrent => CommandError::conflict(
                &format!("{prefix}.session.too_many_starts"),
                format!(
                    "Too many LSP sessions are starting at once (limit {MAX_CONCURRENT_STARTS}). Try again in a moment."
                ),
            ),
        }
    })?;

    let session_id =
        format!("{project_id}::{language_id}::{}", chrono::Utc::now().timestamp_millis());

    // Build the shared pending map.  It is Arc-cloned into both the on_message
    // closure and the on_crash closure so the read thread can resolve requests
    // without touching the session registry.
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_cb = Arc::clone(&pending);

    // Capture metadata for the closures.
    let sid_cb = session_id.clone();
    let lid_cb = language_id.to_string();
    let pid_cb = project_id.to_string();

    // Crash handler — called by the read-loop thread when the server process
    // exits unexpectedly (i.e. without mark_stopping() having been called).
    let pending_crash = Arc::clone(&pending);
    let key_crash = key.clone();
    let sid_crash = session_id.clone();
    let lid_crash = language_id.to_string();
    let pid_crash = project_id.to_string();
    let app_crash = app.clone();
    // Created here (not inside spawn_server) so the crash closure can hold a
    // handle to the same ring the transport's stderr thread fills.
    let stderr_tail = transport::new_stderr_tail();
    let tail_crash = Arc::clone(&stderr_tail);
    let on_crash = move || {
        // Drain pending — each dropped SyncSender causes the waiting
        // recv_timeout in session_request to return Err(Disconnected)
        // immediately, without waiting for the timeout to expire.
        for (_, tx) in pending_crash.lock().unwrap().drain() {
            let _ = tx.send(Err(format!("{lid_crash}.server.crashed")));
        }
        // Remove the zombie session from the registry so future calls fail
        // fast with "session not found" — but ONLY if the registry entry is
        // still OURS. A crash handler firing for an already-replaced session
        // must not evict its successor (2026-07-17 cascade: each removal
        // dropped the next healthy session, closing its child's stdin and
        // perpetuating the loop).
        let owned = {
            let mut guard = sessions().lock().unwrap();
            let owns = guard
                .get(&key_crash)
                .map(|s| crash_owns_registry_entry(Some(&s.session_id), &sid_crash))
                .unwrap_or(false);
            if owns {
                guard.remove(&key_crash);
            }
            owns
        };
        // Emit lsp:error so the frontend can surface the crash and prompt
        // the user to reopen the file / restart the language server. A
        // non-owner crash (superseded session's process dying late) is not
        // an actionable event for the frontend — emitting it would fuel
        // restart churn against a healthy successor.
        if owned {
            let err = CommandError::internal(
                &format!("{lid_crash}.server.crashed"),
                format!("The '{lid_crash}' language server process exited unexpectedly."),
            );
            // The server's dying words (stderr tail) ride the payload as a
            // separate diagnostic field — devtools-visible, never UI copy.
            let tail = transport::snapshot_stderr_tail(&tail_crash);
            if !tail.is_empty() {
                eprintln!(
                    "[lsp crash] {lid_crash} stderr tail ({} lines):\n{}",
                    tail.len(),
                    tail.join("\n")
                );
            }
            ipc_bridge::emit_lsp_error(
                &app_crash,
                &pid_crash,
                &lid_crash,
                Some(&sid_crash),
                &err,
                Some(tail),
            );
        }
    };

    // Resolve the server executable through the 3-tier fallback chain.
    let resolved = resolver::resolve_server(&pack, app).ok_or_else(|| {
        CommandError::not_found(
            &format!("{}.server.not_resolved", pack.error_prefix),
            format!(
                "No '{}' server found (checked PATH, managed, bundled)",
                language_id
            ),
        )
    })?;

    eprintln!(
        "[lsp session] resolved {language_id} server via {} tier: {}",
        resolved.tier,
        resolved.executable.display()
    );

    let transport = transport::spawn_server(
        &pack,
        &resolved,
        project_root,
        app.clone(),
        stderr_tail,
        move |app, msg| on_message(&app, msg, &pending_cb, &sid_cb, &lid_cb, &pid_cb),
        on_crash,
    )
    .map_err(|e| {
        CommandError::internal(&format!("{}.start.failed", pack.error_prefix), e)
    })?;

    let session = LspSession {
        session_id: session_id.clone(),
        language_id: language_id.to_string(),
        project_id: project_id.to_string(),
        canonical_root: canonical_root.clone(),
        transport,
        pending,
    };

    // Handshake — happens before inserting into the registry so the registry is
    // never in a half-initialized state.
    perform_initialize(&session, &pack, project_root).map_err(|e| {
        // Mark stopping before killing so the read-loop thread does not fire
        // the crash handler — this is a controlled startup failure, not a crash.
        session.transport.mark_stopping();
        session.transport.kill();
        CommandError::internal(&format!("{}.start.failed", pack.error_prefix), e)
    })?;

    let payload = LspSessionStartedPayload {
        session_id: session_id.clone(),
        language_id: language_id.to_string(),
        project_id: project_id.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    };

    sessions().lock().unwrap().insert(key, session);
    ipc_bridge::emit_session_started(app, &payload);

    Ok(payload)
}

// ---------------------------------------------------------------------------
// Session stop
// ---------------------------------------------------------------------------

/// Stop the session for the given project + language.
///
/// Sends the LSP `shutdown` request followed by the `exit` notification, then
/// kills the server process.
pub(crate) fn stop_session(
    app: &AppHandle,
    language_id: &str,
    project_id: &str,
    _session_id: Option<&str>,
) -> CommandResult<LspSessionEndedPayload> {
    let key = session_key(project_id, language_id);
    let session = sessions()
        .lock()
        .unwrap()
        .remove(&key)
        .ok_or_else(|| {
            CommandError::not_found(
                &format!("{language_id}.session.not_found"),
                format!(
                    "No active LSP session for project '{project_id}' language '{language_id}'"
                ),
            )
        })?;

    // Graceful shutdown — ignore errors if the server has already exited.
    // mark_stopping() must be called before kill() so the read-loop thread
    // does not treat the EOF as a crash.
    session.transport.mark_stopping();
    let _ = session.request("shutdown", Value::Null, Duration::from_millis(3_000));
    let _ = session.notify("exit", Value::Null);
    session.transport.kill();

    let payload = LspSessionEndedPayload {
        session_id: session.session_id.clone(),
        language_id: language_id.to_string(),
        project_id: project_id.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    };

    ipc_bridge::emit_session_ended(app, &payload);
    Ok(payload)
}

/// Stop every active session for one language across all projects
/// (Slice 7 uninstall: the server binary must not be running when its
/// managed dir is removed — Windows file locks). Individual stop failures
/// are ignored; the count of attempted stops is returned.
pub(crate) fn stop_sessions_for_language(app: &AppHandle, language_id: &str) -> usize {
    // Structured tuple session key (audit #7): match the language component
    // directly rather than parsing a `::`-suffixed string key.
    let project_ids: Vec<String> = sessions()
        .lock()
        .unwrap()
        .keys()
        .filter(|k| k.1.as_str() == language_id)
        .map(|k| k.0.clone())
        .collect();
    for project_id in &project_ids {
        let _ = stop_session(app, language_id, project_id, None);
    }
    project_ids.len()
}

// ---------------------------------------------------------------------------
// Teardown all
// ---------------------------------------------------------------------------

/// Kill all active sessions immediately.  Called on app shutdown.
pub(crate) fn teardown_all_sessions() -> CommandResult<usize> {
    let mut map = sessions().lock().unwrap();
    let count = map.len();
    for (_, session) in map.drain() {
        session.transport.mark_stopping();
        let _ = session.notify("exit", Value::Null);
        session.transport.kill();
    }
    Ok(count)
}

// ---------------------------------------------------------------------------
// Pass-through for Tauri commands
// ---------------------------------------------------------------------------

/// Send a request on an active session and return the server's result value.
///
/// The global sessions mutex is held only long enough to clone the `Arc`s
/// needed for the request.  It is released before the blocking `recv_timeout`
/// call so that concurrent `stop_session` / `start_session` commands are never
/// blocked for the full request timeout duration (up to 5 s) when a session is
/// stopping or a server has crashed.
pub(crate) fn session_request(
    language_id: &str,
    project_id: &str,
    method: &str,
    params: Value,
    timeout_ms: u64,
) -> CommandResult<Value> {
    ensure_len(language_id, MAX_LANGUAGE_ID_LEN, "language_id")?;
    ensure_len(project_id, MAX_PROJECT_ID_LEN, "project_id")?;
    ensure_len(method, MAX_METHOD_LEN, "method")?;
    let timeout_ms = timeout_ms.min(MAX_TIMEOUT_MS);

    // --- Lock scope: clone the Arcs we need, then release immediately. ---
    let (stdin_arc, next_id_arc, pending_arc) = {
        let key = session_key(project_id, language_id);
        let map = sessions().lock().unwrap();
        let session = map.get(&key).ok_or_else(|| {
            CommandError::not_found(
                &format!("{language_id}.session.not_found"),
                format!(
                    "No active LSP session for project '{project_id}' language '{language_id}'"
                ),
            )
        })?;
        (
            Arc::clone(&session.transport.stdin),
            Arc::clone(&session.transport.next_id),
            Arc::clone(&session.pending),
        )
    }; // ← sessions mutex released here

    // Allocate a request ID without re-acquiring the sessions mutex.
    let id = {
        let mut g = next_id_arc.lock().unwrap();
        let i = *g;
        *g = i + 1;
        i
    };

    // Register the response channel *before* writing so we cannot miss a
    // fast response that arrives before we call recv_timeout.
    let (tx, rx) = std::sync::mpsc::sync_channel::<Result<Value, String>>(1);
    pending_arc.lock().unwrap().insert(id, tx);

    // Write the request.  On a broken-pipe (server already dead), clean up
    // the pending entry and return immediately.
    let req = LspRequest::new(id, method, params);
    let body = serde_json::to_string(&serde_json::to_value(&req).unwrap()).unwrap();
    if let Err(e) = transport::write_message_to(&mut *stdin_arc.lock().unwrap(), &body) {
        pending_arc.lock().unwrap().remove(&id);
        return Err(CommandError::internal(
            &format!("{language_id}.request.failed"),
            e,
        ));
    }

    // Block until the response arrives, the timeout elapses, or the crash
    // handler drops the SyncSender (Disconnected → immediate return).
    rx.recv_timeout(Duration::from_millis(timeout_ms))
        .map_err(|_| {
            pending_arc.lock().unwrap().remove(&id);
            CommandError::internal(
                &format!("{language_id}.request.timeout"),
                format!("LSP '{method}' timed out after {timeout_ms}ms"),
            )
        })?
        .map_err(|e| CommandError::internal(&format!("{language_id}.request.failed"), e))
}

/// Send a notification on an active session.
///
/// The sessions mutex is held only to clone the stdin Arc — not across the
/// write — so it does not block concurrent session operations.
pub(crate) fn session_notify(
    language_id: &str,
    project_id: &str,
    method: &str,
    params: Value,
) -> CommandResult<()> {
    ensure_len(language_id, MAX_LANGUAGE_ID_LEN, "language_id")?;
    ensure_len(project_id, MAX_PROJECT_ID_LEN, "project_id")?;
    ensure_len(method, MAX_METHOD_LEN, "method")?;

    let stdin_arc = {
        let key = session_key(project_id, language_id);
        let map = sessions().lock().unwrap();
        let session = map.get(&key).ok_or_else(|| {
            CommandError::not_found(
                &format!("{language_id}.session.not_found"),
                format!(
                    "No active LSP session for project '{project_id}' language '{language_id}'"
                ),
            )
        })?;
        Arc::clone(&session.transport.stdin)
    }; // ← sessions mutex released here

    let notif = LspNotification::new(method, params);
    let body = serde_json::to_string(&serde_json::to_value(&notif).unwrap()).unwrap();
    // Bind the result before the function returns so the MutexGuard temporary
    // is dropped before `stdin_arc` goes out of scope (borrow-checker rule).
    let result = transport::write_message_to(&mut *stdin_arc.lock().unwrap(), &body)
        .map_err(|e| CommandError::internal(&format!("{language_id}.notify.failed"), e));
    result
}

// ---------------------------------------------------------------------------
// Prerequisite detection
// ---------------------------------------------------------------------------

/// Probe all prerequisites declared by the given language pack.
///
/// Also runs the 3-tier resolver to report which tier the server was found at.
/// The `resolution_tier` field in the response tells the frontend whether the
/// server is a global install, managed install, or bundled with CM.
///
/// When the resolver finds the server at a non-global tier (bundled or managed),
/// prerequisites marked `satisfied_by_bundle` are automatically satisfied
/// without a PATH probe — the bundled server ships those tools internally.
pub(crate) fn detect_prerequisites(
    language_id: &str,
    app: Option<&AppHandle>,
) -> CommandResult<LspPrerequisitesPayload> {
    let pack = get_pack(language_id).ok_or_else(|| {
        CommandError::not_found(
            &format!("{language_id}.pack.not_found"),
            format!("No language pack registered for '{language_id}'"),
        )
    })?;

    // Run the resolver first — its result affects which prereqs we probe.
    let resolved = app.and_then(|a| resolver::resolve_server(&pack, a));
    let is_bundled_or_managed = resolved
        .as_ref()
        .map(|r| {
            matches!(
                r.tier,
                crate::lsp::packs::ResolutionTier::Bundled
                    | crate::lsp::packs::ResolutionTier::Managed
            )
        })
        .unwrap_or(false);

    let probes: Vec<PrerequisiteProbeResult> = pack
        .prerequisites
        .iter()
        .map(|prereq| {
            if is_bundled_or_managed && prereq.satisfied_by_bundle {
                // Server is bundled/managed — this prereq is automatically met.
                PrerequisiteProbeResult {
                    display_name: prereq.display_name.to_string(),
                    command: prereq.command.to_string(),
                    available: true,
                    version: Some("(bundled)".to_string()),
                    meets_min_version: true,
                }
            } else {
                probe_prerequisite(prereq)
            }
        })
        .collect();

    let all_met = probes.iter().all(|p| p.available && p.meets_min_version);

    let resolution_tier = resolved.map(|r| r.tier.to_string());

    Ok(LspPrerequisitesPayload {
        language_id: language_id.to_string(),
        all_met,
        probes,
        resolution_tier,
    })
}

fn probe_prerequisite(prereq: &crate::lsp::packs::Prerequisite) -> PrerequisiteProbeResult {
    use std::process::Command;

    // On Windows, npm-installed tools (pyright, tsc, etc.) are .cmd scripts.
    // Command::new() only resolves .exe — use cmd /C to find .cmd/.bat as well.
    let output = if cfg!(windows) {
        Command::new("cmd")
            .args(["/C", prereq.command, prereq.version_arg])
            .output()
    } else {
        Command::new(prereq.command)
            .arg(prereq.version_arg)
            .output()
    };

    match output {
        Err(_) => PrerequisiteProbeResult {
            display_name: prereq.display_name.to_string(),
            command: prereq.command.to_string(),
            available: false,
            version: None,
            meets_min_version: false,
        },
        Ok(out) => {
            let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let version_str = extract_version(&raw);
            let meets = if prereq.min_version.is_empty() {
                true
            } else {
                version_str
                    .as_deref()
                    .map(|v| v.starts_with(prereq.min_version))
                    .unwrap_or(false)
            };
            PrerequisiteProbeResult {
                display_name: prereq.display_name.to_string(),
                command: prereq.command.to_string(),
                available: out.status.success() || !raw.is_empty(),
                version: version_str,
                meets_min_version: meets,
            }
        }
    }
}

/// Extract the first token from command output that looks like a version number.
fn extract_version(raw: &str) -> Option<String> {
    for token in raw.split_whitespace() {
        let token = token.trim_start_matches('v');
        if token.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
            return Some(token.to_string());
        }
    }
    if raw.is_empty() {
        None
    } else {
        Some(raw.to_string())
    }
}

// ---------------------------------------------------------------------------
// Message dispatch (called from the read-loop thread)
// ---------------------------------------------------------------------------

/// Route one incoming LSP message.
///
/// - Response (`id` present, no `method`): resolve the matching pending request.
/// - Notification (`method` present, no `id`): forward to `ipc_bridge`.
/// - Server-initiated requests (both fields): ignored in MVP.
fn on_message(
    app: &AppHandle,
    msg: IncomingMessage,
    pending: &PendingMap,
    session_id: &str,
    language_id: &str,
    project_id: &str,
) {
    if msg.is_response() {
        if let Some(id) = msg.request_id() {
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let outcome = if msg.error.is_some() {
                    Err(format!("LSP error: {:?}", msg.error))
                } else {
                    Ok(msg.result.unwrap_or(Value::Null))
                };
                let _ = tx.send(outcome);
            }
        }
    } else if msg.is_notification() {
        let method = msg.method.as_deref().unwrap_or("");
        let params = msg.params.unwrap_or(Value::Null);
        ipc_bridge::dispatch_notification(app, session_id, language_id, project_id, method, params);
    }
}

// ---------------------------------------------------------------------------
// Initialize handshake
// ---------------------------------------------------------------------------

fn perform_initialize(
    session: &LspSession,
    pack: &LanguagePack,
    project_root: &str,
) -> Result<(), String> {
    let params = json!({
        "processId": std::process::id(),
        "clientInfo": { "name": "Litria", "version": "1.0.0" },
        "rootUri": path_to_uri(project_root),
        "capabilities": pack.client_capabilities,
        "initializationOptions": pack.initialization_options,
        "workspaceFolders": [{ "uri": path_to_uri(project_root), "name": "workspace" }]
    });

    session.request(
        "initialize",
        params,
        Duration::from_millis(pack.startup_timeout_ms),
    )?;

    session.notify("initialized", json!({}))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// A crash handler may remove its registry entry only when the entry still
/// belongs to the crashed session (compared by session_id). Pure so the
/// cascade rule is unit-testable without a live session.
fn crash_owns_registry_entry(registered_session_id: Option<&str>, crashed_session_id: &str) -> bool {
    registered_session_id == Some(crashed_session_id)
}

fn path_to_uri(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if normalized.starts_with('/') {
        format!("file://{normalized}")
    } else {
        format!("file:///{normalized}")
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_len_bounds_free_inputs() {
        assert!(ensure_len("rust", MAX_LANGUAGE_ID_LEN, "language_id").is_ok());
        assert!(ensure_len("textDocument/hover", MAX_METHOD_LEN, "method").is_ok());
        assert!(ensure_len(&"p".repeat(MAX_PROJECT_ID_LEN), MAX_PROJECT_ID_LEN, "project_id").is_ok());
        assert!(ensure_len(&"m".repeat(MAX_METHOD_LEN + 1), MAX_METHOD_LEN, "method").is_err());
        assert!(ensure_len(&"x".repeat(MAX_PROJECT_ID_LEN + 1), MAX_PROJECT_ID_LEN, "project_id").is_err());
    }

    #[test]
    fn session_key_is_collision_free_across_delimiters() {
        // The old string key `"{project_id}::{language_id}"` collided when an id
        // contained "::". The structured tuple key cannot.
        assert_ne!(session_key("a::b", "c"), session_key("a", "b::c"));
        assert_eq!(session_key("proj", "rust"), ("proj".to_string(), "rust".to_string()));
    }

    /// `STARTING` is process-global and now carries a concurrency cap, so the
    /// reservation cases must run as one test — cargo's parallel runner would
    /// otherwise let separate tests hold reservations against each other's cap.
    #[test]
    fn start_reservations_are_per_key_per_root_and_capped() {
        let root_a = Path::new("/tmp/litria-res-a");
        let root_b = Path::new("/tmp/litria-res-b");

        // -- per key: a second start for the same key fails fast, and the key
        //    is reusable once the first reservation drops.
        let key = session_key("res-test-proj", "res-test-lang");
        let first = try_reserve_start(&key, root_a).expect("first reservation");
        assert!(
            matches!(
                try_reserve_start(&key, root_a),
                Err(StartRefusal::KeyInFlight)
            ),
            "second concurrent reservation for the same key must fail fast"
        );
        drop(first);
        let again = try_reserve_start(&key, root_a).expect("reusable after release");
        drop(again);

        // -- audit #21: a different project_id naming the SAME root for the
        //    same language is refused inside the start window, where the
        //    session registry cannot see it yet.
        let a = try_reserve_start(&session_key("proj-a", "python"), root_a).expect("a");
        assert!(
            matches!(
                try_reserve_start(&session_key("proj-a-alias", "python"), root_a),
                Err(StartRefusal::RootInFlight)
            ),
            "a second project_id for one root+language must be refused"
        );
        // A different root, or a different language on the same root, is fine.
        let b = try_reserve_start(&session_key("proj-b", "python"), root_b).expect("b");
        let c = try_reserve_start(&session_key("proj-a", "typescript"), root_a).expect("c");

        // -- concurrency cap: three are held; the fourth fits, the fifth does not.
        let d = try_reserve_start(&session_key("proj-d", "rust"), Path::new("/tmp/litria-res-d"))
            .expect("fourth fits the cap");
        assert_eq!(MAX_CONCURRENT_STARTS, 4, "test assumes the cap it exercises");
        assert!(
            matches!(
                try_reserve_start(&session_key("proj-e", "cpp"), Path::new("/tmp/litria-res-e")),
                Err(StartRefusal::TooManyConcurrent)
            ),
            "a start past the concurrency cap must be refused"
        );

        drop((a, b, c, d));
        assert!(
            starting_keys().lock().unwrap().is_empty(),
            "every reservation must release on drop"
        );
    }

    // -- audit #21 quota policy (pure — no registry, no locks) ----------------

    fn ident<'a>(project_id: &'a str, language_id: &'a str, root: &'a Path) -> SessionIdentity<'a> {
        SessionIdentity {
            project_id,
            language_id,
            canonical_root: root,
        }
    }

    #[test]
    fn quotas_allow_a_fresh_root_and_a_second_language_on_a_known_root() {
        let root = Path::new("/tmp/litria-q-a");
        assert!(evaluate_start_quotas(&[], "p1", "python", root).is_ok());

        let existing = [ident("p1", "python", root)];
        assert!(
            evaluate_start_quotas(&existing, "p1", "typescript", root).is_ok(),
            "a second language on the same project is the normal case"
        );
    }

    #[test]
    fn quotas_refuse_a_second_project_id_for_one_root() {
        // The finding: `project_root` was validated then dropped, so varying
        // `project_id` spawned N servers for one directory.
        let root = Path::new("/tmp/litria-q-b");
        let existing = [ident("p1", "python", root)];
        assert!(matches!(
            evaluate_start_quotas(&existing, "p2", "python", root),
            Err(QuotaRefusal::RootActive { holder }) if holder == "p1"
        ));
    }

    #[test]
    fn quotas_refuse_the_same_key_twice() {
        let root = Path::new("/tmp/litria-q-c");
        let existing = [ident("p1", "python", root)];
        assert!(matches!(
            evaluate_start_quotas(&existing, "p1", "python", root),
            Err(QuotaRefusal::KeyActive)
        ));
    }

    #[test]
    fn quotas_refuse_one_project_id_claiming_two_roots() {
        let root_a = Path::new("/tmp/litria-q-d");
        let root_b = Path::new("/tmp/litria-q-e");
        let existing = [ident("p1", "python", root_a)];
        assert!(matches!(
            evaluate_start_quotas(&existing, "p1", "typescript", root_b),
            Err(QuotaRefusal::ProjectIdRebound { .. })
        ));
    }

    #[test]
    fn quotas_cap_servers_per_root() {
        let root = Path::new("/tmp/litria-q-f");
        // One project id, MAX_SESSIONS_PER_ROOT languages already running.
        let langs: Vec<String> = (0..MAX_SESSIONS_PER_ROOT)
            .map(|i| format!("lang-{i}"))
            .collect();
        let existing: Vec<SessionIdentity<'_>> =
            langs.iter().map(|l| ident("p1", l, root)).collect();
        assert!(matches!(
            evaluate_start_quotas(&existing, "p1", "one-more", root),
            Err(QuotaRefusal::RootQuota { count }) if count == MAX_SESSIONS_PER_ROOT
        ));
    }

    #[test]
    fn quotas_cap_servers_globally() {
        // Every entry on its own root and its own id, so only the global cap
        // can be the thing that refuses.
        let roots: Vec<PathBuf> = (0..MAX_SESSIONS_TOTAL)
            .map(|i| PathBuf::from(format!("/tmp/litria-q-g-{i}")))
            .collect();
        let ids: Vec<String> = (0..MAX_SESSIONS_TOTAL).map(|i| format!("p{i}")).collect();
        let existing: Vec<SessionIdentity<'_>> = roots
            .iter()
            .zip(ids.iter())
            .map(|(r, id)| ident(id, "python", r))
            .collect();
        let fresh = Path::new("/tmp/litria-q-g-fresh");
        assert!(matches!(
            evaluate_start_quotas(&existing, "p-new", "python", fresh),
            Err(QuotaRefusal::GlobalQuota { count }) if count == MAX_SESSIONS_TOTAL
        ));
    }

    #[test]
    fn crash_removal_requires_ownership() {
        // Own entry → removable. Successor's entry or no entry → untouched.
        assert!(crash_owns_registry_entry(Some("sid-1"), "sid-1"));
        assert!(!crash_owns_registry_entry(Some("sid-2"), "sid-1"));
        assert!(!crash_owns_registry_entry(None, "sid-1"));
    }

    #[test]
    fn timeout_clamp_bounds_the_upper_end() {
        assert_eq!(5_000u64.min(MAX_TIMEOUT_MS), 5_000);
        assert_eq!(1_000_000u64.min(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS);
    }
}
