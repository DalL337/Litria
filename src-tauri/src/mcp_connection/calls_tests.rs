//! Track T, slice T1b: tool calls over the real endpoint, against a real
//! workspace and the real catalog, as the session's own agent. The frontend is
//! scripted (`contracts::mcp::real_catalog::Bound`); everything from the pipe
//! to the handlers is the code the app runs.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::endpoint::{Read, Stream, WRITE_DEADLINE};
use super::protocol::INVALID_REQUEST;
use super::server::MAX_MESSAGE_BYTES;
use super::tests::FAST;
use super::*;
use crate::contracts::artifacts::validator;
use crate::contracts::boundary::MAX_REQUEST_BYTES;
use crate::contracts::fixtures::request_fixtures;
use crate::contracts::mcp::real_catalog::{owner, Bound};
use crate::contracts::mcp::{self, embedded, Revision};
use crate::contracts::project_api_bridge::BridgeRequestEvent;
use crate::db;
use crate::project_api::agent_grant;

const WAIT: Duration = Duration::from_secs(10);

/// A service that serves whatever project the database has open, as the app's.
fn real_service() -> Arc<Service> {
    Service::start(Box::new(app_epoch), FAST).unwrap()
}

/// What reading the connection produced.
#[derive(Debug)]
enum Heard {
    Line(Value),
    Quiet,
    Closed,
}

/// A scripted agent: the helper's side of the endpoint.
struct Agent {
    stream: Stream,
    pending: Vec<u8>,
}

impl Agent {
    /// Connected, past the hello and the `initialize` handshake.
    fn connect(service: &Service, token: &str) -> Agent {
        let mut agent = Agent { stream: Stream::connect(service.address()).unwrap(), pending: Vec::new() };
        agent.send(&json!({ "litria": "hello", "v": 1, "token": token }));
        assert_eq!(agent.next().expect("the hello is answered")["litria"], "ready");
        agent.send(&json!({"jsonrpc":"2.0","id":"init","method":"initialize","params":{
            "protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"t1b-test","version":"0"}}}));
        assert_eq!(agent.next().unwrap()["result"]["protocolVersion"], "2025-11-25");
        agent.send(&json!({"jsonrpc":"2.0","method":"notifications/initialized"}));
        agent
    }

    fn send(&self, message: &Value) {
        self.send_raw(message.to_string().as_bytes());
    }

    fn send_raw(&self, message: &[u8]) {
        let mut line = message.to_vec();
        line.push(b'\n');
        self.stream.write_all(&line, WRITE_DEADLINE).unwrap();
    }

    fn hear(&mut self, wait: Duration) -> Heard {
        let deadline = Instant::now() + wait;
        let mut chunk = [0u8; 16 * 1024];
        loop {
            if let Some(end) = self.pending.iter().position(|&byte| byte == b'\n') {
                let line: Vec<u8> = self.pending.drain(..=end).collect();
                return Heard::Line(serde_json::from_slice(&line[..line.len() - 1]).unwrap());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Heard::Quiet;
            }
            match self.stream.read(&mut chunk, Some(left)) {
                Ok(Read::Data(read)) => self.pending.extend_from_slice(&chunk[..read]),
                Ok(Read::TimedOut) => return Heard::Quiet,
                _ => return Heard::Closed,
            }
        }
    }

    /// The next line, or `None` once the connection has closed.
    fn next(&mut self) -> Option<Value> {
        match self.hear(WAIT) {
            Heard::Line(line) => Some(line),
            Heard::Closed => None,
            Heard::Quiet => panic!("nothing was heard within {WAIT:?}"),
        }
    }

    fn start_call(&self, id: u64, name: &str, arguments: Value) {
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}}));
    }

    /// Call a tool and wait for its answer.
    fn call(&mut self, id: u64, name: &str, arguments: Value) -> Value {
        self.start_call(id, name, arguments);
        let answer = self.next().expect("the call is answered");
        assert_eq!(answer["id"], id, "{answer}");
        answer
    }

    /// Ping and wait for the pong: everything sent before it has been read.
    fn sync(&mut self, id: &str) {
        self.send(&json!({"jsonrpc":"2.0","id":id,"method":"ping"}));
        let pong = self.next().expect("the ping is answered");
        assert_eq!(pong["id"], id, "{pong}");
    }
}

fn structured(answer: &Value) -> &Value {
    assert_eq!(answer["result"]["isError"], false, "{answer}");
    &answer["result"]["structuredContent"]
}

