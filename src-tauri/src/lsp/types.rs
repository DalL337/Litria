use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 wire types (outgoing)
// ---------------------------------------------------------------------------

/// An outgoing request that expects a response.
#[derive(Debug, Serialize)]
pub(crate) struct LspRequest {
    pub jsonrpc: &'static str,
    pub id: u64,
    pub method: String,
    pub params: Value,
}

impl LspRequest {
    pub(crate) fn new(id: u64, method: impl Into<String>, params: Value) -> Self {
        Self { jsonrpc: "2.0", id, method: method.into(), params }
    }
}

/// An outgoing notification — no id, no response expected.
#[derive(Debug, Serialize)]
pub(crate) struct LspNotification {
    pub jsonrpc: &'static str,
    pub method: String,
    pub params: Value,
}

impl LspNotification {
    pub(crate) fn new(method: impl Into<String>, params: Value) -> Self {
        Self { jsonrpc: "2.0", method: method.into(), params }
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 wire types (incoming)
// ---------------------------------------------------------------------------

/// A message received from the language server.
///
/// Discrimination rules:
/// - Has `id` + `result` or `error`  → response to a request
/// - Has `method` and no `id`        → server-pushed notification
/// - Has `method` and an `id`        → server-sent request (rare, ignored in MVP)
#[derive(Debug, Deserialize)]
pub(crate) struct IncomingMessage {
    #[allow(dead_code)]
    pub jsonrpc: Option<String>,
    pub id: Option<Value>,
    pub method: Option<String>,
    pub result: Option<Value>,
    pub error: Option<Value>,
    pub params: Option<Value>,
}

impl IncomingMessage {
    /// True if this is a response to one of our requests.
    pub(crate) fn is_response(&self) -> bool {
        self.id.is_some() && self.method.is_none()
    }

    /// True if this is a server-pushed notification.
    pub(crate) fn is_notification(&self) -> bool {
        self.id.is_none() && self.method.is_some()
    }

    /// Extract the numeric request id, if present.
    pub(crate) fn request_id(&self) -> Option<u64> {
        self.id.as_ref().and_then(|v| v.as_u64())
    }
}

// ---------------------------------------------------------------------------
// Common LSP types
// ---------------------------------------------------------------------------

// Protocol vocabulary ahead of its consumers — position-based features
// (e.g. the python symbol layer follow-up) construct these.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub(crate) struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub(crate) struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

// ---------------------------------------------------------------------------
// Tauri event / command payload types
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LspSessionStartedPayload {
    pub session_id: String,
    pub language_id: String,
    pub project_id: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LspSessionEndedPayload {
    pub session_id: String,
    pub language_id: String,
    pub project_id: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LspErrorEvent {
    pub session_id: Option<String>,
    pub language_id: String,
    pub project_id: String,
    pub category: String,
    pub code: String,
    pub message: String,
    /// Last stderr lines the server wrote before dying (crash events only).
    /// Diagnostic payload for the devtools console — kept out of `message`
    /// so raw server output (which may contain paths) never lands in UI copy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stderr_tail: Option<Vec<String>>,
}

/// Result of probing a single prerequisite command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PrerequisiteProbeResult {
    pub display_name: String,
    pub command: String,
    pub available: bool,
    pub version: Option<String>,
    pub meets_min_version: bool,
}

/// Aggregated prerequisite check result returned by lsp_detect_prerequisites.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LspPrerequisitesPayload {
    pub language_id: String,
    pub all_met: bool,
    pub probes: Vec<PrerequisiteProbeResult>,
    /// How the server was resolved: "global", "managed", "bundled", or null
    /// if no tier could satisfy the server requirement.
    pub resolution_tier: Option<String>,
}
