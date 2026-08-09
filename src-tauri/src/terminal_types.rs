use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSessionStartedPayload {
    pub(crate) session_id: String,
    pub(crate) project_id: String,
    pub(crate) timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalSessionEndedPayload {
    pub(crate) session_id: String,
    pub(crate) project_id: String,
    pub(crate) timestamp: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalOutputPayload {
    pub(crate) session_id: String,
    pub(crate) project_id: String,
    pub(crate) chunk: String,
    pub(crate) timestamp: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalProcessCompletePayload {
    pub(crate) id: String,
    pub(crate) project_id: String,
    pub(crate) message: String,
    pub(crate) severity: String,
    pub(crate) timestamp: String,
    pub(crate) exit_code: Option<i32>,
}
