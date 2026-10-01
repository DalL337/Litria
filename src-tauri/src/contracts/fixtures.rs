//! Golden fixtures: sampled evidence that the boundary and the schemas agree
//! (ADR-033 decisions 3–4). The JavaScript suite reads the same files.
//!
//! `fixtures/manifest.json` lists every fixture with its expected verdict. For
//! a request, the verdict is the complete inbound boundary's (byte budget →
//! serde → explicit validation); for a result, it is Rust reading a producer's
//! output back. Except for operational-limit fixtures — schema-valid by
//! definition, rejected only by the byte budget — the inbound schema must
//! reach the same verdict.

use std::collections::BTreeSet;
use std::fs;
use std::path::Path;

use serde::Deserialize;
use serde_json::Value;

use super::artifacts::{family_dir, validator, FIXTURES_DIR, UPDATE_ENV};
use super::boundary::MAX_REQUEST_BYTES;
use super::catalog::OperationEntry;
use super::error::ErrorCode;
use super::project_api::files_read::{MAX_DOCUMENTS, MAX_PATH_LENGTH};
use super::project_api::{catalog, API_VERSION, FAMILY};

const MANIFEST: &str = "manifest.json";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    family: String,
    api_version: u32,
    fixtures: Vec<Fixture>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Fixture {
    /// A committed fixture file…
    file: Option<String>,
    /// …or one built by `generated_fixture` (too large to commit usefully).
    generated: Option<String>,
    operation: String,
    message: Message,
    expect: Expect,
    /// Operational-limit case: schema-valid, rejected by the boundary alone.
    #[serde(default)]
    limit: bool,
    /// Bridge request fixtures: the sample event they must equal.
    sample: Option<String>,
    error_code: Option<ErrorCode>,
    note: String,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
enum Message {
    Request,
    Result,
    /// A bridge reply (inbound to Rust).
    Reply,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
enum Expect {
    Accept,
    Reject,
}

fn manifest() -> Manifest {
    manifest_in(&family_dir())
}

fn manifest_in(dir: &Path) -> Manifest {
    let path = dir.join(FIXTURES_DIR).join(MANIFEST);
    let text = fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse fixture manifest: {error}"))
}

fn fixture_bytes(fixture: &Fixture) -> Vec<u8> {
    fixture_bytes_in(&family_dir(), fixture)
}

fn fixture_bytes_in(dir: &Path, fixture: &Fixture) -> Vec<u8> {
    match (&fixture.file, &fixture.generated) {
        (Some(file), None) => fs::read(dir.join(FIXTURES_DIR).join(file))
            .unwrap_or_else(|error| panic!("read fixture {file}: {error}")),
        (None, Some(name)) => generated_fixture(name),
        _ => panic!("fixture must name exactly one of `file` or `generated`: {}", fixture.note),
    }
}

/// Fixtures built at test time.
fn generated_fixture(name: &str) -> Vec<u8> {
    match name {
        // Every path at maxLength in four-byte characters: schema-valid, yet
        // roughly 80 KiB encoded — over the byte budget.
        "overByteBudget" => {
            let path = "😀".repeat(MAX_PATH_LENGTH);
            let documents: Vec<_> = (0..MAX_DOCUMENTS).map(|_| serde_json::json!({ "path": path })).collect();
            let raw = serde_json::to_vec(&serde_json::json!({ "documents": documents })).unwrap();
            assert!(raw.len() > MAX_REQUEST_BYTES, "the fixture must exceed the byte budget");
            raw
        }
        // A schema-valid reply over the bridge reply ceiling: one buffer
        // entry of four-byte characters, within maxLength code points.
        "overReplyCeiling" => {
            use super::project_api_bridge::MAX_REPLY_BYTES;
            let text = "😀".repeat(MAX_REPLY_BYTES / 4 + 1);
            let raw = serde_json::to_vec(&serde_json::json!({
                "kind": "result",
                "result": { "documents": [{
                    "kind": "buffer", "path": "a.txt", "state": "open", "dirty": false,
                    "revision": "b1-x", "text": text, "range": { "startLine": 1, "endLine": 1 },
                    "totalLines": 1, "truncated": false, "lineCut": false
                }]}
            }))
            .unwrap();
            assert!(raw.len() > MAX_REPLY_BYTES, "the fixture must exceed the reply ceiling");
            raw
        }
        // One entry more than the buffer index allows.
        "bufferIndexOverCount" => {
            use super::project_api_bridge::editor::MAX_INDEX_ENTRIES;
            let entries: Vec<_> = (0..=MAX_INDEX_ENTRIES)
                .map(|index| serde_json::json!({
                    "path": format!("f{index}.txt"), "state": "open", "dirty": false,
                    "revision": "b1-x", "byteLength": 1
                }))
                .collect();
            serde_json::to_vec(&serde_json::json!({
                "kind": "result", "result": { "entries": entries, "omitted": 0 }
            }))
            .unwrap()
        }
        // One selected path more than a selection reply may list.
        "selectionOverCount" => {
            use super::project_api_bridge::workspace::MAX_SELECTED_PATHS;
            let selected: Vec<_> = (0..=MAX_SELECTED_PATHS).map(|index| format!("f{index}.txt")).collect();
            serde_json::to_vec(&serde_json::json!({
                "kind": "result", "result": { "selected": selected, "omitted": 0 }
            }))
            .unwrap()
        }
        // One language row more than a capabilities reply may hold.
        "capabilitiesOverCount" => {
            use super::project_api_bridge::languages::MAX_LANGUAGE_ROWS;
            let languages: Vec<_> = (0..=MAX_LANGUAGE_ROWS)
                .map(|index| serde_json::json!({
                    "language": format!("lang{index}"), "extensions": [format!(".x{index}")],
                    "languageServer": "none", "documentAccess": true, "diagnostics": false,
                    "navigation": false, "symbols": false, "relationshipDiscovery": false,
                    "sourceTransformations": false
                }))
                .collect();
            serde_json::to_vec(&serde_json::json!({
                "kind": "result", "result": { "languages": languages }
            }))
            .unwrap()
        }
        other => panic!("unknown generated fixture `{other}`"),
    }
}

fn label(fixture: &Fixture) -> String {
    fixture
        .file
        .clone()
        .or_else(|| fixture.generated.clone())
        .unwrap_or_default()
}

fn entry_for<'a>(catalog: &'a [OperationEntry], operation: &str) -> &'a OperationEntry {
    catalog
        .iter()
        .find(|entry| entry.name == operation)
        .unwrap_or_else(|| panic!("fixture names unknown operation `{operation}`"))
}

