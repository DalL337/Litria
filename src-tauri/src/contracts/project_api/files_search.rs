//! `litria_files_search` (Project API contract brief §7.3, §10).

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::files_read::{DocumentSource, MAX_PATH_LENGTH, MIN_PATH_LENGTH};
use crate::contracts::boundary::{invalid, schema_length, Validate};
use crate::contracts::catalog::Operation;
use crate::contracts::error::ContractError;

pub(crate) const MIN_QUERY_LENGTH: usize = 1;
pub(crate) const MAX_QUERY_LENGTH: usize = 256;
/// A query is matched within one line, so it can never contain a line break.
/// The schema says so with this pattern; the boundary checks the same rule.
#[cfg(test)]
const QUERY_PATTERN: &str = "^[^\\r\\n]*$";
pub(crate) const MIN_RESULTS: u32 = 1;
pub(crate) const MAX_RESULTS: u32 = 200;
pub(crate) const DEFAULT_RESULTS: u32 = 50;
/// A preview is the matching line clipped to this many characters.
pub(crate) const PREVIEW_LENGTH: usize = 200;

pub(crate) struct FilesSearchOp;

impl Operation for FilesSearchOp {
    const NAME: &'static str = "litria_files_search";
    const DESCRIPTION: &'static str = "Search project files for a literal string, in their text (target: text) or in \
         their project-relative paths (target: path). Searches what the editor holds for documents that are open or \
         unsaved, and the saved file otherwise. Matching is literal; case folding, when on, is ASCII only. Denied and \
         unindexed paths are never searched, links are not followed, and .gitignore is not honoured. Results are \
         ordered by path, then line; a search that stops early says why in truncatedBy.";
    const CAPABILITY: &'static str = "project.files.search";
    type Request = FilesSearchRequest;
    type Result = FilesSearchResult;
}

#[derive(Debug, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FilesSearchRequest {
    /// The literal text to find. No regular expressions; no line breaks.
    #[cfg_attr(test, schemars(length(min = MIN_QUERY_LENGTH, max = MAX_QUERY_LENGTH), pattern(QUERY_PATTERN)))]
    pub query: String,
    /// What to search. Defaults to file text.
    #[serde(default)]
    pub target: SearchTarget,
    /// Match case exactly. Defaults to false: ASCII letters then match either
    /// case; every other character always matches exactly.
    #[serde(default)]
    pub case_sensitive: bool,
    /// Search only this file or directory (project-relative, forward
    /// slashes). The result's `scope` says whether it could be searched.
    #[serde(default)]
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub path_prefix: Option<String>,
    /// At most this many matches; absent means the server default.
    #[serde(default)]
    #[cfg_attr(test, schemars(range(min = MIN_RESULTS, max = MAX_RESULTS)))]
    pub max_results: Option<u32>,
}

/// Inbound-only, but `Serialize` too so the schema shows the default.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum SearchTarget {
    /// File contents, line by line.
    #[default]
    Text,
    /// Project-relative file paths.
    Path,
}

impl Validate for FilesSearchRequest {
    fn validate(&self) -> Result<(), ContractError> {
        // Code points, as JSON Schema's minLength/maxLength count.
        let length = schema_length(&self.query);
        if !(MIN_QUERY_LENGTH..=MAX_QUERY_LENGTH).contains(&length) {
            return Err(invalid(format!(
                "query: expected {MIN_QUERY_LENGTH} to {MAX_QUERY_LENGTH} characters, got {length}"
            )));
        }
        if self.query.contains(['\r', '\n']) {
            return Err(invalid("query: a query cannot contain a line break"));
        }
        if let Some(prefix) = &self.path_prefix {
            let length = schema_length(prefix);
            if !(MIN_PATH_LENGTH..=MAX_PATH_LENGTH).contains(&length) {
                return Err(invalid(format!(
                    "pathPrefix: expected {MIN_PATH_LENGTH} to {MAX_PATH_LENGTH} characters, got {length}"
                )));
            }
        }
        if let Some(results) = self.max_results {
            if !(MIN_RESULTS..=MAX_RESULTS).contains(&results) {
                return Err(invalid(format!("maxResults: expected {MIN_RESULTS} to {MAX_RESULTS}")));
            }
        }
        Ok(())
    }
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct FilesSearchResult {
    /// What was searched: the whole project, or the requested prefix — or why
    /// the prefix could not be searched.
    pub scope: SearchScope,
    /// Ordered by path, then line, then column.
    pub matches: Vec<SearchMatch>,
    /// The search stopped before covering everything it should have; see
    /// `truncatedBy`. Narrow the search (a prefix, a longer query) to see more.
    pub truncated: bool,
    /// Every limit that ended or narrowed the search, in a fixed order.
    pub truncated_by: Vec<TruncationReason>,
    pub skipped: SkippedCounts,
    /// Files searched on disk.
    pub files_searched: u32,
    /// Documents searched in the editor's buffers.
    pub buffers_searched: u32,
}

/// Where the search ran. A reader that meets an unfamiliar value must not
/// assume the prefix was searched.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum SearchScope {
    /// No prefix: the whole project.
    Project,
    /// The prefix names a file or directory, on disk or in the editor.
    Prefix,
    /// The prefix is not a path the API accepts (contract brief §6).
    PrefixInvalid,
    /// The disclosure policy withholds the prefix. Existence is not revealed.
    PrefixDenied,
    /// The prefix is inside a directory search never enters (dependencies,
    /// build output).
    PrefixUnindexed,
    /// Nothing searchable has that name: no such file or directory, or a link
    /// (links are not followed).
    PrefixNotFound,
}

/// One match. A reader that meets an unfamiliar `kind` must skip that match.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum SearchMatch {
    /// The query occurs in a document's text.
    Text {
        path: String,
        /// 1-based.
        line: u32,
        /// 1-based, in Unicode code points.
        column: u32,
        /// The matching line without its line break, clipped to 200
        /// characters around the match.
        preview: String,
        source: DocumentSource,
        /// The revision of the text this match was found in. A later read
        /// that returns the same revision shows the same text.
        revision: String,
    },
    /// The query occurs in a document's project-relative path.
    Path {
        path: String,
        /// `editor` when the document exists only in the editor (unsaved).
        source: DocumentSource,
    },
}

/// A limit that ended or narrowed a search.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum TruncationReason {
    /// More matches exist than `maxResults` allowed.
    Results,
    /// The files-scanned limit was reached.
    FilesScanned,
    /// The time budget ran out.
    TimeBudget,
    /// Some of the editor's buffers could not be searched (`skipped.buffersNotSearched`
    /// counts the ones it knows of; the editor may also hold more buffers than it listed).
    BufferCoverage,
    /// The encoded response ceiling was reached.
    ResponseSize,
}

/// Files and buffers that were not searched, by reason. Denied paths are
/// never counted.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct SkippedCounts {
    /// Over the per-file scan limit.
    pub too_large: u32,
    /// Binary, or not valid UTF-8.
    pub not_text: u32,
    /// Present, but could not be read through the API.
    pub unreadable: u32,
    /// Directories whose entries could not be listed.
    pub unreadable_directories: u32,
    /// Buffers the editor listed that could not be searched.
    pub buffers_not_searched: u32,
}
