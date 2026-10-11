//! `litria_changes_prepare` (Project API build plan W2a; contract brief §13):
//! propose exact-text edits to documents the editor holds. Nothing is applied
//! here. Every change is checked against the current editor text; when all
//! are ready they become one plan that waits for a person's review, and a
//! plan applies only after approval (W2b).

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
/// An unanswered plan expires this long after preparation (owner ruling,
/// 2026-10-11).
pub(crate) const PLAN_TTL_SECONDS: u32 = 600;
/// A plan id: `plan-` and 32 hex digits.
pub(crate) const PLAN_ID_LENGTH: usize = 37;

pub(crate) struct ChangesPrepareOp;

impl Operation for ChangesPrepareOp {
    const NAME: &'static str = "litria_changes_prepare";
    const DESCRIPTION: &'static str = "Propose exact-text edits to documents the editor holds; nothing is applied. \
         Each edit replaces oldText, which must occur exactly once in the document, with newText; expectedRevision \
         is the revision litria_files_read reported. When every change is ready they become one plan that waits \
         for a person to review it: an approved plan is applied to the editor (unsaved), and an unanswered one \
         expires after ten minutes. Ask litria_changes_apply for its outcome.";
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

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProposedChange {
    pub kind: ChangeKind,
    /// Project-relative path with forward slashes. A path the API cannot
    /// accept is answered as `invalidPath`, not as a request error.
    #[cfg_attr(test, schemars(length(min = MIN_PATH_LENGTH, max = MAX_PATH_LENGTH)))]
    pub path: String,
    /// The revision `litria_files_read` reported for this document. The change
    /// is ready only while the editor still holds exactly that text.
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_REVISION_LENGTH)))]
    pub expected_revision: String,
    /// Applied in order; each `oldText` must occur exactly once in the text as
    /// the earlier edits leave it.
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_EDITS_PER_CHANGE)))]
    pub edits: Vec<TextEdit>,
}

/// The kind of change. Only `text.edit` exists; file creation joins later.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
pub(crate) enum ChangeKind {
    /// Exact-text replacement in the editor's copy of a document (its buffer;
    /// not saved to disk).
    #[serde(rename = "text.edit")]
    TextEdit,
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
            let length = schema_length(&change.path);
            if !(MIN_PATH_LENGTH..=MAX_PATH_LENGTH).contains(&length) {
                return Err(invalid(format!(
                    "path: each must be {MIN_PATH_LENGTH} to {MAX_PATH_LENGTH} characters, got {length}"
                )));
            }
            if !(1..=MAX_REVISION_LENGTH).contains(&schema_length(&change.expected_revision)) {
                return Err(invalid(format!("expectedRevision: 1 to {MAX_REVISION_LENGTH} characters")));
            }
            let edits = change.edits.len();
            if !(1..=MAX_EDITS_PER_CHANGE).contains(&edits) {
                return Err(invalid(format!(
                    "edits: expected 1 to {MAX_EDITS_PER_CHANGE} entries, got {edits}"
                )));
            }
            for edit in &change.edits {
                if !(1..=MAX_EDIT_TEXT_LENGTH).contains(&schema_length(&edit.old_text)) {
                    return Err(invalid(format!("oldText: 1 to {MAX_EDIT_TEXT_LENGTH} characters")));
                }
                if schema_length(&edit.new_text) > MAX_EDIT_TEXT_LENGTH {
                    return Err(invalid(format!("newText: at most {MAX_EDIT_TEXT_LENGTH} characters")));
                }
            }
            // The message names the position, never the caller's path.
            if self.changes[..index].iter().any(|earlier| earlier.path == change.path) {
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
    /// Seconds until an unanswered plan expires.
    #[cfg_attr(test, schemars(range(max = PLAN_TTL_SECONDS)))]
    pub expires_in_seconds: u32,
}

/// Where a plan stands. A reader that meets an unfamiliar value must not
/// assume the plan was applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum PlanState {
    /// Waiting for a person to approve or reject it.
    PendingReview,
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
    /// The editor does not hold this document; open it first (disk edits come
    /// later).
    NotInSession { path: String },
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
