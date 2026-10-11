//! Plan store and prepare handler tests (Project API build plan W2a).
//!
//! The store is driven with an explicit clock. The handler runs inside a
//! really bound workspace, against a scripted editor that records what Rust
//! asked it — so a path the policy withholds is proven never to reach it.
//!
// This whole file is the module's test module, so the Windows-hidden-spawn
// guard skips it: the junction helper below spawns `cmd` directly, as the
// reader's own link tests do.

use super::*;
use crate::contracts::context::Grant;
use crate::contracts::project_api::changes_prepare::{ProposedChange, TextEdit};
use crate::contracts::project_api_bridge::BridgeRequestEvent;
use crate::project_api::bridge::testing::answering;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

// --- The store ---------------------------------------------------------------

fn planned(path: &str, revision: &str) -> Vec<PlannedChange> {
    vec![PlannedChange::Edit(ChangeToCheck {
        path: path.into(),
        expected_revision: revision.into(),
        edits: vec![EditToCheck {
            old_text: "a".into(),
            new_text: "b".into(),
        }],
    })]
}

#[test]
fn a_proposal_becomes_a_prepared_plan() {
    let mut store = PlanStore::default();
    let now = Instant::now();
    let plan = store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-x"), now).unwrap();
    assert_eq!(plan.state, PlanState::Prepared, "the agent's own approval is enough (owner ruling)");
    // With Litria's own review on, a plan waits for a person instead.
    let mut reviewed = PlanStore::with_policy(ReviewPolicy::PersonReview);
    let waiting = reviewed.propose(Principal::Test, "ws-1", planned("a.ts", "b1-x"), now).unwrap();
    assert_eq!(waiting.state, PlanState::PendingReview);
    assert_eq!(plan.expires_in_seconds, PLAN_TTL_SECONDS);
    assert!(plan.plan_id.starts_with("plan-"));
    assert_eq!(plan.plan_id.len(), PLAN_ID_LENGTH);
    assert!(plan.plan_id[5..].chars().all(|c| c.is_ascii_hexdigit()));
    assert!(store.get(&plan.plan_id, Principal::Test, "ws-1").is_some());
}

#[test]
fn the_same_proposal_while_pending_is_the_same_plan() {
    let mut store = PlanStore::default();
    let now = Instant::now();
    let first = store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-x"), now).unwrap();
    let later = now + Duration::from_secs(30);
    let again = store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-x"), later).unwrap();
    assert_eq!(again.plan_id, first.plan_id, "no second review request");
    assert_eq!(again.expires_in_seconds, PLAN_TTL_SECONDS - 30, "the original expiry stands");
    // A different proposal, workspace or requester is a different plan.
    let other_text = store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-y"), now).unwrap();
    let other_epoch = store.propose(Principal::Test, "ws-2", planned("a.ts", "b1-x"), now).unwrap();
    let other_principal = store.propose(Principal::Dev, "ws-1", planned("a.ts", "b1-x"), now).unwrap();
    let ids = [&first.plan_id, &other_text.plan_id, &other_epoch.plan_id, &other_principal.plan_id];
    assert_eq!(ids.iter().collect::<HashSet<_>>().len(), 4);
    assert_eq!(store.len(), 4);
}

#[test]
fn pending_plans_are_bounded_per_requester_and_never_evicted_early() {
    let mut store = PlanStore::default();
    let now = Instant::now();
    for index in 0..MAX_PENDING_PER_PRINCIPAL {
        store.propose(Principal::Test, "ws-1", planned("a.ts", &format!("b1-{index}")), now).unwrap();
    }
    let refused = store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-more"), now).unwrap_err();
    assert_eq!(refused.code, ErrorCode::Busy);
    assert_eq!(store.len(), MAX_PENDING_PER_PRINCIPAL, "nothing was dropped to make room");
    // Another requester is not affected.
    store.propose(Principal::Dev, "ws-1", planned("a.ts", "b1-more"), now).unwrap();
    // Once they expire, there is room again.
    store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-more"), now + PLAN_TTL).unwrap();
}

#[test]
fn a_plan_expires_ten_minutes_after_preparation() {
    let mut store = PlanStore::default();
    let now = Instant::now();
    let plan = store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-x"), now).unwrap();
    let stored = store.get(&plan.plan_id, Principal::Test, "ws-1").unwrap();
    assert!(!stored.is_expired(now + PLAN_TTL - Duration::from_millis(1)));
    assert!(stored.is_expired(now + PLAN_TTL));
    // An expired plan is not reused: proposing again makes a new one.
    let again = store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-x"), now + PLAN_TTL).unwrap();
    assert_ne!(again.plan_id, plan.plan_id);
    // It is remembered (as expired) for a while, then forgotten.
    assert!(store.get(&plan.plan_id, Principal::Test, "ws-1").is_some());
    store.propose(Principal::Test, "ws-1", planned("z.ts", "b1-z"), now + PLAN_TTL + EXPIRED_RETENTION).unwrap();
    assert!(store.get(&plan.plan_id, Principal::Test, "ws-1").is_none());
}

#[test]
fn another_requesters_plan_is_indistinguishable_from_none() {
    let mut store = PlanStore::default();
    let plan = store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-x"), Instant::now()).unwrap();
    assert!(store.get(&plan.plan_id, Principal::Dev, "ws-1").is_none());
    assert!(store.get(&plan.plan_id, Principal::Test, "ws-2").is_none());
    assert!(store.get("plan-00000000000000000000000000000000", Principal::Test, "ws-1").is_none());
}

#[test]
fn a_seconds_remainder_is_rounded_up() {
    let mut store = PlanStore::default();
    let now = Instant::now();
    let plan = store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-x"), now).unwrap();
    let stored = store.get(&plan.plan_id, Principal::Test, "ws-1").unwrap();
    let almost = now + PLAN_TTL - Duration::from_millis(400);
    assert_eq!(stored.summary("id", almost).expires_in_seconds, 1, "time left never reads as 0");
}

// --- The handler, in a bound workspace ---------------------------------------

fn temp_root(tag: &str) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("litria-api-changes-{tag}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(dir.join("src")).unwrap();
    fs::write(dir.join("src/a.ts"), "export const a = 1;\n").unwrap();
    fs::write(dir.join("src/b.ts"), "export const b = 2;\n").unwrap();
    fs::write(dir.join(".env"), "SECRET=1\n").unwrap();
    fs::canonicalize(dir).unwrap()
}

fn change(path: &str) -> ProposedChange {
    ProposedChange::TextEdit {
        path: path.into(),
        expected_revision: "b1-x".into(),
        edits: vec![TextEdit {
            old_text: "1".into(),
            new_text: "10".into(),
        }],
    }
}

fn request(paths: &[&str]) -> ChangesPrepareRequest {
    ChangesPrepareRequest {
        changes: paths.iter().map(|path| change(path)).collect(),
    }
}

/// A bound workspace and a bridge whose editor answers every change with
/// `outcome_for(path)`, recording each request it was asked.
struct Session {
    root: PathBuf,
    epoch: String,
    bridge: &'static Bridge,
    asked: Arc<Mutex<Vec<Value>>>,
    _serial: std::sync::MutexGuard<'static, ()>,
}

