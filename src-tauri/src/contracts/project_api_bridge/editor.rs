//! EditorDomain operations of the bridge family (Project API contract brief
//! §5, §8): `editor.documents` and `editor.bufferIndex`.
//!
//! Buffer truth is the editor session — the working text of every entry it
//! holds, including closed entries it still retains — never an editor engine
//! model. Buffer revisions are minted by the JavaScript owner (brief §4.5).

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::BridgeOperation;
use crate::contracts::boundary::{invalid, schema_length, Validate};
use crate::contracts::error::ContractError;
use crate::contracts::project_api::files_read::{
    MAX_BYTES_PER_DOCUMENT, MAX_DOCUMENTS, MAX_PATH_LENGTH, MIN_DOCUMENTS, MIN_PATH_LENGTH,
};

/// Opaque buffer revisions stay short; the owner chooses the format.
pub(crate) const MAX_REVISION_LENGTH: usize = 128;
/// Buffer index entries per reply (brief §10). More are counted, not listed.
#[allow(dead_code)] // litria_files_search (build plan P3) is its consumer; P2 delivers the contract.
pub(crate) const MAX_INDEX_ENTRIES: u32 = 500;
/// Line numbers and counts are `u32` in Rust; the schema says so explicitly,
/// because a `uint32` format is only an annotation to a validator.
#[cfg(test)]
const MAX_U32: u32 = u32::MAX;

// ---------------------------------------------------------------------------
// editor.documents
// ---------------------------------------------------------------------------

pub(crate) struct DocumentsOp;

impl BridgeOperation for DocumentsOp {
    const NAME: &'static str = "editor.documents";
    const DESCRIPTION: &'static str = "For each path, the editor session's state, and — when the session holds the \
         document open or unsaved — its revision and the requested slice of its text. Answered in request order; \
         a page that runs out of room defers the rest.";
    const OWNER: &'static str = "EditorDomain";
    type Request = DocumentsRequest;
    type Result = DocumentsResult;
}

/// Rust → JavaScript. Paths have already passed the disclosure policy.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentsRequest {
    /// The documents to look up, answered in this order.
    pub documents: Vec<DocumentQuery>,
    /// Raw text budget for the whole reply, in UTF-8 bytes, spent in order.
    pub max_text_bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct DocumentQuery {
    /// Project-relative path, forward slashes, exactly as the session should
    /// be searched for it.
    pub path: String,
    /// First line wanted, 1-based; absent means 1.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_line: Option<u32>,
    /// Last line wanted, inclusive; absent means the end.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_line: Option<u32>,
    /// Text budget for this document, in UTF-8 bytes. Strict: a slice never
    /// exceeds it.
    pub max_bytes: u32,
}

