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
// Start reservations — closes the check-then-insert race (2026-07-17 dev
// crash-loop). `start` registers the session only AFTER resolve + spawn +
// handshake (~1-2s); two concurrent starts for the same key both passed the
// registry check, and the second insert REPLACED the first — dropping it
// closed the healthy child's stdin, whose EOF fired the crash handler, whose
// unconditional remove dropped the successor: a self-sustaining cascade.
// A key must now be reserved for the whole start; the loser fails fast with
// `already_active`.
// ---------------------------------------------------------------------------

static STARTING: OnceLock<Mutex<std::collections::HashSet<SessionKey>>> = OnceLock::new();

fn starting_keys() -> &'static Mutex<std::collections::HashSet<SessionKey>> {
    STARTING.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
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

/// Reserve `key` for a start attempt. Returns None when another start for the
/// same key is already in flight.
fn try_reserve_start(key: &SessionKey) -> Option<StartReservation> {
    if starting_keys().lock().unwrap().insert(key.clone()) {
        Some(StartReservation { key: key.clone() })
    } else {
        None
    }
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
    // Identity mirrored from the session key (diagnostics + the
    // multi-session scoping the brief anticipates); not read on any
    // current path.
    #[allow(dead_code)]
    pub language_id: String,
    #[allow(dead_code)]
    pub project_id: String,
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

    let key = session_key(project_id, language_id);
    if sessions().lock().unwrap().contains_key(&key) {
        return Err(CommandError::conflict(
            &format!("{}.session.already_active", pack.error_prefix),
            format!(
                "LSP session already active for project '{project_id}' language '{language_id}'"
            ),
        ));
    }
    // Hold a start reservation for the whole resolve/spawn/handshake window —
    // a concurrent second start fails fast here instead of replacing the
    // first session at insert time. Released on every exit path via Drop.
    let _start_reservation = try_reserve_start(&key).ok_or_else(|| {
        CommandError::conflict(
            &format!("{}.session.already_active", pack.error_prefix),
            format!(
                "LSP session start already in progress for project '{project_id}' language '{language_id}'"
            ),
        )
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

    #[test]
    fn start_reservation_blocks_second_start_and_releases_on_drop() {
        let key = session_key("res-test-proj", "res-test-lang");
        let first = try_reserve_start(&key);
        assert!(first.is_some(), "first reservation must succeed");
        assert!(
            try_reserve_start(&key).is_none(),
            "second concurrent reservation must fail fast"
        );
        drop(first);
        let again = try_reserve_start(&key);
        assert!(again.is_some(), "reservation must be reusable after release");
        drop(again);
    }

    #[test]
    fn reservations_are_per_key() {
        let a = try_reserve_start(&session_key("proj-a", "python"));
        let b = try_reserve_start(&session_key("proj-b", "python"));
        let c = try_reserve_start(&session_key("proj-a", "typescript"));
        assert!(a.is_some() && b.is_some() && c.is_some());
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
