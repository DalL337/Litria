//! Build plan P6: `tools/call` over the REAL read catalog — the production
//! dispatcher and handlers, the workspace fence, the disclosure policy and
//! the owner bridge — with a test principal. Every committed request fixture
//! goes through the adapter: those the contract accepts must come back as
//! results whose `structuredContent` conforms to the published
//! `outputSchema`, and those it rejects as tool errors that conform to
//! `error.schema.json`. The frontend is scripted: it holds nothing open, so
//! every document is the file on disk.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::tests::{error_of, tool};
use super::*;
use crate::contracts::artifacts::{bridge_dir, committed_json_in, validator, FIXTURES_DIR};
use crate::contracts::context::{Grant, Principal};
use crate::contracts::fixtures::request_fixtures;
use crate::contracts::project_api::catalog;
use crate::contracts::project_api_bridge::BridgeRequestEvent;
use crate::db;
use crate::project_api::bridge::{self, testing::answering};

/// A workspace bound for one test, with the global bridge attached to the
/// scripted frontend. Dropping it detaches, closes and deletes, even when an
/// assertion fails.
struct Bound {
    root: PathBuf,
    epoch: String,
    generation: Option<String>,
    // Last: released only after the workspace is closed.
    _serial: std::sync::MutexGuard<'static, ()>,
}

