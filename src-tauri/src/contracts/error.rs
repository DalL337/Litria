#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Request-level failure of a contract operation (Project API contract brief
/// §9). Per-item answers — a missing or denied file — are outcomes inside a
/// result, not errors. Adapters map this onto their transport (an MCP
/// `isError` result, a JSON-RPC error object) rather than redefining it.
///
/// A message never contains file content, a denied path, an absolute path, or
/// text echoed from the caller's input.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContractError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum ErrorCode {
    /// The request violates a constraint its inbound schema declares.
    InvalidParams,
    /// The request exceeds an operational limit that JSON Schema cannot
    /// express (the encoded byte budget).
    LimitExceeded,
    /// No operation of that name is in the catalog.
    UnknownOperation,
    /// The caller's grant lacks the operation's capability.
    Denied,
    /// No workspace is bound, or the session holds a single file only.
    NotReady,
    /// The workspace changed between attach and answer (the epoch fence).
    WorkspaceChanged,
    /// The frontend bridge has no live listener for this workspace.
    OwnerUnavailable,
    /// The frontend bridge did not answer before its deadline (P2).
    OwnerTimeout,
    /// A concurrency ceiling was reached; the call may be retried.
    Busy,
    /// The caller or Litria cancelled the request (track T).
    Cancelled,
    /// Litria is closing (track T).
    ShuttingDown,
    /// Any other failure.
    Internal,
}

impl ContractError {
    pub(crate) fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
