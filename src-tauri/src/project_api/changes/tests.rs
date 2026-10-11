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
use crate::contracts::project_api::changes_prepare::{ChangeKind, ProposedChange, TextEdit};
use crate::contracts::project_api_bridge::BridgeRequestEvent;
use crate::project_api::bridge::testing::answering;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

// --- The store ---------------------------------------------------------------

fn planned(path: &str, revision: &str) -> Vec<ChangeToCheck> {
    vec![ChangeToCheck {
        path: path.into(),
        expected_revision: revision.into(),
        edits: vec![EditToCheck {
            old_text: "a".into(),
            new_text: "b".into(),
        }],
    }]
}

#[test]
fn a_proposal_becomes_a_plan_awaiting_review() {
    let mut store = PlanStore::default();
    let now = Instant::now();
    let plan = store.propose(Principal::Test, "ws-1", planned("a.ts", "b1-x"), now).unwrap();
    assert_eq!(plan.state, PlanState::PendingReview);
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
    ProposedChange {
        kind: ChangeKind::TextEdit,
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
    assert_eq!(plan.state, PlanState::PendingReview);
    assert!(result.changes.iter().all(ChangeCheck::is_ready));
    assert_eq!(session.asked_paths(), [vec!["src/a.ts".to_string(), "src/b.ts".to_string()]]);
    let stored = store.lock().unwrap();
    let stored = stored.get(&plan.plan_id, Principal::Test, &session.epoch).unwrap();
    assert_eq!(stored.changes.len(), 2);
    assert_eq!(stored.changes[0].edits[0].new_text, "10");
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
