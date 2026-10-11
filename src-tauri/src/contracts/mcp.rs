//! MCP adapter proof (contract-schemas brief §9; Project API build plan P6).
//! No SDK and no transport: this builds the `tools/list` result and the
//! `tools/call` results an adapter publishes, from the catalog and the
//! COMMITTED artifacts, embedded the way the application will embed them,
//! following MCP revision 2026-07-28. Track T adds the transport and moves the
//! adapter into the application; until then it is test-only (plan §1).
//!
//! SDK or thin serializer (P6 decision, 2026-10-11): the thin serializer, and
//! no new crate. Without a transport an SDK would bring only its protocol
//! envelope and session machinery, which is track T's subject; what the
//! adapter itself owns is this mapping, pinned here by tests to the revision.
//! Whatever SDK track T picks must serve the committed schemas verbatim.
//!
//! Mapping (S0, extended in P6):
//! - `inputSchema` is the inbound request schema; `outputSchema` the outbound
//!   result schema. Annotations: `readOnlyHint` from the catalog, and
//!   `openWorldHint: false` — the Project API never reaches outside the
//!   project.
//! - Every result says `resultType: "complete"` (the revision's servers MUST).
//! - A contract failure is a tool execution error: `isError: true`, the error
//!   JSON as text content, and no `structuredContent` — any structured result
//!   must conform to `outputSchema`, which an error does not. Input validation
//!   errors are tool execution errors too, as the revision directs.
//! - An unknown tool, or a call whose parameters are not a `CallToolRequest`
//!   (no string `name`, `arguments` not an object), is a protocol error:
//!   JSON-RPC −32602, with a fixed message that never echoes the call.

use serde_json::{json, Value};

use super::catalog::Dispatcher;
use super::context::CallContext;
use super::error::{ContractError, ErrorCode};

/// The MCP revision this mapping follows.
pub(crate) const REVISION: &str = "2026-07-28";

/// JSON-RPC "Invalid params": MCP's code for an unknown tool or a malformed
/// `tools/call`.
pub(crate) const INVALID_PARAMS: i64 = -32602;

/// The committed artifacts MCP serves, compiled in exactly as the application
/// will carry them (contract-schemas brief §5: the running application never
/// generates schemas). A file the catalog names but this table lacks fails a
/// test; a file this table names but the repository lacks fails the build.
pub(crate) mod embedded {
    use serde_json::Value;

    pub(crate) const CATALOG: &str = "catalog.json";
    pub(crate) const ERROR: &str = "error.schema.json";

    macro_rules! artifacts {
        ($($file:literal),* $(,)?) => {
            &[$(($file, include_str!(concat!("../../contracts/project-api/v1/", $file)))),*]
        };
    }

    pub(crate) const FILES: &[(&str, &str)] = artifacts![
        "catalog.json",
        "error.schema.json",
        "litria_files_read.request.schema.json",
        "litria_files_read.result.out.schema.json",
        "litria_project_context.request.schema.json",
        "litria_project_context.result.out.schema.json",
        "litria_files_search.request.schema.json",
        "litria_files_search.result.out.schema.json",
        "litria_graph_query.request.schema.json",
        "litria_graph_query.result.out.schema.json",
        "litria_diagnostics_list.request.schema.json",
        "litria_diagnostics_list.result.out.schema.json",
        "litria_changes_prepare.request.schema.json",
        "litria_changes_prepare.result.out.schema.json",
    ];

    pub(crate) fn text(name: &str) -> Option<&'static str> {
        FILES.iter().find(|(file, _)| *file == name).map(|(_, text)| *text)
    }

    pub(crate) fn json(name: &str) -> Value {
        let text = text(name).unwrap_or_else(|| panic!("`{name}` is not embedded"));
        serde_json::from_str(text).unwrap_or_else(|error| panic!("parse embedded {name}: {error}"))
    }
}

/// The `tools/list` result: every operation in the catalog, in catalog order.
pub(crate) fn tools_list() -> Value {
    let catalog = embedded::json(embedded::CATALOG);
    let tools: Vec<Value> = catalog["operations"]
        .as_array()
        .expect("catalog operations")
        .iter()
        .map(|operation| {
            json!({
                "name": operation["name"],
                "description": operation["description"],
                "inputSchema": embedded::json(operation["request"].as_str().expect("request schema file")),
                "outputSchema": embedded::json(operation["resultOut"].as_str().expect("result schema file")),
                "annotations": {
                    "readOnlyHint": operation["readOnly"].as_bool().expect("readOnly flag"),
                    "openWorldHint": false,
                },
            })
        })
        .collect();
    json!({ "resultType": "complete", "tools": tools })
}

/// A `tools/call` request's `params`. `Ok` is a `CallToolResult`; `Err` is a
/// JSON-RPC error object.
pub(crate) fn tools_call(dispatcher: &Dispatcher, context: &CallContext, params: &Value) -> Result<Value, Value> {
    let Some(params) = params.as_object() else {
        return Err(malformed());
    };
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return Err(malformed());
    };
    // `arguments` is optional; when present it must be an object.
    let raw = match params.get("arguments") {
        None => b"{}".to_vec(),
        Some(arguments @ Value::Object(_)) => serde_json::to_vec(arguments).expect("arguments serialize"),
        Some(_) => return Err(malformed()),
    };
    call_tool(dispatcher, context, name, &raw)
}

/// One call with its arguments already encoded: the byte budget measures
/// exactly these bytes.
pub(crate) fn call_tool(
    dispatcher: &Dispatcher,
    context: &CallContext,
    name: &str,
    arguments: &[u8],
) -> Result<Value, Value> {
    match dispatcher.dispatch(context, name, arguments) {
        Ok(value) => Ok(json!({
            "resultType": "complete",
            "content": [{ "type": "text", "text": value.to_string() }],
            "structuredContent": value,
            "isError": false,
        })),
        Err(error) if error.code == ErrorCode::UnknownOperation => Err(protocol_error(&error.message)),
        Err(error) => Ok(json!({
            "resultType": "complete",
            "content": [{ "type": "text", "text": error_text(&error) }],
            "isError": true,
        })),
    }
}

fn malformed() -> Value {
    protocol_error("tools/call needs a string `name` and, if given, object `arguments`")
}

fn protocol_error(message: &str) -> Value {
    json!({ "code": INVALID_PARAMS, "message": message })
}

fn error_text(error: &ContractError) -> String {
    serde_json::to_string(error).expect("contract error serializes")
}

#[cfg(test)]
mod tests;
#[cfg(test)]
mod real_catalog;
