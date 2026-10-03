//! The `project-api-bridge` contract family, version 1 (draft): how the Rust
//! boundary asks live frontend owners for state (Project API contract brief
//! §8).
//!
//! The direction is the reverse of `project-api`. Rust serializes the
//! requests and emits them to the main window as the event
//! `project-api://bridge-request`; JavaScript answers with the command
//! `project_api_bridge_reply`. Replies are INBOUND to Rust, and pass the same
//! three-layer boundary as external input — the bridge reply ceiling first,
//! then strict deserialization, then explicit validation — because they feed
//! an external caller's answer (brief §8).
//!
//! The disclosure policy stays in Rust: the bridge never sees it, Rust asks
//! only for paths it has already allowed, and filters every path a reply
//! lists before counting or returning it.
//!
//! The committed artifacts in `src-tauri/contracts/project-api-bridge/v1/`
//! are the contract of record; the JavaScript side (`src/app/projectApiBridge.js`)
//! is tested against the fixtures beside them.

pub(crate) mod editor;
pub(crate) mod languages;
pub(crate) mod workspace;

#[cfg(test)]
use schemars::JsonSchema;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::contracts::boundary::{invalid, schema_length, Validate};
use crate::contracts::error::ContractError;

#[cfg(test)]
pub(crate) const FAMILY: &str = "project-api-bridge";
#[cfg(test)]
pub(crate) const API_VERSION: u32 = 1;
/// Published in the catalog; readers must not treat a draft as stable.
#[cfg(test)]
pub(crate) const STATUS: &str = "draft";

/// The event Rust emits to the main window, once per request.
pub(crate) const REQUEST_EVENT: &str = "project-api://bridge-request";
/// Encoded size of one reply, checked before it is parsed (brief §10).
/// Large answers page instead of overflowing it.
pub(crate) const MAX_REPLY_BYTES: usize = 512 * 1024;
/// Error messages from the bridge are bounded; Rust never forwards them to an
/// external caller (they could name paths), so they are diagnostics only.
pub(crate) const MAX_ERROR_MESSAGE_LENGTH: usize = 1000;

/// One operation of the bridge family: the request Rust emits and the result
/// it accepts back.
pub(crate) trait BridgeOperation: 'static {
    const NAME: &'static str;
    // Read by artifact generation (tests); documentation for the JS owner.
    #[cfg_attr(not(test), allow(dead_code))]
    const DESCRIPTION: &'static str;
    /// The frontend domain that owns the answer.
    #[cfg_attr(not(test), allow(dead_code))]
    const OWNER: &'static str;
    type Request: Serialize;
    type Result: DeserializeOwned + Validate;
}

/// The payload of `project-api://bridge-request`.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct BridgeRequestEvent {
    /// Opaque, minted by Rust; the reply echoes it.
    pub request_id: String,
    /// The workspace epoch the request is about. The bridge answers only when
    /// this, its own ready epoch and the frontend's current epoch all agree.
    pub epoch: String,
    /// The attach generation the request is addressed to; a listener with
    /// another generation ignores it.
    pub generation: String,
    /// The operation, as named in the catalog.
    pub op: String,
    /// Shaped by the operation's request schema (`<op>.request.schema.json`).
    #[cfg_attr(test, schemars(with = "serde_json::Map<String, Value>"))]
    pub request: Value,
}