impl Session {
    fn new(tag: &str, outcome_for: fn(&str) -> Value) -> Self {
        let serial = db::serial_guard();
        let root = temp_root(tag);
        let (_, epoch) = db::open_workspace_db(&root).unwrap();
        let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
        let asked = Arc::new(Mutex::new(Vec::new()));
        let record = Arc::clone(&asked);
        answering(bridge, move |event: &BridgeRequestEvent| {
            assert_eq!(event.op, "editor.checkChanges");
            record.lock().unwrap().push(event.request.clone());
            let changes: Vec<Value> = event.request["changes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|change| {
                    let path = change["path"].as_str().unwrap();
                    let mut answer = outcome_for(path);
                    answer["path"] = json!(path);
                    answer
                })
                .collect();
            Some(json!({ "kind": "result", "result": { "changes": changes } }).to_string())
        });
        bridge.attach(&epoch, Some(&epoch)).unwrap();
        Self { root, epoch, bridge, asked, _serial: serial }
    }

    fn context(&self) -> CallContext {
        CallContext {
            principal: Principal::Test,
            grant: Grant::default(),
            epoch: self.epoch.clone(),
        }
    }

    fn prepare(&self, request: ChangesPrepareRequest, store: &Mutex<PlanStore>) -> Result<ChangesPrepareResult, ContractError> {
        handle_with(&self.context(), request, self.bridge, store, Instant::now(), || Some(false))
    }

    fn asked_paths(&self) -> Vec<Vec<String>> {
        self.asked
            .lock()
            .unwrap()
            .iter()
            .map(|request| {
                request["changes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|change| change["path"].as_str().unwrap().to_string())
                    .collect()
            })
            .collect()
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        let _ = db::close_workspace_db();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn ready(_: &str) -> Value {
    json!({ "outcome": "ready" })
}

#[test]
fn ready_changes_become_one_plan_and_the_editor_is_asked_once() {
    let session = Session::new("ready", ready);
    let store = Mutex::new(PlanStore::default());
    let result = session.prepare(request(&["src/a.ts", "src/b.ts"]), &store).unwrap();
    let plan = result.plan.expect("every change is ready");
    assert_eq!(plan.state, PlanState::Prepared);
    assert!(result.changes.iter().all(ChangeCheck::is_ready));
    assert_eq!(session.asked_paths(), [vec!["src/a.ts".to_string(), "src/b.ts".to_string()]]);
    let stored = store.lock().unwrap();
    let stored = stored.get(&plan.plan_id, Principal::Test, &session.epoch).unwrap();
    assert_eq!(stored.changes.len(), 2);
    let PlannedChange::Edit(first) = &stored.changes[0] else { panic!("an edit") };
    assert_eq!(first.edits[0].new_text, "10");
}

#[test]
fn a_withheld_or_invalid_path_never_reaches_the_editor_and_no_plan_is_made() {
    let session = Session::new("policy", ready);
    let store = Mutex::new(PlanStore::default());
    let result = session.prepare(request(&["src/a.ts", ".env", "../outside.ts"]), &store).unwrap();
    assert!(result.plan.is_none());
    assert_eq!(
        result.changes,
        [
            ChangeCheck::Ready { path: "src/a.ts".into() },
            ChangeCheck::Denied { path: ".env".into() },
            ChangeCheck::InvalidPath { path: "../outside.ts".into() },
        ]
    );
    assert_eq!(session.asked_paths(), [vec!["src/a.ts".to_string()]], "only the allowed path was sent");
    assert_eq!(store.lock().unwrap().len(), 0);

    // Nothing allowed at all: the editor is not asked.
    let session_paths_before = session.asked_paths().len();
    let result = session.prepare(request(&[".env"]), &store).unwrap();
    assert_eq!(result.changes, [ChangeCheck::Denied { path: ".env".into() }]);
    assert_eq!(session.asked_paths().len(), session_paths_before);
}

#[test]
fn any_change_not_ready_means_no_plan() {
    fn mixed(path: &str) -> Value {
        match path {
            "src/a.ts" => json!({ "outcome": "ready" }),
            _ => json!({ "outcome": "conflict", "revision": "b1-now" }),
        }
    }
    let session = Session::new("mixed", mixed);
    let store = Mutex::new(PlanStore::default());
    let result = session.prepare(request(&["src/a.ts", "src/b.ts"]), &store).unwrap();
    assert!(result.plan.is_none());
    assert_eq!(
        result.changes[1],
        ChangeCheck::Conflict { path: "src/b.ts".into(), revision: "b1-now".into() }
    );
    assert_eq!(store.lock().unwrap().len(), 0, "nothing awaits review");
}

#[test]
fn a_read_only_workspace_refuses_agent_edits() {
    let session = Session::new("read-only", ready);
    let store = Mutex::new(PlanStore::default());
    let error = handle_with(&session.context(), request(&["src/a.ts"]), session.bridge, &store, Instant::now(), || {
        Some(true)
    })
    .unwrap_err();
    assert_eq!(error.code, ErrorCode::NotReady);
    assert!(session.asked_paths().is_empty(), "the editor was never asked");
}

#[test]
fn a_reply_that_answers_other_paths_is_malformed() {
    fn other(_: &str) -> Value {
        json!({ "outcome": "ready" })
    }
    let session = Session::new("malformed", other);
    // Swap the editor's answer for one naming a path Rust never asked about.
    let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
    answering(bridge, |_| {
        Some(json!({ "kind": "result", "result": { "changes": [{ "outcome": "ready", "path": "src/elsewhere.ts" }] } }).to_string())
    });
    bridge.attach(&session.epoch, Some(&session.epoch)).unwrap();
    let store = Mutex::new(PlanStore::default());
    let error = handle_with(&session.context(), request(&["src/a.ts"]), bridge, &store, Instant::now(), || Some(false))
        .unwrap_err();
    assert_eq!(error.code, ErrorCode::Internal);
    assert_eq!(store.lock().unwrap().len(), 0);
}

#[test]
fn two_spellings_of_one_document_are_refused() {
    let session = Session::new("spellings", ready);
    if !make_dir_link(&session.root.join("lnk"), &session.root.join("src")) {
        eprintln!("skipping: cannot create a directory link here");
        return;
    }
    let store = Mutex::new(PlanStore::default());
    let error = session.prepare(request(&["src/a.ts", "lnk/a.ts"]), &store).unwrap_err();
    assert_eq!(error.code, ErrorCode::InvalidParams);
    assert!(!error.message.contains("a.ts"), "the message names positions, never paths");
    remove_dir_link(&session.root.join("lnk"));
}

#[cfg(windows)]
fn make_dir_link(link: &Path, target: &Path) -> bool {
    std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn remove_dir_link(link: &Path) {
    let _ = fs::remove_dir(link);
}

#[cfg(unix)]
fn make_dir_link(link: &Path, target: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[cfg(unix)]
fn remove_dir_link(link: &Path) {
    let _ = fs::remove_file(link);
}

// --- W2b: the review seam and the outcome ----------------------------------------

use crate::contracts::project_api::changes_apply::{ChangeOutcome, ChangesApplyRequest, Effect};
use std::sync::atomic::{AtomicUsize, Ordering};

/// An editor attached for `epoch` that answers `editor.applyChanges` with
/// `reply(paths)` (None: never answers), counting the requests it receives.
fn applying_editor(
    epoch: &str,
    deadline: Duration,
    reply: fn(&[String]) -> Option<Value>,
) -> (&'static Bridge, Arc<AtomicUsize>) {
    let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(deadline)));
    let calls = Arc::new(AtomicUsize::new(0));
    let counted = Arc::clone(&calls);
    answering(bridge, move |event: &BridgeRequestEvent| {
        assert_eq!(event.op, "editor.applyChanges");
        counted.fetch_add(1, Ordering::SeqCst);
        let paths: Vec<String> = event.request["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|change| change["path"].as_str().unwrap().to_string())
            .collect();
        reply(&paths).map(|value| value.to_string())
    });
    bridge.attach(epoch, Some(epoch)).unwrap();
    (bridge, calls)
}

fn all_applied(paths: &[String]) -> Option<Value> {
    let changes: Vec<Value> = paths
        .iter()
        .map(|path| json!({ "outcome": "applied", "path": path, "revision": format!("b1-new-{path}") }))
        .collect();
    Some(json!({ "kind": "result", "result": { "applied": true, "changes": changes } }))
}

fn store_with_plan(epoch: &str, now: Instant) -> (Mutex<PlanStore>, String) {
    // Its epochs name no open workspace: the bare store, without the journal.
    let mut store = PlanStore::without_journal();
    let plan = store
        .propose(Principal::Test, epoch, [planned("src/a.ts", "b1-x"), planned("src/b.ts", "b1-y")].concat(), now)
        .unwrap();
    (Mutex::new(store), plan.plan_id)
}

#[test]
fn approving_applies_the_plan_once_and_records_each_revision() {
    let now = Instant::now();
    let (store, id) = store_with_plan("ws-1", now);
    let (bridge, calls) = applying_editor("ws-1", Duration::from_secs(5), all_applied);
    let reviewed = review_with(&id, Decision::Approve, "ws-1", bridge, &store, now);
    assert_eq!(reviewed.state, PlanState::Applied);
    assert_eq!(
        reviewed.changes,
        [
            ChangeOutcome::Applied { path: "src/a.ts".into(), revision: "b1-new-src/a.ts".into() },
            ChangeOutcome::Applied { path: "src/b.ts".into(), revision: "b1-new-src/b.ts".into() },
        ]
    );
    // Approving again changes nothing and asks the editor nothing.
    let again = review_with(&id, Decision::Approve, "ws-1", bridge, &store, now);
    assert_eq!(again, reviewed);
    assert_eq!(calls.load(Ordering::SeqCst), 1, "applied at most once");
    // The requester sees the outcome.
    let (state, changes) = store.lock().unwrap().status(&id, Principal::Test, "ws-1", now);
    assert_eq!((state, changes.len()), (PlanState::Applied, 2));
}

#[test]
fn two_approvals_at_once_apply_once() {
    fn slow(paths: &[String]) -> Option<Value> {
        std::thread::sleep(Duration::from_millis(150));
        all_applied(paths)
    }
    let now = Instant::now();
    let (store, id) = store_with_plan("ws-1", now);
    let store: &'static Mutex<PlanStore> = Box::leak(Box::new(store));
    let (bridge, calls) = applying_editor("ws-1", Duration::from_secs(5), slow);
    let reviewers: Vec<_> = (0..4)
        .map(|_| {
            let id = id.clone();
            std::thread::spawn(move || review_with(&id, Decision::Approve, "ws-1", bridge, store, now).state)
        })
        .collect();
    let states: Vec<PlanState> = reviewers.into_iter().map(|reviewer| reviewer.join().unwrap()).collect();
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one claim won; the editor applied once");
    assert!(states.contains(&PlanState::Applied), "{states:?}");
    assert!(states.iter().all(|state| matches!(state, PlanState::Applied | PlanState::Applying)), "{states:?}");
}

#[test]
fn rejecting_ends_the_plan_and_nothing_applies_after() {
    let now = Instant::now();
    let (store, id) = store_with_plan("ws-1", now);
    let (bridge, calls) = applying_editor("ws-1", Duration::from_secs(5), all_applied);
    assert_eq!(review_with(&id, Decision::Reject, "ws-1", bridge, &store, now).state, PlanState::Rejected);
    assert_eq!(review_with(&id, Decision::Approve, "ws-1", bridge, &store, now).state, PlanState::Rejected);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn an_expired_plan_cannot_be_approved() {
    let now = Instant::now();
    let (store, id) = store_with_plan("ws-1", now);
    let (bridge, calls) = applying_editor("ws-1", Duration::from_secs(5), all_applied);
    let later = now + PLAN_TTL;
    assert_eq!(review_with(&id, Decision::Approve, "ws-1", bridge, &store, later).state, PlanState::Expired);
    assert_eq!(review_with(&id, Decision::Reject, "ws-1", bridge, &store, later).state, PlanState::Expired);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert_eq!(store.lock().unwrap().status(&id, Principal::Test, "ws-1", later).0, PlanState::Expired);
}

#[test]
fn a_document_that_changed_meanwhile_is_a_conflict_and_nothing_applies() {
    fn changed(paths: &[String]) -> Option<Value> {
        Some(json!({ "kind": "result", "result": { "applied": false, "changes": [
            { "outcome": "ready", "path": paths[0] },
            { "outcome": "conflict", "path": paths[1], "revision": "b1-typed" }
        ] } }))
    }
    let now = Instant::now();
    let (store, id) = store_with_plan("ws-1", now);
    let (bridge, _) = applying_editor("ws-1", Duration::from_secs(5), changed);
    let reviewed = review_with(&id, Decision::Approve, "ws-1", bridge, &store, now);
    assert_eq!(reviewed.state, PlanState::Conflict);
    assert_eq!(
        reviewed.changes,
        [
            ChangeOutcome::Ready { path: "src/a.ts".into() },
            ChangeOutcome::Conflict { path: "src/b.ts".into(), revision: "b1-typed".into() },
        ]
    );
}

#[test]
fn an_outcome_litria_cannot_know_is_needs_review_never_failed() {
    fn silent(_: &[String]) -> Option<Value> {
        None
    }
    fn other_documents(_: &[String]) -> Option<Value> {
        all_applied(&["src/elsewhere.ts".to_string()])
    }
    fn refuses_internally(_: &[String]) -> Option<Value> {
        Some(json!({ "kind": "error", "code": "internal", "message": "boom" }))
    }
    let cases: [(fn(&[String]) -> Option<Value>, &str); 3] = [
        (silent, "no answer in time"),
        (other_documents, "an answer about other documents"),
        (refuses_internally, "an internal failure after delivery"),
    ];
    for (reply, what) in cases {
        let now = Instant::now();
        let (store, id) = store_with_plan("ws-1", now);
        let (bridge, calls) = applying_editor("ws-1", Duration::from_millis(150), reply);
        let first = review_with(&id, Decision::Approve, "ws-1", bridge, &store, now).state;
        assert_eq!(first, PlanState::NeedsReview, "{what}");
        // Never retried.
        let again = review_with(&id, Decision::Approve, "ws-1", bridge, &store, now).state;
        assert_eq!(again, PlanState::NeedsReview, "{what}");
        assert_eq!(calls.load(Ordering::SeqCst), 1, "{what}");
    }
}

#[test]
fn a_request_that_never_reached_the_editor_failed_with_nothing_applied() {
    fn refused(_: &[String]) -> Option<Value> {
        Some(json!({ "kind": "error", "code": "workspaceChanged", "message": "moved on" }))
    }
    // Not attached for this workspace: never delivered.
    let now = Instant::now();
    let (store, id) = store_with_plan("ws-1", now);
    let detached: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
    assert_eq!(review_with(&id, Decision::Approve, "ws-1", detached, &store, now).state, PlanState::Failed);
    // Delivered, but refused before the editor acted (the workspace moved on).
    let (store, id) = store_with_plan("ws-1", now);
    let (bridge, _) = applying_editor("ws-1", Duration::from_secs(5), refused);
    assert_eq!(review_with(&id, Decision::Approve, "ws-1", bridge, &store, now).state, PlanState::Failed);
}

#[test]
fn a_reviewer_of_another_workspace_finds_nothing() {
    let now = Instant::now();
    let (store, id) = store_with_plan("ws-1", now);
    let (bridge, calls) = applying_editor("ws-2", Duration::from_secs(5), all_applied);
    assert_eq!(review_with(&id, Decision::Approve, "ws-2", bridge, &store, now).state, PlanState::Unknown);
    assert_eq!(review_with(&id, Decision::Reject, "ws-2", bridge, &store, now).state, PlanState::Unknown);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn a_reviewed_plan_no_longer_counts_as_pending() {
    let now = Instant::now();
    let (store, id) = store_with_plan("ws-1", now);
    let (bridge, _) = applying_editor("ws-1", Duration::from_secs(5), all_applied);
    review_with(&id, Decision::Approve, "ws-1", bridge, &store, now);
    // The same changes again are a new proposal, not the applied plan.
    let again = store
        .lock()
        .unwrap()
        .propose(Principal::Test, "ws-1", [planned("src/a.ts", "b1-x"), planned("src/b.ts", "b1-y")].concat(), now)
        .unwrap();
    assert_ne!(again.plan_id, id);
}

/// The agent's own approval is enough (owner ruling): its apply applies its
/// prepared plan, at most once, and reports each new revision.
#[test]
fn the_agents_apply_applies_its_prepared_plan_once() {
    let session = Session::new("apply-tool", ready);
    let store = Mutex::new(PlanStore::default());
    let prepared = session.prepare(request(&["src/a.ts"]), &store).unwrap().plan.unwrap();
    let (editor, calls) = applying_editor(&session.epoch, Duration::from_secs(5), all_applied);
    let ask = |id: &str, principal| {
        let mut context = session.context();
        context.principal = principal;
        handle_apply_with(&context, ChangesApplyRequest { plan_id: id.into() }, editor, &store, Instant::now()).unwrap()
    };
    // Another requester's plan, or a guessed id, is unknown and runs nothing.
    assert_eq!(ask(&prepared.plan_id, Principal::Dev).state, PlanState::Unknown, "another requester's plan");
    assert_eq!(ask("plan-guess", Principal::Test).state, PlanState::Unknown);
    assert_eq!(calls.load(Ordering::SeqCst), 0);

    let applied = ask(&prepared.plan_id, Principal::Test);
    assert_eq!(applied.state, PlanState::Applied);
    assert_eq!(applied.effects, [Effect::Buffer]);
    assert_eq!(
        applied.changes,
        [ChangeOutcome::Applied { path: "src/a.ts".into(), revision: "b1-new-src/a.ts".into() }]
    );
    let again = ask(&prepared.plan_id, Principal::Test);
    assert_eq!(again, applied, "asking again returns the same outcome");
    assert_eq!(calls.load(Ordering::SeqCst), 1, "applied at most once");
}

/// With Litria's own review on, the agent's apply waits for a person and
/// never applies; once a person approves, it reports the outcome.
#[test]
fn with_litria_review_on_the_agents_apply_waits_for_a_person() {
    let session = Session::new("apply-review", ready);
    let store = Mutex::new(PlanStore::with_policy(ReviewPolicy::PersonReview));
    let prepared = session.prepare(request(&["src/a.ts"]), &store).unwrap().plan.unwrap();
    assert_eq!(prepared.state, PlanState::PendingReview);
    let (editor, calls) = applying_editor(&session.epoch, Duration::from_secs(5), all_applied);
    let ask = || {
        handle_apply_with(&session.context(), ChangesApplyRequest { plan_id: prepared.plan_id.clone() }, editor, &store, Instant::now())
            .unwrap()
    };
    let waiting = ask();
    assert_eq!(waiting.state, PlanState::PendingReview);
    assert!(waiting.effects.is_empty() && waiting.changes.is_empty());
    assert_eq!(calls.load(Ordering::SeqCst), 0, "never applied without the person");
    review_with(&prepared.plan_id, Decision::Approve, &session.epoch, editor, &store, Instant::now());
    let applied = ask();
    assert_eq!(applied.state, PlanState::Applied);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

/// The agent's apply and a person's approval racing for one plan: one claim
/// wins, the editor applies once.
#[test]
fn an_agents_apply_racing_a_persons_approval_applies_once() {
    fn slow(paths: &[String]) -> Option<Value> {
        std::thread::sleep(Duration::from_millis(150));
        all_applied(paths)
    }
    let now = Instant::now();
    let (store, id) = store_with_plan("ws-1", now);
    let store: &'static Mutex<PlanStore> = Box::leak(Box::new(store));
    let (editor, calls) = applying_editor("ws-1", Duration::from_secs(5), slow);
    let agent = {
        let id = id.clone();
        std::thread::spawn(move || {
            let claimed = lock(store).claim(&id, "ws-1", now, Claimant::Agent(Principal::Test));
            claimed.map(|changes| execute(&id, changes, "ws-1", editor, store).state)
        })
    };
    let person = {
        let id = id.clone();
        std::thread::spawn(move || review_with(&id, Decision::Approve, "ws-1", editor, store, now).state)
    };
    let agent = agent.join().unwrap();
    let person = person.join().unwrap();
    assert_eq!(calls.load(Ordering::SeqCst), 1, "one claim won: {agent:?} / {person:?}");
    assert_eq!(lock(store).status(&id, Principal::Test, "ws-1", now).0, PlanState::Applied);
}

// --- W3b: new files ---------------------------------------------------------------

use crate::contracts::project_api_bridge::files::FileToCreate as PlannedFile;

fn create(path: &str, text: &str) -> ProposedChange {
    ProposedChange::FileCreate { path: path.into(), text: text.into() }
}

/// The policy answers first, then the disk: a withheld file that exists reads
/// as `denied`, never `exists` (no oracle). New files never reach the editor.
#[test]
fn a_new_file_is_judged_by_the_policy_then_the_disk() {
    let session = Session::new("create-prepare", ready);
    let store = Mutex::new(PlanStore::default());
    let request = ChangesPrepareRequest {
        changes: vec![create("src/new.ts", ""), create("src/a.ts", ""), create(".env", ""), create("../out.ts", "")],
    };
    let result = session.prepare(request, &store).unwrap();
    assert!(result.plan.is_none());
    assert_eq!(
        result.changes,
        [
            ChangeCheck::Ready { path: "src/new.ts".into() },
            ChangeCheck::Exists { path: "src/a.ts".into() },
            ChangeCheck::Denied { path: ".env".into() },
            ChangeCheck::InvalidPath { path: "../out.ts".into() },
        ]
    );
    assert!(session.asked_paths().is_empty(), "the editor is never asked about new files");

    // With an edit beside it: one plan, in request order; only the edit was
    // checked with the editor.
    let request = ChangesPrepareRequest { changes: vec![create("src/new.ts", "N\n"), change("src/b.ts")] };
    let plan = session.prepare(request, &store).unwrap().plan.expect("both are ready");
    assert_eq!(session.asked_paths(), [vec!["src/b.ts".to_string()]]);
    let stored = store.lock().unwrap();
    let stored = stored.get(&plan.plan_id, Principal::Test, &session.epoch).unwrap();
    assert_eq!(stored.changes[0], PlannedChange::Create(PlannedFile { path: "src/new.ts".into(), text: "N\n".into() }));
    assert!(matches!(&stored.changes[1], PlannedChange::Edit(edit) if edit.path == "src/b.ts"));
}

/// A plan never both edits a document and creates it.
#[test]
fn an_edit_and_a_create_of_one_document_are_refused() {
    let session = Session::new("create-twice", ready);
    let store = Mutex::new(PlanStore::default());
    let request = ChangesPrepareRequest { changes: vec![change("src/a.ts"), create("src/a.ts", "")] };
    assert_eq!(session.prepare(request, &store).unwrap_err().code, ErrorCode::InvalidParams);
}

/// What the scripted frontend did, in order: `apply` or `create`.
type Calls = Arc<Mutex<Vec<&'static str>>>;

/// A frontend for the session's workspace: `editor.applyChanges` answered by
/// `apply(paths)`, `files.create` by `create(files)` — each `None` never
/// answers — recording the order of the requests.
fn frontend(
    session: &Session,
    deadline: Duration,
    apply: fn(&[String]) -> Option<Value>,
    create: fn(&[Value]) -> Option<Value>,
) -> (&'static Bridge, Calls) {
    let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(deadline)));
    let calls: Calls = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&calls);
    answering(bridge, move |event: &BridgeRequestEvent| {
        let reply = match event.op.as_str() {
            "editor.applyChanges" => {
                record.lock().unwrap().push("apply");
                let paths: Vec<String> = event.request["changes"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|change| change["path"].as_str().unwrap().to_string())
                    .collect();
                apply(&paths)
            }
            "files.create" => {
                record.lock().unwrap().push("create");
                create(event.request["files"].as_array().unwrap())
            }
            other => panic!("unexpected {other}"),
        };
        reply.map(|value| value.to_string())
    });
    bridge.attach(&session.epoch, Some(&session.epoch)).unwrap();
    (bridge, calls)
}

/// The filesystem write manager, for real: the native create-if-absent.
fn create_for_real(files: &[Value]) -> Option<Value> {
    let (_, root) = db::workspace_binding().unwrap();
    let root = root.unwrap();
    let files: Vec<Value> = files
        .iter()
        .map(|file| {
            let path = file["path"].as_str().unwrap();
            let outcome = match crate::project_ops::create_project_file(root.to_str().unwrap(), path, file["text"].as_str().unwrap()) {
                Ok(crate::project_ops::CreateFileOutcome::Created) => "created",
                Ok(crate::project_ops::CreateFileOutcome::Exists) => "exists",
                Err(_) => "failed",
            };
            json!({ "outcome": outcome, "path": path })
        })
        .collect();
    Some(json!({ "kind": "result", "result": { "files": files } }))
}

/// Something took every name after Rust's own last check.
fn all_taken(files: &[Value]) -> Option<Value> {
    let files: Vec<Value> = files.iter().map(|file| json!({ "outcome": "exists", "path": file["path"] })).collect();
    Some(json!({ "kind": "result", "result": { "files": files } }))
}

fn never(_: &[Value]) -> Option<Value> {
    None
}

fn nothing_applied(paths: &[String]) -> Option<Value> {
    let changes: Vec<Value> =
        paths.iter().map(|path| json!({ "outcome": "conflict", "path": path, "revision": "b1-now" })).collect();
    Some(json!({ "kind": "result", "result": { "applied": false, "changes": changes } }))
}

impl Session {
    fn plan(&self, changes: Vec<ProposedChange>, store: &Mutex<PlanStore>) -> String {
        self.prepare(ChangesPrepareRequest { changes }, store).unwrap().plan.expect("ready").plan_id
    }

    fn apply(&self, plan_id: &str, bridge: &Bridge, store: &Mutex<PlanStore>) -> ChangesApplyResult {
        handle_apply_with(&self.context(), ChangesApplyRequest { plan_id: plan_id.into() }, bridge, store, Instant::now())
            .unwrap()
    }
}

#[test]
fn a_new_file_is_created_with_its_revision() {
    let session = Session::new("create-apply", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![create("src/util/new.ts", "N\n")], &store);
    assert!(!session.root.join("src/util").exists(), "nothing is created before the apply");
    let (bridge, calls) = frontend(&session, Duration::from_secs(5), all_applied, create_for_real);
    let applied = session.apply(&id, bridge, &store);
    assert_eq!(applied.state, PlanState::Applied);
    assert_eq!(applied.effects, [Effect::Disk]);
    assert_eq!(
        applied.changes,
        [ChangeOutcome::Created { path: "src/util/new.ts".into(), revision: disk_revision(b"N\n") }]
    );
    assert_eq!(fs::read_to_string(session.root.join("src/util/new.ts")).unwrap(), "N\n");
    assert_eq!(*calls.lock().unwrap(), ["create"], "a plan without edits never asks the editor");
}

/// Edits land first, all or none; a name taken after Rust's last check is
/// answered by the manager, and the plan is partial.
#[test]
fn edits_land_before_new_files_and_a_name_taken_in_between_is_partial() {
    let session = Session::new("create-partial", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![create("src/new.ts", "N\n"), change("src/a.ts")], &store);
    let (bridge, calls) = frontend(&session, Duration::from_secs(5), all_applied, all_taken);
    let result = session.apply(&id, bridge, &store);
    assert_eq!(result.state, PlanState::Partial);
    assert_eq!(result.effects, [Effect::Buffer]);
    assert_eq!(
        result.changes,
        [
            ChangeOutcome::Exists { path: "src/new.ts".into() },
            ChangeOutcome::Applied { path: "src/a.ts".into(), revision: "b1-new-src/a.ts".into() },
        ]
    );
    assert_eq!(*calls.lock().unwrap(), ["apply", "create"]);
    assert_eq!(session.apply(&id, bridge, &store), result, "never retried");
    assert_eq!(calls.lock().unwrap().len(), 2);
}

/// A name taken between the proposal and the apply: nothing lands.
#[test]
fn a_name_taken_after_the_proposal_means_nothing_lands() {
    let session = Session::new("create-taken", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![change("src/a.ts"), create("src/new.ts", "N\n")], &store);
    fs::write(session.root.join("src/new.ts"), "MINE").unwrap();
    let (bridge, calls) = frontend(&session, Duration::from_secs(5), all_applied, create_for_real);
    let result = session.apply(&id, bridge, &store);
    assert_eq!(result.state, PlanState::Conflict);
    assert!(result.effects.is_empty());
    assert_eq!(
        result.changes,
        [ChangeOutcome::Ready { path: "src/a.ts".into() }, ChangeOutcome::Exists { path: "src/new.ts".into() }]
    );
    assert!(calls.lock().unwrap().is_empty(), "neither owner was asked");
    assert_eq!(fs::read_to_string(session.root.join("src/new.ts")).unwrap(), "MINE");
}

/// Edits that no longer apply: the new files are not created either.
#[test]
fn edits_in_conflict_leave_new_files_uncreated() {
    let session = Session::new("create-after-conflict", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![change("src/a.ts"), create("src/new.ts", "N\n")], &store);
    let (bridge, calls) = frontend(&session, Duration::from_secs(5), nothing_applied, create_for_real);
    let result = session.apply(&id, bridge, &store);
    assert_eq!(result.state, PlanState::Conflict);
    assert_eq!(result.changes[1], ChangeOutcome::Ready { path: "src/new.ts".into() });
    assert_eq!(*calls.lock().unwrap(), ["apply"]);
    assert!(!session.root.join("src/new.ts").exists());
}

/// The manager got the request and never answered: files may exist. The
/// edits that are known stay reported; the plan is never retried.
#[test]
fn a_create_answer_lost_after_delivery_needs_review() {
    let session = Session::new("create-lost", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![change("src/a.ts"), create("src/new.ts", "N\n")], &store);
    let (bridge, calls) = frontend(&session, Duration::from_millis(40), all_applied, never);
    let result = session.apply(&id, bridge, &store);
    assert_eq!(result.state, PlanState::NeedsReview);
    assert_eq!(result.changes, [ChangeOutcome::Applied { path: "src/a.ts".into(), revision: "b1-new-src/a.ts".into() }]);
    assert_eq!(result.effects, [Effect::Buffer], "the edits that landed are still reported");
    assert_eq!(session.apply(&id, bridge, &store).state, PlanState::NeedsReview);
    assert_eq!(calls.lock().unwrap().len(), 2, "never retried");
}

/// The request never reached the manager: no file was created.
#[test]
fn a_create_that_never_reached_the_manager_failed() {
    let session = Session::new("create-undelivered", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![create("src/new.ts", "N\n")], &store);
    let unreachable: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
    let result = session.apply(&id, unreachable, &store);
    assert_eq!(result.state, PlanState::Failed);
    assert_eq!(result.changes, [ChangeOutcome::Failed { path: "src/new.ts".into() }]);
    assert!(!session.root.join("src/new.ts").exists());
}

/// Creating files may take five times the bridge's usual wait; edits may not.
#[test]
fn creating_files_may_take_longer_than_the_usual_wait() {
    fn slow_create(files: &[Value]) -> Option<Value> {
        std::thread::sleep(Duration::from_millis(250));
        create_for_real(files)
    }
    fn slow_apply(paths: &[String]) -> Option<Value> {
        std::thread::sleep(Duration::from_millis(250));
        all_applied(paths)
    }
    let session = Session::new("create-slow", ready);
    let store = Mutex::new(PlanStore::default());
    let created = session.plan(vec![create("src/new.ts", "N\n")], &store);
    let (bridge, _) = frontend(&session, Duration::from_millis(100), slow_apply, slow_create);
    assert_eq!(session.apply(&created, bridge, &store).state, PlanState::Applied, "within five times 100 ms");
    let edited = session.plan(vec![change("src/a.ts")], &store);
    assert_eq!(session.apply(&edited, bridge, &store).state, PlanState::NeedsReview, "edits wait 100 ms");
}

/// A folder swapped for a link after the proposal, pointing into a withheld
/// folder inside the project: the create must never write through it
/// (withheld paths are never written; adversarial check, W3b).
#[test]
fn a_folder_swapped_for_a_link_after_the_proposal_is_never_written_through() {
    let session = Session::new("create-swap", ready);
    fs::create_dir_all(session.root.join(".git")).unwrap();
    fs::create_dir_all(session.root.join("sub")).unwrap();
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![create("sub/new.ts", "N\n")], &store);
    fs::rename(session.root.join("sub"), session.root.join("sub-old")).unwrap();
    if !make_dir_link(&session.root.join("sub"), &session.root.join(".git")) {
        eprintln!("skipping: cannot create a directory link here");
        return;
    }
    let (bridge, calls) = frontend(&session, Duration::from_secs(5), all_applied, create_for_real);
    let result = session.apply(&id, bridge, &store);
    let wrote_through = session.root.join(".git/new.ts").exists();
    remove_dir_link(&session.root.join("sub"));
    assert!(!wrote_through, "the new file was written into the withheld .git folder: {result:?}");
    assert_eq!(result.state, PlanState::Conflict);
    assert_eq!(result.changes, [ChangeOutcome::Denied { path: "sub/new.ts".into() }]);
    assert!(calls.lock().unwrap().is_empty(), "the manager was never asked");
}

/// A new file named through a folder link is withheld at the proposal: a
/// link can lead anywhere, so it is never written through.
#[test]
fn a_new_file_through_a_folder_link_is_denied() {
    let session = Session::new("create-link", ready);
    if !make_dir_link(&session.root.join("lnk"), &session.root.join("src")) {
        eprintln!("skipping: cannot create a directory link here");
        return;
    }
    let store = Mutex::new(PlanStore::default());
    let result = session.prepare(ChangesPrepareRequest { changes: vec![create("lnk/new.ts", "")] }, &store);
    remove_dir_link(&session.root.join("lnk"));
    assert_eq!(result.unwrap().changes, [ChangeCheck::Denied { path: "lnk/new.ts".into() }]);
    assert!(!session.root.join("src/new.ts").exists());
}

/// On a case-insensitive volume another spelling of a withheld file is that
/// file: denied, never `exists`.
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn another_spelling_of_a_withheld_file_is_denied() {
    let session = Session::new("create-case", ready);
    let store = Mutex::new(PlanStore::default());
    let result = session.prepare(ChangesPrepareRequest { changes: vec![create(".ENV", "")] }, &store).unwrap();
    assert_eq!(result.changes, [ChangeCheck::Denied { path: ".ENV".into() }]);
}

/// An answer about other files than the ones asked: what the manager did is
/// unknown, so the plan needs review and is never retried.
#[test]
fn a_create_answer_about_other_files_needs_review() {
    fn elsewhere(_: &[Value]) -> Option<Value> {
        Some(json!({ "kind": "result", "result": { "files": [{ "outcome": "created", "path": "src/other.ts" }] } }))
    }
    let session = Session::new("create-elsewhere", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![create("src/new.ts", "N\n")], &store);
    let (bridge, _) = frontend(&session, Duration::from_secs(5), all_applied, elsewhere);
    let result = session.apply(&id, bridge, &store);
    assert_eq!(result.state, PlanState::NeedsReview);
    assert!(result.changes.is_empty() && result.effects.is_empty());
}

// --- W3c: edits to documents the editor does not hold ---------------------------

fn edits(pairs: &[(&str, &str)]) -> Vec<EditToCheck> {
    pairs.iter().map(|(old, new)| EditToCheck { old_text: (*old).into(), new_text: (*new).into() }).collect()
}

/// The disk planner is the editor's (`planBufferEdit`): in order, each
/// `oldText` exactly once in the text the earlier edits leave, overlapping
/// occurrences counting.
#[test]
fn disk_edits_plan_exactly_as_the_editor_plans() {
    assert_eq!(plan_text_edits("let a = 1;\n", &edits(&[("1", "2")])).unwrap(), "let a = 2;\n");
    assert_eq!(plan_text_edits("ab", &edits(&[("a", "x"), ("xb", "y")])).unwrap(), "y", "the second edit sees the first");
    assert_eq!(plan_text_edits("x", &edits(&[("x", "")])).unwrap(), "", "a deletion");
    assert_eq!(plan_text_edits("abc", &edits(&[("z", "y")])), Err(EditMiss::NoMatch(0)));
    assert_eq!(plan_text_edits("a a", &edits(&[("a", "b")])), Err(EditMiss::Ambiguous(0)));
    assert_eq!(plan_text_edits("aaa", &edits(&[("aa", "b")])), Err(EditMiss::Ambiguous(0)), "an overlap counts");
    assert_eq!(plan_text_edits("ok", &edits(&[("o", "0"), ("k", "")])).unwrap(), "0");
    assert_eq!(plan_text_edits("\u{e9}\u{e9}", &edits(&[("\u{e9}", "e")])), Err(EditMiss::Ambiguous(0)), "multibyte text");
    assert_eq!(plan_text_edits("caf\u{e9}\n", &edits(&[("\u{e9}", "e")])).unwrap(), "cafe\n");
    assert_eq!(plan_text_edits("a\r\nb", &edits(&[("a\r\nb", "c")])).unwrap(), "c", "line endings as read");
}

fn not_in_session(_: &str) -> Value {
    json!({ "outcome": "notInSession" })
}

fn disk_edit(path: &str, revision: &str, pairs: &[(&str, &str)]) -> ProposedChange {
    ProposedChange::TextEdit {
        path: path.into(),
        expected_revision: revision.into(),
        edits: pairs.iter().map(|(old, new)| TextEdit { old_text: (*old).into(), new_text: (*new).into() }).collect(),
    }
}

fn revision_of(text: &str) -> String {
    disk_revision(text.as_bytes())
}

#[test]
fn an_edit_the_editor_cannot_take_is_judged_against_the_disk() {
    let session = Session::new("open-prepare", not_in_session);
    fs::write(session.root.join("src/logo.png"), [0x89u8, 0x50, 0x4e, 0x47, 0, 0, 1]).unwrap();
    fs::write(session.root.join("src/big.ts"), "x".repeat(MAX_OPEN_FILE_BYTES + 1)).unwrap();
    let store = Mutex::new(PlanStore::default());
    let a = revision_of("export const a = 1;\n");
    let request = ChangesPrepareRequest {
        changes: vec![
            disk_edit("src/a.ts", "d1-stale", &[("1", "2")]),
            disk_edit("src/b.ts", &revision_of("export const b = 2;\n"), &[("nothing", "x")]),
            disk_edit("src/logo.png", "d1-x", &[("P", "Q")]),
            disk_edit("src/big.ts", "d1-x", &[("x", "y")]),
            disk_edit("src/gone.ts", "d1-x", &[("x", "y")]),
        ],
    };
    let result = session.prepare(request, &store).unwrap();
    assert!(result.plan.is_none());
    assert_eq!(
        result.changes,
        [
            ChangeCheck::Conflict { path: "src/a.ts".into(), revision: a.clone() },
            ChangeCheck::NoMatch { path: "src/b.ts".into(), edit: 0 },
            ChangeCheck::NotEditable { path: "src/logo.png".into() },
            ChangeCheck::NotEditable { path: "src/big.ts".into() },
            ChangeCheck::NotInSession { path: "src/gone.ts".into() },
        ]
    );

    // At the revision the agent read: one plan, opened from disk when applied.
    let plan = session
        .prepare(ChangesPrepareRequest { changes: vec![disk_edit("src/a.ts", &a, &[("1", "2")])] }, &store)
        .unwrap()
        .plan
        .expect("ready");
    let stored = store.lock().unwrap();
    let stored = stored.get(&plan.plan_id, Principal::Test, &session.epoch).unwrap();
    assert_eq!(
        stored.changes,
        [PlannedChange::Open(OpenEdit { path: "src/a.ts".into(), base_revision: a, edits: edits(&[("1", "2")]) })]
    );
}

/// A frontend for the opening path: `canvas.showFiles` answered by `show`,
/// `editor.applyChanges` by `apply(request)`; the requests are recorded.
fn opener(
    session: &Session,
    show: fn(&[Value]) -> Option<Value>,
    apply: fn(&Value) -> Option<Value>,
) -> (&'static Bridge, Arc<Mutex<Vec<(String, Value)>>>) {
    let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
    let asked = Arc::new(Mutex::new(Vec::new()));
    let record = Arc::clone(&asked);
    answering(bridge, move |event: &BridgeRequestEvent| {
        record.lock().unwrap().push((event.op.clone(), event.request.clone()));
        let reply = match event.op.as_str() {
            "canvas.showFiles" => show(event.request["paths"].as_array().unwrap()),
            "editor.applyChanges" => apply(&event.request),
            other => panic!("unexpected {other}"),
        };
        reply.map(|value| value.to_string())
    });
    bridge.attach(&session.epoch, Some(&session.epoch)).unwrap();
    (bridge, asked)
}

fn all_shown(paths: &[Value]) -> Option<Value> {
    let files: Vec<Value> = paths.iter().map(|path| json!({ "outcome": "shown", "path": path })).collect();
    Some(json!({ "kind": "result", "result": { "files": files } }))
}

fn opened(request: &Value) -> Option<Value> {
    let entries: Vec<Value> = request["opens"]
        .as_array()
        .unwrap()
        .iter()
        .map(|open| json!({ "outcome": "applied", "path": open["path"], "revision": "b1-opened" }))
        .collect();
    Some(json!({ "kind": "result", "result": { "applied": true, "changes": entries } }))
}

#[test]
fn applying_shows_the_file_then_opens_it_with_the_edit_and_writes_nothing() {
    let session = Session::new("open-apply", not_in_session);
    let store = Mutex::new(PlanStore::default());
    let a = revision_of("export const a = 1;\n");
    let id = session.plan(vec![disk_edit("src/a.ts", &a, &[("1", "2")])], &store);
    let (bridge, asked) = opener(&session, all_shown, opened);
    let result = session.apply(&id, bridge, &store);
    assert_eq!(result.state, PlanState::Applied);
    assert_eq!(result.effects, [Effect::Buffer]);
    assert_eq!(result.changes, [ChangeOutcome::Applied { path: "src/a.ts".into(), revision: "b1-opened".into() }]);
    let asked = asked.lock().unwrap();
    assert_eq!(asked.iter().map(|(op, _)| op.as_str()).collect::<Vec<_>>(), ["canvas.showFiles", "editor.applyChanges"]);
    assert_eq!(asked[0].1, json!({ "paths": ["src/a.ts"] }));
    assert_eq!(
        asked[1].1,
        json!({ "changes": [], "opens": [{ "path": "src/a.ts", "baseText": "export const a = 1;\n", "text": "export const a = 2;\n" }] })
    );
    assert_eq!(fs::read_to_string(session.root.join("src/a.ts")).unwrap(), "export const a = 1;\n", "nothing on disk");
}

#[test]
fn a_file_changed_on_disk_after_the_proposal_opens_nothing() {
    let session = Session::new("open-stale", not_in_session);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![disk_edit("src/a.ts", &revision_of("export const a = 1;\n"), &[("1", "2")])], &store);
    fs::write(session.root.join("src/a.ts"), "export const a = 5;\n").unwrap();
    let (bridge, asked) = opener(&session, all_shown, opened);
    let result = session.apply(&id, bridge, &store);
    assert_eq!(result.state, PlanState::Conflict);
    assert_eq!(
        result.changes,
        [ChangeOutcome::Conflict { path: "src/a.ts".into(), revision: revision_of("export const a = 5;\n") }]
    );
    assert!(asked.lock().unwrap().is_empty(), "neither owner was asked");
}

#[test]
fn a_file_the_canvas_cannot_show_is_unavailable_and_nothing_applies() {
    fn none_shown(paths: &[Value]) -> Option<Value> {
        let files: Vec<Value> = paths.iter().map(|path| json!({ "outcome": "failed", "path": path })).collect();
        Some(json!({ "kind": "result", "result": { "files": files } }))
    }
    let session = Session::new("open-unshown", not_in_session);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![disk_edit("src/a.ts", &revision_of("export const a = 1;\n"), &[("1", "2")])], &store);
    let (bridge, asked) = opener(&session, none_shown, opened);
    let result = session.apply(&id, bridge, &store);
    assert_eq!(result.state, PlanState::Failed);
    assert_eq!(result.changes, [ChangeOutcome::Unavailable { path: "src/a.ts".into() }]);
    assert_eq!(asked.lock().unwrap().len(), 1, "the editor was never asked");
}