#[test]
fn manifest_belongs_to_this_family() {
    let manifest = manifest();
    assert_eq!(manifest.family, FAMILY);
    assert_eq!(manifest.api_version, API_VERSION);
}

#[test]
fn every_fixture_file_is_listed_exactly_once() {
    let manifest = manifest();
    let mut listed = BTreeSet::new();
    for fixture in &manifest.fixtures {
        if let Some(file) = &fixture.file {
            assert!(listed.insert(file.clone()), "fixture listed twice: {file}");
        }
    }
    let on_disk: BTreeSet<String> = fs::read_dir(family_dir().join(FIXTURES_DIR))
        .expect("read fixtures directory")
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|name| name != MANIFEST)
        .collect();
    assert_eq!(listed, on_disk, "fixtures on disk and in the manifest differ");
}

#[test]
fn boundary_verdicts_match_the_inbound_schemas() {
    let catalog = catalog();
    let mut failures = Vec::new();
    for fixture in manifest().fixtures {
        let name = label(&fixture);
        let raw = fixture_bytes(&fixture);
        let entry = entry_for(&catalog, &fixture.operation);
        let (schema, verdict) = match fixture.message {
            Message::Request => ((entry.request_schema)(), (entry.accept_request)(&raw)),
            Message::Result => ((entry.result_schema_in)(), (entry.accept_result)(&raw)),
            Message::Reply => panic!("{name}: replies belong to the bridge family"),
        };
        let instance: Value = serde_json::from_slice(&raw).unwrap();
        let schema_accepts = validator(&Value::from(schema)).is_valid(&instance);
        let boundary_accepts = verdict.is_ok();

        if boundary_accepts != (fixture.expect == Expect::Accept) {
            failures.push(format!("{name}: boundary verdict {verdict:?}, expected {:?}", fixture.expect));
        }
        if fixture.limit {
            if !schema_accepts {
                failures.push(format!("{name}: an operational-limit fixture must be schema-valid"));
            }
        } else if schema_accepts != boundary_accepts {
            failures.push(format!(
                "{name}: schema {} but boundary {} ({verdict:?})",
                if schema_accepts { "accepts" } else { "rejects" },
                if boundary_accepts { "accepts" } else { "rejects" },
            ));
        }
        if let (Some(expected), Err(error)) = (fixture.error_code, &verdict) {
            if error.code != expected {
                failures.push(format!("{name}: error code {:?}, expected {expected:?}", error.code));
            }
        }
    }
    assert!(failures.is_empty(), "fixture verdicts disagree:\n{}", failures.join("\n"));
}

