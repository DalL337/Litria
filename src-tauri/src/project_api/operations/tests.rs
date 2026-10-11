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
    Record { id: "plan-1".into(), principal: Principal::Test, run: run_id().into(), epoch: epoch.into(), state, changes, interrupted: false }
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

// --- W4b: settling interrupted operations when a project opens -------------------

fn created(path: &str) -> ChangeOutcome {
    ChangeOutcome::Created { path: path.into(), revision: format!("d1-{path}") }
}

fn stranded(id: &str, epoch: &str, changes: Vec<RecordedChange>) -> Record {
    Record { id: id.into(), principal: Principal::Test, run: run_id().into(), epoch: epoch.into(), state: PlanState::Applying, changes, interrupted: false }
}

/// Owner ruling: interrupted work is reported on reopen, once, and never
/// replayed. What it reports is what can remain: new files (created, or
/// whose creation was started), and the unsaved edits the restart took.
#[test]
fn an_interrupted_operation_is_settled_and_reported_once() {
    let open = Open::new("take");
    let crashed = stranded(
        "plan-crashed",
        "ws-earlier",
        vec![
            change("src/a.ts", ChangeKind::Edit, Phase::Confirmed, Some(applied("src/a.ts"))),
            change("src/b.ts", ChangeKind::Open, Phase::Started, None),
            change("src/made.ts", ChangeKind::Create, Phase::Confirmed, Some(created("src/made.ts"))),
            change("src/maybe.ts", ChangeKind::Create, Phase::Started, None),
            change("src/never.ts", ChangeKind::Create, Phase::Intended, None),
        ],
    );
    save(&open.epoch, &crashed, now()).unwrap();

    let reports = take_interrupted(&open.epoch, now()).unwrap();
    assert_eq!(
        reports,
        [InterruptedReport { files: vec!["src/made.ts".into(), "src/maybe.ts".into()], unsaved_edits: 2 }]
    );
    let settled = load(&open.epoch, "plan-crashed", Principal::Test).unwrap().unwrap();
    assert_eq!(settled.state, PlanState::NeedsReview, "a started change without an answer");
    assert!(settled.interrupted);
    assert_eq!(settled.changes[4].outcome, Some(ChangeOutcome::Ready { path: "src/never.ts".into() }));
    let read = standing(&settled, &open.epoch);
    assert!(read.interrupted);
    assert_eq!(read.state, PlanState::NeedsReview);

    assert!(take_interrupted(&open.epoch, now()).unwrap().is_empty(), "reported once");
}

#[test]
fn an_operation_running_in_this_open_is_left_alone() {
    let open = Open::new("take-running");
    let running = stranded("plan-running", &open.epoch, vec![change("src/a.ts", ChangeKind::Edit, Phase::Started, None)]);
    save(&open.epoch, &running, now()).unwrap();
    assert!(take_interrupted(&open.epoch, now()).unwrap().is_empty());
    let record = load(&open.epoch, "plan-running", Principal::Test).unwrap().unwrap();
    assert_eq!((record.state, record.interrupted), (PlanState::Applying, false));
}

/// Nothing could have changed (the intent alone): settled, never a pill.
#[test]
fn an_operation_that_changed_nothing_is_settled_without_a_report() {
    let open = Open::new("take-nothing");
    let crashed = stranded("plan-nothing", "ws-earlier", vec![change("src/a.ts", ChangeKind::Edit, Phase::Intended, None)]);
    save(&open.epoch, &crashed, now()).unwrap();
    assert!(take_interrupted(&open.epoch, now()).unwrap().is_empty());
    let settled = load(&open.epoch, "plan-nothing", Principal::Test).unwrap().unwrap();
    assert_eq!((settled.state, settled.interrupted), (PlanState::Failed, true));
}

/// Receipts past retention are pruned when the project opens, too.
#[test]
fn opening_prunes_receipts_past_retention() {
    let open = Open::new("take-prune");
    let day = 24 * 60 * 60 * 1000_i64;
    let mut old = record(&open.epoch, PlanState::Applied, vec![]);
    old.id = "plan-old".into();
    save(&open.epoch, &old, 10 * day).unwrap();
    take_interrupted(&open.epoch, 41 * day).unwrap();
    assert_eq!(load(&open.epoch, "plan-old", Principal::Test).unwrap(), None);
}

/// The W4b live finding: every run of Litria counts epochs from the start, so
/// a run after a crash can open the project under the very epoch the crashed
/// operation recorded. It is still another open: interrupted, not running.
#[test]
fn an_earlier_run_with_the_same_epoch_is_another_open() {
    let mut crashed = record("ws-1", PlanState::Applying, vec![change("n.ts", ChangeKind::Create, Phase::Started, None)]);
    crashed.run = "run-earlier".into();
    let read = standing(&crashed, "ws-1");
    assert_eq!((read.state, read.interrupted), (PlanState::NeedsReview, true));

    // And it is settled and reported when the project opens again.
    let open = Open::new("same-epoch");
    crashed.epoch = open.epoch.clone();
    save(&open.epoch, &crashed, now()).unwrap();
    assert_eq!(take_interrupted(&open.epoch, now()).unwrap(), [InterruptedReport { files: vec!["n.ts".into()], unsaved_edits: 0 }]);
}

/// A record written before runs were recorded names no run of this process.
#[test]
fn a_record_without_a_run_is_from_another_run() {
    assert_eq!(split_open_key("ws-3"), (String::new(), "ws-3".to_string()));
    assert_eq!(split_open_key("run-ab/ws-3"), ("run-ab".to_string(), "ws-3".to_string()));
}