/// The user opened and typed in the file meanwhile: its tab holds text of its
/// own, so nothing is applied.
#[test]
fn a_file_opened_meanwhile_is_a_conflict() {
    fn typed(request: &Value) -> Option<Value> {
        let entries: Vec<Value> = request["opens"]
            .as_array()
            .unwrap()
            .iter()
            .map(|open| json!({ "outcome": "conflict", "path": open["path"], "revision": "b1-typed" }))
            .collect();
        Some(json!({ "kind": "result", "result": { "applied": false, "changes": entries } }))
    }
    let session = Session::new("open-typed", not_in_session);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![disk_edit("src/a.ts", &revision_of("export const a = 1;\n"), &[("1", "2")])], &store);
    let (bridge, _) = opener(&session, all_shown, typed);
    let result = session.apply(&id, bridge, &store);
    assert_eq!(result.state, PlanState::Conflict);
    assert_eq!(result.changes, [ChangeOutcome::Conflict { path: "src/a.ts".into(), revision: "b1-typed".into() }]);
}

/// A folder swapped for a link into a withheld folder after the proposal: the
/// apply's read goes through the reader's policy and refuses, so no withheld
/// text ever reaches the editor (W3c adversarial check).
#[test]
fn a_folder_swapped_for_a_link_after_a_disk_edit_proposal_opens_nothing() {
    let session = Session::new("open-swap", not_in_session);
    fs::create_dir_all(session.root.join("sub")).unwrap();
    fs::create_dir_all(session.root.join(".git")).unwrap();
    fs::write(session.root.join("sub/x.ts"), "export const x = 1;\n").unwrap();
    fs::write(session.root.join(".git/x.ts"), "export const x = 1;\n").unwrap();
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![disk_edit("sub/x.ts", &revision_of("export const x = 1;\n"), &[("1", "2")])], &store);
    fs::rename(session.root.join("sub"), session.root.join("sub-old")).unwrap();
    if !make_dir_link(&session.root.join("sub"), &session.root.join(".git")) {
        eprintln!("skipping: cannot create a directory link here");
        return;
    }
    let (bridge, asked) = opener(&session, all_shown, opened);
    let result = session.apply(&id, bridge, &store);
    remove_dir_link(&session.root.join("sub"));
    assert_eq!(result.state, PlanState::Conflict, "{result:?}");
    assert_eq!(result.changes, [ChangeOutcome::Denied { path: "sub/x.ts".into() }]);
    assert!(asked.lock().unwrap().is_empty(), "the withheld text never reached the frontend");
}