mod outbound {
    use super::*;
    use crate::contracts::artifacts::outbound_schema;
    use crate::contracts::error::ContractError;
    use crate::contracts::project_api::files_read::FilesReadResult;
    use crate::contracts::project_api::files_search::FilesSearchResult;
    use crate::contracts::project_api::project_context::ProjectContextResult;
    use crate::contracts::project_api::samples;
    use schemars::JsonSchema;
    use serde::Serialize;

    fn assert_conforms<T: Serialize + JsonSchema>(label: &str, value: &T) -> Value {
        let instance = serde_json::to_value(value).unwrap();
        let outbound = Value::from(outbound_schema::<T>());
        let errors: Vec<String> = validator(&outbound)
            .iter_errors(&instance)
            .map(|error| error.to_string())
            .collect();
        assert!(errors.is_empty(), "{label}: emitted value violates its outbound schema: {errors:?}");
        instance
    }

    /// What Rust emits conforms to the outbound schema, for every outcome kind.
    #[test]
    fn emitted_values_conform_to_their_outbound_schemas() {
        assert_conforms("project context", &samples::project_context_result());
        let search = assert_conforms("files search", &samples::files_search_result());
        assert_eq!(search["matches"][2]["kind"], "path");
        let files_read = assert_conforms("files read", &samples::files_read_result());
        let empty = &files_read["documents"][2];
        assert_eq!(empty["kind"], "read");
        assert!(empty.get("range").is_none(), "an absent range is omitted");
        assert_conforms(
            "error",
            &ContractError::new(ErrorCode::LimitExceeded, "request is too large"),
        );
    }

    /// The committed result fixture is exactly what Rust emits, so readers
    /// are tested against real output, not hand-made shapes.
    #[test]
    fn result_fixtures_are_what_rust_emits() {
        fn check<T: Serialize + serde::de::DeserializeOwned>(file: &str, sample: &T) {
            let emitted = serde_json::to_value(sample).unwrap();
            let path = family_dir().join(FIXTURES_DIR).join(file);
            // Regenerated with the schemas, so it can only ever be Rust's output.
            if std::env::var(UPDATE_ENV).is_ok_and(|value| value == "1") {
                let mut text = serde_json::to_string_pretty(&emitted).unwrap();
                text.push('\n');
                fs::write(&path, text).unwrap();
            }
            let text = fs::read_to_string(&path).unwrap();
            let committed: Value = serde_json::from_str(&text).unwrap();
            assert_eq!(committed, emitted, "{file} differs from what Rust emits");
            // Round trip: what Rust emits, a tolerant reader of the contract reads back.
            let _: T = serde_json::from_value(emitted).unwrap();
        }
        check::<FilesReadResult>("files_read.result.json", &samples::files_read_result());
        check::<ProjectContextResult>("project_context.result.json", &samples::project_context_result());
        check::<FilesSearchResult>("files_search.result.json", &samples::files_search_result());
    }
}

/// The bridge family's fixtures (build plan P2). Requests are what Rust EMITS:
/// each request fixture must equal the sample event it names, and conform to
/// the envelope and the operation's request schema. Replies are what Rust
/// ACCEPTS: the reply boundary's verdict must equal the reply schema's, as
/// for project-api requests. The JavaScript bridge is tested against the same
/// files (test/domains/projectApiBridge.test.mjs).
mod bridge_family {
    use super::*;
    use crate::contracts::artifacts::{bridge_dir, EVENT_FILE};
    use crate::contracts::project_api_bridge::entry::BridgeEntry;
    use crate::contracts::project_api_bridge::{catalog, samples, API_VERSION, FAMILY};