/// A reply, as JavaScript sends it (the JSON text of the reply command's
/// `reply` argument). Read strictly: unknown fields are rejected.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum BridgeReply<T> {
    /// The owner's answer.
    Result { result: T },
    /// The owner refused or failed. Never forwarded as text.
    Error {
        code: BridgeErrorCode,
        #[cfg_attr(test, schemars(length(max = MAX_ERROR_MESSAGE_LENGTH)))]
        message: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum BridgeErrorCode {
    /// The request's epoch is not the one the owner's state belongs to.
    WorkspaceChanged,
    /// The owner does not know the operation.
    UnknownOperation,
    /// The owner could not read the request.
    InvalidRequest,
    /// Any other failure.
    Internal,
}

impl<T: Validate> Validate for BridgeReply<T> {
    fn validate(&self) -> Result<(), ContractError> {
        match self {
            Self::Result { result } => result.validate(),
            Self::Error { message, .. } => {
                if schema_length(message) > MAX_ERROR_MESSAGE_LENGTH {
                    return Err(invalid(format!(
                        "message: at most {MAX_ERROR_MESSAGE_LENGTH} characters"
                    )));
                }
                Ok(())
            }
        }
    }
}

/// The family's operation catalog, in publication order.
#[cfg(test)]
pub(crate) fn catalog() -> Vec<entry::BridgeEntry> {
    vec![
        entry::bridge_entry::<editor::DocumentsOp>(),
        entry::bridge_entry::<editor::BufferIndexOp>(),
        entry::bridge_entry::<workspace::SelectionOp>(),
        entry::bridge_entry::<workspace::GraphOp>(),
        entry::bridge_entry::<languages::CapabilitiesOp>(),
    ]
}

/// Representative events Rust emits; the committed request fixtures must equal
/// them, and the JavaScript tests answer them.
#[cfg(test)]
pub(crate) mod samples {
    use super::editor::{BufferIndexOp, BufferIndexRequest, DocumentQuery, DocumentsOp, DocumentsRequest};
    use super::languages::{CapabilitiesOp, CapabilitiesRequest};
    use super::workspace::{GraphDirection, GraphOp, GraphRequest, SelectionOp, SelectionRequest};
    use super::{BridgeOperation, BridgeRequestEvent};

    fn event<O: BridgeOperation>(request: &O::Request) -> BridgeRequestEvent {
        BridgeRequestEvent {
            request_id: "r1".into(),
            epoch: "ws-7".into(),
            generation: "g3".into(),
            op: O::NAME.into(),
            request: serde_json::to_value(request).unwrap(),
        }
    }

    fn query(path: &str, lines: Option<(u32, u32)>, max_bytes: u32) -> DocumentQuery {
        DocumentQuery {
            path: path.into(),
            start_line: lines.map(|(start, _)| start),
            end_line: lines.map(|(_, end)| end),
            max_bytes,
        }
    }

    /// Every entry kind but `deferred`: open and dirty, closed and dirty,
    /// closed and clean, not in the session, a line range, and a cut line.
    pub(crate) fn documents_event() -> BridgeRequestEvent {
        event::<DocumentsOp>(&DocumentsRequest {
            documents: vec![
                query("src/open.ts", None, 65536),
                query("src/closed-dirty.ts", None, 65536),
                query("src/closed-clean.ts", None, 65536),
                query("src/not-in-session.ts", None, 65536),
                query("src/lines.ts", Some((2, 3)), 65536),
                query("dist/bundle.min.js", None, 8),
            ],
            max_text_bytes: 262144,
        })
    }

    pub(crate) fn buffer_index_event() -> BridgeRequestEvent {
        event::<BufferIndexOp>(&BufferIndexRequest { max_entries: 500 })
    }

    pub(crate) fn selection_event() -> BridgeRequestEvent {
        event::<SelectionOp>(&SelectionRequest { max_paths: 1000 })
    }

    pub(crate) fn graph_event() -> BridgeRequestEvent {
        event::<GraphOp>(&GraphRequest {
            paths: vec!["src/a.ts".into(), "src/b.ts".into()],
            direction: GraphDirection::Both,
            max_edges_per_node: 500,
        })
    }

    pub(crate) fn capabilities_event() -> BridgeRequestEvent {
        event::<CapabilitiesOp>(&CapabilitiesRequest {})
    }
}

/// Test-only catalog entries: schemas and the reply boundary, for generation,
/// drift and fixture verdicts.
#[cfg(test)]
pub(crate) mod entry {
    use schemars::{JsonSchema, Schema};

    use super::{BridgeOperation, BridgeReply, MAX_REPLY_BYTES};
    use crate::contracts::artifacts::{inbound_schema, outbound_schema};
    use crate::contracts::boundary::accept_within;
    use crate::contracts::error::ContractError;

    pub(crate) struct BridgeEntry {
        pub name: &'static str,
        pub description: &'static str,
        pub owner: &'static str,
        /// What Rust emits as the event's `request`.
        pub request_schema: fn() -> Schema,
        /// What Rust accepts as the reply.
        pub reply_schema: fn() -> Schema,
        /// The full reply boundary: ceiling, strict serde, validation.
        pub accept_reply: fn(&[u8]) -> Result<(), ContractError>,
    }

    pub(crate) fn bridge_entry<O: BridgeOperation>() -> BridgeEntry
    where
        O::Request: JsonSchema,
        O::Result: JsonSchema,
    {
        BridgeEntry {
            name: O::NAME,
            description: O::DESCRIPTION,
            owner: O::OWNER,
            request_schema: outbound_schema::<O::Request>,
            reply_schema: inbound_schema::<BridgeReply<O::Result>>,
            accept_reply: accept_reply::<O>,
        }
    }

    fn accept_reply<O: BridgeOperation>(raw: &[u8]) -> Result<(), ContractError> {
        accept_within::<BridgeReply<O::Result>>(raw, MAX_REPLY_BYTES).map(|_| ())
    }
}