// --- W4a: durable operations ------------------------------------------------------

use crate::contracts::project_api::operations_get::OperationsGetRequest;

impl Session {
    fn get(&self, epoch: &str, principal: Principal, id: &str, store: &Mutex<PlanStore>) -> OperationsGetResult {
        let context = CallContext { principal, grant: Grant::default(), epoch: epoch.to_string() };
        handle_operations_get_with(&context, OperationsGetRequest { operation_id: id.into() }, store, Instant::now()).unwrap()
    }

    /// Close the project and open it again: a new epoch, as after a restart.
    fn reopen(&self) -> String {
        db::close_workspace_db().unwrap();
        db::open_workspace_db(&self.root).unwrap().1
    }
}

#[test]
fn an_applied_plan_is_recorded_and_read_back() {
    let session = Session::new("ops-applied", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![change("src/a.ts")], &store);
    let (editor, _) = applying_editor(&session.epoch, Duration::from_secs(5), all_applied);
    let applied = session.apply(&id, editor, &store);
    assert_eq!(applied.state, PlanState::Applied);

    let record = operations::load(&session.epoch, &id, Principal::Test).unwrap().expect("recorded");
    assert_eq!(record.state, PlanState::Applied);
    assert_eq!(record.changes[0].phase, Phase::Confirmed);
    let read = session.get(&session.epoch, Principal::Test, &id, &store);
    assert_eq!(read.state, PlanState::Applied);
    assert_eq!(read.effects, [Effect::Buffer]);
    assert_eq!(read.changes, applied.changes);
    assert!(!read.interrupted);
    assert_eq!(session.get(&session.epoch, Principal::Dev, &id, &store).state, PlanState::Unknown, "another requester's");
}

