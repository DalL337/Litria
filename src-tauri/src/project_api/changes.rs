//! Agent-proposed changes (Project API build plan W2; contract brief §13).
//! W2a: proposing — `litria_changes_prepare`. W2b: a person's review (the
//! review seam) and `litria_changes_apply`, the plan's outcome.
//!
//! A proposal is checked against the editor's latest text (the bridge's
//! `editor.checkChanges`, W1's planning). Only when every change is ready does
//! it become a plan: immutable (its canonical changes and their hash), bound
//! to the requester and the workspace epoch, waiting for a person's review,
//! and expiring ten minutes after preparation (owner rulings, 2026-10-11).
//! Plans live in memory (durable operations are W4).
//!
//! Only a person's approval applies a plan (owner ruling: every agent edit
//! needs review). Approving claims the plan atomically — `pendingReview` →
//! `applying`, so it executes at most once — and applies it through the
//! editor's `editor.applyChanges`, all or none. An outcome Litria cannot be
//! sure of is recorded as `needsReview` and never retried (R5).

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use rand::Rng;
use sha2::{Digest, Sha256};

use super::bridge::{self, Bridge, CallFailure};
use super::reader::{identity, Identity};
use super::workspace;
use crate::contracts::boundary::invalid;
use crate::contracts::context::{CallContext, Principal};
use crate::contracts::error::{ContractError, ErrorCode};
use crate::contracts::project_api::changes_apply::{ChangeOutcome, ChangesApplyRequest, ChangesApplyResult, Effect};
use crate::contracts::project_api::changes_prepare::{
    ChangeCheck, ChangesPrepareRequest, ChangesPrepareResult, PlanState, PreparedPlan, PLAN_ID_LENGTH, PLAN_TTL_SECONDS,
};
use crate::contracts::project_api_bridge::editor::{
    ApplyChangesOp, ApplyEntry, ChangeToCheck, CheckChangesOp, CheckChangesRequest, CheckedChange, EditToCheck,
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
// litria_changes_apply: the outcome
// ---------------------------------------------------------------------------

pub(crate) fn handle_apply(context: &CallContext, request: ChangesApplyRequest) -> Result<ChangesApplyResult, ContractError> {
    handle_apply_with(context, request, plans(), Instant::now())
}

/// Where the requester's plan stands. Never applies: under the every-edit-
/// needs-review ruling only a person's approval does.
pub(crate) fn handle_apply_with(
    context: &CallContext,
    request: ChangesApplyRequest,
    store: &Mutex<PlanStore>,
    now: Instant,
) -> Result<ChangesApplyResult, ContractError> {
    workspace::fenced(context, |_root| {
        let (state, changes) = lock(store).status(&request.plan_id, context.principal, &context.epoch, now);
        Ok(ChangesApplyResult {
            plan_id: request.plan_id.clone(),
            state,
            effect: (state == PlanState::Applied).then_some(Effect::Buffer),
            changes,
        })
    })
}

// ---------------------------------------------------------------------------
// The review seam
// ---------------------------------------------------------------------------

/// A person's decision on a plan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Decision {
    Approve,
    Reject,
}

/// Where a plan stands after a decision.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Reviewed {
    pub state: PlanState,
    pub changes: Vec<ChangeOutcome>,
}

/// A person's decision on a plan of the workspace `epoch` — the seam the
/// review surface calls (track T designs where it appears; tests and a
/// debug-only command drive it until then). Approving applies the plan
/// through the editor, at most once; rejecting ends it.
#[cfg_attr(not(debug_assertions), allow(dead_code))] // the debug command is its caller until track T
pub(crate) fn review(plan_id: &str, decision: Decision, epoch: &str) -> Reviewed {
    review_with(plan_id, decision, epoch, bridge::global(), plans(), Instant::now())
}

pub(crate) fn review_with(
    plan_id: &str,
    decision: Decision,
    epoch: &str,
    bridge: &Bridge,
    store: &Mutex<PlanStore>,
    now: Instant,
) -> Reviewed {
    if decision == Decision::Reject {
        let state = lock(store).reject(plan_id, epoch, now);
        return Reviewed { state, changes: Vec::new() };
    }
    // Bound first, so the store's guard is released before either arm runs:
    // a guard created in a `match` scrutinee lives to the end of the match,
    // and the second lock below would deadlock on it.
    let claimed = lock(store).claim(plan_id, epoch, now);
    let changes = match claimed {
        Ok(changes) => changes,
        // Not pending (applied, applying, rejected, expired, …) or not this
        // workspace's: nothing runs, the plan's standing is the answer.
        Err(state) => return lock(store).reviewed(plan_id, epoch, state),
    };
    // The store is not locked while the editor works.
    let sent: Vec<String> = changes.iter().map(|change| change.path.clone()).collect();
    let (state, outcomes) = match bridge.call_reporting::<ApplyChangesOp>(epoch, &CheckChangesRequest { changes }) {
        Ok(result) if result.changes.iter().map(ApplyEntry::path).eq(sent.iter().map(String::as_str)) => {
            let outcomes: Vec<ChangeOutcome> = result.changes.into_iter().map(outcome_of).collect();
            (if result.applied { PlanState::Applied } else { PlanState::Conflict }, outcomes)
        }
        // An answer about other documents: the editor acted on something, but
        // what is unknown.
        Ok(_) => (PlanState::NeedsReview, Vec::new()),
        // Never delivered, or refused before the editor acted: nothing applied.
        Err(CallFailure { delivered: false, .. }) => (PlanState::Failed, Vec::new()),
        Err(CallFailure { error, .. }) if error.code == ErrorCode::WorkspaceChanged => (PlanState::Failed, Vec::new()),
        // Delivered, then lost (no answer in time, a broken answer): the
        // editor may have applied it. Unknown — and never retried.
        Err(_) => (PlanState::NeedsReview, Vec::new()),
    };
    lock(store).finish(plan_id, state, outcomes.clone());
    Reviewed { state, changes: outcomes }
}

