//! The MCP conversation on one authenticated connection (track T, T1a).
//!
//! Litria speaks the `initialize` handshake revisions the installed agents
//! use (`contracts::mcp::Revision::HANDSHAKE`). Captured live on 2026-10-15:
//! Claude Code 2.1.185 sends `initialize` with 2025-11-25, then
//! `notifications/initialized`, then `tools/list`; Codex 0.162 does the same
//! with 2025-06-18.
//!
//! - **Negotiation** (2025-11-25 lifecycle): a requested revision Litria
//!   serves is echoed; any other gets Litria's newest, and the client decides.
//! - **Stateless clients** (2026-07-28) open with `server/discover`. Litria
//!   answers it at once with "method not found", which the specification
//!   requires such clients to treat as "this server is legacy" and fall back
//!   to `initialize` (Claude Code negotiates 2026-07-28 by default from
//!   2.1.292). Serving 2026-07-28 itself is a follow-up.
//! - **Before `initialize`** only `ping` is answered (clients SHOULD NOT send
//!   anything else).
//! - **`tools/call`** (T1b) is handed back to the connection as a [`Call`],
//!   to run off the reading thread as the session's own principal. A
//!   `notifications/cancelled` for a call still running means its answer is
//!   not sent (receivers SHOULD NOT answer a cancelled request); the call
//!   itself runs to its end, so an apply is never cut off halfway.
//! - **No key twice.** A message that names a key twice in any object is
//!   refused before it is parsed: parsing keeps one of the two silently, and
//!   which one a reader keeps is not something to rely on.
//! - **Never echoed:** error messages are fixed text, whatever was sent.
//!
//! JSON-RPC: one object per message (batches were removed in 2025-06-18), ids
//! are strings or numbers, notifications get no answer, and responses to
//! requests Litria never sent are ignored.

use std::cell::Cell;
use std::collections::HashSet;

use serde::de::{DeserializeSeed, Deserializer, Error as _, MapAccess, SeqAccess, Visitor};
use serde_json::{json, Value};

use crate::contracts::catalog::Dispatcher;
use crate::contracts::context::{CallContext, Grant};
use crate::contracts::error::ContractError;
use crate::contracts::mcp::{self, Revision};

pub(crate) const PARSE_ERROR: i64 = -32700;
pub(crate) const INVALID_REQUEST: i64 = -32600;
pub(crate) const METHOD_NOT_FOUND: i64 = -32601;

/// The server's name in `initialize`.
pub(crate) const SERVER_NAME: &str = "litria";

/// What one message asks of the connection.
#[derive(Debug)]
pub(crate) enum Reply {
    /// Nothing to send: a notification, or a stray response.
    Nothing,
    /// Send this.
    Now(Value),
    /// A tool call, to run off the reading thread.
    Call(Call),
    /// The client cancelled the request whose id has this key ([`id_key`]).
    Cancel(String),
}

/// One `tools/call`, ready to run.
#[derive(Debug)]
pub(crate) struct Call {
    id: Value,
    params: Value,
    revision: Revision,
}

impl Call {
    /// The key cancellation names this call by.
    pub(crate) fn key(&self) -> String {
        id_key(&self.id)
    }

    /// Run the call in `context` and build its response.
    pub(crate) fn run(&self, dispatcher: &Dispatcher, context: &CallContext) -> Value {
        match mcp::tools_call(dispatcher, context, &self.params, self.revision) {
            Ok(result) => success(self.id.clone(), result),
            Err(error) => json!({ "jsonrpc": "2.0", "id": self.id, "error": error }),
        }
    }

    /// The response for a call the connection will not run (`busy`, or
    /// Litria is closing): a tool execution error, like the dispatcher's own.
    pub(crate) fn refused(&self, error: &ContractError) -> Value {
        success(self.id.clone(), mcp::tool_error(self.revision, error))
    }

    /// The response for a call whose id is already in flight.
    pub(crate) fn duplicate_id(&self) -> Value {
        error(self.id.clone(), INVALID_REQUEST, "a request with that id is still running")
    }
}

/// How a request id is compared: its JSON text, so `1` and `"1"` differ.
pub(crate) fn id_key(id: &Value) -> String {
    id.to_string()
}

pub(crate) struct Conversation {
    grant: Grant,
    /// Set once `initialize` has been answered.
    revision: Option<Revision>,
}

impl Conversation {
    pub(crate) fn new(grant: Grant) -> Self {
        Self { grant, revision: None }
    }

