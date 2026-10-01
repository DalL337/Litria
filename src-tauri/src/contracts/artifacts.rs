//! Schema generation and the committed artifact set (ADR-033 decisions 2, 5).
//!
//! Inbound schemas use schemars' deserialize contract and outbound schemas its
//! serialize contract, both with the 2020-12 dialect pinned explicitly —
//! schemars documents its default settings as liable to change. The rendered
//! files are committed; `committed_artifacts_match_generation` fails when the
//! committed set is missing a file, carries an extra one, or differs from what
//! the contract types generate today.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use schemars::generate::SchemaSettings;
use schemars::{JsonSchema, Schema};
use serde::Serialize;
use serde_json::{json, Value};

use super::error::ContractError;
use super::project_api::{catalog, API_VERSION, FAMILY, STATUS};
use super::project_api_bridge as bridge;

pub(crate) const DRAFT_2020_12: &str = "https://json-schema.org/draft/2020-12/schema";
pub(crate) const CATALOG_FILE: &str = "catalog.json";
pub(crate) const ERROR_FILE: &str = "error.schema.json";
pub(crate) const FIXTURES_DIR: &str = "fixtures";
pub(crate) const UPDATE_ENV: &str = "LITRIA_UPDATE_CONTRACTS";
/// The bridge family's event envelope.
pub(crate) const EVENT_FILE: &str = "request-event.schema.json";

/// What Rust accepts.
pub(crate) fn inbound_schema<T: JsonSchema>() -> Schema {
    SchemaSettings::draft2020_12()
        .for_deserialize()
        .into_generator()
        .into_root_schema_for::<T>()
}

/// What Rust emits.
pub(crate) fn outbound_schema<T: JsonSchema>() -> Schema {
    SchemaSettings::draft2020_12()
        .for_serialize()
        .into_generator()
        .into_root_schema_for::<T>()
}

/// `src-tauri/contracts/<family>/v<apiVersion>/` — inside `src-tauri/`, so the
/// Rust CI path filter (`src-tauri/**`) already covers every artifact.
pub(crate) fn family_dir() -> PathBuf {
    family_dir_of(FAMILY, API_VERSION)
}

pub(crate) fn family_dir_of(family: &str, api_version: u32) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("contracts")
        .join(family)
        .join(format!("v{api_version}"))
}

/// `src-tauri/contracts/project-api-bridge/v1/`.
pub(crate) fn bridge_dir() -> PathBuf {
    family_dir_of(bridge::FAMILY, bridge::API_VERSION)
}

pub(crate) fn bridge_request_file(operation: &str) -> String {
    format!("{operation}.request.schema.json")
}

pub(crate) fn bridge_reply_file(operation: &str) -> String {
    format!("{operation}.reply.schema.json")
}

/// The bridge family's artifacts. Its direction is reversed: a request
/// schema describes what Rust EMITS (outbound) and a reply schema what Rust
/// ACCEPTS (inbound). The catalog also publishes the event name, the reply
/// command and the reply ceiling, so the JavaScript side can be tested
/// against them.
pub(crate) fn generate_bridge() -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    let mut operations = Vec::new();
    for operation in bridge::catalog() {
        let request = bridge_request_file(operation.name);
        let reply = bridge_reply_file(operation.name);
        files.insert(request.clone(), render(&(operation.request_schema)()));
        files.insert(reply.clone(), render(&(operation.reply_schema)()));
        operations.push(json!({
            "name": operation.name,
            "description": operation.description,
            "owner": operation.owner,
            "request": request,
            "reply": reply,
        }));
    }
    files.insert(
        EVENT_FILE.into(),
        render(&outbound_schema::<bridge::BridgeRequestEvent>()),
    );
    files.insert(
        CATALOG_FILE.into(),
        render(&json!({
            "family": bridge::FAMILY,
            "apiVersion": bridge::API_VERSION,
            "status": bridge::STATUS,
            "event": bridge::REQUEST_EVENT,
            "envelope": EVENT_FILE,
            "replyCommand": "project_api_bridge_reply",
            "maxReplyBytes": bridge::MAX_REPLY_BYTES,
            "operations": operations,
        })),
    );
    files
}

/// Every family: its directory and what its types generate today.
pub(crate) fn families() -> Vec<(PathBuf, BTreeMap<String, String>)> {
    vec![(family_dir(), generate()), (bridge_dir(), generate_bridge())]
}

