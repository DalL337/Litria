//! `litria_diagnostics_list` handler tests (build plan P5b): every per-file
//! state, the disclosure rules, the ceilings, and message redaction, over a
//! scripted source of sessions + store snapshots + the editor's capability
//! table — plus one pass through the epoch fence and the real bridge.

// This whole file is the handler's test module (`#[cfg(test)] mod tests;`),
// so the Windows-hidden-spawn guard skips it: the junction helper below spawns
// `cmd` directly, as the reader's own link tests do.
use super::*;
use crate::lsp::diagnostics_cache::{
    DocumentDiagnostics, Freshness as StoreFreshness, Position, Range, RelatedLocation as StoreRelated,
    SessionSnapshot, StaleReason, StoredDiagnostic, UnknownReason,
};
use serde_json::json;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_root(tag: &str) -> PathBuf {
    let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let dir = std::env::temp_dir().join(format!("litria-api-diag-{tag}-{}-{stamp}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    fs::canonicalize(dir).unwrap()
}

fn put(root: &Path, path: &str) {
    let full = root.join(path);
    fs::create_dir_all(full.parent().unwrap()).unwrap();
    fs::write(full, "x\n").unwrap();
}

/// A `file:` URI for a project path, spelled the way servers spell them.
fn uri(root: &Path, path: &str) -> String {
    let text = format!("{}/{path}", root_text(root));
    if text.starts_with('/') {
        format!("file://{text}")
    } else {
        format!("file:///{text}")
    }
}

fn stored(line: u32, severity: Option<u8>, message: &str) -> StoredDiagnostic {
    StoredDiagnostic {
        severity,
        message: message.into(),
        range: Range {
            start: Position { line, character: 0 },
            end: Position { line, character: 4 },
        },
        code: Some("2322".into()),
        source: None,
        related: Vec::new(),
    }
}

fn document(root: &Path, path: &str, freshness: StoreFreshness, diagnostics: Vec<StoredDiagnostic>) -> DocumentDiagnostics {
    DocumentDiagnostics {
        uri: uri(root, path),
        key: path.into(),
        diagnostics,
        store_truncated: false,
        freshness,
        // Published while the file was what it is now.
        canonical_at_publish: fs::canonicalize(root.join(path)).ok(),
    }
}

fn session(language: &str, documents: Vec<DocumentDiagnostics>) -> SessionDiagnostics {
    SessionDiagnostics {
        session: LiveSession {
            language_id: language.into(),
            project_id: "p".into(),
            session_id: format!("p::{language}::1"),
        },
        producer: producer_name(language),
        snapshot: Some(SessionSnapshot {
            session_id: format!("p::{language}::1"),
            language_id: language.into(),
            documents,
            documents_evicted: false,
        }),
    }
}

/// The editor's real shape for the rows these tests touch.
fn capabilities() -> CapabilitiesResult {
    let row = |language: &str, extensions: &[&str], source: &str, server: Option<&str>| {
        json!({
            "language": language, "extensions": extensions, "languageServer": "installed",
            "documentAccess": true, "diagnostics": source != "none", "diagnosticsSource": source,
            "server": server, "navigation": true, "symbols": true,
            "relationshipDiscovery": false, "sourceTransformations": false
        })
    };
    serde_json::from_value(json!({ "languages": [
        row("typescript", &[".ts", ".tsx"], "server", Some("typescript")),
        row("javascript", &[".js"], "server", Some("typescript")),
        row("python", &[".py"], "server", Some("python")),
        row("json", &[".json"], "editor", None),
        row("markdown", &[".md"], "none", None),
    ]}))
    .unwrap()
}

#[derive(Default)]
struct Scripted {
    sessions: Vec<SessionDiagnostics>,
    capability_calls: usize,
}

impl DiagnosticsSources for Scripted {
    fn capabilities(&mut self) -> Result<CapabilitiesResult, ContractError> {
        self.capability_calls += 1;
        Ok(capabilities())
    }
    fn sessions(&mut self, _root: &Path) -> Vec<SessionDiagnostics> {
        std::mem::take(&mut self.sessions)
    }
}

fn request(value: serde_json::Value) -> DiagnosticsListRequest {
    serde_json::from_value(value).unwrap()
}

fn paths_and_states(result: &DiagnosticsListResult) -> Vec<String> {
    result
        .files
        .iter()
        .map(|file| match file {
            FileDiagnostics::Available { path, diagnostics, .. } => format!("{path} available {}", diagnostics.len()),
            FileDiagnostics::Unavailable { path, reason } => format!("{path} unavailable {reason:?}"),
            FileDiagnostics::NoProducer { path } => format!("{path} noProducer"),
            FileDiagnostics::Denied { path } => format!("{path} denied"),
            FileDiagnostics::InvalidPath { path } => format!("{path} invalidPath"),
            FileDiagnostics::Skipped { path } => format!("{path} skipped"),
        })
        .collect()
}

const FRESH: StoreFreshness = StoreFreshness::Current;

#[test]
fn named_paths_report_every_state_in_request_order() {
    let root = temp_root("states");
    for path in ["src/a.ts", "src/b.json", "src/c.py", "src/d.ts", "README.md", ".env"] {
        put(&root, path);
    }
    let mut sources = Scripted {
        sessions: vec![session("typescript", vec![document(&root, "src/a.ts", FRESH, vec![stored(0, Some(1), "bad")])])],
        ..Scripted::default()
    };
    let result = run(
        &root,
        &request(json!({ "paths": ["src/a.ts", "src/b.json", "src/c.py", "src/d.ts", "README.md", ".env", "../x.ts"] })),
        &mut sources,
        MAX_RESPONSE_BYTES,
    )
    .unwrap();
    assert_eq!(
        paths_and_states(&result),
        [
            "src/a.ts available 1",
            "src/b.json unavailable NotBridged",
            "src/c.py unavailable ProducerNotRunning",
            "src/d.ts unavailable NotAnalyzed",
            "README.md noProducer",
            ".env denied",
            "../x.ts invalidPath",
        ]
    );
    assert_eq!(sources.capability_calls, 1, "the table is fetched once, lazily");
    assert!(!result.truncated);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_table_is_not_fetched_when_nothing_needs_it() {
    let root = temp_root("lazy");
    put(&root, "src/a.ts");
    let docs = || vec![document(&root, "src/a.ts", FRESH, vec![stored(0, Some(1), "bad")])];
    let mut named = Scripted {
        sessions: vec![session("typescript", docs())],
        ..Scripted::default()
    };
    run(&root, &request(json!({ "paths": ["src/a.ts", ".env"] })), &mut named, MAX_RESPONSE_BYTES).unwrap();
    assert_eq!(named.capability_calls, 0);
    let mut all = Scripted {
        sessions: vec![session("typescript", docs())],
        ..Scripted::default()
    };
    run(&root, &request(json!({})), &mut all, MAX_RESPONSE_BYTES).unwrap();
    assert_eq!(all.capability_calls, 0);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn enumeration_lists_files_with_diagnostics_in_path_order_and_never_denied_or_unindexed() {
    let root = temp_root("all");
    for path in ["z.ts", "a.ts", ".env", "node_modules/pkg/index.js", "src/keys/server.pem"] {
        put(&root, path);
    }
    let mut sources = Scripted {
        sessions: vec![session(
            "typescript",
            vec![
                document(&root, "z.ts", FRESH, vec![stored(1, Some(1), "z")]),
                document(&root, "a.ts", FRESH, vec![]),
                document(&root, ".env", FRESH, vec![stored(0, Some(1), "SECRET=1 is wrong")]),
                document(&root, "node_modules/pkg/index.js", FRESH, vec![stored(0, Some(1), "dep")]),
                document(&root, "src/keys/server.pem", FRESH, vec![stored(0, Some(1), "pem")]),
            ],
        )],
        ..Scripted::default()
    };
    let result = run(&root, &request(json!({})), &mut sources, MAX_RESPONSE_BYTES).unwrap();
    assert_eq!(paths_and_states(&result), ["z.ts available 1"]);
    let text = serde_json::to_string(&result).unwrap();
    assert!(!text.contains(".env") && !text.contains("SECRET") && !text.contains(".pem"));
    let _ = fs::remove_dir_all(&root);
}

/// A published document is judged by what it IS (canonical location), never
/// by the name a server used: a link inside the project that names a denied
/// directory cannot carry its files out.
#[test]
fn a_link_cannot_disclose_a_denied_file() {
    let root = temp_root("link");
    put(&root, ".git/config");
    if !make_dir_link(&root.join("public"), &root.join(".git")) {
        eprintln!("skipping: cannot create a directory link here");
        let _ = fs::remove_dir_all(&root);
        return;
    }
    let mut sources = Scripted {
        sessions: vec![session(
            "typescript",
            vec![document(&root, "public/config", FRESH, vec![stored(0, Some(1), "core.secret")])],
        )],
        ..Scripted::default()
    };
    let all = run(&root, &request(json!({})), &mut sources, MAX_RESPONSE_BYTES).unwrap();
    assert!(all.files.is_empty(), "{:?}", all.files);
    let mut sources = Scripted {
        sessions: vec![session(
            "typescript",
            vec![document(&root, "public/config", FRESH, vec![stored(0, Some(1), "core.secret")])],
        )],
        ..Scripted::default()
    };
    let named = run(&root, &request(json!({ "paths": ["public/config"] })), &mut sources, MAX_RESPONSE_BYTES).unwrap();
    assert_eq!(paths_and_states(&named), ["public/config denied"]);
    remove_dir_link(&root.join("public"));
    let _ = fs::remove_dir_all(&root);
}

/// Adversarial F1 (check versus use): the server diagnosed the document when
/// it published, through whatever the URI named THEN. A link swapped before
/// the query must not let a denied file's diagnostics surface under the name
/// the link used to have. Driven through the real store.
#[test]
fn a_link_swapped_after_publish_cannot_disclose_a_denied_file() {
    use crate::lsp::diagnostics_cache::Cache;
    let root = temp_root("swap");
    put(&root, ".git/config");
    if !make_dir_link(&root.join("public"), &root.join(".git")) {
        eprintln!("skipping: cannot create a directory link here");
        let _ = fs::remove_dir_all(&root);
        return;
    }
    let mut cache = Cache::default();
    cache.begin_session("p::typescript::1", "p", "typescript");
    cache.record_publish(
        "p::typescript::1",
        &json!({ "uri": uri(&root, "public/config"), "diagnostics": [{
            "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 4 } },
            "severity": 1, "message": "core.secret = hunter2"
        }]}),
    );
    // The swap: the link goes, a real allowed folder of the same name arrives.
    remove_dir_link(&root.join("public"));
    put(&root, "public/config");
    let snapshot = || cache.snapshot("p", "typescript", "p::typescript::1");
    let sources = |snapshot| Scripted {
        sessions: vec![SessionDiagnostics {
            session: LiveSession {
                language_id: "typescript".into(),
                project_id: "p".into(),
                session_id: "p::typescript::1".into(),
            },
            producer: producer_name("typescript"),
            snapshot,
        }],
        ..Scripted::default()
    };
    let all = run(&root, &request(json!({})), &mut sources(snapshot()), MAX_RESPONSE_BYTES).unwrap();
    let named = run(&root, &request(json!({ "paths": ["public/config"] })), &mut sources(snapshot()), MAX_RESPONSE_BYTES)
        .unwrap();
    for result in [&all, &named] {
        let text = serde_json::to_string(result).unwrap();
        assert!(!text.contains("hunter2"), "a denied file's diagnostics leaked: {text}");
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn severity_filter_keeps_the_more_severe_and_reads_a_missing_severity_as_error() {
    let root = temp_root("severity");
    put(&root, "a.ts");
    let mut sources = Scripted {
        sessions: vec![session(
            "typescript",
            vec![document(
                &root,
                "a.ts",
                FRESH,
                vec![
                    stored(0, Some(1), "error"),
                    stored(1, Some(2), "warning"),
                    stored(2, Some(3), "information"),
                    stored(3, Some(4), "hint"),
                    stored(4, None, "unspecified"),
                ],
            )],
        )],
        ..Scripted::default()
    };
    let result = run(&root, &request(json!({ "paths": ["a.ts"], "minSeverity": "warning" })), &mut sources, MAX_RESPONSE_BYTES)
        .unwrap();
    let FileDiagnostics::Available { diagnostics, .. } = &result.files[0] else { panic!() };
    let seen: Vec<(Severity, &str)> = diagnostics.iter().map(|d| (d.severity, d.message.as_str())).collect();
    assert_eq!(
        seen,
        [(Severity::Error, "error"), (Severity::Warning, "warning"), (Severity::Error, "unspecified")]
    );
    // Lines and columns are 1-based.
    assert_eq!(diagnostics[0].range.start_line, 1);
    assert_eq!(diagnostics[0].range.start_column, 1);
    assert_eq!(diagnostics[0].range.end_column, 5);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn ceilings_per_file_and_per_response() {
    let root = temp_root("ceilings");
    let names: Vec<String> = (0..12).map(|i| format!("f{i:02}.ts")).collect();
    for name in &names {
        put(&root, name);
    }
    let many = |n: u32| (0..n).map(|i| stored(i, Some(1), "e")).collect::<Vec<_>>();
    let documents: Vec<_> = names.iter().map(|n| document(&root, n, FRESH, many(150))).collect();
    let mut sources = Scripted {
        sessions: vec![session("typescript", documents)],
        ..Scripted::default()
    };
    let result = run(&root, &request(json!({ "paths": names })), &mut sources, MAX_RESPONSE_BYTES).unwrap();
    let counts: Vec<String> = paths_and_states(&result);
    // Ten files of 100 fill the 1,000-diagnostic response; the rest are skipped.
    assert_eq!(counts.iter().filter(|c| c.ends_with("available 100")).count(), 10);
    assert_eq!(counts.iter().filter(|c| c.ends_with("skipped")).count(), 2);
    assert!(result.truncated);
    assert_eq!(result.truncated_by, [TruncationReason::PerFile, TruncationReason::Diagnostics]);
    assert!(matches!(&result.files[0], FileDiagnostics::Available { truncated: true, .. }));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn the_encoded_ceiling_skips_named_files_and_ends_enumeration() {
    let root = temp_root("bytes");
    for name in ["a.ts", "b.ts", "c.ts"] {
        put(&root, name);
    }
    let docs = || {
        ["a.ts", "b.ts", "c.ts"]
            .iter()
            .map(|n| document(&root, n, FRESH, vec![stored(0, Some(1), &"m".repeat(300))]))
            .collect::<Vec<_>>()
    };
    // Measured, not guessed: room for a and b, plus the skipped tail for c.
    let mut probe = Scripted {
        sessions: vec![session("typescript", docs())],
        ..Scripted::default()
    };
    let full = run(&root, &request(json!({ "paths": ["a.ts", "b.ts", "c.ts"] })), &mut probe, MAX_RESPONSE_BYTES).unwrap();
    let size = |i: usize| Output::encoded_len(&full.files[i]);
    let ceiling = ENVELOPE_RESERVE + size(0) + size(1) + Output::skipped_len("c.ts");
    let mut named = Scripted {
        sessions: vec![session("typescript", docs())],
        ..Scripted::default()
    };
    let result = run(&root, &request(json!({ "paths": ["a.ts", "b.ts", "c.ts"] })), &mut named, ceiling).unwrap();
    assert_eq!(paths_and_states(&result), ["a.ts available 1", "b.ts available 1", "c.ts skipped"]);
    assert_eq!(result.truncated_by, [TruncationReason::ResponseSize]);
    assert!(serde_json::to_vec(&result).unwrap().len() <= ceiling);

    let mut all = Scripted {
        sessions: vec![session("typescript", docs())],
        ..Scripted::default()
    };
    let result = run(&root, &request(json!({})), &mut all, ceiling).unwrap();
    assert_eq!(paths_and_states(&result), ["a.ts available 1", "b.ts available 1"]);
    assert_eq!(result.truncated_by, [TruncationReason::ResponseSize]);
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn freshness_is_reported_with_its_reason() {
    let root = temp_root("fresh");
    let cases = [
        ("a.ts", StoreFreshness::Current, Freshness::Current, None),
        ("b.ts", StoreFreshness::Stale(StaleReason::OlderVersion), Freshness::Stale, Some(FreshnessReason::OlderVersion)),
        ("c.ts", StoreFreshness::Stale(StaleReason::Reopened), Freshness::Stale, Some(FreshnessReason::Reopened)),
        (
            "d.ts",
            StoreFreshness::Unknown(UnknownReason::ProducerOmitsVersion),
            Freshness::Unknown,
            Some(FreshnessReason::ProducerOmitsVersion),
        ),
        ("e.ts", StoreFreshness::Unknown(UnknownReason::ClosedFile), Freshness::Unknown, Some(FreshnessReason::ClosedFile)),
    ];
    for (path, ..) in &cases {
        put(&root, path);
    }
    let mut sources = Scripted {
        sessions: vec![session(
            "typescript",
            cases.iter().map(|(path, store, ..)| document(&root, path, *store, vec![])).collect(),
        )],
        ..Scripted::default()
    };
    let paths: Vec<&str> = cases.iter().map(|(path, ..)| *path).collect();
    let result = run(&root, &request(json!({ "paths": paths })), &mut sources, MAX_RESPONSE_BYTES).unwrap();
    for ((_, _, freshness, reason), file) in cases.iter().zip(&result.files) {
        let FileDiagnostics::Available { freshness: got, freshness_reason, producer, .. } = file else { panic!() };
        assert_eq!((got, freshness_reason), (freshness, reason));
        assert_eq!(producer, "typescript-language-server");
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn related_locations_in_denied_files_or_outside_the_project_are_dropped() {
    let root = temp_root("related");
    for path in ["src/a.ts", "src/b.ts", ".env"] {
        put(&root, path);
    }
    let outside = temp_root("related-outside");
    put(&outside, "lib.d.ts");
    let related = |uri: String, message: &str| StoreRelated {
        uri,
        range: Range {
            start: Position { line: 0, character: 0 },
            end: Position { line: 0, character: 1 },
        },
        message: message.into(),
    };
    let mut diagnostic = stored(0, Some(1), "bad");
    diagnostic.related = vec![
        related(uri(&root, "src/b.ts"), "declared here, see ./.env"),
        related(uri(&root, ".env"), "secret here"),
        related(uri(&outside, "lib.d.ts"), "outside"),
        related(uri(&root, "src/missing.ts"), "gone"),
    ];
    let mut sources = Scripted {
        sessions: vec![session("typescript", vec![document(&root, "src/a.ts", FRESH, vec![diagnostic])])],
        ..Scripted::default()
    };
    let result = run(&root, &request(json!({ "paths": ["src/a.ts"] })), &mut sources, MAX_RESPONSE_BYTES).unwrap();
    let FileDiagnostics::Available { diagnostics, .. } = &result.files[0] else { panic!() };
    let kept: Vec<(&str, &str)> = diagnostics[0].related.iter().map(|r| (r.path.as_str(), r.message.as_str())).collect();
    // ./.env from src/b.ts's diagnosed file (src/a.ts) resolves to src/.env — a denied basename.
    assert_eq!(kept, [("src/b.ts", "declared here, see [denied]")]);
    let _ = fs::remove_dir_all(&root);
    let _ = fs::remove_dir_all(&outside);
}

// --- Message redaction --------------------------------------------------------

#[test]
fn redaction_replaces_denied_and_outside_references_and_nothing_else() {
    let root = temp_root("redact");
    let r = root_text(&root);
    let cases: Vec<(String, String)> = vec![
        (
            "Cannot find module './.env' or its corresponding type declarations.".into(),
            "Cannot find module '[denied]' or its corresponding type declarations.".into(),
        ),
        ("Type 'string' is not assignable to type 'number'.".into(), "Type 'string' is not assignable to type 'number'.".into()),
        (format!("Key file {r}/src/certs/server.pem is invalid"), "Key file [denied] is invalid".into()),
        (format!("Imported from {r}/src/b.ts: unused"), "Imported from src/b.ts: unused".into()),
        (format!("Cannot read {}", "/etc/passwd"), "Cannot read [path]".into()),
        ("Cannot read 'C:/Windows/System32/drivers/etc/hosts'".into(), "Cannot read '[path]'".into()),
        (format!("See file://{}{r}/.env", if r.starts_with('/') { "" } else { "/" }), "See [denied]".into()),
        ("Cannot find module '../../../outside/x'".into(), "Cannot find module '[path]'".into()),
        ("Cannot find module '../utils'".into(), "Cannot find module '../utils'".into()),
        ("Loading id_rsa failed".into(), "Loading [denied] failed".into()),
        ("Unexpected token ':' at (.env).".into(), "Unexpected token ':' at ([denied]).".into()),
        ("Value \".npmrc\", expected".into(), "Value \"[denied]\", expected".into()),
    ];
    for (message, expected) in cases {
        assert_eq!(redact_message(&message, &root, "src/app"), expected, "message: {message}");
    }
    // Backslash spellings of an absolute path inside the project.
    let windows_style = format!("Key {}\\src\\.env", r.replace('/', "\\"));
    assert_eq!(redact_message(&windows_style, &root, "src"), "Key [denied]");
    let _ = fs::remove_dir_all(&root);
}

/// Adversarial F4: on a case-insensitive file system a message may spell the
/// project path in another case (`c:/…` for `C:/…`); it is the same path.
#[cfg(any(windows, target_os = "macos"))]
#[test]
fn redaction_sees_a_differently_cased_project_path() {
    let root = temp_root("redact-case");
    let r = root_text(&root);
    for spelled in [r.to_lowercase(), r.to_uppercase()] {
        assert_eq!(redact_message(&format!("Key {spelled}/.env bad"), &root, ""), "Key [denied] bad");
        assert_eq!(redact_message(&format!("See {spelled}/src/a.ts"), &root, ""), "See src/a.ts");
    }
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn a_code_is_redacted_like_a_message() {
    let root = temp_root("code");
    put(&root, "a.ts");
    let mut diagnostic = stored(0, Some(1), "bad");
    diagnostic.code = Some(format!("{}/.env", root_text(&root)));
    let mut sources = Scripted {
        sessions: vec![session("typescript", vec![document(&root, "a.ts", FRESH, vec![diagnostic])])],
        ..Scripted::default()
    };
    let result = run(&root, &request(json!({ "paths": ["a.ts"] })), &mut sources, MAX_RESPONSE_BYTES).unwrap();
    let FileDiagnostics::Available { diagnostics, .. } = &result.files[0] else { panic!() };
    assert_eq!(diagnostics[0].code.as_deref(), Some("[denied]"));
    let _ = fs::remove_dir_all(&root);
}

#[test]
fn messages_are_bounded_after_redaction() {
    let root = temp_root("bound");
    let long = format!("{} {}", "é".repeat(1_500), "./.env");
    let out = redact_message(&long, &root, "");
    assert_eq!(out.chars().count(), MAX_MESSAGE_CHARS as usize);
    let _ = fs::remove_dir_all(&root);
}

// --- Through the epoch fence and the real bridge --------------------------------

/// The production path: the bound root through `workspace::fenced`, the
/// capability table over the real bridge (detached → ownerUnavailable), and
/// the real LSP registry (no live sessions here, so a TypeScript file's
/// producer is not running).
#[test]
fn runs_through_the_fence_and_the_bridge() {
    use crate::contracts::catalog::Operation;
    use crate::contracts::context::{Grant, Principal};
    use crate::contracts::project_api::diagnostics_list::DiagnosticsListOp;
    use crate::db;
    use crate::project_api::bridge::{testing::answering, Bridge};
    use std::time::Duration;

    let _serial = db::serial_guard();
    let root = temp_root("bridge");
    put(&root, "a.ts");
    let (_ro, epoch) = db::open_workspace_db(&root).unwrap();
    let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
    answering(bridge, |event| {
        assert_eq!(event.op, "languages.capabilities");
        let rows = serde_json::to_value(json!({ "languages": [{
            "language": "typescript", "extensions": [".ts"], "languageServer": "installed",
            "documentAccess": true, "diagnostics": true, "diagnosticsSource": "server", "server": "typescript",
            "navigation": true, "symbols": true, "relationshipDiscovery": true, "sourceTransformations": true
        }]}))
        .unwrap();
        Some(json!({ "kind": "result", "result": rows }).to_string())
    });
    let context = CallContext {
        principal: Principal::Test,
        grant: Grant::of([DiagnosticsListOp::CAPABILITY]),
        epoch: epoch.clone(),
    };
    let sources = || LiveSources {
        bridge,
        epoch: &epoch,
    };
    let named = || request(json!({ "paths": ["a.ts"] }));
    let error = handle_with(&context, named(), &mut sources(), MAX_RESPONSE_BYTES).unwrap_err();
    assert_eq!(error.code, crate::contracts::error::ErrorCode::OwnerUnavailable);
    bridge.attach(&epoch, Some(&epoch)).unwrap();
    let result = handle_with(&context, named(), &mut sources(), MAX_RESPONSE_BYTES).unwrap();
    assert_eq!(paths_and_states(&result), ["a.ts unavailable ProducerNotRunning"]);
    // Enumeration never needs the table: an empty, honest answer.
    let all = handle_with(&context, request(json!({})), &mut sources(), MAX_RESPONSE_BYTES).unwrap();
    assert!(all.files.is_empty() && !all.truncated);
    db::close_workspace_db().unwrap();
    let _ = fs::remove_dir_all(&root);
}

// --- Links --------------------------------------------------------------------

#[cfg(windows)]
fn make_dir_link(link: &Path, target: &Path) -> bool {
    std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn remove_dir_link(link: &Path) {
    // A junction is removed with remove_dir, which never follows it.
    let _ = fs::remove_dir(link);
}

#[cfg(unix)]
fn make_dir_link(link: &Path, target: &Path) -> bool {
    std::os::unix::fs::symlink(target, link).is_ok()
}

#[cfg(unix)]
fn remove_dir_link(link: &Path) {
    let _ = fs::remove_file(link);
}
