use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Structured failure of a contract operation. Adapters map it onto their
/// transport (an MCP `isError` result, a JSON-RPC error object) rather than
/// redefining it — see `mcp.rs`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ContractError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ErrorCode {
    /// The request violates a constraint its inbound schema declares.
    InvalidParams,
    /// The request is schema-valid but exceeds an operational limit that
    /// JSON Schema cannot express (the encoded byte budget).
    LimitExceeded,
    /// No handler is registered under the requested operation name.
    UnknownOperation,
    /// A handler's result could not be encoded.
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
