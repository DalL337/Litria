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
    error_code: Option<ErrorCode>,
    note: String,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
enum Message {
    Request,
    Result,
}

#[derive(Deserialize, Clone, Copy, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
enum Expect {
    Accept,
    Reject,
}

fn manifest() -> Manifest {
    let path = family_dir().join(FIXTURES_DIR).join(MANIFEST);
    let text = fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("parse fixture manifest: {error}"))
}

fn fixture_bytes(fixture: &Fixture) -> Vec<u8> {
    match (&fixture.file, &fixture.generated) {
        (Some(file), None) => fs::read(family_dir().join(FIXTURES_DIR).join(file))
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
        let emitted = serde_json::to_value(samples::files_read_result()).unwrap();
        let path = family_dir().join(FIXTURES_DIR).join("files_read.result.json");
        // Regenerated with the schemas, so it can only ever be Rust's output.
        if std::env::var(UPDATE_ENV).is_ok_and(|value| value == "1") {
            let mut text = serde_json::to_string_pretty(&emitted).unwrap();
            text.push('\n');
            fs::write(&path, text).unwrap();
        }
        let text = fs::read_to_string(&path).unwrap();
        let committed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(committed, emitted, "files_read.result.json differs from what Rust emits");
        // Round trip: what Rust emits, a tolerant reader of the contract reads back.
        let _: FilesReadResult = serde_json::from_value(emitted).unwrap();
    }
}
