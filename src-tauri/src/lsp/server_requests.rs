//! Replies to the requests a language server makes of the client.
//!
//! Every server→client request gets an answer, so no server ever waits
//! forever. Until 2026-10-11 they were ignored ("MVP"), and Pyright — which
//! asks for `workspace/configuration` because the Python pack declares that
//! capability — waited on that answer and never published a diagnostic: no
//! Python errors ever reached the editor or the Project API (found in the
//! Project API P5c live pass).
//!
//! The replies are deliberately minimal and never act: configuration is
//! "nothing configured" (servers fall back to their defaults), dynamic
//! registrations and progress tokens are accepted without effect, a server's
//! request to edit files is declined, and anything unrecognised is answered
//! with JSON-RPC's MethodNotFound.

use serde_json::{json, Value};

/// JSON-RPC 2.0: the method does not exist / is not available.
pub(crate) const METHOD_NOT_FOUND: i64 = -32601;

/// At most this many `null`s answer one `workspace/configuration` request; a
/// request for more is answered with exactly that many anyway — the protocol
/// requires one entry per item — but the count is bounded first.
const MAX_CONFIGURATION_ITEMS: usize = 256;

/// The full JSON-RPC response to the server request `method` with `id`.
/// `workspace_uri` is the folder the session was started in.
pub(crate) fn reply(id: &Value, method: &str, params: Option<&Value>, workspace_uri: &str) -> Value {
    let result = match method {
        // One entry per requested item; `null` = nothing configured, so the
        // server uses its defaults.
        "workspace/configuration" => {
            let items = params
                .and_then(|p| p.get("items"))
                .and_then(Value::as_array)
                .map_or(0, Vec::len)
                .min(MAX_CONFIGURATION_ITEMS);
            Value::Array(vec![Value::Null; items])
        }
        "workspace/workspaceFolders" => json!([{ "uri": workspace_uri, "name": "workspace" }]),
        // Accepted without effect.
        "client/registerCapability"
        | "client/unregisterCapability"
        | "window/workDoneProgress/create"
        | "window/showMessageRequest"
        | "workspace/semanticTokens/refresh"
        | "workspace/inlayHint/refresh"
        | "workspace/inlineValue/refresh"
        | "workspace/codeLens/refresh"
        | "workspace/diagnostic/refresh"
        | "workspace/foldingRange/refresh" => Value::Null,
        // A server never edits the user's files on its own say-so.
        "workspace/applyEdit" => json!({
            "applied": false,
            "failureReason": "Litria does not apply edits requested by a language server"
        }),
        _ => {
            return json!({
                "jsonrpc": "2.0",
                "id": id,
                "error": {
                    "code": METHOD_NOT_FOUND,
                    "message": format!("Litria does not handle '{}'", bounded(method, 128))
                }
            })
        }
    };
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn bounded(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((cut, _)) => &text[..cut],
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ROOT: &str = "file:///C:/proj";

    #[test]
    fn configuration_gets_one_null_per_item() {
        let params = json!({ "items": [{ "section": "python" }, { "section": "python.analysis" }] });
        let r = reply(&json!(7), "workspace/configuration", Some(&params), ROOT);
        assert_eq!(r, json!({ "jsonrpc": "2.0", "id": 7, "result": [null, null] }));
        // No items (or none sent) is an empty list, never an error.
        let r = reply(&json!(8), "workspace/configuration", None, ROOT);
        assert_eq!(r["result"], json!([]));
    }

    #[test]
    fn configuration_item_count_is_bounded() {
        let items: Vec<Value> = (0..10_000).map(|_| json!({})).collect();
        let r = reply(&json!(1), "workspace/configuration", Some(&json!({ "items": items })), ROOT);
        assert_eq!(r["result"].as_array().unwrap().len(), MAX_CONFIGURATION_ITEMS);
    }

    #[test]
    fn the_id_is_echoed_exactly_whatever_its_type() {
        for id in [json!(0), json!(42), json!("abc-1"), json!(9_007_199_254_740_993_i64)] {
            let r = reply(&id, "client/registerCapability", None, ROOT);
            assert_eq!(r["id"], id);
            assert_eq!(r["result"], Value::Null);
        }
    }

    #[test]
    fn workspace_folders_name_the_session_root() {
        let r = reply(&json!(3), "workspace/workspaceFolders", None, ROOT);
        assert_eq!(r["result"], json!([{ "uri": ROOT, "name": "workspace" }]));
    }

    #[test]
    fn acknowledgements_carry_a_null_result() {
        for method in [
            "client/registerCapability",
            "client/unregisterCapability",
            "window/workDoneProgress/create",
            "window/showMessageRequest",
            "workspace/semanticTokens/refresh",
            "workspace/diagnostic/refresh",
        ] {
            let r = reply(&json!(1), method, Some(&json!({})), ROOT);
            assert_eq!(r, json!({ "jsonrpc": "2.0", "id": 1, "result": null }), "{method}");
        }
    }

    #[test]
    fn a_server_cannot_edit_files_through_apply_edit() {
        let edit = json!({ "edit": { "changes": { "file:///C:/proj/a.py": [] } } });
        let r = reply(&json!(5), "workspace/applyEdit", Some(&edit), ROOT);
        assert_eq!(r["result"]["applied"], json!(false));
    }

    #[test]
    fn anything_else_is_method_not_found_never_silence() {
        let r = reply(&json!(9), "$/custom/thing", None, ROOT);
        assert_eq!(r["id"], json!(9));
        assert_eq!(r["error"]["code"], json!(METHOD_NOT_FOUND));
        assert!(r.get("result").is_none());
        // A hostile method name cannot bloat the reply.
        let long = "x".repeat(10_000);
        let r = reply(&json!(1), &long, None, ROOT);
        assert!(r["error"]["message"].as_str().unwrap().len() < 200);
    }
}