    /// The revision `initialize` settled on, if it has run.
    #[cfg(test)]
    pub(crate) fn revision(&self) -> Option<Revision> {
        self.revision
    }

    /// Handle one message.
    pub(crate) fn handle(&mut self, message: &[u8]) -> Reply {
        match repeats_a_key(message) {
            None => return Reply::Now(error(Value::Null, PARSE_ERROR, "the message is not JSON")),
            Some(true) => {
                return Reply::Now(error(Value::Null, INVALID_REQUEST, "a message must not name a key twice"))
            }
            Some(false) => {}
        }
        let Ok(message) = serde_json::from_slice::<Value>(message) else {
            return Reply::Now(error(Value::Null, PARSE_ERROR, "the message is not JSON"));
        };
        let Some(object) = message.as_object() else {
            // An array is a batch, which these revisions do not have.
            return Reply::Now(error(Value::Null, INVALID_REQUEST, "a message must be one JSON-RPC object"));
        };
        let method = object.get("method");
        let id = object.get("id");
        match (method, id) {
            (Some(Value::String(method)), None) => self.notification(method, object.get("params")),
            (Some(Value::String(method)), Some(id @ (Value::String(_) | Value::Number(_)))) => {
                self.request(id.clone(), method, object.get("params"))
            }
            // A response to a request Litria never sends.
            (None, Some(_)) if object.contains_key("result") || object.contains_key("error") => Reply::Nothing,
            _ => Reply::Now(error(Value::Null, INVALID_REQUEST, "not a JSON-RPC request or notification")),
        }
    }

    fn notification(&mut self, method: &str, params: Option<&Value>) -> Reply {
        // `notifications/initialized` needs nothing: `initialize` already
        // settled the revision.
        match (method, params.and_then(|params| params.get("requestId"))) {
            ("notifications/cancelled", Some(id @ (Value::String(_) | Value::Number(_)))) => {
                Reply::Cancel(id_key(id))
            }
            _ => Reply::Nothing,
        }
    }

    fn request(&mut self, id: Value, method: &str, params: Option<&Value>) -> Reply {
        let answer = match method {
            "ping" => success(id, json!({})),
            "initialize" => self.initialize(id, params),
            // The stateless revisions' probe, at any point: this server is legacy.
            "server/discover" => error(id, METHOD_NOT_FOUND, "method not found"),
            _ if self.revision.is_none() => error(id, INVALID_REQUEST, "send initialize first"),
            "tools/list" => success(id, mcp::tools_list(self.revision.expect("initialized"), &self.grant)),
            "tools/call" => {
                return Reply::Call(Call {
                    id,
                    params: params.cloned().unwrap_or(Value::Null),
                    revision: self.revision.expect("initialized"),
                })
            }
            _ => error(id, METHOD_NOT_FOUND, "method not found"),
        };
        Reply::Now(answer)
    }

    fn initialize(&mut self, id: Value, params: Option<&Value>) -> Value {
        if self.revision.is_some() {
            return error(id, INVALID_REQUEST, "already initialized");
        }
        let requested = params
            .and_then(|params| params.get("protocolVersion"))
            .and_then(Value::as_str)
            .and_then(Revision::handshake);
        let revision = requested.unwrap_or(Revision::HANDSHAKE[0]);
        self.revision = Some(revision);
        success(
            id,
            json!({
                "protocolVersion": revision.as_str(),
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": SERVER_NAME, "title": "Litria", "version": env!("CARGO_PKG_VERSION") },
            }),
        )
    }
}

/// Whether any object in `raw` names a key twice; `None` if `raw` is not
/// JSON. One pass, before anything is parsed, within serde_json's own
/// nesting limit.
pub(crate) fn repeats_a_key(raw: &[u8]) -> Option<bool> {
    let repeated = Cell::new(false);
    let mut reader = serde_json::Deserializer::from_slice(raw);
    let walked = Walk(&repeated).deserialize(&mut reader).and_then(|()| reader.end());
    match walked {
        Ok(()) => Some(false),
        Err(_) if repeated.get() => Some(true),
        Err(_) => None,
    }
}

/// Walks a JSON value and stops at the first key an object names twice.
struct Walk<'a>(&'a Cell<bool>);

