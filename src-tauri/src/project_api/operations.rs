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
//!
//! When a project opens, `take_interrupted` settles every operation an earlier
//! run left applying and reports each once, for the reopen pill (W4b; owner
//! ruling: a pill on reopen, never a replay).

use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rand::Rng;

use rusqlite::{params, Connection, DatabaseName, OptionalExtension};
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
    /// The run of Litria it ran in (`run_id`). Epochs restart with every run,
    /// so a run and an epoch together name one open.
    pub run: String,
    /// The project open it ran in. A record still `applying` from another open
    /// (another run, or another epoch of this one) was interrupted.
    pub epoch: String,
    pub state: PlanState,
    pub changes: Vec<RecordedChange>,
    /// Settled by `take_interrupted` after a restart cut it short.
    pub interrupted: bool,
}

/// Where an operation stands, as a reader may learn it.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct Standing {
    pub state: PlanState,
    /// Known outcomes, in plan order; an unknown one is left out.
    pub changes: Vec<ChangeOutcome>,
    pub interrupted: bool,
}

/// This run of Litria: random, minted once per process. Workspace epochs are
/// a per-process counter (`ws-1`, `ws-2`, …) that every run starts again, so
/// an epoch alone does not tell a record of this open from one an earlier run
/// left (W4b live pass: a crashed operation read as still running after the
/// restart reused its epoch).
pub(crate) fn run_id() -> &'static str {
    static RUN: OnceLock<String> = OnceLock::new();
    RUN.get_or_init(|| format!("run-{:016x}", rand::rng().random::<u64>()))
}

/// The open a record names, as stored: the run and the epoch.
fn open_key(run: &str, epoch: &str) -> String {
    format!("{run}/{epoch}")
}