/// JavaScript → Rust.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocumentsResult {
    /// Exactly one entry per requested document, in request order.
    #[cfg_attr(test, schemars(length(min = MIN_DOCUMENTS, max = MAX_DOCUMENTS)))]
    pub documents: Vec<DocumentEntry>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub(crate) enum DocumentEntry {
    /// The session holds no buffer an effective read should use: no entry for
    /// the path, or a closed entry with no unsaved changes.
    NotBuffered {
        #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
        path: String,
        // Diagnostic: the effective read needs only that no buffer is used.
        #[allow(dead_code)]
        state: UnbufferedState,
    },
    /// The session's buffer: open, or closed with unsaved changes.
    Buffer {
        #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
        path: String,
        state: BufferState,
        dirty: bool,
        /// Revision of the WHOLE buffer, whatever slice is returned.
        #[cfg_attr(test, schemars(length(min = 1, max = MAX_REVISION_LENGTH)))]
        revision: String,
        #[cfg_attr(test, schemars(length(max = MAX_BYTES_PER_DOCUMENT)))]
        text: String,
        /// The lines returned; absent when none were.
        #[serde(default)]
        range: Option<BufferRange>,
        #[cfg_attr(test, schemars(range(max = MAX_U32)))]
        total_lines: u32,
        truncated: bool,
        line_cut: bool,
    },
    /// Buffered, but this page had no room left: ask again.
    Deferred {
        #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
        path: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum UnbufferedState {
    None,
    ClosedClean,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum BufferState {
    Open,
    ClosedDirty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BufferRange {
    #[cfg_attr(test, schemars(range(min = 1, max = MAX_U32)))]
    pub start_line: u32,
    #[cfg_attr(test, schemars(range(min = 1, max = MAX_U32)))]
    pub end_line: u32,
}

fn check_path(path: &str) -> Result<(), ContractError> {
    let length = schema_length(path);
    if !(MIN_PATH_LENGTH..=MAX_PATH_LENGTH).contains(&length) {
        return Err(invalid(format!(
            "path: each must be {MIN_PATH_LENGTH} to {MAX_PATH_LENGTH} characters"
        )));
    }
    Ok(())
}

fn check_revision(revision: &str) -> Result<(), ContractError> {
    if !(1..=MAX_REVISION_LENGTH).contains(&schema_length(revision)) {
        return Err(invalid(format!("revision: 1 to {MAX_REVISION_LENGTH} characters")));
    }
    Ok(())
}

impl Validate for DocumentsResult {
    fn validate(&self) -> Result<(), ContractError> {
        let count = self.documents.len();
        if !(MIN_DOCUMENTS..=MAX_DOCUMENTS).contains(&count) {
            return Err(invalid(format!(
                "documents: expected {MIN_DOCUMENTS} to {MAX_DOCUMENTS} entries"
            )));
        }
        for entry in &self.documents {
            match entry {
                DocumentEntry::NotBuffered { path, .. } | DocumentEntry::Deferred { path } => check_path(path)?,
                DocumentEntry::Buffer {
                    path,
                    revision,
                    text,
                    range,
                    ..
                } => {
                    check_path(path)?;
                    check_revision(revision)?;
                    // Code points, as the schema's maxLength counts. The
                    // request-relative byte budget is checked by the client.
                    if schema_length(text) > MAX_BYTES_PER_DOCUMENT as usize {
                        return Err(invalid(format!(
                            "text: at most {MAX_BYTES_PER_DOCUMENT} characters"
                        )));
                    }
                    if let Some(range) = range {
                        if range.start_line < 1 || range.end_line < 1 {
                            return Err(invalid("range: lines are 1-based"));
                        }
                    }
                }
            }
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// editor.bufferIndex
// ---------------------------------------------------------------------------

#[allow(dead_code)] // litria_files_search (build plan P3) is its consumer; P2 delivers the contract.
/// The buffer index (brief §7.3): what effective search plans its buffer
/// coverage from. Its consumer, `litria_files_search`, arrives in build plan
/// P3; P2 delivers the contract, the owner port and the client call.
pub(crate) struct BufferIndexOp;

impl BridgeOperation for BufferIndexOp {
    const NAME: &'static str = "editor.bufferIndex";
    const DESCRIPTION: &'static str = "Path, revision, UTF-8 byte length and session state of every open or unsaved \
         buffer, without text. Entries beyond the limit, or beyond the reply ceiling, are counted as omitted.";
    const OWNER: &'static str = "EditorDomain";
    type Request = BufferIndexRequest;
    type Result = BufferIndexResult;
}

#[allow(dead_code)] // litria_files_search (build plan P3) is its consumer; P2 delivers the contract.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct BufferIndexRequest {
    /// List at most this many entries.
    pub max_entries: u32,
}

#[allow(dead_code)] // litria_files_search (build plan P3) is its consumer; P2 delivers the contract.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BufferIndexResult {
    #[cfg_attr(test, schemars(length(max = MAX_INDEX_ENTRIES)))]
    pub entries: Vec<BufferIndexEntry>,
    /// Buffers that exist but were not listed (the limit or the ceiling).
    #[cfg_attr(test, schemars(range(max = MAX_U32)))]
    pub omitted: u32,
}

#[allow(dead_code)] // litria_files_search (build plan P3) is its consumer; P2 delivers the contract.
#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BufferIndexEntry {
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub path: String,
    pub state: BufferState,
    pub dirty: bool,
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_REVISION_LENGTH)))]
    pub revision: String,
    /// The whole buffer's length in UTF-8 bytes.
    #[cfg_attr(test, schemars(range(max = MAX_U32)))]
    pub byte_length: u32,
}

#[allow(dead_code)] // litria_files_search (build plan P3) is its consumer; P2 delivers the contract.
impl Validate for BufferIndexResult {
    fn validate(&self) -> Result<(), ContractError> {
        if self.entries.len() > MAX_INDEX_ENTRIES as usize {
            return Err(invalid(format!("entries: at most {MAX_INDEX_ENTRIES}")));
        }
        for entry in &self.entries {
            check_path(&entry.path)?;
            check_revision(&entry.revision)?;
        }
        Ok(())
    }
}
