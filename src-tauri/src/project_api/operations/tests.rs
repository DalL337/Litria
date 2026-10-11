//! Durable operations: the record, recovery and retention (build plan W4a).

use super::*;
use std::fs;
use std::path::PathBuf;

fn change(path: &str, kind: ChangeKind, phase: Phase, outcome: Option<ChangeOutcome>) -> RecordedChange {
    RecordedChange { path: path.into(), kind, phase, outcome }
}

fn applied(path: &str) -> ChangeOutcome {
    ChangeOutcome::Applied { path: path.into(), revision: format!("b1-{path}") }
}

fn record(epoch: &str, state: PlanState, changes: Vec<RecordedChange>) -> Record {
    Record { id: "plan-1".into(), principal: Principal::Test, epoch: epoch.into(), state, changes }
}

#[test]
fn an_operation_of_this_open_still_applying_is_running_not_interrupted() {
    let running = record("ws-now", PlanState::Applying, vec![change("a.ts", ChangeKind::Edit, Phase::Started, None)]);
    assert_eq!(
        standing(&running, "ws-now"),
        Standing { state: PlanState::Applying, changes: vec![], interrupted: false }
    );
}

/// R5: the process ended after a change was started and before its owner
/// answered. Its outcome is unknown: needs review, never replayed.
#[test]
fn a_started_change_without_an_answer_needs_review_after_a_restart() {
    let crashed = record(
        "ws-before",
        PlanState::Applying,
        vec![
            change("a.ts", ChangeKind::Edit, Phase::Confirmed, Some(applied("a.ts"))),
            change("new.ts", ChangeKind::Create, Phase::Started, None),
        ],
    );
    assert_eq!(
        standing(&crashed, "ws-now"),
        Standing { state: PlanState::NeedsReview, changes: vec![applied("a.ts")], interrupted: true }
    );
}

/// R5: the process ended after the intent was recorded and before anything
/// started: nothing was done.
#[test]
fn an_intent_never_started_did_nothing() {
    let crashed = record(
        "ws-before",
        PlanState::Applying,
        vec![change("a.ts", ChangeKind::Edit, Phase::Intended, None), change("n.ts", ChangeKind::Create, Phase::Intended, None)],
    );
    assert_eq!(
        standing(&crashed, "ws-now"),
        Standing {
            state: PlanState::Failed,
            changes: vec![ChangeOutcome::Ready { path: "a.ts".into() }, ChangeOutcome::Ready { path: "n.ts".into() }],
            interrupted: true
        }
    );
}

/// R5: the process ended after every answer and before the final state was
/// written: the outcomes are known.
#[test]
fn every_answer_known_settles_even_without_the_final_write() {
    let crashed = record(
        "ws-before",
        PlanState::Applying,
        vec![
            change("a.ts", ChangeKind::Edit, Phase::Confirmed, Some(applied("a.ts"))),
            change("n.ts", ChangeKind::Create, Phase::Intended, None),
        ],
    );
    let standing = standing(&crashed, "ws-now");
    assert_eq!(standing.state, PlanState::Partial, "the edit landed; the file was never started");
    assert!(standing.interrupted);
}

#[test]
fn a_finished_operation_reads_as_it_finished() {
    let done = record("ws-before", PlanState::Applied, vec![change("a.ts", ChangeKind::Edit, Phase::Confirmed, Some(applied("a.ts")))]);
    assert_eq!(standing(&done, "ws-now"), Standing { state: PlanState::Applied, changes: vec![applied("a.ts")], interrupted: false });
}

// --- In a project database -----------------------------------------------------------

struct Open {
    root: PathBuf,
    epoch: String,
    _serial: std::sync::MutexGuard<'static, ()>,
}

impl Open {
    fn new(tag: &str) -> Self {
        let serial = db::serial_guard();
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let root = std::env::temp_dir().join(format!("litria-operations-{tag}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let (_, epoch) = db::open_workspace_db(&root).unwrap();
        Self { root, epoch, _serial: serial }
    }
}

impl Drop for Open {
    fn drop(&mut self) {
        let _ = db::close_workspace_db();
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn a_record_round_trips_and_belongs_to_its_requester() {
    let open = Open::new("round-trip");
    let mut written = record(&open.epoch, PlanState::Applying, vec![change("a.ts", ChangeKind::Open, Phase::Intended, None)]);
    save(&open.epoch, &written, now()).unwrap();
    written.state = PlanState::Applied;
    written.changes[0] = change("a.ts", ChangeKind::Open, Phase::Confirmed, Some(applied("a.ts")));
    save(&open.epoch, &written, now()).unwrap();
    assert_eq!(load(&open.epoch, "plan-1", Principal::Test).unwrap(), Some(written));
    assert_eq!(load(&open.epoch, "plan-1", Principal::Dev).unwrap(), None, "another requester's is none");
    assert_eq!(load(&open.epoch, "plan-2", Principal::Test).unwrap(), None);
}

#[test]
fn a_record_never_holds_file_text() {
    let open = Open::new("no-text");
    let written = record(&open.epoch, PlanState::Applied, vec![change("a.ts", ChangeKind::Edit, Phase::Confirmed, Some(applied("a.ts")))]);
    save(&open.epoch, &written, now()).unwrap();
    let stored: String = db::with_workspace_db(&open.epoch, |conn| {
        conn.query_row("SELECT changes FROM api_operations WHERE id = 'plan-1'", [], |row| row.get(0))
            .map_err(DbError::sqlite("read"))
    })
    .unwrap();
    let value: serde_json::Value = serde_json::from_str(&stored).unwrap();
    let keys: Vec<String> = value[0].as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys, ["kind", "outcome", "path", "phase"], "identifiers and outcomes only");
}

/// Owner ruling: receipts are kept 30 days, then pruned when a new
/// operation begins.
#[test]
fn receipts_older_than_thirty_days_are_pruned_when_an_operation_begins() {
    let open = Open::new("prune");
    let day = 24 * 60 * 60 * 1000_i64;
    let start = 100 * day;
    let mut old = record(&open.epoch, PlanState::Applied, vec![]);
    old.id = "plan-old".into();
    save(&open.epoch, &old, start).unwrap();
    let mut recent = record(&open.epoch, PlanState::Applied, vec![]);
    recent.id = "plan-recent".into();
    save(&open.epoch, &recent, start + 20 * day).unwrap();
    // A new operation 31 days after the old one.
    let fresh = record(&open.epoch, PlanState::Applying, vec![change("a.ts", ChangeKind::Edit, Phase::Intended, None)]);
    save(&open.epoch, &fresh, start + 31 * day).unwrap();
    assert_eq!(load(&open.epoch, "plan-old", Principal::Test).unwrap(), None, "past retention");
    assert!(load(&open.epoch, "plan-recent", Principal::Test).unwrap().is_some());
    assert!(load(&open.epoch, "plan-1", Principal::Test).unwrap().is_some());
}

#[test]
fn a_write_to_a_project_that_is_not_open_fails() {
    let written = record("ws-nowhere", PlanState::Applying, vec![]);
    let _serial = db::serial_guard();
    assert!(save("ws-nowhere", &written, now()).is_err());
}