/// A stored open key, split. A key with no run (written before runs were
/// recorded) names no run of this process.
fn split_open_key(key: &str) -> (String, String) {
    match key.split_once('/') {
        Some((run, epoch)) => (run.to_string(), epoch.to_string()),
        None => (String::new(), key.to_string()),
    }
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
                params![
                    record.id,
                    principal_key(record.principal),
                    open_key(&record.run, &record.epoch),
                    state_key(record.state),
                    changes,
                    now
                ],
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
                "SELECT epoch, state, changes, interrupted FROM api_operations WHERE id = ?1 AND principal = ?2",
                params![id, principal_key(principal)],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()
            .map_err(DbError::sqlite("Failed to read an API operation"))?;
        Ok(row.map(|(key, state, changes, interrupted)| {
            let (run, epoch) = split_open_key(&key);
            Record {
                id: id.to_string(),
                principal,
                run,
                epoch,
                state: state_from_key(&state),
                changes: serde_json::from_str(&changes).unwrap_or_default(),
                interrupted: interrupted != 0,
            }
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
    let this_open = record.run == run_id() && record.epoch == current_epoch;
    let running_elsewhere = record.state == PlanState::Applying && !this_open;
    let known: Vec<ChangeOutcome> = record.changes.iter().filter_map(|change| change.outcome.clone()).collect();
    if !running_elsewhere {
        return Standing { state: record.state, changes: known, interrupted: record.interrupted };
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

/// An interrupted operation, as the reopen pill reports it: what may be on
/// disk, and how many unsaved edits the restart took with it. Unsaved text is
/// not kept across a restart (the editor reloads every file from disk).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InterruptedReport {
    /// New files it created, or may have: their creation was started and
    /// never confirmed.
    pub files: Vec<String>,
    /// Edits that were, or may have been, in the editor unsaved, and are gone.
    pub unsaved_edits: u32,
}

/// When a project opens (W4b): prune receipts past retention, settle every
/// operation an earlier run left applying (as `standing` reads it, now
/// recorded, interrupted), and report each interrupted one exactly once.
/// Operations that could have changed nothing are settled without a report.
/// A read-only project is left as it is.
pub(crate) fn take_interrupted(epoch: &str, now: i64) -> Result<Vec<InterruptedReport>, DbError> {
    db::with_workspace_db(epoch, |conn| {
        if conn.is_readonly(DatabaseName::Main).map_err(DbError::sqlite("Failed to probe writability"))? {
            return Ok(Vec::new());
        }
        let tx = conn.unchecked_transaction().map_err(DbError::sqlite("Failed to begin operation recovery"))?;
        prune(&tx, now)?;
        let current = open_key(run_id(), epoch);
        let stranded = select_records(
            &tx,
            "SELECT id, principal, epoch, state, changes, interrupted FROM api_operations
             WHERE state = 'applying' AND epoch != ?1",
            &current,
        )?;
        for record in stranded {
            let settled = settle(&record, epoch);
            let changes = serde_json::to_string(&settled.changes).map_err(|error| DbError::from(error.to_string()))?;
            tx.execute(
                "UPDATE api_operations SET state = ?1, changes = ?2, interrupted = 1, updated_at = ?3 WHERE id = ?4",
                params![state_key(settled.state), changes, now, settled.id],
            )
            .map_err(DbError::sqlite("Failed to settle an interrupted operation"))?;
        }
        let unreported = select_records(
            &tx,
            "SELECT id, principal, epoch, state, changes, interrupted FROM api_operations
             WHERE interrupted = 1 AND reported = 0 AND epoch != ?1",
            &current,
        )?;
        let mut reports = Vec::new();
        for record in unreported {
            tx.execute("UPDATE api_operations SET reported = 1 WHERE id = ?1", [&record.id])
                .map_err(DbError::sqlite("Failed to mark an operation reported"))?;
            let report = report(&record);
            if !report.files.is_empty() || report.unsaved_edits > 0 {
                reports.push(report);
            }
        }
        tx.commit().map_err(DbError::sqlite("Failed to commit operation recovery"))?;
        Ok(reports)
    })
}

fn select_records(conn: &Connection, sql: &str, current_key: &str) -> Result<Vec<Record>, DbError> {
    let mut statement = conn.prepare(sql).map_err(DbError::sqlite("Failed to read API operations"))?;
    let rows = statement
        .query_map([current_key], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, i64>(5)?,
            ))
        })
        .map_err(DbError::sqlite("Failed to read API operations"))?;
    Ok(rows
        .flatten()
        .filter_map(|(id, principal, key, state, changes, interrupted)| {
            let (run, epoch) = split_open_key(&key);
            Some(Record {
                id,
                principal: principal_from_key(&principal)?,
                run,
                epoch,
                state: state_from_key(&state),
                changes: serde_json::from_str(&changes).unwrap_or_default(),
                interrupted: interrupted != 0,
            })
        })
        .collect())
}

fn principal_from_key(key: &str) -> Option<Principal> {
    match key {
        "test" => Some(Principal::Test),
        "dev" => Some(Principal::Dev),
        _ => None,
    }
}

/// A stranded record as `standing` reads it, written down: its state, and a
/// `ready` outcome for each change that never started.
fn settle(record: &Record, current_epoch: &str) -> Record {
    let state = standing(record, current_epoch).state;
    let changes = record
        .changes
        .iter()
        .map(|change| match (&change.outcome, change.phase) {
            (None, Phase::Intended) => RecordedChange {
                outcome: Some(ChangeOutcome::Ready { path: change.path.clone() }),
                ..change.clone()
            },
            _ => change.clone(),
        })
        .collect();
    Record { state, changes, interrupted: true, ..record.clone() }
}

/// What an interrupted operation may have left: new files created, or whose
/// creation was started and never confirmed; and edits that were, or may have
/// been, applied to the editor, unsaved, and are gone with the restart.
fn report(record: &Record) -> InterruptedReport {
    let uncertain = |change: &RecordedChange| change.phase == Phase::Started && change.outcome.is_none();
    let files = record
        .changes
        .iter()
        .filter(|change| change.kind == ChangeKind::Create)
        .filter(|change| uncertain(change) || matches!(change.outcome, Some(ChangeOutcome::Created { .. })))
        .map(|change| change.path.clone())
        .collect();
    let unsaved_edits = record
        .changes
        .iter()
        .filter(|change| matches!(change.kind, ChangeKind::Edit | ChangeKind::Open))
        .filter(|change| uncertain(change) || matches!(change.outcome, Some(ChangeOutcome::Applied { .. })))
        .count() as u32;
    InterruptedReport { files, unsaved_edits }
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
