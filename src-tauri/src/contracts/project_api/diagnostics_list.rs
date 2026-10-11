//! `litria_diagnostics_list` (Project API contract brief §7.5, §10): detailed
//! diagnostics per file, with their producer, an honest freshness, and an
//! explicit `unavailable` state — which is not the same as "no errors".

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::files_read::{MAX_PATH_LENGTH, MIN_PATH_LENGTH};
use crate::contracts::boundary::{invalid, schema_length, Validate};
use crate::contracts::catalog::Operation;
use crate::contracts::error::ContractError;

/// Files named in one request.
pub(crate) const MAX_PATHS: usize = 100;
/// Owner ruling 2026-10-11: diagnostics returned per file, per response, and
/// the characters kept of each message.
pub(crate) const MAX_DIAGNOSTICS_PER_FILE: u32 = 100;
pub(crate) const MAX_DIAGNOSTICS_PER_RESPONSE: u32 = 1_000;
pub(crate) const MAX_MESSAGE_CHARS: u32 = 1_000;
/// Related locations kept per diagnostic (after removing denied ones).
pub(crate) const MAX_RELATED_PER_DIAGNOSTIC: u32 = 16;

pub(crate) struct DiagnosticsListOp;

impl Operation for DiagnosticsListOp {
    const NAME: &'static str = "litria_diagnostics_list";
    const DESCRIPTION: &'static str = "Return the diagnostics language servers have reported, per file: for the \
         given project-relative paths, or for every file with diagnostics at or above minSeverity. Each file is \
         available (with its producer, its diagnostics and a freshness of current, stale or unknown, with a \
         reason), unavailable (the producer is not bridged, not running, or has not analysed the file), or \
         noProducer. Unavailable is not the same as no errors. Denied files are never reported, and denied or \
         out-of-project references inside a message are replaced with [denied] or [path]. Lines and columns are \
         1-based. A response that reaches a ceiling says so in truncatedBy.";
    const CAPABILITY: &'static str = "project.diagnostics.read";
    type Request = DiagnosticsListRequest;
    type Result = DiagnosticsListResult;
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DiagnosticsListRequest {
    /// Files to report on (project-relative, forward slashes). Absent means
    /// every file that has diagnostics at or above `minSeverity`.
    #[serde(default)]
    #[cfg_attr(
        test,
        schemars(length(min = 1, max = MAX_PATHS), inner(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))
    )]
    pub paths: Option<Vec<String>>,
    /// The least severe diagnostics to include. Defaults to `hint` (all).
    #[serde(default)]
    pub min_severity: Severity,
}

impl Validate for DiagnosticsListRequest {
    fn validate(&self) -> Result<(), ContractError> {
        if let Some(paths) = &self.paths {
            if !(1..=MAX_PATHS).contains(&paths.len()) {
                return Err(invalid(format!("paths: expected 1 to {MAX_PATHS} entries")));
            }
            for path in paths {
                let length = schema_length(path);
                if !(MIN_PATH_LENGTH..=MAX_PATH_LENGTH).contains(&length) {
                    return Err(invalid(format!(
                        "paths: each {MIN_PATH_LENGTH} to {MAX_PATH_LENGTH} characters, got {length}"
                    )));
                }
            }
        }
        Ok(())
    }
}

/// LSP severities, most severe first.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum Severity {
    Error,
    Warning,
    Information,
    #[default]
    Hint,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticsListResult {
    /// Requested paths in request order; otherwise files in path order.
    pub files: Vec<FileDiagnostics>,
    /// The response stopped before covering everything; see `truncatedBy`.
    pub truncated: bool,
    pub truncated_by: Vec<TruncationReason>,
}

/// One file's answer. A reader that meets an unfamiliar `state` must not
/// assume the file has no errors.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "state", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum FileDiagnostics {
    /// The producer has reported on this file. An empty list means it found
    /// nothing at or above `minSeverity`, as fresh as `freshness` says.
    Available {
        path: String,
        /// The language server that reported (for example
        /// `typescript-language-server`).
        producer: String,
        freshness: Freshness,
        /// Why the freshness is not `current`.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        freshness_reason: Option<FreshnessReason>,
        diagnostics: Vec<Diagnostic>,
        /// The list is not complete: more diagnostics exist than were
        /// returned for this file, or some were shortened (see `truncatedBy`).
        truncated: bool,
    },
    /// A producer exists for this kind of file, but no diagnostics can be
    /// reported. Not the same as no errors.
    Unavailable { path: String, reason: UnavailableReason },
    /// Nothing produces diagnostics for this kind of file.
    NoProducer { path: String },
    /// The disclosure policy withholds the path (only when asked for by name;
    /// otherwise it is omitted). Existence is not revealed.
    Denied { path: String },
    /// Not a path the API accepts (contract brief §6).
    InvalidPath { path: String },
    /// Not reported: the response ceiling was reached first. Ask again.
    Skipped { path: String },
}

/// A reader that meets an unfamiliar value must not treat the file as current.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum Freshness {
    /// The producer diagnosed the version Litria last sent, in this opening of
    /// the document, in its current session.
    Current,
    /// The producer diagnosed an older version or an earlier opening.
    Stale,
    /// Freshness cannot be proven; see `freshnessReason`.
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum FreshnessReason {
    /// Stale: an older version than the one last sent.
    OlderVersion,
    /// Stale: reported during an earlier opening of the document.
    Reopened,
    /// Unknown: the producer reports no document version.
    ProducerOmitsVersion,
    /// Unknown: the file is not open in Litria; the producer diagnosed it from disk.
    ClosedFile,
    /// Unknown: the producer reported a version newer than any Litria sent.
    VersionAhead,
    /// Unknown: no version was recorded for this opening.
    NoSentVersion,
    /// Unknown: an earlier opening of the document used the same version, so
    /// which opening the producer diagnosed cannot be told apart.
    ReusedVersion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum UnavailableReason {
    /// The editor produces this file's diagnostics itself (JSON, CSS); they
    /// are not bridged to the Project API.
    NotBridged,
    /// The language server for this file is not running.
    ProducerNotRunning,
    /// The language server is running but has not reported on this file (most
    /// servers only analyse files open in the editor).
    NotAnalyzed,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct Diagnostic {
    pub severity: Severity,
    /// At most 1,000 characters; denied and out-of-project paths replaced.
    pub message: String,
    pub range: DiagnosticRange,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    pub producer: String,
    /// Locations the producer relates to this diagnostic, inside the project
    /// and not denied.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub related: Vec<RelatedLocation>,
}

/// Lines and columns are 1-based (brief §5). Columns count the producer's
/// UTF-16 code units: they equal Unicode code points unless a character
/// outside the Basic Multilingual Plane (an emoji, for example) precedes the
/// position on its line. The producer's positions describe the text it
/// diagnosed; see `freshness`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiagnosticRange {
    pub start_line: u32,
    pub start_column: u32,
    pub end_line: u32,
    pub end_column: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct RelatedLocation {
    pub path: String,
    pub range: DiagnosticRange,
    pub message: String,
}

/// Why the response is not complete.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum TruncationReason {
    /// A file has more diagnostics than it lists: over 100, or more than the
    /// store could keep or read (that file says `truncated`).
    PerFile,
    /// The 1,000-diagnostic response ceiling was reached.
    Diagnostics,
    /// The encoded response ceiling was reached.
    ResponseSize,
    /// The store dropped some files' diagnostics to stay within its bounds, so
    /// a file missing from the list, or `notAnalyzed`, may have had some.
    StoreEvicted,
    /// A diagnostic's message, code or related locations were shortened (that
    /// file says `truncated`).
    Details,
}
