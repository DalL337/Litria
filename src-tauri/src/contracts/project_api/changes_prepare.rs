//! `litria_changes_prepare` (Project API build plan W2a, W3b; contract brief
//! §13): propose exact-text edits to documents the editor holds, and new files.
//! Nothing is applied here. Every edit is checked against the current editor
//! text and every new file's name against the disk; when all are ready they
//! become one plan, which `litria_changes_apply` applies (W2b). The agent's own
//! approval is enough: its client already asked the person (owner ruling,
//! 2026-10-11). Litria's own review is off unless enabled.

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::contracts::boundary::{invalid, schema_length, Validate};
use crate::contracts::catalog::Operation;
use crate::contracts::error::ContractError;
use crate::contracts::project_api::files_read::{MAX_PATH_LENGTH, MIN_PATH_LENGTH};
use crate::contracts::project_api_bridge::editor::MAX_REVISION_LENGTH;

pub(crate) const MAX_CHANGES: usize = 16;
pub(crate) const MAX_EDITS_PER_CHANGE: usize = 64;
/// Characters in one `oldText` or `newText`. The 64 KiB request budget binds
/// first; the bound keeps every string bounded in the schema too.
pub(crate) const MAX_EDIT_TEXT_LENGTH: usize = 65_536;
/// Characters in a created file's `text`; the request budget binds first here
/// too (build plan W3b).
pub(crate) const MAX_CREATE_TEXT_LENGTH: usize = 65_536;
/// Largest file an edit opens from disk into the editor (build plan W3c).
pub(crate) const MAX_OPEN_FILE_BYTES: usize = 1024 * 1024;
/// An unanswered plan expires this long after preparation (owner ruling,
/// 2026-10-11).
pub(crate) const PLAN_TTL_SECONDS: u32 = 600;
/// A plan id: `plan-` and 32 hex digits.
pub(crate) const PLAN_ID_LENGTH: usize = 37;

pub(crate) struct ChangesPrepareOp;

impl Operation for ChangesPrepareOp {
    const NAME: &'static str = "litria_changes_prepare";
    const DESCRIPTION: &'static str = "Propose changes; nothing is applied yet. A text.edit changes a document: each \
         edit replaces oldText, which must occur exactly once in the document, with newText, and expectedRevision is \
         the revision litria_files_read reported. A document the editor does not hold is opened into it with the \
         edit, unsaved, beside the open tabs; nothing is written to disk until the user saves. A file.create makes a \
         new file holding text, only if nothing has its name (never an overwrite), and shows it on the canvas. When \
         every change is ready they become one plan: apply it with litria_changes_apply. A plan that is not applied \
         expires after ten minutes.";
    const CAPABILITY: &'static str = "project.changes.propose";
    const READ_ONLY: bool = false;
    type Request = ChangesPrepareRequest;
    type Result = ChangesPrepareResult;
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChangesPrepareRequest {
    /// One change per document, each document at most once. Checked in this
    /// order and answered in it.
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_CHANGES)))]
    pub changes: Vec<ProposedChange>,
}

/// One proposed change, by `kind`. Paths are project-relative with forward
/// slashes; a path the API cannot accept is answered as `invalidPath`, not as
/// a request error.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "kind", rename_all_fields = "camelCase", deny_unknown_fields)]
pub(crate) enum ProposedChange {
    /// Exact-text replacement in the editor's copy of a document (its buffer;
    /// not saved to disk). A document the editor does not hold is opened into
    /// it from disk, with the edit (build plan W3c).
    #[serde(rename = "text.edit")]
    TextEdit {
        #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
        path: String,
        /// The revision `litria_files_read` reported for this document. The
        /// change is ready only while the editor still holds exactly that text.
        #[cfg_attr(test, schemars(length(min = 1, max = MAX_REVISION_LENGTH)))]
        expected_revision: String,
        /// Applied in order; each `oldText` must occur exactly once in the text
        /// as the earlier edits leave it.
        #[cfg_attr(test, schemars(length(min = 1, max = MAX_EDITS_PER_CHANGE)))]
        edits: Vec<TextEdit>,
    },
    /// A new file on disk holding `text`, created only if nothing has its name
    /// (never an overwrite), and shown on the canvas. Missing folders are
    /// created.
    #[serde(rename = "file.create")]
    FileCreate {
        #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
        path: String,
        /// The whole file; may be empty.
        #[cfg_attr(test, schemars(length(max = MAX_CREATE_TEXT_LENGTH)))]
        text: String,
    },
}

impl ProposedChange {
    pub(crate) fn path(&self) -> &str {
        match self {
            ProposedChange::TextEdit { path, .. } | ProposedChange::FileCreate { path, .. } => path,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TextEdit {
    /// Text that must occur exactly once (overlapping occurrences count).
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_EDIT_TEXT_LENGTH)))]
    pub old_text: String,
    /// Its replacement; may be empty.
    #[cfg_attr(test, schemars(length(max = MAX_EDIT_TEXT_LENGTH)))]
    pub new_text: String,
}