/// R5: the intent and the start are on disk before the editor is asked.
#[test]
fn the_record_shows_a_change_started_before_its_owner_is_asked() {
    static SEEN: Mutex<Option<(PlanState, Phase)>> = Mutex::new(None);
    fn observing(paths: &[String]) -> Option<Value> {
        let (epoch, _) = db::workspace_binding().unwrap();
        let ids: Vec<String> = db::with_workspace_db(&epoch, |conn| {
            let mut statement = conn.prepare("SELECT id FROM api_operations").map_err(crate::db::DbError::sqlite("ids"))?;
            let ids = statement.query_map([], |row| row.get(0)).map_err(crate::db::DbError::sqlite("ids"))?;
            Ok(ids.flatten().collect())
        })
        .unwrap();
        let record = operations::load(&epoch, &ids[0], Principal::Test).unwrap().unwrap();
        *SEEN.lock().unwrap() = Some((record.state, record.changes[0].phase));
        all_applied(paths)
    }
    let session = Session::new("ops-started", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![change("src/a.ts")], &store);
    let (editor, _) = applying_editor(&session.epoch, Duration::from_secs(5), observing);
    assert_eq!(session.apply(&id, editor, &store).state, PlanState::Applied);
    assert_eq!(*SEEN.lock().unwrap(), Some((PlanState::Applying, Phase::Started)));
}

