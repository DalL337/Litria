//! `litria_operations_get` (Project API build plan W4a; Project API proposal
//! R5): where an operation stands and what each of its changes did, read
//! without applying anything. An operation is an applied plan; its id is the
//! plan id. Receipts are durable: they survive a restart of Litria and are
//! kept 30 days (owner ruling, 2026-10-11). An operation a restart
//! interrupted is reported as such, and one whose outcome Litria cannot know
//! is `needsReview`: it is never replayed.

#[cfg(test)]
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::contracts::boundary::{invalid, schema_length, Validate};
use crate::contracts::catalog::Operation;
use crate::contracts::error::ContractError;
use crate::contracts::project_api::changes_apply::{ChangeOutcome, Effect, MAX_PLAN_ID_LENGTH};
use crate::contracts::project_api::changes_prepare::PlanState;

pub(crate) struct OperationsGetOp;

impl Operation for OperationsGetOp {
    const NAME: &'static str = "litria_operations_get";
    const DESCRIPTION: &'static str = "Where an operation stands, and what each of its changes did, without \
         applying anything: safe after a lost response or a restart. The operation id is the plan id from \
         litria_changes_prepare. Receipts are kept 30 days. An operation that a restart of Litria interrupted says \
         so (interrupted), and its unsaved editor edits did not survive it; one whose outcome cannot be known is \
         needsReview and is never retried.";
    const CAPABILITY: &'static str = "project.operations.read";
    const READ_ONLY: bool = true;
    type Request = OperationsGetRequest;
    type Result = OperationsGetResult;
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OperationsGetRequest {
    /// The plan id `litria_changes_prepare` returned.
    #[cfg_attr(test, schemars(length(min = 1, max = MAX_PLAN_ID_LENGTH)))]
    pub operation_id: String,
}

impl Validate for OperationsGetRequest {
    fn validate(&self) -> Result<(), ContractError> {
        if !(1..=MAX_PLAN_ID_LENGTH).contains(&schema_length(&self.operation_id)) {
            return Err(invalid(format!("operationId: 1 to {MAX_PLAN_ID_LENGTH} characters")));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(test, derive(JsonSchema))]
#[serde(rename_all = "camelCase")]
pub(crate) struct OperationsGetResult {
    pub operation_id: String,
    /// `unknown` for an id that is not this requester's, or is older than the
    /// retention period.
    pub state: PlanState,
    /// Where the changes that landed went: `buffer` (edits, in the editor,
    /// unsaved), then `disk` (new files).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub effects: Vec<Effect>,
    /// Per change, as far as Litria knows. A change whose outcome is unknown is
    /// left out, and the operation is then `needsReview`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<ChangeOutcome>,
    /// A restart of Litria interrupted the operation while it was being
    /// applied. Its unsaved editor edits did not survive the restart; new files
    /// it created may be on disk.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub interrupted: bool,
}
