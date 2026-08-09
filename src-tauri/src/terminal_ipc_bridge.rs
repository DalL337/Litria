use crate::errors::{CommandError, CommandResult};
use crate::terminal_types::{
    TerminalProcessCompletePayload, TerminalSessionEndedPayload,
    TerminalSessionStartedPayload,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[allow(dead_code)]
pub(crate) const EVENT_TERMINAL_SESSION_STARTED: &str = "terminal:session-started";
#[allow(dead_code)]
pub(crate) const EVENT_TERMINAL_SESSION_ENDED: &str = "terminal:session-ended";
#[allow(dead_code)]
pub(crate) const EVENT_TERMINAL_PROCESS_COMPLETE: &str = "terminal:process-complete";
#[allow(dead_code)]
pub(crate) const EVENT_TERMINAL_ERROR: &str = "terminal:error";

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalErrorEvent {
    pub(crate) session_id: Option<String>,
    pub(crate) project_id: String,
    pub(crate) category: String,
    pub(crate) code: String,
    pub(crate) message: String,
    pub(crate) timestamp: String,
}

#[allow(dead_code)]
pub(crate) fn build_terminal_error_event(
    project_id: &str,
    session_id: Option<&str>,
    error: &CommandError,
) -> CommandResult<TerminalErrorEvent> {
    let trimmed_project = project_id.trim();
    if trimmed_project.is_empty() {
        return Err(CommandError::invalid_path(
            "terminal.invalid_request",
            "Project id is required for terminal error events.",
        ));
    }

    let category = match error.category() {
        crate::errors::ErrorCategory::AccessDenied => "AccessDenied",
        crate::errors::ErrorCategory::InvalidPath => "InvalidPath",
        crate::errors::ErrorCategory::Conflict => "Conflict",
        crate::errors::ErrorCategory::NotFound => "NotFound",
        crate::errors::ErrorCategory::Internal => "Internal",
    };
    Ok(TerminalErrorEvent {
        session_id: session_id.map(|value| value.to_string()),
        project_id: trimmed_project.to_string(),
        category: category.to_string(),
        code: error.code().to_string(),
        message: error.message().to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

fn emit_payload<T: Serialize>(app: &AppHandle, event_name: &str, payload: &T) -> CommandResult<()> {
    app.emit(event_name, payload).map_err(|error| {
        CommandError::internal(
            "terminal.io_failed",
            format!("Failed to emit terminal event `{event_name}`: {error}"),
        )
    })
}

pub(crate) fn emit_session_started(
    app: &AppHandle,
    payload: &TerminalSessionStartedPayload,
) -> CommandResult<()> {
    emit_payload(app, EVENT_TERMINAL_SESSION_STARTED, payload)
}

pub(crate) fn emit_session_ended(
    app: &AppHandle,
    payload: &TerminalSessionEndedPayload,
) -> CommandResult<()> {
    emit_payload(app, EVENT_TERMINAL_SESSION_ENDED, payload)
}

pub(crate) fn emit_process_complete(
    app: &AppHandle,
    project_id: &str,
    message: &str,
    severity: &str,
    exit_code: Option<i32>,
) -> CommandResult<()> {
    let payload = TerminalProcessCompletePayload {
        id: format!("terminal-complete-{}", chrono::Utc::now().timestamp_millis()),
        project_id: project_id.to_string(),
        message: message.to_string(),
        severity: severity.to_string(),
        timestamp: chrono::Utc::now().to_rfc3339(),
        exit_code,
    };
    emit_payload(app, EVENT_TERMINAL_PROCESS_COMPLETE, &payload)
}

pub(crate) fn emit_terminal_error(
    app: &AppHandle,
    project_id: &str,
    session_id: Option<&str>,
    error: &CommandError,
) -> CommandResult<()> {
    let payload = build_terminal_error_event(project_id, session_id, error)?;
    emit_payload(app, EVENT_TERMINAL_ERROR, &payload)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_names_use_transport_naming_convention() {
        assert!(EVENT_TERMINAL_SESSION_STARTED.starts_with("terminal:"));
        assert!(EVENT_TERMINAL_SESSION_ENDED.starts_with("terminal:"));
        assert!(EVENT_TERMINAL_PROCESS_COMPLETE.starts_with("terminal:"));
        assert!(EVENT_TERMINAL_ERROR.starts_with("terminal:"));
    }

    #[test]
    fn build_terminal_error_event_requires_project_id() {
        let err = CommandError::internal("terminal.io_failed", "failed");
        let result = build_terminal_error_event(" ", None, &err);
        assert!(result.is_err());
    }
}