    fn entry_for<'a>(catalog: &'a [BridgeEntry], operation: &str) -> &'a BridgeEntry {
        catalog
            .iter()
            .find(|entry| entry.name == operation)
            .unwrap_or_else(|| panic!("fixture names unknown bridge operation `{operation}`"))
    }

    #[test]
    fn manifest_belongs_to_this_family() {
        let manifest = manifest_in(&bridge_dir());
        assert_eq!(manifest.family, FAMILY);
        assert_eq!(manifest.api_version, API_VERSION);
    }

    #[test]
    fn every_fixture_file_is_listed_exactly_once() {
        let manifest = manifest_in(&bridge_dir());
        let mut listed = BTreeSet::new();
        for fixture in &manifest.fixtures {
            if let Some(file) = &fixture.file {
                assert!(listed.insert(file.clone()), "fixture listed twice: {file}");
            }
        }
        let on_disk: BTreeSet<String> = fs::read_dir(bridge_dir().join(FIXTURES_DIR))
            .expect("read fixtures directory")
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name != MANIFEST)
            .collect();
        assert_eq!(listed, on_disk, "fixtures on disk and in the manifest differ");
    }

    #[test]
    fn reply_verdicts_match_the_reply_schemas() {
        let catalog = catalog();
        let mut failures = Vec::new();
        let mut checked = 0;
        for fixture in manifest_in(&bridge_dir()).fixtures {
            if fixture.message != Message::Reply {
                continue;
            }
            checked += 1;
            let name = label(&fixture);
            let raw = fixture_bytes_in(&bridge_dir(), &fixture);
            let entry = entry_for(&catalog, &fixture.operation);
            let verdict = (entry.accept_reply)(&raw);
            let instance: Value = serde_json::from_slice(&raw).unwrap();
            let schema_accepts = validator(&Value::from((entry.reply_schema)())).is_valid(&instance);
            let boundary_accepts = verdict.is_ok();
            if boundary_accepts != (fixture.expect == Expect::Accept) {
                failures.push(format!("{name}: boundary verdict {verdict:?}, expected {:?}", fixture.expect));
            }
            if fixture.limit {
                if !schema_accepts {
                    failures.push(format!("{name}: an operational-limit fixture must be schema-valid"));
                }
            } else if schema_accepts != boundary_accepts {
                failures.push(format!(
                    "{name}: schema {} but boundary {} ({verdict:?})",
                    if schema_accepts { "accepts" } else { "rejects" },
                    if boundary_accepts { "accepts" } else { "rejects" },
                ));
            }
            if let (Some(expected), Err(error)) = (fixture.error_code, &verdict) {
                if error.code != expected {
                    failures.push(format!("{name}: error code {:?}, expected {expected:?}", error.code));
                }
            }
        }
        assert!(checked > 0, "no reply fixtures were checked");
        assert!(failures.is_empty(), "reply fixture verdicts disagree:\n{}", failures.join("\n"));
    }

    /// Request fixtures are exactly what Rust emits (regenerated with the
    /// schemas), and conform to the envelope and the operation's schema.
    #[test]
    fn request_fixtures_are_what_rust_emits() {
        let catalog = catalog();
        let envelope = validator(&crate::contracts::artifacts::committed_json_in(&bridge_dir(), EVENT_FILE));
        let mut checked = 0;
        for fixture in manifest_in(&bridge_dir()).fixtures {
            if fixture.message != Message::Request {
                continue;
            }
            checked += 1;
            let file = fixture.file.clone().expect("request fixtures are committed files");
            let sample = match fixture.sample.as_deref() {
                Some("documents") => samples::documents_event(),
                Some("bufferIndex") => samples::buffer_index_event(),
                Some("selection") => samples::selection_event(),
                Some("capabilities") => samples::capabilities_event(),
                other => panic!("{file}: unknown sample {other:?}"),
            };
            assert_eq!(sample.op, fixture.operation, "{file}: the sample is for another operation");
            let emitted = serde_json::to_value(&sample).unwrap();
            let path = bridge_dir().join(FIXTURES_DIR).join(&file);
            if std::env::var(UPDATE_ENV).is_ok_and(|value| value == "1") {
                let mut text = serde_json::to_string_pretty(&emitted).unwrap();
                text.push('\n');
                fs::write(&path, text).unwrap();
            }
            let committed: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            assert_eq!(committed, emitted, "{file} differs from what Rust emits");
            assert!(envelope.is_valid(&committed), "{file}: violates the event envelope schema");
            let request_schema = validator(&Value::from((entry_for(&catalog, &fixture.operation).request_schema)()));
            let errors: Vec<String> = request_schema
                .iter_errors(&committed["request"])
                .map(|error| error.to_string())
                .collect();
            assert!(errors.is_empty(), "{file}: request violates its schema: {errors:?}");
        }
        assert!(checked > 0, "no request fixtures were checked");
    }
}