impl Bound {
    fn new(tag: &str) -> Self {
        let serial = db::serial_guard();
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("litria-mcp-{tag}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(dir).unwrap();
        for (path, text) in [
            ("src/a.ts", "export const a = 1;\n"),
            ("src/b.ts", "import { a } from './a';\nexport const b = a + 1;\n"),
            ("src/auth.ts", "export function signIn() {}\n"),
            ("README.md", "# Sample\n"),
            (".env", "SECRET=1\n"),
        ] {
            put(&root, path, text);
        }
        let (_, epoch) = db::open_workspace_db(&root).unwrap();
        let bridge = bridge::global();
        answering(bridge, owner);
        let generation = bridge.attach(&epoch, Some(&epoch)).unwrap();
        Self {
            root,
            epoch,
            generation: Some(generation),
            _serial: serial,
        }
    }

    fn context(&self, grant: Grant) -> CallContext {
        CallContext {
            principal: Principal::Test,
            grant,
            epoch: self.epoch.clone(),
        }
    }

    fn detach(&mut self) {
        if let Some(generation) = self.generation.take() {
            bridge::global().detach(&generation);
        }
    }
}

impl Drop for Bound {
    fn drop(&mut self) {
        self.detach();
        let _ = db::close_workspace_db();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn put(root: &Path, path: &str, text: &str) {
    let full = root.join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, text).unwrap();
}

/// A frontend with nothing open but src/auth.ts (for proposals): no other
/// buffers, no selection, no wires; the language table is the committed
/// bridge fixture.
fn owner(event: &BridgeRequestEvent) -> Option<String> {
    let paths = |key: &str| -> Vec<Value> { event.request[key].as_array().cloned().unwrap_or_default() };
    let result = match event.op.as_str() {
        "editor.documents" => json!({
            "documents": paths("documents")
                .iter()
                .map(|query| json!({ "kind": "notBuffered", "path": query["path"], "state": "none" }))
                .collect::<Vec<_>>()
        }),
        "editor.bufferIndex" => json!({ "entries": [], "omitted": 0 }),
        "workspace.selection" => json!({ "selected": [], "omitted": 0 }),
        "workspace.graph" => json!({
            "nodes": paths("paths")
                .iter()
                .map(|path| json!({ "path": path, "onCanvas": false, "discoverable": true }))
                .collect::<Vec<_>>(),
            "edges": [],
            "discoveryInFlight": false,
            "omitted": 0
        }),
        // It holds src/auth.ts unchanged since it was read, and nothing else:
        // a proposal for it alone becomes a plan (build plan W2a).
        "editor.checkChanges" => json!({
            "changes": paths("changes")
                .iter()
                .map(|change| match change["path"].as_str() {
                    Some("src/auth.ts") => json!({ "outcome": "ready", "path": change["path"] }),
                    _ => json!({ "outcome": "notInSession", "path": change["path"] }),
                })
                .collect::<Vec<_>>()
        }),
        // Approved plans for src/auth.ts apply; anything else changed since.
        // Documents to open (W3c) open beside it.
        "editor.applyChanges" => {
            let changes = paths("changes");
            let opens = paths("opens");
            let held = changes.iter().all(|change| change["path"] == "src/auth.ts");
            json!({
                "applied": held,
                "changes": changes
                    .iter()
                    .map(|change| if held {
                        json!({ "outcome": "applied", "path": change["path"], "revision": "b1-applied" })
                    } else {
                        json!({ "outcome": "notInSession", "path": change["path"] })
                    })
                    .chain(opens.iter().map(|open| if held {
                        json!({ "outcome": "applied", "path": open["path"], "revision": "b1-opened" })
                    } else {
                        json!({ "outcome": "ready", "path": open["path"] })
                    }))
                    .collect::<Vec<_>>()
            })
        }
        // Every file it is asked to show gets a piece (W3c).
        "canvas.showFiles" => json!({
            "files": paths("paths")
                .iter()
                .map(|path| json!({ "outcome": "shown", "path": path }))
                .collect::<Vec<_>>()
        }),
        "languages.capabilities" => {
            let reply = committed_json_in(&bridge_dir().join(FIXTURES_DIR), "languages.capabilities.reply.json");
            return Some(reply.to_string());
        }
        // The filesystem write manager creates each file with the native
        // create-if-absent (build plan W3a), as the real one does (W3b).
        "files.create" => {
            let (_, root) = db::workspace_binding().unwrap();
            let root = root.unwrap();
            json!({
                "files": paths("files")
                    .iter()
                    .map(|file| {
                        let path = file["path"].as_str().unwrap();
                        let text = file["text"].as_str().unwrap();
                        let outcome = match crate::project_ops::create_project_file(root.to_str().unwrap(), path, text) {
                            Ok(crate::project_ops::CreateFileOutcome::Created) => "created",
                            Ok(crate::project_ops::CreateFileOutcome::Exists) => "exists",
                            Err(_) => "failed",
                        };
                        json!({ "outcome": outcome, "path": path })
                    })
                    .collect::<Vec<_>>()
            })
        }
        _ => return None,
    };
    Some(json!({ "kind": "result", "result": result }).to_string())
}

fn code_of(code: ErrorCode) -> Value {
    serde_json::to_value(code).unwrap()
}

#[test]
fn every_request_fixture_gets_a_conforming_answer_from_the_real_catalog() {
    let bound = Bound::new("fixtures");
    let dispatcher = crate::project_api::dispatcher();
    let context = bound.context(Grant::of(dispatcher.capabilities()));
    let list = tools_list();
    let error_schema = validator(&embedded::json(embedded::ERROR));
    let fixtures = request_fixtures();
    assert!(fixtures.iter().any(|f| f.accept) && fixtures.iter().any(|f| !f.accept));
    let mut failures = Vec::new();
    for fixture in &fixtures {
        let arguments: Value = serde_json::from_slice(&fixture.raw).expect("request fixtures are JSON");
        let params = json!({ "name": fixture.operation, "arguments": arguments });
        let label = &fixture.label;
        let result = match tools_call(dispatcher, &context, &params) {
            Ok(result) => result,
            Err(error) => {
                failures.push(format!("{label}: protocol error {error}"));
                continue;
            }
        };
        if result["resultType"] != "complete" {
            failures.push(format!("{label}: resultType {}", result["resultType"]));
        }
        if fixture.accept {
            if result["isError"] != false {
                failures.push(format!("{label}: accepted request answered with an error: {}", result["content"][0]["text"]));
                continue;
            }
            let structured = &result["structuredContent"];
            let output = validator(&tool(&list, &fixture.operation)["outputSchema"]);
            if let Err(error) = output.validate(structured) {
                failures.push(format!("{label}: structuredContent violates outputSchema: {error}"));
            }
            let text: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap_or("null")).unwrap();
            if &text != structured {
                failures.push(format!("{label}: text content differs from structuredContent"));
            }
        } else {
            if result["isError"] != true {
                failures.push(format!("{label}: rejected request answered as a success"));
                continue;
            }
            let error = error_of(&result);
            if !error_schema.is_valid(&error) {
                failures.push(format!("{label}: error violates {}: {error}", embedded::ERROR));
            }
            let expected = fixture.error_code.map(code_of).unwrap_or_else(|| code_of(ErrorCode::InvalidParams));
            if error["code"] != expected {
                failures.push(format!("{label}: code {} (expected {expected})", error["code"]));
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} fixtures:\n{}", failures.len(), fixtures.len(), failures.join("\n"));
}

/// The answers come from the workspace, not from samples: the file's real text
/// through the effective read (the editor holds nothing, so disk), and the
/// policy's denial of `.env`.
#[test]
fn the_real_handlers_answer_from_the_workspace() {
    let bound = Bound::new("real");
    let dispatcher = crate::project_api::dispatcher();
    let params = json!({
        "name": "litria_files_read",
        "arguments": { "documents": [{ "path": "src/a.ts" }, { "path": ".env" }] }
    });
    let result = tools_call(dispatcher, &bound.context(Grant::of(dispatcher.capabilities())), &params).unwrap();
    assert_eq!(result["isError"], false, "{result}");
    let documents = &result["structuredContent"]["documents"];
    assert_eq!(documents[0]["kind"], "read");
    assert_eq!(documents[0]["source"], "disk");
    assert_eq!(documents[0]["text"], "export const a = 1;\n");
    assert_eq!(documents[1], json!({ "kind": "denied", "path": ".env" }));
    assert!(!result.to_string().contains("SECRET"));
}

/// The real catalog's other error paths, each a conforming tool error: a
/// grant without the tool's capability (every tool), the editor gone, and
/// the workspace closed.
#[test]
fn denied_and_service_errors_are_conforming_tool_errors() {
    let mut bound = Bound::new("errors");
    let dispatcher = crate::project_api::dispatcher();
    let error_schema = validator(&embedded::json(embedded::ERROR));
    let conforming = |result: &Value, code: ErrorCode, what: &str| {
        assert_eq!(result["resultType"], "complete", "{what}");
        let error = error_of(result);
        assert!(error_schema.is_valid(&error), "{what}: {error}");
        assert_eq!(error["code"], code_of(code), "{what}: {error}");
    };

    for entry in catalog() {
        let grant = Grant::of(dispatcher.capabilities().filter(|capability| *capability != entry.capability));
        let result = tools_call(dispatcher, &bound.context(grant), &json!({ "name": entry.name, "arguments": {} })).unwrap();
        conforming(&result, ErrorCode::Denied, entry.name);
    }

    let everything = || Grant::of(dispatcher.capabilities());
    let context_call = json!({ "name": "litria_project_context", "arguments": {} });
    let live = tools_call(dispatcher, &bound.context(everything()), &context_call).unwrap();
    assert_eq!(live["isError"], false, "precondition: the context answers while the editor is attached");

    bound.detach();
    let result = tools_call(dispatcher, &bound.context(everything()), &context_call).unwrap();
    conforming(&result, ErrorCode::OwnerUnavailable, "editor detached");

    db::close_workspace_db().unwrap();
    let result = tools_call(dispatcher, &bound.context(everything()), &context_call).unwrap();
    conforming(&result, ErrorCode::NotReady, "workspace closed");
}

/// A ready proposal through the real catalog becomes a prepared plan,
/// and its result (plan present) conforms to the published schema; a proposal
/// that is not ready makes no plan (build plan W2a).
#[test]
fn a_ready_proposal_becomes_a_prepared_plan_through_the_real_catalog() {
    let bound = Bound::new("propose");
    let dispatcher = crate::project_api::dispatcher();
    let context = bound.context(Grant::of(dispatcher.capabilities()));
    let list = tools_list();
    let output = validator(&tool(&list, "litria_changes_prepare")["outputSchema"]);
    let propose = |path: &str| {
        json!({ "name": "litria_changes_prepare", "arguments": { "changes": [{
            "kind": "text.edit", "path": path, "expectedRevision": "b1-x",
            "edits": [{ "oldText": "signIn", "newText": "logIn" }]
        }]}})
    };

    let ready = tools_call(dispatcher, &context, &propose("src/auth.ts")).unwrap();
    assert_eq!(ready["isError"], false, "{ready}");
    let plan = &ready["structuredContent"]["plan"];
    assert_eq!(plan["state"], "prepared");
    assert_eq!(plan["expiresInSeconds"], 600);
    assert!(plan["planId"].as_str().unwrap().starts_with("plan-"));
    assert!(output.is_valid(&ready["structuredContent"]));
    let again = tools_call(dispatcher, &context, &propose("src/auth.ts")).unwrap();
    assert_eq!(again["structuredContent"]["plan"]["planId"], plan["planId"], "the same proposal is the same plan");

    // Not held by the editor: judged against the disk (W3c), where the agent's
    // revision is stale.
    let not_ready = tools_call(dispatcher, &context, &propose("src/b.ts")).unwrap();
    assert!(not_ready["structuredContent"].get("plan").is_none());
    assert_eq!(not_ready["structuredContent"]["changes"][0]["outcome"], "conflict");
    assert!(not_ready["structuredContent"]["changes"][0]["revision"].as_str().unwrap().starts_with("d1-"));
    let missing = tools_call(dispatcher, &context, &propose("src/missing.ts")).unwrap();
    assert_eq!(missing["structuredContent"]["changes"][0]["outcome"], "notInSession");

    let withheld = tools_call(dispatcher, &context, &propose(".env")).unwrap();
    assert_eq!(withheld["structuredContent"]["changes"][0]["outcome"], "denied");
    assert!(!withheld.to_string().contains("SECRET"));
    let annotations = &tool(&list, "litria_changes_prepare")["annotations"];
    assert_eq!(annotations["readOnlyHint"], false);
}

/// The whole loop through the real catalog (build plan W2b; owner ruling: the
/// agent's own approval is enough): an agent proposes, applies, and learns
/// each new revision; applying again changes nothing; a plan a person rejects
/// first is never applied. Every answer conforms to the schema.
#[test]
fn propose_and_apply_through_the_real_catalog() {
    let bound = Bound::new("loop");
    let dispatcher = crate::project_api::dispatcher();
    let context = bound.context(Grant::of(dispatcher.capabilities()));
    let list = tools_list();
    let output = validator(&tool(&list, "litria_changes_apply")["outputSchema"]);
    let propose = |old: &str, new: &str| {
        let prepared = tools_call(dispatcher, &context, &json!({ "name": "litria_changes_prepare", "arguments": { "changes": [{
            "kind": "text.edit", "path": "src/auth.ts", "expectedRevision": "b1-x",
            "edits": [{ "oldText": old, "newText": new }]
        }]}}))
        .unwrap();
        prepared["structuredContent"]["plan"]["planId"].as_str().unwrap().to_string()
    };
    let apply = |plan_id: &str| {
        tools_call(dispatcher, &context, &json!({ "name": "litria_changes_apply", "arguments": { "planId": plan_id } })).unwrap()
    };

    let plan_id = propose("signIn", "logIn");
    let applied = apply(&plan_id);
    let result = &applied["structuredContent"];
    assert_eq!(result["state"], "applied", "{result}");
    assert_eq!(result["effects"], json!(["buffer"]));
    assert_eq!(result["changes"][0], json!({ "outcome": "applied", "path": "src/auth.ts", "revision": "b1-applied" }));
    assert!(output.is_valid(result), "{result}");
    assert_eq!(apply(&plan_id)["structuredContent"], *result, "applying again returns the same outcome");

    // A person can still turn a plan down before the agent applies it.
    let rejected_id = propose("export", "export default");
    assert_eq!(crate::project_api::dev_review(&rejected_id, false).unwrap()["state"], "rejected");
    let rejected = apply(&rejected_id);
    assert_eq!(rejected["structuredContent"]["state"], "rejected");
    assert!(output.is_valid(&rejected["structuredContent"]));
    let annotations = &tool(&list, "litria_changes_apply")["annotations"];
    assert_eq!(annotations["readOnlyHint"], false);
}

/// New files through the real catalog (build plan W3b; owner ruling: created
/// on disk, only if nothing has the name). The policy answers before the disk
/// does, so a withheld file that exists reads as `denied`, never `exists`.
/// The revision the apply reports is the one `litria_files_read` then reads.
#[test]
fn new_files_through_the_real_catalog() {
    let bound = Bound::new("create");
    let dispatcher = crate::project_api::dispatcher();
    let context = bound.context(Grant::of(dispatcher.capabilities()));
    let list = tools_list();
    let prepare_output = validator(&tool(&list, "litria_changes_prepare")["outputSchema"]);
    let apply_output = validator(&tool(&list, "litria_changes_apply")["outputSchema"]);
    let call = |name: &str, arguments: Value| {
        let reply = tools_call(dispatcher, &context, &json!({ "name": name, "arguments": arguments })).unwrap();
        reply["structuredContent"].clone()
    };
    let create = |path: &str, text: &str| json!({ "kind": "file.create", "path": path, "text": text });

    // Taken names, withheld names, and invalid ones: no plan.
    let refused = call(
        "litria_changes_prepare",
        json!({ "changes": [create("README.md", ""), create(".env", ""), create("../out.ts", ""), create("src/new.ts", "")] }),
    );
    assert!(prepare_output.is_valid(&refused), "{refused}");
    assert!(refused.get("plan").is_none());
    assert_eq!(
        refused["changes"],
        json!([
            { "outcome": "exists", "path": "README.md" },
            { "outcome": "denied", "path": ".env" },
            { "outcome": "invalidPath", "path": "../out.ts" },
            { "outcome": "ready", "path": "src/new.ts" },
        ])
    );

    // A new file in a folder that does not exist yet, with an edit beside it.
    let text = "export const format = String;\n";
    let prepared = call(
        "litria_changes_prepare",
        json!({ "changes": [create("src/util/format.ts", text), {
            "kind": "text.edit", "path": "src/auth.ts", "expectedRevision": "b1-x",
            "edits": [{ "oldText": "signIn", "newText": "logIn" }]
        }]}),
    );
    let plan_id = prepared["plan"]["planId"].as_str().unwrap().to_string();
    assert!(!bound.root.join("src/util").exists(), "nothing is created before the apply");
    let applied = call("litria_changes_apply", json!({ "planId": plan_id }));
    assert!(apply_output.is_valid(&applied), "{applied}");
    assert_eq!(applied["state"], "applied", "{applied}");
    assert_eq!(applied["effects"], json!(["buffer", "disk"]));
    assert_eq!(applied["changes"][1], json!({ "outcome": "applied", "path": "src/auth.ts", "revision": "b1-applied" }));
    assert_eq!(applied["changes"][0]["outcome"], "created");
    assert_eq!(fs::read_to_string(bound.root.join("src/util/format.ts")).unwrap(), text);
    let read = call("litria_files_read", json!({ "documents": [{ "path": "src/util/format.ts" }] }));
    assert_eq!(read["documents"][0]["revision"], applied["changes"][0]["revision"], "{read}");
    assert_eq!(call("litria_changes_apply", json!({ "planId": plan_id })), applied, "applying again returns the same outcome");

    // A name taken between proposal and apply: nothing lands.
    let prepared = call("litria_changes_prepare", json!({ "changes": [create("src/late.ts", "export {};\n")] }));
    put(&bound.root, "src/late.ts", "MINE");
    let conflict = call("litria_changes_apply", json!({ "planId": prepared["plan"]["planId"] }));
    assert!(apply_output.is_valid(&conflict), "{conflict}");
    assert_eq!(conflict["state"], "conflict");
    assert_eq!(conflict["changes"], json!([{ "outcome": "exists", "path": "src/late.ts" }]));
    assert!(conflict.get("effects").is_none());
    assert_eq!(fs::read_to_string(bound.root.join("src/late.ts")).unwrap(), "MINE");
}

/// An edit to a document the editor does not hold, through the real catalog
/// (build plan W3c; owner ruling: it opens as an unsaved edit in a background
/// tab). It is judged against the disk revision the agent read; applying it
/// opens it with the edit, and nothing is written to disk.
#[test]
fn an_edit_to_a_closed_file_opens_it_through_the_real_catalog() {
    let bound = Bound::new("open");
    let dispatcher = crate::project_api::dispatcher();
    let context = bound.context(Grant::of(dispatcher.capabilities()));
    let list = tools_list();
    let prepare_output = validator(&tool(&list, "litria_changes_prepare")["outputSchema"]);
    let apply_output = validator(&tool(&list, "litria_changes_apply")["outputSchema"]);
    let call = |name: &str, arguments: Value| {
        let reply = tools_call(dispatcher, &context, &json!({ "name": name, "arguments": arguments })).unwrap();
        reply["structuredContent"].clone()
    };
    let read = call("litria_files_read", json!({ "documents": [{ "path": "src/b.ts" }] }));
    let revision = read["documents"][0]["revision"].as_str().unwrap().to_string();
    assert!(revision.starts_with("d1-"), "{read}");
    let edit = |old: &str, new: &str| json!({ "kind": "text.edit", "path": "src/b.ts", "expectedRevision": revision, "edits": [{ "oldText": old, "newText": new }] });

    let missing = call("litria_changes_prepare", json!({ "changes": [edit("a + 2", "a + 3")] }));
    assert_eq!(missing["changes"][0], json!({ "outcome": "noMatch", "path": "src/b.ts", "edit": 0 }));
    let prepared = call("litria_changes_prepare", json!({ "changes": [edit("a + 1", "a + 2")] }));
    assert!(prepare_output.is_valid(&prepared), "{prepared}");
    let plan_id = prepared["plan"]["planId"].as_str().unwrap().to_string();

    let applied = call("litria_changes_apply", json!({ "planId": plan_id }));
    assert!(apply_output.is_valid(&applied), "{applied}");
    assert_eq!(applied["state"], "applied", "{applied}");
    assert_eq!(applied["effects"], json!(["buffer"]));
    assert_eq!(applied["changes"], json!([{ "outcome": "applied", "path": "src/b.ts", "revision": "b1-opened" }]));
    assert_eq!(
        fs::read_to_string(bound.root.join("src/b.ts")).unwrap(),
        "import { a } from './a';\nexport const b = a + 1;\n",
        "nothing reaches the disk until the user saves"
    );

    // The file changed on disk after the proposal: nothing is opened.
    let stale = call("litria_changes_prepare", json!({ "changes": [edit("export const b", "export const bb")] }));
    put(&bound.root, "src/b.ts", "export const b = 9;\n");
    let conflict = call("litria_changes_apply", json!({ "planId": stale["plan"]["planId"] }));
    assert!(apply_output.is_valid(&conflict), "{conflict}");
    assert_eq!(conflict["state"], "conflict");
    assert!(conflict["changes"][0]["revision"].as_str().unwrap().starts_with("d1-"));
}

/// `litria_operations_get` through the real catalog (build plan W4a): a
/// read-only tool that reports an applied plan's standing and receipts, never
/// applies one, and answers `unknown` for an id that is not the requester's.
#[test]
fn an_operation_is_read_back_through_the_real_catalog() {
    let bound = Bound::new("operations");
    let dispatcher = crate::project_api::dispatcher();
    let context = bound.context(Grant::of(dispatcher.capabilities()));
    let list = tools_list();
    let output = validator(&tool(&list, "litria_operations_get")["outputSchema"]);
    assert_eq!(tool(&list, "litria_operations_get")["annotations"]["readOnlyHint"], true);
    let call = |name: &str, arguments: Value| {
        let reply = tools_call(dispatcher, &context, &json!({ "name": name, "arguments": arguments })).unwrap();
        reply["structuredContent"].clone()
    };
    let prepared = call("litria_changes_prepare", json!({ "changes": [{
        "kind": "text.edit", "path": "src/auth.ts", "expectedRevision": "b1-x",
        "edits": [{ "oldText": "signIn", "newText": "logIn" }]
    }]}));
    let plan_id = prepared["plan"]["planId"].as_str().unwrap().to_string();

    // Before it is applied, reading it never applies it.
    let waiting = call("litria_operations_get", json!({ "operationId": plan_id }));
    assert!(output.is_valid(&waiting), "{waiting}");
    assert_eq!(waiting["state"], "prepared");
    let still = call("litria_operations_get", json!({ "operationId": plan_id }));
    assert_eq!(still["state"], "prepared", "reading twice applied nothing");

    let applied = call("litria_changes_apply", json!({ "planId": plan_id }));
    let read = call("litria_operations_get", json!({ "operationId": plan_id }));
    assert!(output.is_valid(&read), "{read}");
    assert_eq!(read["state"], "applied");
    assert_eq!(read["changes"], applied["changes"]);
    assert_eq!(read["effects"], json!(["buffer"]));
    assert!(read.get("interrupted").is_none());

    let unknown = call("litria_operations_get", json!({ "operationId": "plan-00000000000000000000000000000000" }));
    assert_eq!(unknown, json!({ "operationId": "plan-00000000000000000000000000000000", "state": "unknown" }));
}
