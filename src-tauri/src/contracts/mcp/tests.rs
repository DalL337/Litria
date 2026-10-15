//! The adapter's mapping, over the test dispatcher (sample results): what it
//! publishes and how it shapes every kind of answer. The real catalog runs in
//! `real_catalog`.

use super::*;
use crate::contracts::artifacts::{assert_self_contained, committed_files_of_family, validator};
use crate::contracts::catalog::Operation;
use crate::contracts::context::{Grant, Principal};
use crate::contracts::project_api::files_read::FilesReadOp;
use crate::contracts::project_api::{catalog, test_dispatcher};

/// Every capability in the catalog.
pub(super) fn whole_catalog() -> Grant {
    Grant::of(catalog().iter().map(|entry| entry.capability))
}

/// P6 pinned the mapping to the stateless revision with every tool listed;
/// these keep its tests there. The handshake revisions have their own tests
/// below.
pub(super) fn tools_list() -> Value {
    super::tools_list(Revision::V2026_07_28, &whole_catalog())
}

pub(super) fn tools_call(dispatcher: &Dispatcher, context: &CallContext, params: &Value) -> Result<Value, Value> {
    super::tools_call(dispatcher, context, params, Revision::V2026_07_28)
}

pub(super) fn tool<'a>(list: &'a Value, name: &str) -> &'a Value {
    list["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tool| tool["name"] == name)
        .unwrap_or_else(|| panic!("tool `{name}` not published"))
}

/// The error JSON a tool error carries as its text.
pub(super) fn error_of(result: &Value) -> Value {
    assert_eq!(result["isError"], true, "{result}");
    assert!(result.get("structuredContent").is_none(), "errors carry no structuredContent");
    serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
}

fn context() -> CallContext {
    CallContext {
        principal: Principal::Test,
        grant: Grant::of([FilesReadOp::CAPABILITY]),
        epoch: "ws-test".into(),
    }
}

/// The embedded table is the committed directory's served files, byte for
/// byte, and covers every file the catalog names.
#[test]
fn artifacts_are_embedded_exactly_as_committed() {
    let committed = committed_files_of_family();
    for (name, text) in embedded::FILES {
        assert_eq!(Some(*text), committed.get(*name).map(String::as_str), "{name} differs from the committed file");
    }
    let catalog = embedded::json(embedded::CATALOG);
    let mut named = vec![embedded::CATALOG.to_string(), catalog["error"].as_str().unwrap().to_string()];
    for operation in catalog["operations"].as_array().unwrap() {
        for key in ["request", "resultOut"] {
            named.push(operation[key].as_str().unwrap().to_string());
        }
    }
    for name in &named {
        assert!(embedded::text(name).is_some(), "the catalog names `{name}`, which is not embedded");
    }
    assert_eq!(embedded::FILES.len(), named.len(), "embedded files the catalog does not name");
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
        assert_self_contained(entry.name, &published["inputSchema"]);
        assert_self_contained(entry.name, &published["outputSchema"]);
    }
}

/// MCP 2026-07-28, Tool: names of 1–128 characters from `A–Z a–z 0–9 _ - .`,
/// unique; `inputSchema` an object schema; annotations as the catalog says.
#[test]
fn tool_definitions_follow_the_revision() {
    let list = tools_list();
    assert_eq!(list["resultType"], "complete");
    let mut seen = std::collections::BTreeSet::new();
    for entry in catalog() {
        let published = tool(&list, entry.name);
        let name = entry.name;
        assert!((1..=128).contains(&name.len()), "{name}: length");
        assert!(
            name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.')),
            "{name}: characters"
        );
        assert!(seen.insert(name), "{name}: duplicate");
        assert_eq!(published["inputSchema"]["type"], "object", "{name}: inputSchema root");
        assert!(!published["description"].as_str().unwrap().is_empty(), "{name}: description");
        assert_eq!(published["annotations"]["readOnlyHint"], entry.read_only, "{name}");
        assert_eq!(published["annotations"]["openWorldHint"], false, "{name}");
    }
    // The reads are read-only; proposing a change is not (build plan W2a).
    for entry in catalog() {
        assert_eq!(entry.read_only, !entry.name.starts_with("litria_changes_"), "{}", entry.name);
    }
}

#[test]
fn successful_calls_return_conforming_structured_content() {
    let list = tools_list();
    let params = json!({ "name": FilesReadOp::NAME, "arguments": { "documents": [{ "path": "src/auth.ts" }], "source": "disk" } });
    let result = tools_call(&test_dispatcher(), &context(), &params).expect("a tool result");
    assert_eq!(result["resultType"], "complete");
    assert_eq!(result["isError"], false);
    let structured = &result["structuredContent"];
    let output_schema = &tool(&list, FilesReadOp::NAME)["outputSchema"];
    assert!(validator(output_schema).is_valid(structured), "structuredContent violates outputSchema");
    // The revision's backwards compatibility: the same JSON also as text.
    let text: Value = serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap();
    assert_eq!(&text, structured);
}

#[test]
fn contract_failures_are_tool_errors_without_structured_content() {
    let error_schema = embedded::json(embedded::ERROR);
    let params = json!({ "name": FilesReadOp::NAME, "arguments": { "documents": [{ "path": "a" }], "extra": true } });
    let result = tools_call(&test_dispatcher(), &context(), &params).expect("a tool result, not a protocol error");
    assert_eq!(result["resultType"], "complete");
    let error = error_of(&result);
    assert!(validator(&error_schema).is_valid(&error), "error payload violates {}", embedded::ERROR);
    assert_eq!(error["code"], "invalidParams");
}

