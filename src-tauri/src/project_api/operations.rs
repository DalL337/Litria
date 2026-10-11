//! Durable operations (Project API build plan W4a; Project API proposal R5).
//!
//! An operation is an applied plan; its id is the plan id. From the moment a
//! plan is claimed, its record in the project database says, per change, how
//! far it got: intended (recorded before anything is done), started (recorded
//! before the owner is asked), confirmed (the owner's answer). An effect is
//! never started before its intent is recorded, so after a restart Litria
//! tells a verified outcome from an uncertain one: a change started but never
//! confirmed is unknown, and its operation is `needsReview`. Nothing is ever
//! replayed.
//!
//! Records hold identifiers and outcomes only — paths, kinds, phases,
//! outcomes, revisions — never file text (agent brief), and are pruned 30
//! days after their last change (owner ruling, 2026-10-11).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::contracts::context::Principal;
use crate::contracts::project_api::changes_apply::ChangeOutcome;
use crate::contracts::project_api::changes_prepare::PlanState;
use crate::db::{self, DbError};

/// How long a receipt is kept after its last change (owner ruling).
pub(crate) const RETENTION: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// What a change does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ChangeKind {
    /// An edit to a document the editor holds (unsaved).
    Edit,
    /// An edit that opens its document from disk (unsaved; W3c).
    Open,
    /// A new file on disk (W3b).
    Create,
}

/// How far a change got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Phase {
    /// Recorded before anything was done.
    Intended,
    /// Recorded before its owner was asked to act.
    Started,
    /// Its owner answered: the outcome is known.
    Confirmed,
}

/// One change of an operation, as recorded.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecordedChange {
    pub path: String,
    pub kind: ChangeKind,
    pub phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<ChangeOutcome>,
}

/// An operation's durable record.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Record {
    pub id: String,
    pub principal: Principal,
    /// The project open it ran in. A record still `applying` from another open
    /// was interrupted.
    pub epoch: String,
    pub state: PlanState,
    pub changes: Vec<RecordedChange>,
}

/// Where an operation stands, as a reader may learn it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Standing {
    pub state: PlanState,
    /// Known outcomes, in plan order; an unknown one is left out.
    pub changes: Vec<ChangeOutcome>,
    pub interrupted: bool,
}

fn principal_key(principal: Principal) -> &'static str {
    match principal {
        Principal::Test => "test",
        Principal::Dev => "dev",
    }
}

fn now_millis() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|elapsed| elapsed.as_millis() as i64).unwrap_or(0)
}

fn state_key(state: PlanState) -> String {
    serde_json::to_value(state).ok().and_then(|value| value.as_str().map(str::to_string)).unwrap_or_default()
}

fn state_from_key(key: &str) -> PlanState {
    serde_json::from_value(serde_json::Value::String(key.to_string())).unwrap_or(PlanState::Unknown)
}

/// Write `record` (insert or update), and prune receipts past retention when
/// a new operation begins. A write the database refuses (closed, switched,
/// read-only) is an error: the caller then does not start what it records.
pub(crate) fn save(epoch: &str, record: &Record, now: i64) -> Result<(), DbError> {
    let changes = serde_json::to_string(&record.changes).map_err(|error| DbError::from(error.to_string()))?;
    db::with_workspace_db(epoch, |conn| {
        let inserted = conn
            .execute(
                "INSERT INTO api_operations (id, principal, epoch, state, changes, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)
                 ON CONFLICT(id) DO UPDATE SET state = excluded.state, changes = excluded.changes,
                     updated_at = excluded.updated_at",
                params![record.id, principal_key(record.principal), record.epoch, state_key(record.state), changes, now],
            )
            .map_err(DbError::sqlite("Failed to record an API operation"))?;
        if inserted > 0 && record.state == PlanState::Applying && record.changes.iter().all(|c| c.phase == Phase::Intended) {
            prune(conn, now)?;
        }
        Ok(())
    })
}

/// Delete receipts whose last change is older than the retention period.
pub(crate) fn prune(conn: &Connection, now: i64) -> Result<usize, DbError> {
    let cutoff = now - RETENTION.as_millis() as i64;
    conn.execute("DELETE FROM api_operations WHERE updated_at < ?1", [cutoff])
        .map_err(DbError::sqlite("Failed to prune API operations"))
}

/// The requester's record of operation `id`, if this project has it.
/// Another requester's is indistinguishable from none.
pub(crate) fn load(epoch: &str, id: &str, principal: Principal) -> Result<Option<Record>, DbError> {
    db::with_workspace_db(epoch, |conn| {
        let row = conn
            .query_row(
                "SELECT epoch, state, changes FROM api_operations WHERE id = ?1 AND principal = ?2",
                params![id, principal_key(principal)],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?)),
            )
            .optional()
            .map_err(DbError::sqlite("Failed to read an API operation"))?;
        Ok(row.map(|(epoch, state, changes)| Record {
            id: id.to_string(),
            principal,
            epoch,
            state: state_from_key(&state),
            changes: serde_json::from_str(&changes).unwrap_or_default(),
        }))
    })
}

/// The current millisecond clock, for `save`.
pub(crate) fn now() -> i64 {
    now_millis()
}

/// Where a record stands, read in the open `current_epoch`. A record still
/// `applying` from another open was interrupted; a record of this open that
/// is `applying` is still running.
pub(crate) fn standing(record: &Record, current_epoch: &str) -> Standing {
    let interrupted = record.state == PlanState::Applying && record.epoch != current_epoch;
    let known: Vec<ChangeOutcome> = record.changes.iter().filter_map(|change| change.outcome.clone()).collect();
    if !interrupted {
        return Standing { state: record.state, changes: known, interrupted: false };
    }
    // A change started but never confirmed: its owner may have acted.
    if record.changes.iter().any(|change| change.phase == Phase::Started && change.outcome.is_none()) {
        return Standing { state: PlanState::NeedsReview, changes: known, interrupted: true };
    }
    // Every outcome is known; a change never started did nothing.
    let changes: Vec<ChangeOutcome> = record
        .changes
        .iter()
        .map(|change| change.outcome.clone().unwrap_or(ChangeOutcome::Ready { path: change.path.clone() }))
        .collect();
    Standing { state: settled_state(&changes), changes, interrupted: true }
}

/// The state a plan ends in once every change's outcome is known: everything
/// landed, some of it, or none (a conflict if a new file's name was taken).
pub(crate) fn settled_state(outcomes: &[ChangeOutcome]) -> PlanState {
    let landed = outcomes.iter().filter(|outcome| landed(outcome)).count();
    if landed == outcomes.len() {
        PlanState::Applied
    } else if landed > 0 {
        PlanState::Partial
    } else if outcomes.iter().any(|outcome| matches!(outcome, ChangeOutcome::Exists { .. } | ChangeOutcome::Conflict { .. })) {
        PlanState::Conflict
    } else {
        PlanState::Failed
    }
}

pub(crate) fn landed(outcome: &ChangeOutcome) -> bool {
    matches!(outcome, ChangeOutcome::Applied { .. } | ChangeOutcome::Created { .. })
}

#[cfg(test)]
mod tests;