/// R5: no intent on record, no effect.
#[test]
fn a_plan_whose_intent_cannot_be_recorded_does_nothing() {
    let mut store = PlanStore::default();
    let now = Instant::now();
    let plan = store.propose(Principal::Test, "ws-nowhere", planned("src/a.ts", "b1-x"), now).unwrap();
    let store = Mutex::new(store);
    let _serial = db::serial_guard();
    let (editor, calls) = applying_editor("ws-nowhere", Duration::from_secs(5), all_applied);
    let reviewed = review_with(&plan.plan_id, Decision::Approve, "ws-nowhere", editor, &store, now);
    assert_eq!(reviewed.state, PlanState::Failed);
    assert_eq!(calls.load(Ordering::SeqCst), 0, "the editor was never asked");
}

/// R5: the process stops after the change started and before the editor
/// answered. After a restart the operation is interrupted and needs review;
/// asking to apply it again reads the record and never applies it.
#[test]
fn a_restart_mid_apply_reads_as_interrupted_and_is_never_replayed() {
    let session = Session::new("ops-crash", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![change("src/a.ts"), create("src/new.ts", "N\n")], &store);
    // What execute records, up to the moment the process ends.
    let changes = lock(&store).claim(&id, &session.epoch, Instant::now(), Claimant::Agent(Principal::Test)).unwrap();
    let mut journal = Journal::new(&id, Some(Principal::Test), &session.epoch, &changes);
    assert!(journal.intend());
    assert!(journal.start(&[RecordedKind::Edit, RecordedKind::Open]));

    let epoch = session.reopen();
    let after = Mutex::new(PlanStore::default());
    let read = session.get(&epoch, Principal::Test, &id, &after);
    assert_eq!(read.state, PlanState::NeedsReview);
    assert!(read.interrupted);
    assert!(read.changes.is_empty(), "no outcome is known");

    let (editor, calls) = applying_editor(&epoch, Duration::from_secs(5), all_applied);
    let context = CallContext { principal: Principal::Test, grant: Grant::default(), epoch: epoch.clone() };
    let again = handle_apply_with(&context, ChangesApplyRequest { plan_id: id.clone() }, editor, &after, Instant::now()).unwrap();
    assert_eq!(again.state, PlanState::NeedsReview);
    assert_eq!(calls.load(Ordering::SeqCst), 0, "never replayed");
    assert!(!session.root.join("src/new.ts").exists());
}