/// The contract error a tool execution error carries.
fn tool_error(answer: &Value) -> Value {
    assert_eq!(answer["result"]["isError"], true, "{answer}");
    serde_json::from_str(answer["result"]["content"][0]["text"].as_str().unwrap()).unwrap()
}

/// A scripted frontend that holds `editor.documents` (every read asks it)
/// until it is let go, or for at most the bridge's own wait.
#[derive(Clone, Default)]
struct Gate(Arc<(Mutex<bool>, Condvar)>);

impl Gate {
    fn hold(&self) {
        let (open, opened) = &*self.0;
        let deadline = Instant::now() + Duration::from_millis(1500);
        let mut is_open = open.lock().unwrap();
        while !*is_open {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return;
            }
            is_open = opened.wait_timeout(is_open, left).unwrap().0;
        }
    }

    fn open(&self) {
        let (open, opened) = &*self.0;
        *open.lock().unwrap() = true;
        opened.notify_all();
    }

    fn owner(&self) -> impl Fn(&BridgeRequestEvent) -> Option<String> + Send + Sync + 'static {
        let gate = self.clone();
        move |event| {
            if event.op == "editor.documents" {
                gate.hold();
            }
            owner(event)
        }
    }
}

fn read_a() -> Value {
    json!({ "documents": [{ "path": "src/a.ts" }] })
}

fn wait_until(what: &str, mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + WAIT;
    while !done() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(5));
    }
}

/// Build plan T1b: every committed request fixture through the real pipe, as
/// P6 ran them in process. A fixture whose message is over the line cap is
/// refused before anything parses it.
#[test]
fn every_request_fixture_gets_a_conforming_answer_through_the_pipe() {
    let bound = Bound::new("pipe-fixtures");
    let service = real_service();
    let session = service.start_session(&bound.epoch, agent_grant()).unwrap();
    let mut agent = Agent::connect(&service, &session.token);
    let list = mcp::tools_list(Revision::V2025_11_25, &agent_grant());
    let output_of = |name: &str| {
        let tool = list["tools"].as_array().unwrap().iter().find(|tool| tool["name"] == name).unwrap();
        validator(&tool["outputSchema"])
    };
    let error_schema = validator(&embedded::json(embedded::ERROR));
    let fixtures = request_fixtures();
    let mut failures = Vec::new();
    let mut over_the_cap = 0;
    for (id, fixture) in fixtures.iter().enumerate() {
        let label = &fixture.label;
        let arguments: Value = serde_json::from_slice(&fixture.raw).unwrap();
        let message = json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{
            "name": fixture.operation, "arguments": arguments }})
        .to_string();
        agent.send_raw(message.as_bytes());
        let answer = agent.next().expect("an answer");
        if message.len() > MAX_MESSAGE_BYTES {
            over_the_cap += 1;
            if fixture.accept || answer["error"]["code"] != INVALID_REQUEST || !answer["id"].is_null() {
                failures.push(format!("{label}: over the line cap, answered {answer}"));
            }
            continue;
        }
        if answer["id"] != id {
            failures.push(format!("{label}: answered for id {}", answer["id"]));
            continue;
        }
        let result = &answer["result"];
        if result.get("resultType").is_some() {
            failures.push(format!("{label}: a 2025-11-25 result carries resultType"));
        }
        if fixture.accept {
            if result["isError"] != false {
                failures.push(format!("{label}: accepted request answered with an error: {}", result["content"][0]["text"]));
            } else if let Err(error) = output_of(&fixture.operation).validate(&result["structuredContent"]) {
                failures.push(format!("{label}: structuredContent violates outputSchema: {error}"));
            }
        } else if result["isError"] != true {
            failures.push(format!("{label}: rejected request answered as a success"));
        } else {
            let error = tool_error(&answer);
            if !error_schema.is_valid(&error) {
                failures.push(format!("{label}: error violates the error schema: {error}"));
            }
            let expected = serde_json::to_value(
                fixture.error_code.unwrap_or(crate::contracts::error::ErrorCode::InvalidParams),
            )
            .unwrap();
            if error["code"] != expected {
                failures.push(format!("{label}: code {} (expected {expected})", error["code"]));
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} fixtures:\n{}", failures.len(), fixtures.len(), failures.join("\n"));
    assert!(over_the_cap > 0, "the over-budget fixture exercises the line cap");
    service.shutdown();
}

