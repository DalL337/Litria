//! The MCP adapter (contract-schemas brief §9; Project API build plan P6;
//! track T slice T1a): the `tools/list` result and the `tools/call` results
//! Litria's MCP connection serves, built from the catalog and the COMMITTED
//! artifacts, embedded in the application.
//!
//! Revisions (T1a, 2026-10-15). P6 proved this mapping against 2026-07-28,
//! the stateless revision. The agents people have installed still open with
//! the `initialize` handshake of an earlier revision: Claude Code 2.1.185
//! asks for 2025-11-25 and Codex 0.162 for 2025-06-18 (captured live, track T
//! plan T1a record). So results are shaped for the revision the connection
//! negotiated: `resultType` exists only in 2026-07-28 and is left out
//! elsewhere (2026-07-28 clients treat its absence as `complete`). The
//! connection serves the handshake revisions; the 2026-07-28 shape stays
//! pinned by the P6 tests until the connection is dual-era.
//!
//! SDK or thin serializer: the thin serializer and no new crate (P6, re-decided
//! in T1a with the P6 criteria; the record is in the track T plan).
//!
//! Mapping (S0, extended in P6 and T1a):
//! - `inputSchema` is the inbound request schema; `outputSchema` the outbound
//!   result schema. Annotations: `readOnlyHint` from the catalog, and
//!   `openWorldHint: false` — the Project API never reaches outside the
//!   project.
//! - `tools/list` shows only the tools the connection's grant allows (track T
//!   plan D5), in catalog order.
//! - A contract failure is a tool execution error: `isError: true`, the error
//!   JSON as text content, and no `structuredContent` — any structured result
//!   must conform to `outputSchema`, which an error does not. Input validation
//!   errors are tool execution errors too, as the revisions direct.
//! - An unknown tool, or a call whose parameters are not a `CallToolRequest`
//!   (no string `name`, `arguments` not an object), is a protocol error:
//!   JSON-RPC −32602, with a fixed message that never echoes the call.

use serde_json::{json, Map, Value};

use super::catalog::Dispatcher;
use super::context::{CallContext, Grant};
use super::error::{ContractError, ErrorCode};

/// The MCP revisions this mapping shapes results for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Revision {
    /// The handshake revision Codex 0.162 asks for.
    V2025_06_18,
    /// The handshake revision Claude Code 2.1.185 asks for.
    V2025_11_25,
    /// The stateless revision: no `initialize`, and `resultType` on every
    /// result. Only the P6 tests use it until the connection is dual-era.
    #[cfg_attr(not(test), allow(dead_code))] // the dual-era connection is a T1a follow-up
    V2026_07_28,
}

impl Revision {
    /// The revisions the `initialize` handshake can settle on, newest first.
    /// Not 2025-03-26: it has no `outputSchema` or `structuredContent`, which
    /// every tool here publishes.
    pub(crate) const HANDSHAKE: [Revision; 2] = [Revision::V2025_11_25, Revision::V2025_06_18];

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Revision::V2025_06_18 => "2025-06-18",
            Revision::V2025_11_25 => "2025-11-25",
            Revision::V2026_07_28 => "2026-07-28",
        }
    }

    /// The handshake revision named `text`, if it is one this side serves.
    pub(crate) fn handshake(text: &str) -> Option<Revision> {
        Self::HANDSHAKE.into_iter().find(|revision| revision.as_str() == text)
    }

    fn has_result_type(self) -> bool {
        self == Revision::V2026_07_28
    }
}

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
    #[cfg_attr(not(test), allow(dead_code))] // read by the artifact tests
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
        "litria_changes_apply.request.schema.json",
        "litria_changes_apply.result.out.schema.json",
        "litria_operations_get.request.schema.json",
        "litria_operations_get.result.out.schema.json",
    ];

    pub(crate) fn text(name: &str) -> Option<&'static str> {
        FILES.iter().find(|(file, _)| *file == name).map(|(_, text)| *text)
    }

    pub(crate) fn json(name: &str) -> Value {
        let text = text(name).unwrap_or_else(|| panic!("`{name}` is not embedded"));
        serde_json::from_str(text).unwrap_or_else(|error| panic!("parse embedded {name}: {error}"))
    }
}

/// The `tools/list` result for `revision`: every operation `grant` allows, in
/// catalog order.
pub(crate) fn tools_list(revision: Revision, grant: &Grant) -> Value {
    let catalog = embedded::json(embedded::CATALOG);
    let tools: Vec<Value> = catalog["operations"]
        .as_array()
        .expect("catalog operations")
        .iter()
        .filter(|operation| grant.allows(operation["capability"].as_str().expect("capability")))
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
    shaped(revision, [("tools", Value::Array(tools))])
}

/// A `tools/call` request's `params`. `Ok` is a `CallToolResult`; `Err` is a
/// JSON-RPC error object.
pub(crate) fn tools_call(
    dispatcher: &Dispatcher,
    context: &CallContext,
    params: &Value,
    revision: Revision,
) -> Result<Value, Value> {
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
    call_tool(dispatcher, context, name, &raw, revision)
}

/// One call with its arguments already encoded: the byte budget measures
/// exactly these bytes. The connection has already bounded the raw message
/// and refused any key named twice before this was parsed (track T, T1b).
pub(crate) fn call_tool(
    dispatcher: &Dispatcher,
    context: &CallContext,
    name: &str,
    arguments: &[u8],
    revision: Revision,
) -> Result<Value, Value> {
    match dispatcher.dispatch(context, name, arguments) {
        Ok(value) => Ok(shaped(
            revision,
            [
                ("content", json!([{ "type": "text", "text": value.to_string() }])),
                ("structuredContent", value),
                ("isError", Value::Bool(false)),
            ],
        )),
        Err(error) if error.code == ErrorCode::UnknownOperation => Err(protocol_error(&error.message)),
        Err(error) => Ok(tool_error(revision, &error)),
    }
}

/// A contract failure as a tool execution error: `isError`, the error JSON as
/// text content, and no `structuredContent`.
pub(crate) fn tool_error(revision: Revision, error: &ContractError) -> Value {
    shaped(
        revision,
        [
            ("content", json!([{ "type": "text", "text": error_text(error) }])),
            ("isError", Value::Bool(true)),
        ],
    )
}

/// A result object for `revision`: `resultType` first where the revision has
/// it, then the fields.
fn shaped<const N: usize>(revision: Revision, fields: [(&str, Value); N]) -> Value {
    let mut result = Map::new();
    if revision.has_result_type() {
        result.insert("resultType".into(), Value::from("complete"));
    }
    for (key, value) in fields {
        result.insert(key.into(), value);
    }
    Value::Object(result)
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
pub(crate) mod real_catalog;
