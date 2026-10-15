use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSessionStartedPayload {
    pub(crate) session_id: String,
    pub(crate) project_id: String,
    pub(crate) timestamp: String,
}

/// The reply to `terminal_session_end`. A session that had already ended
/// replies too, with no exit code.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSessionEndedPayload {
    pub(crate) session_id: String,
    pub(crate) project_id: String,
    pub(crate) exit_code: Option<i32>,
    /// True when the teardown outlived its budget and is still running.
    pub(crate) still_ending: bool,
    pub(crate) timestamp: String,
}

/// The reply to `terminal_end_project` and `terminal_teardown_all`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalEndReport {
    pub(crate) ended: usize,
    pub(crate) still_ending: usize,
}