/// A session's plans and receipts are its own: another session can neither
/// apply its plan nor see its operation, and the session itself, connecting
/// again with the same token, finds its receipt (plan D6: a session of a
/// later run would not).
#[test]
fn a_sessions_plans_and_receipts_are_its_own() {
    let bound = Bound::new("pipe-binding");
    let service = real_service();
    let a = service.start_session(&bound.epoch, agent_grant()).unwrap();
    let b = service.start_session(&bound.epoch, agent_grant()).unwrap();
    let mut agent_a = Agent::connect(&service, &a.token);
    let mut agent_b = Agent::connect(&service, &b.token);
    let made = bound.root.join("src/made-by-a.ts");

    let prepared = agent_a.call(
        1,
        "litria_changes_prepare",
        json!({ "changes": [{ "kind": "file.create", "path": "src/made-by-a.ts", "text": "export {};\n" }] }),
    );
    let plan_id = structured(&prepared)["plan"]["planId"].as_str().unwrap().to_owned();

    let by_b = agent_b.call(1, "litria_changes_apply", json!({ "planId": plan_id }));
    assert_eq!(structured(&by_b)["state"], "unknown", "{by_b}");
    assert!(!made.exists(), "another session's apply changes nothing");
    let seen_by_b = agent_b.call(2, "litria_operations_get", json!({ "operationId": plan_id }));
    assert_eq!(structured(&seen_by_b)["state"], "unknown");

    let applied = agent_a.call(2, "litria_changes_apply", json!({ "planId": plan_id }));
    assert_eq!(structured(&applied)["state"], "applied", "{applied}");
    assert!(made.exists());

    let seen_by_b = agent_b.call(3, "litria_operations_get", json!({ "operationId": plan_id }));
    assert_eq!(structured(&seen_by_b)["state"], "unknown", "still not B's");
    drop(agent_a);
    let mut again = Agent::connect(&service, &a.token);
    let receipt = again.call(1, "litria_operations_get", json!({ "operationId": plan_id }));
    assert_eq!(structured(&receipt)["state"], "applied", "{receipt}");
    service.shutdown();
}

/// The person opens another project while an agent's apply waits on the
/// frontend. The real frontend then refuses (its per-reply check), and the
/// session ends with its project. The call answers `workspaceChanged`, or its
/// connection closes first; either way nothing lands in either project.
#[test]
fn a_project_switch_mid_call_lands_nothing_anywhere() {
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let other = std::env::temp_dir().join(format!("litria-mcp-other-{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&other).unwrap();
    let other: PathBuf = std::fs::canonicalize(other).unwrap();
    let switch_to = other.clone();
    let bound = Bound::with_owner("pipe-switch", move |event| {
        if event.op == "files.create" {
            db::open_workspace_db(&switch_to).unwrap();
            return Some(
                json!({ "kind": "error", "code": "workspaceChanged", "message": "the workspace changed" }).to_string(),
            );
        }
        owner(event)
    });
    let service = real_service();
    let session = service.start_session(&bound.epoch, agent_grant()).unwrap();
    let mut agent = Agent::connect(&service, &session.token);
    let prepared = agent.call(
        1,
        "litria_changes_prepare",
        json!({ "changes": [{ "kind": "file.create", "path": "src/never.ts", "text": "x\n" }] }),
    );
    let plan_id = structured(&prepared)["plan"]["planId"].as_str().unwrap().to_owned();
    agent.start_call(2, "litria_changes_apply", json!({ "planId": plan_id }));
    if let Some(answer) = agent.next() {
        assert_eq!(answer["id"], 2, "{answer}");
        assert_eq!(tool_error(&answer)["code"], "workspaceChanged", "{answer}");
    }
    assert!(!bound.root.join("src/never.ts").exists());
    assert!(!other.join("src/never.ts").exists());
    // The session ended with its project.
    wait_until("the session to end", || service.registry.session_count() == 0);
    service.shutdown();
    let _ = std::fs::remove_dir_all(&other);
}

/// The raw message is bounded before anything parses it, however it is
/// padded; a call's arguments within the line but over their own budget are
/// `limitExceeded`; and a key named twice is refused unparsed.
#[test]
fn the_raw_message_is_bounded_and_no_key_may_repeat() {
    let bound = Bound::new("pipe-bounds");
    let service = real_service();
    let session = service.start_session(&bound.epoch, agent_grant()).unwrap();
    let mut agent = Agent::connect(&service, &session.token);
    let padded = |id: u64, padding: usize| {
        format!(
            r#"{{"jsonrpc":"2.0","id":{id},"method":"tools/call","params":{{"name":"litria_files_read","arguments":{{"documents":[{{"path":"src/a.ts"}}]{}}}}}}}"#,
            " ".repeat(padding)
        )
    };

    let over = padded(1, MAX_MESSAGE_BYTES);
    agent.send_raw(over.as_bytes());
    let answer = agent.next().unwrap();
    assert_eq!(answer["error"]["code"], INVALID_REQUEST, "{answer}");
    assert!(answer["id"].is_null(), "an unread message has no id to answer");

    let within = padded(2, 1000);
    agent.send_raw(within.as_bytes());
    let answer = agent.next().unwrap();
    assert_eq!(answer["id"], 2);
    assert_eq!(structured(&answer)["documents"][0]["kind"], "read", "{answer}");

    // Documents with paths of four-byte characters, until the arguments are
    // over the call's budget: the message still fits the line.
    let path = "😀".repeat(1024);
    let mut documents = Vec::new();
    let arguments = loop {
        documents.push(json!({ "path": path }));
        let arguments = json!({ "documents": documents });
        if arguments.to_string().len() > MAX_REQUEST_BYTES {
            break arguments;
        }
    };
    let message = json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"litria_files_read","arguments":arguments}});
    assert!(message.to_string().len() <= MAX_MESSAGE_BYTES);
    agent.send(&message);
    let answer = agent.next().unwrap();
    assert_eq!(answer["id"], 3);
    assert_eq!(tool_error(&answer)["code"], "limitExceeded", "{answer}");

    let twice = r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"litria_files_read","arguments":{"documents":[{"path":"src/a.ts"}],"documents":[{"path":".env"}]}}}"#;
    agent.send_raw(twice.as_bytes());
    let answer = agent.next().unwrap();
    assert_eq!(answer["error"]["code"], INVALID_REQUEST, "{answer}");
    assert!(answer["id"].is_null());

    agent.sync("still-serving");
    service.shutdown();
}

