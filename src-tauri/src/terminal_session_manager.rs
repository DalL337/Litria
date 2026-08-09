use crate::errors::{CommandError, CommandResult};
use crate::terminal_policy;
use crate::terminal_pty::{self, PtySession, TerminalEvent};
use crate::terminal_types::{TerminalSessionEndedPayload, TerminalSessionStartedPayload};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use tauri::ipc::Channel;

static SESSIONS_BY_PROJECT: OnceLock<Mutex<HashMap<String, SessionEntry>>> = OnceLock::new();
static SESSION_COUNTER: AtomicU64 = AtomicU64::new(1);

struct SessionEntry {
    session_id: String,
    project_id: String,
    pty: Option<PtySession>,
}

fn sessions() -> &'static Mutex<HashMap<String, SessionEntry>> {
    SESSIONS_BY_PROJECT.get_or_init(|| Mutex::new(HashMap::new()))
}

fn next_session_id() -> String {
    let id = SESSION_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("term-{id}")
}

fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

/// Start a metadata-only session (no PTY process). Used by the legacy `terminal_session_start` command.
pub(crate) fn start_session(
    project_id: &str,
    project_root: &str,
    executable: Option<&str>,
) -> CommandResult<TerminalSessionStartedPayload> {
    let validated = terminal_policy::validate_terminal_execution_boundary(project_id, project_root, executable)?;
    let trimmed_project_id = validated.project_id;

    let mut state = sessions()
        .lock()
        .map_err(|_| CommandError::internal("terminal.internal.lock_poisoned", "Terminal session lock is poisoned."))?;

    if state.contains_key(&trimmed_project_id) {
        return Err(CommandError::conflict(
            "terminal.session_already_exists",
            "A terminal session is already active for this project.",
        ));
    }

    let session_id = next_session_id();
    state.insert(
        trimmed_project_id.clone(),
        SessionEntry {
            session_id: session_id.clone(),
            project_id: trimmed_project_id.clone(),
            pty: None,
        },
    );

    Ok(TerminalSessionStartedPayload {
        session_id,
        project_id: trimmed_project_id,
        timestamp: now_iso(),
    })
}

/// Start a PTY-backed session. Spawns a real shell process and streams output via Channel.
pub(crate) fn start_pty_session(
    project_id: &str,
    project_root: &str,
    executable: Option<&str>,
    cols: u16,
    rows: u16,
    channel: Channel<TerminalEvent>,
) -> CommandResult<TerminalSessionStartedPayload> {
    let validated = terminal_policy::validate_terminal_execution_boundary(project_id, project_root, executable)?;
    let trimmed_project_id = validated.project_id.clone();

    // Step 1: Remove existing session while holding the lock (fast)
    let existing = {
        let mut state = sessions()
            .lock()
            .map_err(|_| CommandError::internal("terminal.internal.lock_poisoned", "Terminal session lock is poisoned."))?;
        state.remove(&trimmed_project_id)
    };

    // Step 2: Teardown outside the lock (slow — joins reader thread, kills child)
    if let Some(mut entry) = existing {
        if let Some(ref mut pty) = entry.pty {
            pty.teardown();
        }
    }

    // Step 3: Spawn new PTY outside the lock (slow — ConPTY creation)
    let session_id = next_session_id();
    let pty = terminal_pty::spawn_pty(&session_id, &validated, cols, rows, channel)?;

    // Step 4: Insert new session while holding the lock (fast)
    {
        let mut state = sessions()
            .lock()
            .map_err(|_| CommandError::internal("terminal.internal.lock_poisoned", "Terminal session lock is poisoned."))?;
        state.insert(
            trimmed_project_id.clone(),
            SessionEntry {
                session_id: session_id.clone(),
                project_id: trimmed_project_id.clone(),
                pty: Some(pty),
            },
        );
    }

    Ok(TerminalSessionStartedPayload {
        session_id,
        project_id: trimmed_project_id,
        timestamp: now_iso(),
    })
}

