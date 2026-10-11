//! Agent-proposed changes (Project API build plan W2; contract brief §13).
//! W2a: proposing — `litria_changes_prepare`.
//!
//! A proposal is checked against the editor's latest text (the bridge's
//! `editor.checkChanges`, W1's planning). Only when every change is ready does
//! it become a plan: immutable (its canonical changes and their hash), bound
//! to the requester and the workspace epoch, waiting for a person's review,
//! and expiring ten minutes after preparation (owner rulings, 2026-10-11).
//! Plans live in memory (durable operations are W4).
//!
//! Review and application are W2b: no code path here changes a document.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rand::Rng;
use sha2::{Digest, Sha256};

use super::bridge::{self, Bridge};
use super::reader::{identity, Identity};
use super::workspace;
use crate::contracts::boundary::invalid;
use crate::contracts::context::{CallContext, Principal};
use crate::contracts::error::{ContractError, ErrorCode};
use crate::contracts::project_api::changes_prepare::{
    ChangeCheck, ChangesPrepareRequest, ChangesPrepareResult, PlanState, PreparedPlan, PLAN_ID_LENGTH, PLAN_TTL_SECONDS,
};
use crate::contracts::project_api_bridge::editor::{
    ChangeToCheck, CheckChangesOp, CheckChangesRequest, CheckedChange, EditToCheck,
};
use crate::db;

/// Plans one requester may have awaiting review at once. More are refused,
/// never made room for by expiring older ones early.
pub(crate) const MAX_PENDING_PER_PRINCIPAL: usize = 16;
const PLAN_TTL: Duration = Duration::from_secs(PLAN_TTL_SECONDS as u64);
/// How long an expired plan is remembered, so it can still be answered as
/// expired (W2b) before it is forgotten.
const EXPIRED_RETENTION: Duration = Duration::from_secs(60 * 60);

pub(crate) fn handle(context: &CallContext, request: ChangesPrepareRequest) -> Result<ChangesPrepareResult, ContractError> {
    handle_with(context, request, bridge::global(), plans(), Instant::now(), db::workspace_read_only)
}

pub(crate) fn handle_with(
    context: &CallContext,
    request: ChangesPrepareRequest,
    bridge: &Bridge,
    store: &Mutex<PlanStore>,
    now: Instant,
    read_only: impl Fn() -> Option<bool>,
) -> Result<ChangesPrepareResult, ContractError> {
    workspace::fenced(context, |root| {
        if read_only() == Some(true) {
            return Err(ContractError::new(
                ErrorCode::NotReady,
                "the project opened read-only (safety mode), so agent edits are off",
            ));
        }
        prepare(root, context, &request, bridge, store, now)
    })
}

fn prepare(
    root: &Path,
    context: &CallContext,
    request: &ChangesPrepareRequest,
    bridge: &Bridge,
    store: &Mutex<PlanStore>,
    now: Instant,
) -> Result<ChangesPrepareResult, ContractError> {
    // Paths first, exactly as reads judge them: a denied or invalid path never
    // reaches the editor and is never written.
    let mut checks: Vec<Option<ChangeCheck>> = vec![None; request.changes.len()];
    let mut to_check: Vec<(usize, ChangeToCheck)> = Vec::new();
    let mut documents = HashSet::new();
    for (index, change) in request.changes.iter().enumerate() {
        let path = change.path.clone();
        match identity(root, &change.path) {
            Identity::InvalidPath => checks[index] = Some(ChangeCheck::InvalidPath { path }),
            Identity::Denied => checks[index] = Some(ChangeCheck::Denied { path }),
            Identity::Key(key) => {
                // Two spellings of one document would make one plan edit it
                // twice against one revision.
                if !documents.insert(key.clone()) {
                    return Err(invalid(format!("changes: entry {index} names a document an earlier entry names")));
                }
                to_check.push((
                    index,
                    ChangeToCheck {
                        path: key,
                        expected_revision: change.expected_revision.clone(),
                        edits: change
                            .edits
                            .iter()
                            .map(|edit| EditToCheck {
                                old_text: edit.old_text.clone(),
                                new_text: edit.new_text.clone(),
                            })
                            .collect(),
                    },
                ));
            }
        }
    }

    if !to_check.is_empty() {
        let reply = bridge.call::<CheckChangesOp>(
            &context.epoch,
            &CheckChangesRequest {
                changes: to_check.iter().map(|(_, change)| change.clone()).collect(),
            },
        )?;
        // The reply answers exactly what was asked, in order; anything else is
        // a misbehaving bridge, never partial truth.
        if reply.changes.len() != to_check.len()
            || reply.changes.iter().zip(&to_check).any(|(got, (_, sent))| got.path() != sent.path)
        {
            return Err(bridge::malformed());
        }
        for (checked, (index, _)) in reply.changes.into_iter().zip(&to_check) {
            let path = request.changes[*index].path.clone();
            checks[*index] = Some(match checked {
                CheckedChange::Ready { .. } => ChangeCheck::Ready { path },
                CheckedChange::Conflict { revision, .. } => ChangeCheck::Conflict { path, revision },
                CheckedChange::NoMatch { edit, .. } => ChangeCheck::NoMatch { path, edit },
                CheckedChange::Ambiguous { edit, .. } => ChangeCheck::Ambiguous { path, edit },
                CheckedChange::NotInSession { .. } => ChangeCheck::NotInSession { path },
            });
        }
    }

    let changes: Vec<ChangeCheck> = checks.into_iter().map(|check| check.expect("every change was judged")).collect();
    if !changes.iter().all(ChangeCheck::is_ready) {
        return Ok(ChangesPrepareResult { plan: None, changes });
    }
    let planned: Vec<ChangeToCheck> = to_check.into_iter().map(|(_, change)| change).collect();
    let plan = store
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .propose(context.principal, &context.epoch, planned, now)?;
    Ok(ChangesPrepareResult {
        plan: Some(plan),
        changes,
    })
}