pub(crate) fn request_file(operation: &str) -> String {
    format!("{operation}.request.schema.json")
}

pub(crate) fn result_out_file(operation: &str) -> String {
    format!("{operation}.result.out.schema.json")
}

pub(crate) fn result_in_file(operation: &str) -> String {
    format!("{operation}.result.in.schema.json")
}

/// Every generated artifact of the family, keyed by file name and rendered
/// exactly as committed. Result types travel both ways (emitted to callers,
/// read back from the JavaScript bridge), so both directions are always
/// written — identical or not — and consumers never have to guess which exists.
pub(crate) fn generate() -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    let mut operations = Vec::new();
    for operation in catalog() {
        let request = request_file(operation.name);
        let result_out = result_out_file(operation.name);
        let result_in = result_in_file(operation.name);
        files.insert(request.clone(), render(&(operation.request_schema)()));
        files.insert(result_out.clone(), render(&(operation.result_schema_out)()));
        files.insert(result_in.clone(), render(&(operation.result_schema_in)()));
        operations.push(json!({
            "name": operation.name,
            "description": operation.description,
            "capability": operation.capability,
            "request": request,
            "resultOut": result_out,
            "resultIn": result_in,
        }));
    }
    files.insert(ERROR_FILE.into(), render(&outbound_schema::<ContractError>()));
    files.insert(
        CATALOG_FILE.into(),
        render(&json!({
            "family": FAMILY,
            "apiVersion": API_VERSION,
            "status": STATUS,
            "error": ERROR_FILE,
            "operations": operations,
        })),
    );
    files
}

fn render(value: &impl Serialize) -> String {
    let mut text = serde_json::to_string_pretty(value).expect("contract artifact serializes");
    text.push('\n');
    text
}

/// Top-level files of the family directory (the hand-written `fixtures/`
/// subdirectory is not part of the generated set).
fn committed_files(dir: &Path) -> BTreeMap<String, String> {
    let mut files = BTreeMap::new();
    let Ok(entries) = fs::read_dir(dir) else {
        return files;
    };
    for entry in entries {
        let entry = entry.expect("read contracts directory entry");
        if entry.file_type().expect("file type").is_file() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let text = fs::read_to_string(entry.path()).expect("read committed artifact");
            files.insert(name, text);
        }
    }
    files
}

fn write_all(dir: &Path, generated: &BTreeMap<String, String>) {
    fs::create_dir_all(dir).expect("create contracts directory");
    for name in committed_files(dir).keys() {
        if !generated.contains_key(name) {
            fs::remove_file(dir.join(name)).expect("remove stale artifact");
        }
    }
    for (name, text) in generated {
        fs::write(dir.join(name), text).expect("write artifact");
    }
}

/// Parsed committed artifact, as a transport would embed it.
pub(crate) fn committed_json(name: &str) -> Value {
    committed_json_in(&family_dir(), name)
}

pub(crate) fn committed_json_in(dir: &Path, name: &str) -> Value {
    let text = fs::read_to_string(dir.join(name))
        .unwrap_or_else(|error| panic!("read committed artifact {name}: {error}"));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse {name}: {error}"))
}

pub(crate) fn validator(schema: &Value) -> jsonschema::Validator {
    jsonschema::draft202012::new(schema).expect("schema compiles as draft 2020-12")
}

/// Every `$ref` in a schema document.
pub(crate) fn refs(schema: &Value) -> Vec<String> {
    let mut found = Vec::new();
    collect_refs(schema, &mut found);
    found
}

fn collect_refs(value: &Value, found: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, child) in map {
                if key == "$ref" {
                    if let Value::String(reference) = child {
                        found.push(reference.clone());
                    }
                }
                collect_refs(child, found);
            }
        }
        Value::Array(items) => items.iter().for_each(|item| collect_refs(item, found)),
        _ => {}
    }
}

