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
//! - **`tools/call`** is not served until slice T1b gives calls their own
//!   principal; until then it is "method not found".
//! - **Never echoed:** error messages are fixed text, whatever was sent.
//!
//! JSON-RPC: one object per message (batches were removed in 2025-06-18), ids
//! are strings or numbers, notifications get no answer, and responses to
//! requests Litria never sent are ignored.

use serde_json::{json, Value};

use crate::contracts::context::Grant;
use crate::contracts::mcp::{self, Revision};

pub(crate) const PARSE_ERROR: i64 = -32700;
pub(crate) const INVALID_REQUEST: i64 = -32600;
pub(crate) const METHOD_NOT_FOUND: i64 = -32601;

/// The server's name in `initialize`.
pub(crate) const SERVER_NAME: &str = "litria";

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

    /// Handle one message; `Some` is the response to send.
    pub(crate) fn handle(&mut self, message: &[u8]) -> Option<Value> {
        let Ok(message) = serde_json::from_slice::<Value>(message) else {
            return Some(error(Value::Null, PARSE_ERROR, "the message is not JSON"));
        };
        let Some(object) = message.as_object() else {
            // An array is a batch, which these revisions do not have.
            return Some(error(Value::Null, INVALID_REQUEST, "a message must be one JSON-RPC object"));
        };
        let method = object.get("method");
        let id = object.get("id");
        match (method, id) {
            (Some(Value::String(method)), None) => {
                self.notification(method);
                None
            }
            (Some(Value::String(method)), Some(id @ (Value::String(_) | Value::Number(_)))) => {
                Some(self.request(id.clone(), method, object.get("params")))
            }
            // A response to a request Litria never sends.
            (None, Some(_)) if object.contains_key("result") || object.contains_key("error") => None,
            _ => Some(error(Value::Null, INVALID_REQUEST, "not a JSON-RPC request or notification")),
        }
    }

    fn notification(&mut self, _method: &str) {
        // `notifications/initialized` needs nothing: `initialize` already
        // settled the revision. `notifications/cancelled` names requests that
        // are answered synchronously, so there is nothing left to cancel.
    }

    fn request(&mut self, id: Value, method: &str, params: Option<&Value>) -> Value {
        match method {
            "ping" => success(id, json!({})),
            "initialize" => self.initialize(id, params),
            // The stateless revisions' probe, at any point: this server is legacy.
            "server/discover" => error(id, METHOD_NOT_FOUND, "method not found"),
            _ if self.revision.is_none() => error(id, INVALID_REQUEST, "send initialize first"),
            "tools/list" => success(id, mcp::tools_list(self.revision.expect("initialized"), &self.grant)),
            _ => error(id, METHOD_NOT_FOUND, "method not found"),
        }
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
        conversation.handle(message.to_string().as_bytes())
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

    /// T1a lists the tools; calling one arrives with T1b.
    #[test]
    fn tool_calls_and_unknown_methods_are_not_found() {
        let mut conversation = Conversation::new(everything());
        send(&mut conversation, claude_initialize());
        for method in ["tools/call", "resources/list", "prompts/list", "logging/setLevel"] {
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
        ];
        for (message, code) in cases {
            let answer = conversation.handle(&message).unwrap();
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
        assert!(send(&mut conversation, json!({"jsonrpc":"2.0","method":"notifications/cancelled","params":{"requestId":1}})).is_none());
        assert!(send(&mut conversation, json!({"jsonrpc":"2.0","id":3,"result":{}})).is_none());
        assert!(send(&mut conversation, json!({"jsonrpc":"2.0","id":3,"error":{"code":1,"message":"x"}})).is_none());
    }
}
