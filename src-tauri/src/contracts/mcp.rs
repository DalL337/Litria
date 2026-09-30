//! Minimal MCP adapter proof (brief §9). No SDK and no agent runtime: this
//! builds the `tools/list` entries and `tools/call` results an adapter would
//! publish, from the catalog and the COMMITTED artifacts — the files the
//! application would embed — following MCP revision 2026-07-28.
//!
//! Mapping decisions S0 fixes:
//! - `inputSchema` is the inbound request schema; `outputSchema` the outbound
//!   result schema.
//! - A contract failure is a tool execution error: `isError: true`, the error
//!   JSON as text content, and no `structuredContent` — the spec requires any
//!   structured result to conform to `outputSchema`, which an error does not.
//! - An unknown operation is a protocol error (JSON-RPC -32602), as MCP
//!   specifies for unknown tools, not a tool result.

use serde_json::{json, Value};

use super::artifacts::{committed_json, CATALOG_FILE};
use super::catalog::Dispatcher;
use super::error::{ContractError, ErrorCode};

/// JSON-RPC "Invalid params", which MCP uses for an unknown tool.
const INVALID_PARAMS: i64 = -32602;

pub(crate) fn tools_list() -> Value {
    let catalog = committed_json(CATALOG_FILE);
    let tools: Vec<Value> = catalog["operations"]
        .as_array()
        .expect("catalog operations")
        .iter()
        .map(|operation| {
            json!({
                "name": operation["name"],
                "description": operation["description"],
                "inputSchema": committed_json(operation["request"].as_str().unwrap()),
                "outputSchema": committed_json(operation["resultOut"].as_str().unwrap()),
            })
        })
        .collect();
    json!({ "tools": tools })
}

/// `Ok` is a `CallToolResult`; `Err` is a JSON-RPC error object.
pub(crate) fn call_tool(dispatcher: &Dispatcher, name: &str, arguments: &[u8]) -> Result<Value, Value> {
    match dispatcher.dispatch(name, arguments) {
        Ok(value) => Ok(json!({
            "content": [{ "type": "text", "text": value.to_string() }],
            "structuredContent": value,
            "isError": false,
        })),
        Err(error) if error.code == ErrorCode::UnknownOperation => Err(json!({
            "code": INVALID_PARAMS,
            "message": error.message,
        })),
        Err(error) => Ok(json!({
            "content": [{ "type": "text", "text": error_text(&error) }],
            "isError": true,
        })),
    }
}

fn error_text(error: &ContractError) -> String {
    serde_json::to_string(error).expect("contract error serializes")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::artifacts::{assert_self_contained, validator, ERROR_FILE};
    use crate::contracts::catalog::Operation;
    use crate::contracts::project_api::{catalog, sample_dispatcher, FilesReadOp, ProjectContextOp};

    fn tool<'a>(list: &'a Value, name: &str) -> &'a Value {
        list["tools"]
            .as_array()
            .unwrap()
            .iter()
            .find(|tool| tool["name"] == name)
            .unwrap_or_else(|| panic!("tool `{name}` not published"))
    }

    #[test]
    fn published_schemas_are_the_committed_and_generated_ones() {
        let list = tools_list();
        let names: Vec<&str> = list["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap())
            .collect();
        let expected: Vec<&str> = catalog().iter().map(|entry| entry.name).collect();
        assert_eq!(names, expected, "tools are published in catalog order");
        for entry in catalog() {
            let published = tool(&list, entry.name);
            assert_eq!(published["inputSchema"], Value::from((entry.request_schema)()), "{}", entry.name);
            assert_eq!(published["outputSchema"], Value::from((entry.result_schema_out)()), "{}", entry.name);
            assert_eq!(published["inputSchema"]["type"], "object", "{}", entry.name);
            assert_self_contained(entry.name, &published["inputSchema"]);
            assert_self_contained(entry.name, &published["outputSchema"]);
        }
    }

    #[test]
    fn successful_calls_return_conforming_structured_content() {
        let list = tools_list();
        let dispatcher = sample_dispatcher();
        let calls: [(&str, &[u8]); 3] = [
            (ProjectContextOp::NAME, b"{}"),
            (ProjectContextOp::NAME, br#"{"includeSelection":true}"#),
            (FilesReadOp::NAME, br#"{"paths":["src/auth.ts"],"source":"disk"}"#),
        ];
        for (name, arguments) in calls {
            let result = call_tool(&dispatcher, name, arguments).expect("a tool result");
            assert_eq!(result["isError"], false, "{name}");
            let structured = &result["structuredContent"];
            let output_schema = &tool(&list, name)["outputSchema"];
            assert!(validator(output_schema).is_valid(structured), "{name}: structuredContent violates outputSchema");
            // MCP backwards compatibility: the same JSON also as text content.
            let text: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
            assert_eq!(&text, structured, "{name}");
        }
        // The owner stand-in honours the typed request: a disk read is never dirty.
        let disk = call_tool(&dispatcher, FilesReadOp::NAME, br#"{"paths":["src/auth.ts"],"source":"disk"}"#).unwrap();
        for document in disk["structuredContent"]["documents"].as_array().unwrap() {
            if document["kind"] == "read" {
                assert_eq!(document["source"], "disk");
                assert_eq!(document["dirty"], false);
            }
        }
    }

    #[test]
    fn contract_failures_are_tool_errors_without_structured_content() {
        let dispatcher = sample_dispatcher();
        let error_schema = committed_json(ERROR_FILE);
        let result = call_tool(&dispatcher, FilesReadOp::NAME, br#"{"paths":["a"],"extra":true}"#)
            .expect("a tool result, not a protocol error");
        assert_eq!(result["isError"], true);
        assert!(result.get("structuredContent").is_none(), "errors carry no structuredContent");
        let error: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
        assert!(validator(&error_schema).is_valid(&error), "error payload violates {ERROR_FILE}");
        assert_eq!(error["code"], "invalidParams");
    }

    #[test]
    fn an_unknown_tool_is_a_protocol_error() {
        let error = call_tool(&sample_dispatcher(), "litria_nope", b"{}").unwrap_err();
        assert_eq!(error["code"], INVALID_PARAMS);
    }
}