fn outcome_of(entry: ApplyEntry) -> ChangeOutcome {
    match entry {
        ApplyEntry::Applied { path, revision } => ChangeOutcome::Applied { path, revision },
        ApplyEntry::Ready { path } => ChangeOutcome::Ready { path },
        ApplyEntry::Conflict { path, revision } => ChangeOutcome::Conflict { path, revision },
        ApplyEntry::NoMatch { path, edit } => ChangeOutcome::NoMatch { path, edit },
        ApplyEntry::Ambiguous { path, edit } => ChangeOutcome::Ambiguous { path, edit },
        ApplyEntry::NotInSession { path } => ChangeOutcome::NotInSession { path },
    }
}

fn lock(store: &Mutex<PlanStore>) -> std::sync::MutexGuard<'_, PlanStore> {
    store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---------------------------------------------------------------------------
// The plan store
// ---------------------------------------------------------------------------

/// The process's plans.
pub(crate) fn plans() -> &'static Mutex<PlanStore> {
    static PLANS: OnceLock<Mutex<PlanStore>> = OnceLock::new();
    PLANS.get_or_init(|| Mutex::new(PlanStore::default()))
}

/// One immutable plan and where it stands. `changes` hold canonical
/// session paths.
#[derive(Debug)]
pub(crate) struct Plan {
    pub principal: Principal,
    pub epoch: String,
    pub hash: [u8; 32],
    pub changes: Vec<ChangeToCheck>,
    pub prepared_at: Instant,
    /// `PendingReview` reads as `Expired` once its time is up.
    state: PlanState,
    /// Per document, once applied or found in conflict.
    outcomes: Vec<ChangeOutcome>,
}

impl Plan {
    /// Where the plan stands at `now`.
    pub(crate) fn state(&self, now: Instant) -> PlanState {
        if self.state == PlanState::PendingReview && self.is_expired(now) {
            PlanState::Expired
        } else {
            self.state
        }
    }

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
        let pending = |plan: &Plan| {
            plan.principal == principal && plan.epoch == epoch && plan.state(now) == PlanState::PendingReview
        };
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
            state: PlanState::PendingReview,
            outcomes: Vec::new(),
        };
        let summary = plan.summary(&id, now);
        self.plans.insert(id, plan);
        Ok(summary)
    }

    /// A plan, if it exists and belongs to this requester and workspace.
    /// Another's plan is indistinguishable from none.
    #[cfg(test)]
    pub(crate) fn get(&self, id: &str, principal: Principal, epoch: &str) -> Option<&Plan> {
        self.plans.get(id).filter(|plan| plan.principal == principal && plan.epoch == epoch)
    }

    /// The requester's plan's standing and outcomes; `Unknown` for another's
    /// plan, an unknown id, or a forgotten one.
    pub(crate) fn status(&self, id: &str, principal: Principal, epoch: &str, now: Instant) -> (PlanState, Vec<ChangeOutcome>) {
        match self.plans.get(id).filter(|plan| plan.principal == principal && plan.epoch == epoch) {
            Some(plan) => (plan.state(now), plan.outcomes.clone()),
            None => (PlanState::Unknown, Vec::new()),
        }
    }

    /// Claim a plan of workspace `epoch` for applying: only a pending,
    /// unexpired plan moves to `Applying`, so at most one claim ever wins.
    /// Otherwise the plan's standing (`Unknown` when there is none).
    pub(crate) fn claim(&mut self, id: &str, epoch: &str, now: Instant) -> Result<Vec<ChangeToCheck>, PlanState> {
        let Some(plan) = self.plans.get_mut(id).filter(|plan| plan.epoch == epoch) else {
            return Err(PlanState::Unknown);
        };
        match plan.state(now) {
            PlanState::PendingReview => {
                plan.state = PlanState::Applying;
                Ok(plan.changes.clone())
            }
            other => Err(other),
        }
    }

    /// Reject a pending plan of workspace `epoch`; returns where it stands.
    pub(crate) fn reject(&mut self, id: &str, epoch: &str, now: Instant) -> PlanState {
        let Some(plan) = self.plans.get_mut(id).filter(|plan| plan.epoch == epoch) else {
            return PlanState::Unknown;
        };
        if plan.state(now) == PlanState::PendingReview {
            plan.state = PlanState::Rejected;
        }
        plan.state(now)
    }

    /// Record the outcome of the claim that won.
    pub(crate) fn finish(&mut self, id: &str, state: PlanState, outcomes: Vec<ChangeOutcome>) {
        if let Some(plan) = self.plans.get_mut(id).filter(|plan| plan.state == PlanState::Applying) {
            plan.state = state;
            plan.outcomes = outcomes;
        }
    }

    /// A plan's standing for a reviewer of workspace `epoch`.
    fn reviewed(&self, id: &str, epoch: &str, state: PlanState) -> Reviewed {
        let changes = self
            .plans
            .get(id)
            .filter(|plan| plan.epoch == epoch)
            .map(|plan| plan.outcomes.clone())
            .unwrap_or_default();
        Reviewed { state, changes }
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
