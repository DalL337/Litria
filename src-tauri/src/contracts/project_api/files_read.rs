//! `litria_files_read` (Project API contract brief §5, §7.2).

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::contracts::boundary::{invalid, schema_length, Validate};
use crate::contracts::catalog::Operation;
use crate::contracts::error::ContractError;

pub(crate) const MIN_DOCUMENTS: usize = 1;
pub(crate) const MAX_DOCUMENTS: usize = 20;
pub(crate) const MIN_PATH_LENGTH: usize = 1;
pub(crate) const MAX_PATH_LENGTH: usize = 1024;
/// Generous for any file under the hard cap; explicit so the schema bounds
/// line numbers and keeps every integer well below 2^53.
pub(crate) const MAX_LINE_NUMBER: u32 = 16_777_216;
pub(crate) const MIN_BYTES_PER_DOCUMENT: u32 = 1;
/// Ceiling on the per-document text budget a caller may ask for.
pub(crate) const MAX_BYTES_PER_DOCUMENT: u32 = 256 * 1024;
/// The budget when the caller does not ask for one.
pub(crate) const DEFAULT_BYTES_PER_DOCUMENT: u32 = 64 * 1024;

pub(crate) struct FilesReadOp;

impl Operation for FilesReadOp {
    const NAME: &'static str = "litria_files_read";
    const DESCRIPTION: &'static str = "Read project documents by project-relative path, optionally by line range. \
         Returns the editor's buffer when the document is open or unsaved, otherwise the saved file \
         (source: effective), or the saved file only (source: disk). Every document reports its source, \
         dirty state and revision.";
    const CAPABILITY: &'static str = "project.files.read";
    type Request = FilesReadRequest;
    type Result = FilesReadResult;
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FilesReadRequest {
    /// The documents to read, answered in this order.
    #[cfg_attr(test, schemars(length(min = MIN_DOCUMENTS, max = MAX_DOCUMENTS)))]
    pub documents: Vec<DocumentRequest>,
    /// Which text to return. Defaults to the effective text.
    #[serde(default)]
    pub source: ReadSource,
    /// Text budget per document, in UTF-8 bytes; absent means the server
    /// default. The server may return less when the response budget runs out.
    #[serde(default)]
    #[cfg_attr(test, schemars(range(min = MIN_BYTES_PER_DOCUMENT, max = MAX_BYTES_PER_DOCUMENT)))]
    pub max_bytes_per_document: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DocumentRequest {
    /// Project-relative path with forward slashes. A path the API cannot
    /// accept is answered as `invalidPath`, not as a request error.
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub path: String,
    /// First line to return, 1-based. Defaults to 1.
    #[serde(default)]
    #[cfg_attr(test, schemars(range(min = 1, max = MAX_LINE_NUMBER)))]
    pub start_line: Option<u32>,
    /// Last line to return, inclusive. Defaults to the end of the document.
    /// An end before the start returns no lines.
    #[serde(default)]
    #[cfg_attr(test, schemars(range(min = 1, max = MAX_LINE_NUMBER)))]
    pub end_line: Option<u32>,
}

/// Inbound-only, but `Serialize` too: schemars emits a field's `default` only
/// when it can serialize the default value, and callers should see it.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum ReadSource {
    /// The editor's buffer when the document is open or unsaved, otherwise
    /// the saved file.
    #[default]
    Effective,
    /// The saved file, even when the editor holds unsaved changes.
    Disk,
}

impl Validate for FilesReadRequest {
    fn validate(&self) -> Result<(), ContractError> {
        let count = self.documents.len();
        if !(MIN_DOCUMENTS..=MAX_DOCUMENTS).contains(&count) {
            return Err(invalid(format!(
                "documents: expected {MIN_DOCUMENTS} to {MAX_DOCUMENTS} entries, got {count}"
            )));
        }
        for document in &self.documents {
            // Code points, as JSON Schema's maxLength counts — never bytes.
            let length = schema_length(&document.path);
            if !(MIN_PATH_LENGTH..=MAX_PATH_LENGTH).contains(&length) {
                return Err(invalid(format!(
                    "path: each must be {MIN_PATH_LENGTH} to {MAX_PATH_LENGTH} characters, got {length}"
                )));
            }
            for (field, line) in [("startLine", document.start_line), ("endLine", document.end_line)] {
                if let Some(line) = line {
                    if !(1..=MAX_LINE_NUMBER).contains(&line) {
                        return Err(invalid(format!("{field}: expected 1 to {MAX_LINE_NUMBER}")));
                    }
                }
            }
        }
        if let Some(bytes) = self.max_bytes_per_document {
            if !(MIN_BYTES_PER_DOCUMENT..=MAX_BYTES_PER_DOCUMENT).contains(&bytes) {
                return Err(invalid(format!(
                    "maxBytesPerDocument: expected {MIN_BYTES_PER_DOCUMENT} to {MAX_BYTES_PER_DOCUMENT}"
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilesReadResult {
    /// One outcome per requested document, in request order.
    pub documents: Vec<DocumentOutcome>,
}

/// Per-document outcome. A reader that meets an unfamiliar `kind` must treat
/// that document as unknown, never as one of these.
#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum DocumentOutcome {
    Read {
        path: String,
        source: DocumentSource,
        /// Whether the editor holds unsaved changes. Always false for disk.
        dirty: bool,
        /// Opaque revision of the whole document as observed. Compare for
        /// equality only; editor and disk revisions are never comparable.
        revision: String,
        text: String,
        /// The lines returned; omitted when no line was returned.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        range: Option<LineRange>,
        total_lines: u32,
        /// Fewer lines were returned than requested; continue from the line
        /// after `range.endLine`.
        truncated: bool,
        /// The only returned line was cut at a character boundary because it
        /// alone exceeds the budget. Defaulted when read, always written.
        #[serde(default)]
        line_cut: bool,
    },
    NotFound {
        path: String,
    },
    /// The disclosure policy withholds this path. Existence is not revealed.
    Denied {
        path: String,
    },
    /// A directory or another non-regular file.
    NotFile {
        path: String,
    },
    /// Binary or not valid UTF-8.
    NotText {
        path: String,
    },
    TooLarge {
        path: String,
        limit_bytes: u32,
    },
    /// A path the API does not accept (brief §6).
    InvalidPath {
        path: String,
    },
    /// The file exists but could not be read (for example, locked).
    Unreadable {
        path: String,
    },
    /// The response budget ran out before this document.
    Skipped {
        path: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum DocumentSource {
    Editor,
    Disk,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct LineRange {
    pub start_line: u32,
    pub end_line: u32,
}
