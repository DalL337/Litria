//! `litria_changes_apply` (Project API build plan W2b, W3b; contract brief
//! §13): apply a prepared plan. The agent's own approval is enough — its
//! client already asked the person (owner ruling, 2026-10-11) — so this call
//! applies the plan unless Litria is set to review agent edits itself (off by
//! default), when it answers `pendingReview` until a person decides.
//!
//! A plan's edits apply all or none, to the editor. Its new files are created
//! after them, each only if nothing has its name: a disk change and a buffer
//! change never happen together, so a plan can end `partial` (agent brief),
//! and every change reports its own outcome. Asking again is safe: a plan is
//! applied at most once.

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::contracts::boundary::{invalid, schema_length, Validate};
use crate::contracts::catalog::Operation;
use crate::contracts::error::ContractError;
use crate::contracts::project_api::changes_prepare::PlanState;

/// Longest plan id accepted. Ids Litria mints are shorter; any other string
/// of this length is answered `unknown`, never as a request error.
pub(crate) const MAX_PLAN_ID_LENGTH: usize = 128;

pub(crate) struct ChangesApplyOp;

impl Operation for ChangesApplyOp {
    const NAME: &'static str = "litria_changes_apply";
    const DESCRIPTION: &'static str = "Apply a plan from litria_changes_prepare. Its text edits apply all or none: \
         every document must still be the revision it was proposed against, otherwise nothing is applied (state \
         conflict; propose again). Applied edits are in the editor, unsaved (effect buffer), each with its new \
         revision; a document that was not open is opened beside the open tabs. New files are created after the edits, each only if nothing has its name (effect disk; outcome \
         created with the file's revision, or exists); if only some changes land the state is partial and each \
         change says what happened. A plan is applied at most once; asking again returns the same outcome. If \
         Litria is set to have a person review agent edits, the plan waits for that decision (state \
         pendingReview); ask again later.";
    const CAPABILITY: &'static str = "project.changes.apply";
    const READ_ONLY: bool = false;
    type Request = ChangesApplyRequest;
    type Result = ChangesApplyResult;
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChangesApplyRequest {
    /// The plan id `litria_changes_prepare` returned.
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_PLAN_ID_LENGTH)))]
    pub plan_id: String,
}

impl Validate for ChangesApplyRequest {
    fn validate(&self) -> Result<(), ContractError> {
        if !(1..=MAX_PLAN_ID_LENGTH).contains(&schema_length(&self.plan_id)) {
            return Err(invalid(format!("planId: 1 to {MAX_PLAN_ID_LENGTH} characters")));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangesApplyResult {
    pub plan_id: String,
    pub state: PlanState,
    /// Where the changes that landed went, once any did: `buffer` (edits, in
    /// the editor, unsaved), then `disk` (new files).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    /// Per change, once the plan ran: what each one did or found.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<ChangeOutcome>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum Effect {
    /// Edits applied to the editor's copy of documents; not saved to disk.
    Buffer,
    /// New files created on disk.
    Disk,
}

/// One change of a plan that ran. A reader that meets an unfamiliar
/// `outcome` must not assume anything changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum ChangeOutcome {
    /// Changed in the editor, unsaved; the document's revision now. A document
    /// that was not open was opened beside the open tabs.
    Applied { path: String, revision: String },
    /// Would have applied, but another document of the plan did not: nothing
    /// was applied.
    Ready { path: String },
    /// The editor holds another revision now.
    Conflict { path: String, revision: String },
    /// The edit at this index matches nowhere any more.
    NoMatch { path: String, edit: u32 },
    /// The edit at this index matches more than once now.
    Ambiguous { path: String, edit: u32 },
    /// Neither the editor nor the disk has the document now.
    NotInSession { path: String },
    /// The document could not be opened into the editor (its canvas piece could
    /// not be made). Nothing was applied.
    Unavailable { path: String },
    /// The new file was created on disk; its revision as created.
    Created { path: String, revision: String },
    /// Not created: something has the new file's name now, on disk or open in
    /// the editor. Nothing was replaced.
    Exists { path: String },
    /// Not created: the file could not be written, or the workspace changed
    /// while creating.
    Failed { path: String },
    /// Not created: the path is withheld now (it passes through a link that
    /// appeared since the proposal). Nothing was written.
    Denied { path: String },
}