/// Every reference is local (`#/$defs/...`) and resolves inside the document.
pub(crate) fn assert_self_contained(name: &str, schema: &Value) {
    for reference in refs(schema) {
        let pointer = reference
            .strip_prefix('#')
            .unwrap_or_else(|| panic!("{name}: non-local $ref {reference}"));
        assert!(
            pointer.starts_with("/$defs/"),
            "{name}: $ref outside $defs: {reference}"
        );
        assert!(
            schema.pointer(pointer).is_some(),
            "{name}: $ref does not resolve: {reference}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::project_api::files_read::FilesReadResult;

    #[test]
    fn committed_artifacts_match_generation() {
        for (dir, generated) in families() {
            check_family(&dir, &generated);
        }
    }

    fn check_family(dir: &Path, generated: &BTreeMap<String, String>) {
        if std::env::var(UPDATE_ENV).is_ok_and(|value| value == "1") {
            write_all(dir, generated);
            return;
        }
        let committed = committed_files(dir);
        let missing: Vec<&String> = generated.keys().filter(|name| !committed.contains_key(*name)).collect();
        let extra: Vec<&String> = committed.keys().filter(|name| !generated.contains_key(*name)).collect();
        let stale: Vec<&String> = generated
            .iter()
            .filter(|(name, text)| committed.get(*name).is_some_and(|committed| committed != *text))
            .map(|(name, _)| name)
            .collect();
        assert!(
            missing.is_empty() && extra.is_empty() && stale.is_empty(),
            "contract artifacts in {} are out of date — missing {missing:?}, extra {extra:?}, stale {stale:?}. \
             Regenerate with {UPDATE_ENV}=1 cargo test contracts:: and review the diff.",
            dir.display()
        );
    }

    #[test]
    fn generation_is_deterministic() {
        assert_eq!(generate(), generate());
        assert_eq!(generate_bridge(), generate_bridge());
    }

    #[test]
    fn every_schema_is_a_self_contained_2020_12_document() {
        for (name, text) in generate().into_iter().chain(generate_bridge()) {
            if name == CATALOG_FILE {
                continue;
            }
            let schema: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(schema["$schema"], DRAFT_2020_12, "{name}: dialect");
            assert!(
                jsonschema::draft202012::meta::is_valid(&schema),
                "{name}: not a valid draft 2020-12 schema"
            );
            assert_self_contained(&name, &schema);
        }
    }

    #[test]
    fn request_schemas_are_closed_objects() {
        for operation in catalog() {
            let schema = Value::from((operation.request_schema)());
            assert_eq!(schema["type"], "object", "{}: MCP inputSchema must be an object", operation.name);
            assert_closed(operation.name, &schema);
        }
    }

    /// The bridge's replies are inbound and read strictly, like requests.
    #[test]
    fn bridge_reply_schemas_are_closed_objects() {
        for operation in bridge::catalog() {
            let schema = Value::from((operation.reply_schema)());
            assert_closed(operation.name, &schema);
        }
    }

    /// Every object subschema of an inbound request rejects unknown properties.
    fn assert_closed(name: &str, value: &Value) {
        match value {
            Value::Object(map) => {
                if map.contains_key("properties") {
                    assert_eq!(
                        map.get("additionalProperties"),
                        Some(&Value::Bool(false)),
                        "{name}: an object subschema accepts unknown fields"
                    );
                }
                map.values().for_each(|child| assert_closed(name, child));
            }
            Value::Array(items) => items.iter().for_each(|item| assert_closed(name, item)),
            _ => {}
        }
    }

    /// The directions differ exactly where serde does: `lineCut` is defaulted
    /// when read, so optional inbound, but always written, so required outbound.
    #[test]
    fn directional_schemas_differ_where_serde_does() {
        let inbound = Value::from(inbound_schema::<FilesReadResult>());
        let outbound = Value::from(outbound_schema::<FilesReadResult>());
        assert!(!read_variant_requires(&inbound, "lineCut"), "inbound should not require `lineCut`");
        assert!(read_variant_requires(&outbound, "lineCut"), "outbound should require `lineCut`");
        assert_ne!(inbound, outbound);
    }

    fn read_variant_requires(schema: &Value, field: &str) -> bool {
        let variants = schema
            .pointer("/$defs/DocumentOutcome/oneOf")
            .and_then(Value::as_array)
            .expect("DocumentOutcome is a oneOf of tagged variants");
        let read = variants
            .iter()
            .find(|variant| variant.pointer("/properties/kind/const") == Some(&json!("read")))
            .expect("a `read` variant");
        read["required"]
            .as_array()
            .is_some_and(|required| required.contains(&json!(field)))
    }
}