// ---------------------------------------------------------------------------
// The plan store
// ---------------------------------------------------------------------------

/// The process's plans.
pub(crate) fn plans() -> &'static Mutex<PlanStore> {
    static PLANS: OnceLock<Mutex<PlanStore>> = OnceLock::new();
    PLANS.get_or_init(|| Mutex::new(PlanStore::default()))
}

/// One immutable plan. `changes` hold canonical session paths.
#[derive(Debug)]
pub(crate) struct Plan {
    pub principal: Principal,
    pub epoch: String,
    pub hash: [u8; 32],
    #[cfg_attr(not(test), allow(dead_code))] // W2b applies them
    pub changes: Vec<ChangeToCheck>,
    pub prepared_at: Instant,
}

impl Plan {
    fn expires_at(&self) -> Instant {
        self.prepared_at + PLAN_TTL
    }

    pub(crate) fn is_expired(&self, now: Instant) -> bool {
        now >= self.expires_at()
    }

    fn summary(&self, id: &str, now: Instant) -> PreparedPlan {
        let left = self.expires_at().saturating_duration_since(now);
        PreparedPlan {
            plan_id: id.to_string(),
            state: PlanState::PendingReview,
            // Rounded up: a plan with time left never reads as 0.
            expires_in_seconds: (left.as_millis().div_ceil(1000) as u32).min(PLAN_TTL_SECONDS),
        }
    }
}

#[derive(Debug, Default)]
pub(crate) struct PlanStore {
    plans: HashMap<String, Plan>,
}

impl PlanStore {
    /// Store a proposal as a plan awaiting review, or return the pending plan
    /// the same requester already made of the same changes.
    pub(crate) fn propose(
        &mut self,
        principal: Principal,
        epoch: &str,
        changes: Vec<ChangeToCheck>,
        now: Instant,
    ) -> Result<PreparedPlan, ContractError> {
        self.forget_old(now);
        let hash = plan_hash(&changes);
        let pending = |plan: &Plan| plan.principal == principal && plan.epoch == epoch && !plan.is_expired(now);
        if let Some((id, plan)) = self.plans.iter().find(|(_, plan)| pending(plan) && plan.hash == hash) {
            return Ok(plan.summary(id, now));
        }
        if self.plans.values().filter(|plan| pending(plan)).count() >= MAX_PENDING_PER_PRINCIPAL {
            return Err(ContractError::new(
                ErrorCode::Busy,
                format!("{MAX_PENDING_PER_PRINCIPAL} proposals already await review; wait for a decision, then retry"),
            ));
        }
        let id = new_plan_id();
        let plan = Plan {
            principal,
            epoch: epoch.to_string(),
            hash,
            changes,
            prepared_at: now,
        };
        let summary = plan.summary(&id, now);
        self.plans.insert(id, plan);
        Ok(summary)
    }

    /// A plan, if it exists and belongs to this requester and workspace.
    /// Another's plan is indistinguishable from none.
    #[cfg_attr(not(test), allow(dead_code))] // W2b's review and apply read through it
    pub(crate) fn get(&self, id: &str, principal: Principal, epoch: &str) -> Option<&Plan> {
        self.plans.get(id).filter(|plan| plan.principal == principal && plan.epoch == epoch)
    }

    fn forget_old(&mut self, now: Instant) {
        self.plans.retain(|_, plan| now < plan.expires_at() + EXPIRED_RETENTION);
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.plans.len()
    }
}

/// `plan-` and 128 random bits: unguessable, so an id is never an oracle for
/// another requester's plan (R5), on top of the ownership check.
fn new_plan_id() -> String {
    let id = format!("plan-{:032x}", rand::rng().random::<u128>());
    debug_assert_eq!(id.len(), PLAN_ID_LENGTH);
    id
}

/// The plan's identity of content: its canonical changes, hashed.
fn plan_hash(changes: &[ChangeToCheck]) -> [u8; 32] {
    let encoded = serde_json::to_vec(changes).expect("planned changes serialize");
    Sha256::digest(encoded).into()
}

#[cfg(test)]
mod tests;