impl<'de> DeserializeSeed<'de> for Walk<'_> {
    type Value = ();

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Walk<'_> {
    type Value = ();

    fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<(), E> {
        Ok(())
    }
    fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<(), E> {
        Ok(())
    }
    fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<(), E> {
        Ok(())
    }
    fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<(), E> {
        Ok(())
    }
    fn visit_str<E: serde::de::Error>(self, _: &str) -> Result<(), E> {
        Ok(())
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<(), E> {
        Ok(())
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut items: A) -> Result<(), A::Error> {
        while items.next_element_seed(Walk(self.0))?.is_some() {}
        Ok(())
    }

    fn visit_map<A: MapAccess<'de>>(self, mut entries: A) -> Result<(), A::Error> {
        let mut seen = HashSet::new();
        while let Some(key) = entries.next_key::<String>()? {
            if !seen.insert(key) {
                self.0.set(true);
                return Err(A::Error::custom("a key repeats"));
            }
            entries.next_value_seed(Walk(self.0))?;
        }
        Ok(())
    }
}

fn success(id: Value, result: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn everything() -> Grant {
        Grant::of(crate::contracts::project_api::catalog().iter().map(|entry| entry.capability))
    }

    fn send(conversation: &mut Conversation, message: Value) -> Option<Value> {
        answer_of(conversation.handle(message.to_string().as_bytes()))
    }

    fn answer_of(reply: Reply) -> Option<Value> {
        match reply {
            Reply::Now(answer) => Some(answer),
            Reply::Nothing => None,
            other => panic!("expected an answer or nothing, got {other:?}"),
        }
    }

    /// Exactly what Claude Code 2.1.185 sent on 2026-10-15.
    fn claude_initialize() -> Value {
        json!({"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{"roots":{},"elicitation":{}},"clientInfo":{"name":"claude-code","title":"Claude Code","version":"2.1.185","description":"Anthropic's agentic coding tool","websiteUrl":"https://claude.com/claude-code"}},"jsonrpc":"2.0","id":0})
    }

    /// Exactly what Codex 0.162.0-alpha.17.2 sent on 2026-10-15.
    fn codex_initialize() -> Value {
        json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{"experimental":{"codex/auth-change":{}},"elicitation":{"form":{},"url":{}}},"clientInfo":{"name":"codex-mcp-client","title":"Codex","version":"0.162.0-alpha.17.2"}}})
    }

    #[test]
    fn claude_codes_handshake_gets_its_own_revision_and_the_tools() {
        let mut conversation = Conversation::new(everything());
        let answer = send(&mut conversation, claude_initialize()).unwrap();
        assert_eq!(answer["id"], 0);
        assert_eq!(answer["result"]["protocolVersion"], "2025-11-25");
        assert_eq!(answer["result"]["capabilities"]["tools"]["listChanged"], false);
        assert_eq!(answer["result"]["serverInfo"]["name"], "litria");
        assert!(send(&mut conversation, json!({"method":"notifications/initialized","jsonrpc":"2.0"})).is_none());
        let list = send(&mut conversation, json!({"method":"tools/list","jsonrpc":"2.0","id":1})).unwrap();
        assert_eq!(list["id"], 1);
        assert_eq!(list["result"], mcp::tools_list(Revision::V2025_11_25, &everything()));
        assert!(list["result"].get("resultType").is_none());
    }

    #[test]
    fn codexs_handshake_gets_its_own_revision_and_the_tools() {
        let mut conversation = Conversation::new(everything());
        let answer = send(&mut conversation, codex_initialize()).unwrap();
        assert_eq!(answer["result"]["protocolVersion"], "2025-06-18");
        assert_eq!(conversation.revision(), Some(Revision::V2025_06_18));
        assert!(send(&mut conversation, json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        let list = send(
            &mut conversation,
            json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"progressToken":0}}}),
        )
        .unwrap();
        assert_eq!(list["result"]["tools"].as_array().unwrap().len(), crate::contracts::project_api::catalog().len());
    }

    #[test]
    fn an_unserved_revision_gets_the_newest_one() {
        for asked in [json!("2024-11-05"), json!("2025-03-26"), json!("2026-07-28"), json!("1999-01-01"), json!(7)] {
            let mut conversation = Conversation::new(everything());
            let answer = send(
                &mut conversation,
                json!({"jsonrpc":"2.0","id":"a","method":"initialize","params":{"protocolVersion": asked}}),
            )
            .unwrap();
            assert_eq!(answer["result"]["protocolVersion"], "2025-11-25", "{asked}");
        }
        let mut conversation = Conversation::new(everything());
        let answer = send(&mut conversation, json!({"jsonrpc":"2.0","id":1,"method":"initialize"})).unwrap();
        assert_eq!(answer["result"]["protocolVersion"], "2025-11-25", "no params at all");
    }

    /// A 2026-07-28 client probes first; a fast error makes it fall back.
    #[test]
    fn a_stateless_probe_is_told_this_server_is_legacy() {
        let mut conversation = Conversation::new(everything());
        let probe = json!({"jsonrpc":"2.0","id":0,"method":"server/discover","params":{"_meta":{
            "io.modelcontextprotocol/protocolVersion":"2026-07-28",
            "io.modelcontextprotocol/clientCapabilities":{}}}});
        let answer = send(&mut conversation, probe).unwrap();
        assert_eq!(answer["error"]["code"], METHOD_NOT_FOUND, "{answer}");
        assert_eq!(answer["id"], 0);
        // The fallback works afterwards.
        let answer = send(&mut conversation, claude_initialize()).unwrap();
        assert_eq!(answer["result"]["protocolVersion"], "2025-11-25");
        let again = send(&mut conversation, json!({"jsonrpc":"2.0","id":9,"method":"server/discover"})).unwrap();
        assert_eq!(again["error"]["code"], METHOD_NOT_FOUND);
    }

    #[test]
    fn ping_is_answered_before_and_after_initialize() {
        let mut conversation = Conversation::new(everything());
        let pong = send(&mut conversation, json!({"jsonrpc":"2.0","id":"p","method":"ping"})).unwrap();
        assert_eq!(pong, json!({"jsonrpc":"2.0","id":"p","result":{}}));
        send(&mut conversation, codex_initialize());
        let pong = send(&mut conversation, json!({"jsonrpc":"2.0","id":2,"method":"ping"})).unwrap();
        assert_eq!(pong["result"], json!({}));
    }

    #[test]
    fn nothing_but_ping_is_served_before_initialize() {
        let mut conversation = Conversation::new(everything());
        for method in ["tools/list", "tools/call", "resources/list"] {
            let answer = send(&mut conversation, json!({"jsonrpc":"2.0","id":1,"method":method})).unwrap();
            assert_eq!(answer["error"]["code"], INVALID_REQUEST, "{method}");
        }
        assert!(conversation.revision().is_none());
    }

    #[test]
    fn a_second_initialize_is_refused_and_changes_nothing() {
        let mut conversation = Conversation::new(everything());
        send(&mut conversation, codex_initialize());
        let answer = send(&mut conversation, claude_initialize()).unwrap();
        assert_eq!(answer["error"]["code"], INVALID_REQUEST);
        assert_eq!(conversation.revision(), Some(Revision::V2025_06_18));
    }

    /// A tool call is handed to the connection to run; the conversation itself
    /// never runs one.
    #[test]
    fn a_tool_call_is_handed_back_to_run() {
        let mut conversation = Conversation::new(everything());
        send(&mut conversation, claude_initialize());
        let reply = conversation.handle(
            json!({"jsonrpc":"2.0","id":"c1","method":"tools/call","params":{"name":"litria_files_read","arguments":{}}})
                .to_string()
                .as_bytes(),
        );
        let Reply::Call(call) = reply else { panic!("expected a call, got {reply:?}") };
        assert_eq!(call.key(), "\"c1\"");
        assert_eq!(call.revision, Revision::V2025_11_25);
        // What it answers is a CallToolResult for its own id. No project is
        // bound to this context, so that result is a tool error.
        let context = CallContext {
            principal: crate::contracts::context::Principal::Test,
            grant: everything(),
            epoch: "ws-not-open".into(),
        };
        let answer = call.run(crate::project_api::dispatcher(), &context);
        assert_eq!(answer["id"], "c1");
        assert_eq!(answer["result"]["isError"], true, "{answer}");
        assert!(answer["result"].get("resultType").is_none());
        // Refusals have the same shape.
        let busy = ContractError::new(crate::contracts::error::ErrorCode::Busy, "busy");
        let refused = call.refused(&busy);
        assert_eq!(refused["result"]["isError"], true);
        assert_eq!(refused["id"], "c1");
        assert_eq!(call.duplicate_id()["error"]["code"], INVALID_REQUEST);
    }

    #[test]
    fn unknown_methods_are_not_found() {
        let mut conversation = Conversation::new(everything());
        send(&mut conversation, claude_initialize());
        for method in ["resources/list", "prompts/list", "logging/setLevel", "tools/run"] {
            let answer = send(
                &mut conversation,
                json!({"jsonrpc":"2.0","id":5,"method":method,"params":{"name":"litria_files_read"}}),
            )
            .unwrap();
            assert_eq!(answer["error"]["code"], METHOD_NOT_FOUND, "{method}");
            assert_eq!(answer["id"], 5);
        }
    }

    #[test]
    fn the_list_follows_the_grant() {
        let reads_only = Grant::of(["project.files.read"]);
        let mut conversation = Conversation::new(reads_only);
        send(&mut conversation, claude_initialize());
        let list = send(&mut conversation, json!({"jsonrpc":"2.0","id":1,"method":"tools/list"})).unwrap();
        let names: Vec<&str> =
            list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
        assert_eq!(names, ["litria_files_read"]);
    }

    #[test]
    fn malformed_messages_get_fixed_errors_that_echo_nothing() {
        let mut conversation = Conversation::new(everything());
        let secret = "s3cr3t-value";
        let cases: Vec<(Vec<u8>, i64)> = vec![
            (format!("{{not json {secret}").into_bytes(), PARSE_ERROR),
            (format!("[{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"{secret}\"}}]").into_bytes(), INVALID_REQUEST),
            (format!("\"{secret}\"").into_bytes(), INVALID_REQUEST),
            (format!("{{\"jsonrpc\":\"2.0\",\"id\":null,\"method\":\"{secret}\"}}").into_bytes(), INVALID_REQUEST),
            (format!("{{\"jsonrpc\":\"2.0\",\"id\":{{}},\"method\":\"{secret}\"}}").into_bytes(), INVALID_REQUEST),
            (format!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":7,\"x\":\"{secret}\"}}").into_bytes(), INVALID_REQUEST),
            // A key named twice, at the top or anywhere inside.
            (format!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"id\":2,\"method\":\"{secret}\"}}").into_bytes(), INVALID_REQUEST),
            (
                format!("{{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{{\"name\":\"litria_files_read\",\"arguments\":{{\"documents\":[{{\"path\":\"a\",\"path\":\"{secret}\"}}]}}}}}}")
                    .into_bytes(),
                INVALID_REQUEST,
            ),
        ];
        for (message, code) in cases {
            let answer = answer_of(conversation.handle(&message)).unwrap();
            assert_eq!(answer["error"]["code"], code, "{}", String::from_utf8_lossy(&message));
            assert!(!answer.to_string().contains(secret), "echoed: {answer}");
        }
        send(&mut conversation, claude_initialize());
        let unknown = send(&mut conversation, json!({"jsonrpc":"2.0","id":1,"method":secret})).unwrap();
        assert!(!unknown.to_string().contains(secret));
    }

    #[test]
    fn notifications_and_stray_responses_get_no_answer() {
        let mut conversation = Conversation::new(everything());
        assert!(send(&mut conversation, json!({"jsonrpc":"2.0","method":"notifications/initialized"})).is_none());
        assert!(send(&mut conversation, json!({"jsonrpc":"2.0","method":"notifications/cancelled"})).is_none());
        assert!(send(&mut conversation, json!({"jsonrpc":"2.0","id":3,"result":{}})).is_none());
        assert!(send(&mut conversation, json!({"jsonrpc":"2.0","id":3,"error":{"code":1,"message":"x"}})).is_none());
    }

    /// A cancellation names its request by id, and `1` is not `"1"`.
    #[test]
    fn a_cancellation_names_the_request_it_cancels() {
        let mut conversation = Conversation::new(everything());
        for (id, key) in [(json!(1), "1"), (json!("1"), "\"1\"")] {
            let reply = conversation.handle(
                json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":id,"reason":"x"}})
                    .to_string()
                    .as_bytes(),
            );
            let Reply::Cancel(cancelled) = reply else { panic!("expected a cancellation, got {reply:?}") };
            assert_eq!(cancelled, key);
        }
    }

    #[test]
    fn a_repeated_key_is_found_anywhere_and_only_then() {
        let cases: [(&str, Option<bool>); 9] = [
            (r#"{"a":1,"b":2}"#, Some(false)),
            (r#"{"a":1,"a":1}"#, Some(true)),
            (r#"{"a":{"b":1,"b":2}}"#, Some(true)),
            (r#"[{"x":1},{"x":2}]"#, Some(false)),
            (r#"[{"x":1,"y":[{"z":0,"z":0}]}]"#, Some(true)),
            // The same key written two ways is one key.
            (r#"{"a":1,"a":2}"#, Some(true)),
            (r#"{"a":1} trailing"#, None),
            (r#"{"a":"#, None),
            ("", None),
        ];
        for (raw, expected) in cases {
            assert_eq!(repeats_a_key(raw.as_bytes()), expected, "{raw}");
        }
        // Deeper than serde_json's nesting limit is not accepted as JSON.
        let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        assert_eq!(repeats_a_key(deep.as_bytes()), None);
    }
}