/// R5: the process stops after the intent and before anything started: after a
/// restart the operation reads as interrupted, and nothing was done.
#[test]
fn a_restart_after_the_intent_alone_reads_as_failed() {
    let session = Session::new("ops-intent", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![change("src/a.ts")], &store);
    let changes = lock(&store).claim(&id, &session.epoch, Instant::now(), Claimant::Agent(Principal::Test)).unwrap();
    assert!(Journal::new(&id, Some(Principal::Test), &session.epoch, &changes).intend());
    let epoch = session.reopen();
    let read = session.get(&epoch, Principal::Test, &id, &Mutex::new(PlanStore::default()));
    assert_eq!(read.state, PlanState::Failed);
    assert!(read.interrupted);
    assert_eq!(read.changes, [ChangeOutcome::Ready { path: "src/a.ts".into() }]);
}

/// A finished operation is read back after a restart exactly as it finished.
#[test]
fn a_finished_operation_survives_a_restart() {
    let session = Session::new("ops-finished", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![change("src/a.ts")], &store);
    let (editor, _) = applying_editor(&session.epoch, Duration::from_secs(5), all_applied);
    let applied = session.apply(&id, editor, &store);
    let epoch = session.reopen();
    let read = session.get(&epoch, Principal::Test, &id, &Mutex::new(PlanStore::default()));
    assert_eq!((read.state, read.changes, read.interrupted), (PlanState::Applied, applied.changes, false));
}

/// A lost answer is recorded as such: needs review, the change still started.
#[test]
fn a_lost_answer_is_recorded_as_needing_review() {
    let session = Session::new("ops-lost", ready);
    let store = Mutex::new(PlanStore::default());
    let id = session.plan(vec![change("src/a.ts")], &store);
    let (editor, _) = applying_editor(&session.epoch, Duration::from_millis(40), |_| None);
    assert_eq!(session.apply(&id, editor, &store).state, PlanState::NeedsReview);
    let record = operations::load(&session.epoch, &id, Principal::Test).unwrap().unwrap();
    assert_eq!(record.state, PlanState::NeedsReview);
    assert_eq!((record.changes[0].phase, record.changes[0].outcome.clone()), (Phase::Started, None));
}
