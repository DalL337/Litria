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

/// A frontend with nothing open: no buffers, no selection, no wires; the
/// language table is the committed bridge fixture.
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
        "languages.capabilities" => {
            let reply = committed_json_in(&bridge_dir().join(FIXTURES_DIR), "languages.capabilities.reply.json");
            return Some(reply.to_string());
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
