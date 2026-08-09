use crate::errors::{CommandError, CommandResult};
use crate::lsp::types::{LspErrorEvent, LspSessionEndedPayload, LspSessionStartedPayload};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Emitter};

// ---------------------------------------------------------------------------
// Event name constants
// ---------------------------------------------------------------------------

pub(crate) const EVENT_SESSION_STARTED: &str = "lsp:session-started";
pub(crate) const EVENT_SESSION_ENDED: &str = "lsp:session-ended";
pub(crate) const EVENT_ERROR: &str = "lsp:error";
pub(crate) const EVENT_SERVER_UNINSTALLED: &str = "lsp:server-uninstalled";
pub(crate) const EVENT_DIAGNOSTICS: &str = "lsp:diagnostics";
pub(crate) const EVENT_LOG_MESSAGE: &str = "lsp:log-message";

// ---------------------------------------------------------------------------
// Payload types for notifications
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsPayload {
    pub session_id: String,
    pub language_id: String,
    pub project_id: String,
    pub uri: String,
    pub diagnostics: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogMessagePayload {
    pub session_id: String,
    pub language_id: String,
    pub project_id: String,
    pub message_type: i64,
    pub message: String,
}

/// A managed server was removed via settings (Slice 7). Lets same-session
/// consumers (the file-open offer pill) drop their cached installed-state
/// instead of waiting for the next project open.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerUninstalledPayload {
    pub language_id: String,
    pub server: String,
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

fn emit_payload<T: Serialize>(app: &AppHandle, event_name: &str, payload: &T) -> CommandResult<()> {
    app.emit(event_name, payload).map_err(|e| {
        CommandError::internal(
            "lsp.transport.failed",
            format!("Failed to emit lsp event `{event_name}`: {e}"),
        )
    })
}

fn category_str(cat: &crate::errors::ErrorCategory) -> &'static str {
    match cat {
        crate::errors::ErrorCategory::AccessDenied => "AccessDenied",
        crate::errors::ErrorCategory::InvalidPath => "InvalidPath",
        crate::errors::ErrorCategory::Conflict => "Conflict",
        crate::errors::ErrorCategory::NotFound => "NotFound",
        crate::errors::ErrorCategory::Internal => "Internal",
    }
}

// ---------------------------------------------------------------------------
// Public emit functions
// ---------------------------------------------------------------------------

pub(crate) fn emit_session_started(app: &AppHandle, payload: &LspSessionStartedPayload) {
    let _ = emit_payload(app, EVENT_SESSION_STARTED, payload);
}

pub(crate) fn emit_session_ended(app: &AppHandle, payload: &LspSessionEndedPayload) {
    let _ = emit_payload(app, EVENT_SESSION_ENDED, payload);
}

pub(crate) fn emit_server_uninstalled(app: &AppHandle, language_id: &str, server: &str) {
    let payload = ServerUninstalledPayload {
        language_id: language_id.to_string(),
        server: server.to_string(),
    };
    let _ = emit_payload(app, EVENT_SERVER_UNINSTALLED, &payload);
}

pub(crate) fn emit_lsp_error(
    app: &AppHandle,
    project_id: &str,
    language_id: &str,
    session_id: Option<&str>,
    error: &CommandError,
    stderr_tail: Option<Vec<String>>,
) {
    let payload = LspErrorEvent {
        session_id: session_id.map(|s| s.to_string()),
        language_id: language_id.to_string(),
        project_id: project_id.to_string(),
        category: category_str(error.category()).to_string(),
        code: error.code().to_string(),
        message: error.message().to_string(),
        stderr_tail: stderr_tail.filter(|t| !t.is_empty()),
    };
    let _ = emit_payload(app, EVENT_ERROR, &payload);
}

/// Route a server-pushed notification to the appropriate Tauri event.
///
/// Called from the read-loop thread via the `on_message` closure.
/// Must not block.
pub(crate) fn dispatch_notification(
    app: &AppHandle,
    session_id: &str,
    language_id: &str,
    project_id: &str,
    method: &str,
    params: Value,
) {
    match method {
        "textDocument/publishDiagnostics" => {
            let uri = params
                .get("uri")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let diagnostics = params
                .get("diagnostics")
                .cloned()
                .unwrap_or(Value::Array(vec![]));
            let payload = DiagnosticsPayload {
                session_id: session_id.to_string(),
                language_id: language_id.to_string(),
                project_id: project_id.to_string(),
                uri,
                diagnostics,
            };
            let _ = emit_payload(app, EVENT_DIAGNOSTICS, &payload);
        }
        "window/logMessage" => {
            let message_type = params
                .get("type")
                .and_then(|v| v.as_i64())
                .unwrap_or(3);
            let message = params
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let payload = LogMessagePayload {
                session_id: session_id.to_string(),
                language_id: language_id.to_string(),
                project_id: project_id.to_string(),
                message_type,
                message,
            };
            let _ = emit_payload(app, EVENT_LOG_MESSAGE, &payload);
        }
        "window/showMessage" | "$/progress" | "$/cancelRequest" => {
            // window/showMessage and progress are no-ops in MVP.
        }
        _ => {
            // Unknown notification — silently discard.
        }
    }
}