/// Calls run beside the reading: a ping is answered while a call waits on the
/// frontend, a cancelled call's answer is never sent, and a fifth call at once
/// is `busy`.
#[test]
fn calls_run_beside_the_reading_and_a_cancelled_one_goes_unanswered() {
    let gate = Gate::default();
    let bound = Bound::with_owner("pipe-concurrent", gate.owner());
    let service = real_service();
    let session = service.start_session(&bound.epoch, agent_grant()).unwrap();
    let mut agent = Agent::connect(&service, &session.token);

    agent.start_call(1, "litria_files_read", read_a());
    wait_until("the call to start", || service.calls.running() == 1);
    agent.sync("while-calling");
    agent.send(&json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1,"reason":"test"}}));
    for id in [2, 3, 4] {
        agent.start_call(id, "litria_files_read", read_a());
    }
    wait_until("four calls to run", || service.calls.running() == 4);
    agent.start_call(5, "litria_files_read", read_a());
    let busy = agent.next().unwrap();
    assert_eq!(busy["id"], 5, "the fifth is answered at once: {busy}");
    assert_eq!(tool_error(&busy)["code"], "busy");

    gate.open();
    let mut answered = Vec::new();
    for _ in 0..3 {
        let answer = agent.next().unwrap();
        assert_eq!(structured(&answer)["documents"][0]["kind"], "read", "{answer}");
        answered.push(answer["id"].as_u64().unwrap());
    }
    answered.sort();
    assert_eq!(answered, [2, 3, 4]);
    match agent.hear(Duration::from_millis(500)) {
        Heard::Quiet => {}
        other => panic!("the cancelled call was answered: {other:?}"),
    }
    wait_until("the calls to finish", || service.calls.running() == 0);
    service.shutdown();
}

/// Litria quitting: a call already running finishes and answers; a call that
/// arrives while it does is `shuttingDown`; then the connection closes.
#[test]
fn quitting_lets_running_calls_answer_and_refuses_new_ones() {
    let gate = Gate::default();
    let bound = Bound::with_owner("pipe-quit", gate.owner());
    let service = real_service();
    let session = service.start_session(&bound.epoch, agent_grant()).unwrap();
    let mut agent = Agent::connect(&service, &session.token);

    agent.start_call(1, "litria_files_read", read_a());
    wait_until("the call to start", || service.calls.running() == 1);
    let quitting = {
        let service = Arc::clone(&service);
        thread::spawn(move || service.shutdown())
    };
    wait_until("the quit to begin", || service.calls.is_closing());
    let refused = agent.call(2, "litria_files_read", read_a());
    assert_eq!(tool_error(&refused)["code"], "shuttingDown", "{refused}");

    gate.open();
    let answer = agent.next().expect("the running call answers before the close");
    assert_eq!(answer["id"], 1);
    assert_eq!(structured(&answer)["documents"][0]["kind"], "read");
    quitting.join().unwrap();
    assert!(agent.next().is_none(), "then the connection closes");
    assert!(service.shut.load(Ordering::SeqCst));
    drop(bound);
}