pub(crate) fn end_session(project_id: &str) -> CommandResult<(TerminalSessionEndedPayload, Option<i32>)> {
    let trimmed_project_id = project_id.trim();
    if trimmed_project_id.is_empty() {
        return Err(CommandError::invalid_path(
            "terminal.invalid_request",
            "Project id is required.",
        ));
    }

    // Remove from map while holding lock (fast)
    let entry = {
        let mut state = sessions()
            .lock()
            .map_err(|_| CommandError::internal("terminal.internal.lock_poisoned", "Terminal session lock is poisoned."))?;
        state.remove(trimmed_project_id)
    };

    let Some(mut entry) = entry else {
        return Err(CommandError::not_found(
            "terminal.session_not_found",
            "No active terminal session found for this project.",
        ));
    };

    // Teardown outside the lock (slow)
    let exit_code = entry.pty.as_mut().and_then(|pty| pty.teardown());

    Ok((
        TerminalSessionEndedPayload {
            session_id: entry.session_id,
            project_id: entry.project_id,
            timestamp: now_iso(),
        },
        exit_code,
    ))
}

#[allow(dead_code)]
pub(crate) fn assert_session(project_id: &str, session_id: &str) -> CommandResult<()> {
    let trimmed_project_id = project_id.trim();
    let trimmed_session_id = session_id.trim();
    if trimmed_project_id.is_empty() || trimmed_session_id.is_empty() {
        return Err(CommandError::invalid_path(
            "terminal.invalid_request",
            "Project id and session id are required.",
        ));
    }

    let state = sessions()
        .lock()
        .map_err(|_| CommandError::internal("terminal.internal.lock_poisoned", "Terminal session lock is poisoned."))?;
    let Some(entry) = state.get(trimmed_project_id) else {
        return Err(CommandError::not_found(
            "terminal.session_not_found",
            "No active terminal session found for this project.",
        ));
    };
    if entry.session_id != trimmed_session_id {
        return Err(CommandError::invalid_path(
            "terminal.project_context_mismatch",
            "Session id does not match active project session.",
        ));
    }
    Ok(())
}

/// Write input to the PTY stdin for the given session.
pub(crate) fn write_input(project_id: &str, session_id: &str, data: &[u8]) -> CommandResult<()> {
    let trimmed_project_id = project_id.trim();
    let trimmed_session_id = session_id.trim();

    let state = sessions()
        .lock()
        .map_err(|_| CommandError::internal("terminal.internal.lock_poisoned", "Terminal session lock is poisoned."))?;

    let Some(entry) = state.get(trimmed_project_id) else {
        return Err(CommandError::not_found(
            "terminal.session_not_found",
            "No active terminal session found for this project.",
        ));
    };
    if entry.session_id != trimmed_session_id {
        return Err(CommandError::invalid_path(
            "terminal.project_context_mismatch",
            "Session id does not match active project session.",
        ));
    }

    match &entry.pty {
        Some(pty) => pty.write_input(data),
        None => {
            // Metadata-only session — no PTY attached (legacy path).
            Ok(())
        }
    }
}

/// Resize the PTY for the given session.
pub(crate) fn resize_pty(project_id: &str, session_id: &str, cols: u16, rows: u16) -> CommandResult<()> {
    let trimmed_project_id = project_id.trim();
    let trimmed_session_id = session_id.trim();

    let state = sessions()
        .lock()
        .map_err(|_| CommandError::internal("terminal.internal.lock_poisoned", "Terminal session lock is poisoned."))?;

    let Some(entry) = state.get(trimmed_project_id) else {
        return Err(CommandError::not_found(
            "terminal.session_not_found",
            "No active terminal session found for this project.",
        ));
    };
    if entry.session_id != trimmed_session_id {
        return Err(CommandError::invalid_path(
            "terminal.project_context_mismatch",
            "Session id does not match active project session.",
        ));
    }

    match &entry.pty {
        Some(pty) => pty.resize(cols, rows),
        None => Ok(()),
    }
}