#[test]
fn a_denied_capability_is_a_tool_error() {
    let mut context = context();
    context.grant = Grant::default();
    let params = json!({ "name": FilesReadOp::NAME, "arguments": { "documents": [{ "path": "a" }] } });
    let result = tools_call(&test_dispatcher(), &context, &params).expect("a tool result");
    assert_eq!(error_of(&result)["code"], "denied");
}

#[test]
fn an_unknown_tool_is_a_protocol_error() {
    let error = tools_call(&test_dispatcher(), &context(), &json!({ "name": "litria_nope" })).unwrap_err();
    assert_eq!(error["code"], INVALID_PARAMS);
}

/// A call that is not a `CallToolRequest` never reaches a tool.
#[test]
fn malformed_calls_are_protocol_errors() {
    for params in [
        json!(null),
        json!([]),
        json!({}),
        json!({ "name": 7 }),
        json!({ "name": FilesReadOp::NAME, "arguments": [] }),
        json!({ "name": FilesReadOp::NAME, "arguments": "{}" }),
        json!({ "name": FilesReadOp::NAME, "arguments": null }),
    ] {
        let error = tools_call(&test_dispatcher(), &context(), &params).expect_err(&params.to_string());
        assert_eq!(error["code"], INVALID_PARAMS, "{params}");
    }
}

/// `arguments` is optional: absent, the tool sees `{}` (here rejected by the
/// operation's own schema, so a tool error, not a protocol one).
#[test]
fn absent_arguments_are_an_empty_object() {
    let result = tools_call(&test_dispatcher(), &context(), &json!({ "name": FilesReadOp::NAME })).expect("a tool result");
    assert_eq!(error_of(&result)["code"], "invalidParams");
}

/// Nothing a caller sends comes back in a message: not the tool name, not a
/// field name, not a value (contract brief §9).
#[test]
fn errors_never_echo_the_call() {
    let secret = "hunter2_SECRET";
    let unknown = tools_call(&test_dispatcher(), &context(), &json!({ "name": format!("litria_{secret}") })).unwrap_err();
    let malformed = tools_call(&test_dispatcher(), &context(), &json!({ "name": FilesReadOp::NAME, "arguments": secret }))
        .unwrap_err();
    let field = tools_call(
        &test_dispatcher(),
        &context(),
        &json!({ "name": FilesReadOp::NAME, "arguments": { "documents": [{ "path": "a" }], secret: secret } }),
    )
    .unwrap();
    for answer in [unknown, malformed, field] {
        assert!(!answer.to_string().contains(secret), "echoed: {answer}");
    }
}

#[test]
fn the_revisions_are_named_as_the_specification_names_them() {
    assert_eq!(Revision::V2026_07_28.as_str(), "2026-07-28");
    assert_eq!(Revision::V2025_11_25.as_str(), "2025-11-25");
    assert_eq!(Revision::V2025_06_18.as_str(), "2025-06-18");
    // The handshake serves exactly what the installed agents ask for
    // (Claude Code 2.1.185: 2025-11-25; Codex 0.162: 2025-06-18), newest first.
    assert_eq!(Revision::HANDSHAKE, [Revision::V2025_11_25, Revision::V2025_06_18]);
    assert_eq!(Revision::handshake("2025-06-18"), Some(Revision::V2025_06_18));
    assert_eq!(Revision::handshake("2026-07-28"), None, "the stateless revision has no handshake");
    assert_eq!(Revision::handshake("2025-03-26"), None, "no outputSchema in 2025-03-26");
}

/// A handshake revision's results are the stateless ones minus `resultType`,
/// which only 2026-07-28 defines.
#[test]
fn handshake_results_carry_no_result_type() {
    for revision in Revision::HANDSHAKE {
        let list = super::tools_list(revision, &whole_catalog());
        assert!(list.get("resultType").is_none(), "{}: {list}", revision.as_str());
        let mut stateless = tools_list();
        stateless.as_object_mut().unwrap().remove("resultType");
        assert_eq!(list, stateless, "{}", revision.as_str());

        let params = json!({ "name": FilesReadOp::NAME, "arguments": { "documents": [{ "path": "src/auth.ts" }], "source": "disk" } });
        let result = super::tools_call(&test_dispatcher(), &context(), &params, revision).unwrap();
        assert!(result.get("resultType").is_none(), "{result}");
        assert_eq!(result["isError"], false);
        let denied = json!({ "name": "litria_project_context" });
        let error = super::tools_call(&test_dispatcher(), &context(), &denied, revision).unwrap();
        assert!(error.get("resultType").is_none(), "{error}");
        assert_eq!(error["isError"], true);
    }
}

/// Track T plan D5: the list shows what the grant allows, in catalog order,
/// and nothing else.
#[test]
fn the_list_shows_only_granted_tools() {
    let names = |grant: &Grant| -> Vec<String> {
        super::tools_list(Revision::V2025_11_25, grant)["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_owned())
            .collect()
    };
    let all: Vec<String> = catalog().iter().map(|entry| entry.name.to_owned()).collect();
    assert_eq!(names(&whole_catalog()), all);
    assert!(names(&Grant::default()).is_empty());
    let reads = Grant::of(catalog().iter().filter(|entry| entry.read_only).map(|entry| entry.capability));
    let expected: Vec<String> = catalog().iter().filter(|e| e.read_only).map(|e| e.name.to_owned()).collect();
    assert_eq!(names(&reads), expected);
    assert!(!names(&reads).iter().any(|name| name == "litria_changes_apply"));
}
