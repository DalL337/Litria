//! `litria_changes_apply` (Project API build plan W2b; contract brief §13):
//! apply a prepared plan, all or none. The agent's own approval is enough —
//! its client already asked the person (owner ruling, 2026-10-11) — so this
//! call applies the plan unless Litria is set to review agent edits itself
//! (off by default), when it answers `pendingReview` until a person decides.
//! It reports where the plan stands and, once applied, each document's new
//! revision. Asking again is safe: a plan is applied at most once.

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
    const DESCRIPTION: &'static str = "Apply a plan from litria_changes_prepare, all or none: every document must \
         still be the revision it was proposed against, otherwise nothing is applied (state conflict; propose \
         again). Applied changes are in the editor, unsaved (effect: buffer), each with its new revision. A plan \
         is applied at most once; asking again returns the same outcome. If Litria is set to have a person review \
         agent edits, the plan waits for that decision (state pendingReview); ask again later.";
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
    /// Where an applied plan's changes went: the editor's copy, not saved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<Effect>,
    /// Per document, once applied (each new revision) or in conflict (what
    /// each document no longer matched).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<ChangeOutcome>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) enum Effect {
    /// Applied to the editor's copy of each document; not saved to disk.
    Buffer,
}

/// One document of a plan that was applied or found in conflict. A reader
/// that meets an unfamiliar `outcome` must not assume the document changed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(tag = "outcome", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub(crate) enum ChangeOutcome {
    /// Changed; the document's revision now.
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
    /// The editor no longer holds the document.
    NotInSession { path: String },
}