impl Validate for ChangesPrepareRequest {
    fn validate(&self) -> Result<(), ContractError> {
        let count = self.changes.len();
        if !(1..=MAX_CHANGES).contains(&count) {
            return Err(invalid(format!("changes: expected 1 to {MAX_CHANGES} entries, got {count}")));
        }
        for (index, change) in self.changes.iter().enumerate() {
            let length = schema_length(change.path());
            if !(MIN_PATH_LENGTH..=MAX_PATH_LENGTH).contains(&length) {
                return Err(invalid(format!(
                    "path: each must be {MIN_PATH_LENGTH} to {MAX_PATH_LENGTH} characters, got {length}"
                )));
            }
            match change {
                ProposedChange::TextEdit { expected_revision, edits, .. } => {
                    if !(1..=MAX_REVISION_LENGTH).contains(&schema_length(expected_revision)) {
                        return Err(invalid(format!("expectedRevision: 1 to {MAX_REVISION_LENGTH} characters")));
                    }
                    let count = edits.len();
                    if !(1..=MAX_EDITS_PER_CHANGE).contains(&count) {
                        return Err(invalid(format!(
                            "edits: expected 1 to {MAX_EDITS_PER_CHANGE} entries, got {count}"
                        )));
                    }
                    for edit in edits {
                        if !(1..=MAX_EDIT_TEXT_LENGTH).contains(&schema_length(&edit.old_text)) {
                            return Err(invalid(format!("oldText: 1 to {MAX_EDIT_TEXT_LENGTH} characters")));
                        }
                        if schema_length(&edit.new_text) > MAX_EDIT_TEXT_LENGTH {
                            return Err(invalid(format!("newText: at most {MAX_EDIT_TEXT_LENGTH} characters")));
                        }
                    }
                }
                ProposedChange::FileCreate { text, .. } => {
                    if schema_length(text) > MAX_CREATE_TEXT_LENGTH {
                        return Err(invalid(format!("text: at most {MAX_CREATE_TEXT_LENGTH} characters")));
                    }
                }
            }
            // The message names the position, never the caller's path.
            if self.changes[..index].iter().any(|earlier| earlier.path() == change.path()) {
                return Err(invalid(format!("changes: entry {index} names a document an earlier entry names")));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangesPrepareResult {
    /// The plan awaiting review: present only when every change is ready.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<PreparedPlan>,
    /// One check per proposed change, in request order.
    pub changes: Vec<ChangeCheck>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct PreparedPlan {
    /// Opaque; pass it to `litria_changes_apply`.
    #[cfg_attr(test, schemars(length(min = PLAN_ID_LENGTH, max = PLAN_ID_LENGTH)))]
    pub plan_id: String,
    pub state: PlanState,
    /// Seconds until the plan expires if it is not applied.
    #[cfg_attr(test, schemars(range(max = PLAN_TTL_SECONDS)))]
    pub expires_in_seconds: u32,
}

/// Where a plan stands. A reader that meets an unfamiliar value must not
/// assume the plan was applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlanState {
    /// Ready: `litria_changes_apply` applies it.
    Prepared,
    /// Waiting for a person to approve or reject it. Only when Litria is set
    /// to review agent edits itself (off by default).
    PendingReview,
    /// Approved, and being applied now.
    Applying,
    /// Every change landed: edits in the editor (unsaved), new files on disk.
    Applied,
    /// Some changes landed and some did not; each change's outcome says which.
    /// Never retried: propose the rest again.
    Partial,
    /// A person rejected it. Nothing was applied.
    Rejected,
    /// Nobody answered within ten minutes. Nothing was applied.
    Expired,
    /// A document changed after the plan was prepared, so nothing was applied.
    /// Propose again against the current text.
    Conflict,
    /// Applying could not reach the editor. Nothing was applied.
    Failed,
    /// Applying reached the editor but its outcome is unknown (it did not
    /// answer in time). Check the documents; the plan is never retried.
    NeedsReview,
    /// Not a plan of this connection and workspace, or one long expired.
    Unknown,
}

/// One proposed change, checked against the editor's current text. A reader
/// that meets an unfamiliar `outcome` must treat the change as not ready.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum ChangeCheck {
    /// The editor holds the expected revision and every edit matches once.
    Ready { path: String },
    /// The editor holds another revision of this document now.
    Conflict { path: String, revision: String },
    /// The edit at this index matches nowhere in the text as it stands.
    NoMatch { path: String, edit: u32 },
    /// The edit at this index matches more than once.
    Ambiguous { path: String, edit: u32 },
    /// Neither the editor nor the disk has this document.
    NotInSession { path: String },
    /// The document is not one Litria opens as text: binary, not a regular
    /// file, unreadable, or over 1 MiB.
    NotEditable { path: String },
    /// A new file's name is taken on disk (by a file, a folder or a link): a
    /// create never replaces anything. Choose another name, or edit the file.
    Exists { path: String },
    /// The disclosure policy withholds the path; it is never written.
    Denied { path: String },
    /// Not a path the API accepts (contract brief §6).
    InvalidPath { path: String },
}

impl ChangeCheck {
    pub(crate) fn is_ready(&self) -> bool {
        matches!(self, ChangeCheck::Ready { .. })
    }
}