/// Pause PTY output for the given session (backpressure from frontend).
pub(crate) fn pause_output(project_id: &str) -> CommandResult<()> {
    let trimmed_project_id = project_id.trim();

    let state = sessions()
        .lock()
        .map_err(|_| CommandError::internal("terminal.internal.lock_poisoned", "Terminal session lock is poisoned."))?;

    let Some(entry) = state.get(trimmed_project_id) else {
        return Err(CommandError::not_found("terminal.session_not_found", "No active terminal session."));
    };
    if let Some(pty) = &entry.pty {
        pty.pause_output();
    }
    Ok(())
}

/// Resume PTY output for the given session.
pub(crate) fn resume_output(project_id: &str) -> CommandResult<()> {
    let trimmed_project_id = project_id.trim();

    let state = sessions()
        .lock()
        .map_err(|_| CommandError::internal("terminal.internal.lock_poisoned", "Terminal session lock is poisoned."))?;

    let Some(entry) = state.get(trimmed_project_id) else {
        return Err(CommandError::not_found("terminal.session_not_found", "No active terminal session."));
    };
    if let Some(pty) = &entry.pty {
        pty.resume_output();
    }
    Ok(())
}

pub(crate) fn teardown_all_sessions() -> CommandResult<usize> {
    // Drain the map while holding lock (fast)
    let entries: Vec<SessionEntry> = {
        let mut state = sessions()
            .lock()
            .map_err(|_| CommandError::internal("terminal.internal.lock_poisoned", "Terminal session lock is poisoned."))?;
        state.drain().map(|(_, entry)| entry).collect()
    };

    // Teardown all sessions outside the lock (slow)
    let count = entries.len();
    for mut entry in entries {
        if let Some(ref mut pty) = entry.pty {
            pty.teardown();
        }
    }
    Ok(count)
}

#[allow(dead_code)]
pub(crate) fn active_session_count() -> usize {
    sessions().lock().map(|state| state.len()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::MutexGuard;

    static TEST_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    fn lock_tests() -> MutexGuard<'static, ()> {
        TEST_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .expect("test lock must not be poisoned")
    }

    fn reset() {
        let _ = teardown_all_sessions();
    }

    #[test]
    fn start_session_allows_one_active_session_per_project() {
        let _guard = lock_tests();
        reset();
        let root = std::env::temp_dir().to_string_lossy().to_string();
        let first = start_session("project-1", &root, None).expect("first session must start");
        assert!(!first.session_id.is_empty());
        let second = start_session("project-1", &root, None);
        assert!(second.is_err());
    }

    #[test]
    fn start_session_rejects_invalid_project_root() {
        let _guard = lock_tests();
        reset();
        let result = start_session("project-3", "Z:/definitely-not-a-real-litria-root", None);
        assert!(result.is_err());
    }

    #[test]
    fn end_session_clears_project_session() {
        let _guard = lock_tests();
        reset();
        let root = std::env::temp_dir().to_string_lossy().to_string();
        let started = start_session("project-2", &root, None).expect("session must start");
        let (ended, _exit_code) = end_session("project-2").expect("session must end");
        assert_eq!(started.project_id, ended.project_id);
        assert_eq!(active_session_count(), 0);
    }

    #[test]
    fn teardown_all_sessions_clears_all_records() {
        let _guard = lock_tests();
        reset();
        let root = std::env::temp_dir().to_string_lossy().to_string();
        start_session("project-a", &root, None).expect("session a must start");
        start_session("project-b", &root, None).expect("session b must start");
        let cleared = teardown_all_sessions().expect("teardown must succeed");
        assert_eq!(cleared, 2);
        assert_eq!(active_session_count(), 0);
    }

    #[test]
    fn assert_session_detects_project_context_mismatch() {
        let _guard = lock_tests();
        reset();
        let root = std::env::temp_dir().to_string_lossy().to_string();
        let started = start_session("project-z", &root, None).expect("session must start");
        let mismatch = assert_session("project-z", &(started.session_id.clone() + "-wrong"));
        assert!(mismatch.is_err());
    }

    #[test]
    fn start_session_rejects_non_allowlisted_executable() {
        let _guard = lock_tests();
        reset();
        let root = std::env::temp_dir().to_string_lossy().to_string();
        let result = start_session("project-q", &root, Some("python.exe"));
        assert!(result.is_err());
    }
}
