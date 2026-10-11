//! The store PRODUCES the freshness signal P5b reports, so these tests drive
//! the real `Cache` through the sequences that could make it lie: restarts,
//! reopen (the webview resets versions), version-less producers, empty and
//! malformed publishes, out-of-order arrival (test-authoring policy Rule 1).

use super::*;
use serde_json::{json, Value};

const PROJECT: &str = "p1";
const LANG: &str = "python";
const S1: &str = "p1::python::1";
const S2: &str = "p1::python::2";
const A: &str = "file:///proj/a.py";

fn cache_with(session: &str) -> Cache {
    let mut c = Cache::default();
    c.begin_session(session, PROJECT, LANG);
    c
}

fn open(c: &mut Cache, sid: &str, uri: &str, version: i64) {
    c.record_sent(
        sid,
        "textDocument/didOpen",
        &json!({ "textDocument": { "uri": uri, "languageId": "python", "version": version, "text": "" } }),
    );
}

fn change(c: &mut Cache, sid: &str, uri: &str, version: i64) {
    c.record_sent(
        sid,
        "textDocument/didChange",
        &json!({ "textDocument": { "uri": uri, "version": version }, "contentChanges": [{ "text": "" }] }),
    );
}

fn close(c: &mut Cache, sid: &str, uri: &str) {
    c.record_sent(sid, "textDocument/didClose", &json!({ "textDocument": { "uri": uri } }));
}

fn diag(line: u64, message: &str) -> Value {
    json!({
        "range": { "start": { "line": line, "character": 0 }, "end": { "line": line, "character": 4 } },
        "severity": 1,
        "message": message,
        "code": 2322,
        "source": "Pyright"
    })
}

fn publish(c: &mut Cache, sid: &str, uri: &str, version: Option<i64>, diagnostics: Vec<Value>) {
    let mut params = json!({ "uri": uri, "diagnostics": diagnostics });
    if let Some(v) = version {
        params["version"] = json!(v);
    }
    c.record_publish(sid, &params);
}

fn snap(c: &Cache, sid: &str) -> SessionSnapshot {
    c.snapshot(PROJECT, LANG, sid).expect("live session")
}

fn doc(c: &Cache, sid: &str, uri: &str) -> Option<DocumentDiagnostics> {
    let key = document_key(uri);
    snap(c, sid).documents.into_iter().find(|d| d.key == key)
}

fn freshness_of(c: &Cache, sid: &str, uri: &str) -> Freshness {
    doc(c, sid, uri).expect("published document").freshness
}

#[test]
fn matching_version_in_the_same_opening_is_current() {
    let mut c = cache_with(S1);
    open(&mut c, S1, A, 1);
    publish(&mut c, S1, A, Some(1), vec![diag(3, "bad")]);
    assert_eq!(freshness_of(&c, S1, A), Freshness::Current);
    let d = doc(&c, S1, A).unwrap();
    assert_eq!(d.diagnostics.len(), 1);
    assert_eq!(d.diagnostics[0].code.as_deref(), Some("2322"));
    assert_eq!(d.diagnostics[0].severity, Some(1));
}

#[test]
fn an_older_version_is_stale_until_the_newest_arrives() {
    let mut c = cache_with(S1);
    open(&mut c, S1, A, 1);
    change(&mut c, S1, A, 2);
    change(&mut c, S1, A, 3);
    publish(&mut c, S1, A, Some(2), vec![diag(1, "old")]);
    assert_eq!(freshness_of(&c, S1, A), Freshness::Stale(StaleReason::OlderVersion));
    publish(&mut c, S1, A, Some(3), vec![]);
    assert_eq!(freshness_of(&c, S1, A), Freshness::Current);
    // A late publish for v2 replaces the store, and is stale again: arrival
    // order never makes old diagnostics current.
    publish(&mut c, S1, A, Some(2), vec![diag(1, "late")]);
    assert_eq!(freshness_of(&c, S1, A), Freshness::Stale(StaleReason::OlderVersion));
}

#[test]
fn a_version_newer_than_any_sent_is_unknown() {
    let mut c = cache_with(S1);
    open(&mut c, S1, A, 1);
    publish(&mut c, S1, A, Some(5), vec![]);
    assert_eq!(freshness_of(&c, S1, A), Freshness::Unknown(UnknownReason::VersionAhead));
}

#[test]
fn a_producer_without_versions_is_unknown_even_for_an_open_document() {
    // Owner ruling 2026-10-11: typescript-language-server publishes no version;
    // a session match alone is not proof.
    let mut c = cache_with(S1);
    open(&mut c, S1, A, 1);
    publish(&mut c, S1, A, None, vec![diag(0, "x")]);
    assert_eq!(freshness_of(&c, S1, A), Freshness::Unknown(UnknownReason::ProducerOmitsVersion));
}

#[test]
fn closed_file_diagnostics_are_kept_with_unknown_freshness() {
    let mut c = cache_with(S1);
    let b = "file:///proj/never_opened.py";
    publish(&mut c, S1, b, None, vec![diag(2, "from disk")]);
    let d = doc(&c, S1, b).expect("closed-file diagnostics are stored");
    assert_eq!(d.diagnostics.len(), 1);
    assert_eq!(d.freshness, Freshness::Unknown(UnknownReason::ClosedFile));

    open(&mut c, S1, A, 1);
    publish(&mut c, S1, A, Some(1), vec![diag(0, "x")]);
    close(&mut c, S1, A);
    assert_eq!(freshness_of(&c, S1, A), Freshness::Unknown(UnknownReason::ClosedFile));
}

#[test]
fn reopening_resets_versions_but_never_revives_old_diagnostics() {
    let mut c = cache_with(S1);
    open(&mut c, S1, A, 1);
    publish(&mut c, S1, A, Some(1), vec![diag(0, "first opening")]);
    assert_eq!(freshness_of(&c, S1, A), Freshness::Current);
    close(&mut c, S1, A);
    // The webview restarts the version at 1 on reopen: version 1 again.
    open(&mut c, S1, A, 1);
    assert_eq!(freshness_of(&c, S1, A), Freshness::Stale(StaleReason::Reopened));
    publish(&mut c, S1, A, Some(1), vec![]);
    assert_eq!(freshness_of(&c, S1, A), Freshness::Current);
}

#[test]
fn a_restarted_session_drops_the_previous_sessions_diagnostics() {
    let mut c = cache_with(S1);
    open(&mut c, S1, A, 1);
    publish(&mut c, S1, A, Some(1), vec![diag(0, "from the old server")]);
    c.begin_session(S2, PROJECT, LANG);
    assert!(c.snapshot(PROJECT, LANG, S1).is_none(), "the old session is gone");
    assert!(snap(&c, S2).documents.is_empty(), "nothing carried into the new session");
    // A late publish from the dead session is not recorded anywhere.
    publish(&mut c, S1, A, Some(1), vec![diag(0, "late, from the dead server")]);
    assert!(c.snapshot(PROJECT, LANG, S1).is_none());
    assert!(snap(&c, S2).documents.is_empty());
}

#[test]
fn a_restart_only_replaces_the_same_project_and_language() {
    let mut c = cache_with(S1);
    c.begin_session("p1::typescript::1", PROJECT, "typescript");
    c.begin_session("p2::python::1", "p2", LANG);
    c.begin_session(S2, PROJECT, LANG);
    assert!(c.snapshot(PROJECT, "typescript", "p1::typescript::1").is_some());
    assert!(c.snapshot("p2", LANG, "p2::python::1").is_some());
    assert!(c.snapshot(PROJECT, LANG, S1).is_none());
}

#[test]
fn drop_and_clear_remove_sessions() {
    let mut c = cache_with(S1);
    c.begin_session("p1::typescript::1", PROJECT, "typescript");
    c.drop_session(S1);
    assert!(c.snapshot(PROJECT, LANG, S1).is_none());
    c.clear();
    assert!(c.snapshot(PROJECT, "typescript", "p1::typescript::1").is_none());
}

#[test]
fn snapshot_requires_the_matching_project_and_language() {
    let c = cache_with(S1);
    assert!(c.snapshot("other", LANG, S1).is_none());
    assert!(c.snapshot(PROJECT, "typescript", S1).is_none());
}

#[test]
fn an_unknown_session_records_nothing() {
    let mut c = Cache::default();
    open(&mut c, "nobody", A, 1);
    publish(&mut c, "nobody", A, Some(1), vec![diag(0, "x")]);
    assert!(c.sessions.is_empty());
}

#[test]
fn an_empty_publish_is_a_positive_no_errors() {
    let mut c = cache_with(S1);
    open(&mut c, S1, A, 1);
    publish(&mut c, S1, A, Some(1), vec![diag(0, "x")]);
    publish(&mut c, S1, A, Some(1), vec![]);
    let d = doc(&c, S1, A).expect("an empty list is kept, not dropped");
    assert!(d.diagnostics.is_empty());
    assert_eq!(d.freshness, Freshness::Current);
}

#[test]
fn a_malformed_publish_is_ignored_not_read_as_no_errors() {
    let mut c = cache_with(S1);
    open(&mut c, S1, A, 1);
    publish(&mut c, S1, A, Some(1), vec![diag(0, "real")]);
    c.record_publish(S1, &json!({ "uri": A, "diagnostics": "not an array", "version": 1 }));
    c.record_publish(S1, &json!({ "diagnostics": [] }));
    c.record_publish(S1, &json!({ "uri": 42, "diagnostics": [] }));
    let d = doc(&c, S1, A).unwrap();
    assert_eq!(d.diagnostics.len(), 1, "the good publish survives garbage");
    assert_eq!(d.diagnostics[0].message, "real");
}

#[test]
fn invalid_entries_are_skipped_and_fields_are_sanitized() {
    let mut c = cache_with(S1);
    let entries = vec![
        diag(0, "valid"),
        json!({ "message": "no range", "severity": 1 }),
        json!({ "range": { "start": { "line": -1, "character": 0 }, "end": { "line": 0, "character": 0 } }, "message": "negative line" }),
        json!({ "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } } }),
        json!({
            "range": { "start": { "line": 1, "character": 0 }, "end": { "line": 1, "character": 1 } },
            "message": "odd fields", "severity": 9, "code": { "value": 1 }, "source": 7
        }),
    ];
    publish(&mut c, S1, A, None, entries);
    let d = doc(&c, S1, A).unwrap();
    let messages: Vec<&str> = d.diagnostics.iter().map(|x| x.message.as_str()).collect();
    assert_eq!(messages, ["valid", "odd fields"]);
    let odd = &d.diagnostics[1];
    assert_eq!(odd.severity, None, "severity outside 1..=4 is dropped");
    assert_eq!(odd.code, None);
    assert_eq!(odd.source, None);
}

#[test]
fn storage_is_bounded() {
    let mut c = cache_with(S1);
    let long = "é".repeat(MAX_STORED_MESSAGE_CHARS + 500);
    let mut big = json!({
        "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } },
        "message": long,
        "relatedInformation": []
    });
    let related: Vec<Value> = (0..40)
        .map(|i| json!({
            "location": { "uri": format!("file:///proj/r{i}.py"),
                          "range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": 1 } } },
            "message": "see here"
        }))
        .collect();
    big["relatedInformation"] = json!(related);
    let mut entries = vec![big];
    entries.extend((0..MAX_STORED_DIAGNOSTICS_PER_DOCUMENT + 5).map(|i| diag(i as u64, "x")));
    publish(&mut c, S1, A, None, entries);
    let d = doc(&c, S1, A).unwrap();
    assert_eq!(d.diagnostics.len(), MAX_STORED_DIAGNOSTICS_PER_DOCUMENT);
    assert!(d.store_truncated);
    assert_eq!(d.diagnostics[0].message.chars().count(), MAX_STORED_MESSAGE_CHARS);
    assert_eq!(d.diagnostics[0].related.len(), MAX_RELATED_PER_DIAGNOSTIC);
}

#[test]
fn eviction_at_the_cap_prefers_closed_documents_and_is_reported() {
    let mut c = cache_with(S1);
    let kept_open = "file:///proj/open.py";
    open(&mut c, S1, kept_open, 1); // oldest touch of all, but open
    for i in 0..MAX_DOCUMENTS_PER_SESSION - 1 {
        publish(&mut c, S1, &format!("file:///proj/f{i}.py"), None, vec![]);
    }
    assert!(!snap(&c, S1).documents_evicted);
    publish(&mut c, S1, "file:///proj/one_more.py", None, vec![]);
    let s = snap(&c, S1);
    assert!(s.documents_evicted);
    assert!(s.documents.iter().all(|d| d.key != document_key("file:///proj/f0.py")), "oldest closed doc evicted");
    // The open document survived (it has no publish, so check its state directly).
    assert!(c.sessions[S1].docs.contains_key(&document_key(kept_open)));
}

#[test]
fn document_keys_meet_across_uri_spellings() {
    assert_eq!(document_key("file:///x/a%20b.py"), document_key("file:///x/a b.py"));
    assert_eq!(document_key("file:///x/sub\\a.py"), document_key("file:///x/sub/a.py"));
    // Malformed escapes are kept literally, never panic.
    assert_eq!(document_key("file:///x/100%zz"), "/x/100%zz".to_string().to_lowercase_if_insensitive());
    assert_eq!(document_key("file:///x/trailing%"), "/x/trailing%".to_string().to_lowercase_if_insensitive());
    assert_eq!(document_key("file:///x/%e"), "/x/%e".to_string().to_lowercase_if_insensitive());
}

#[cfg(any(windows, target_os = "macos"))]
#[test]
fn the_sent_and_published_spellings_of_a_windows_path_are_one_document() {
    // Litria sends file:///C:/…; typescript-language-server publishes
    // file:///c%3A/… (seen live 2026-10-11).
    let mut c = cache_with(S1);
    open(&mut c, S1, "file:///C:/proj/a.py", 1);
    publish(&mut c, S1, "file:///c%3A/proj/a.py", Some(1), vec![]);
    assert_eq!(snap(&c, S1).documents.len(), 1);
    assert_eq!(freshness_of(&c, S1, "file:///C:/proj/a.py"), Freshness::Current);
    assert_eq!(document_key("file:///C:/proj/a.py"), "c:/proj/a.py");
}

#[test]
fn the_process_store_guard_drops_a_failed_start_and_keeps_a_good_one() {
    // The global store is shared by parallel tests: unique ids only.
    let failed = "guard-test::lang::1";
    {
        let _guard = SessionGuard::begin(failed, "guard-project", "lang");
        assert!(snapshot("guard-project", "lang", failed).is_some());
    }
    assert!(snapshot("guard-project", "lang", failed).is_none(), "dropped on failure");

    let good = "guard-test::lang::2";
    SessionGuard::begin(good, "guard-project-2", "lang").keep();
    assert!(snapshot("guard-project-2", "lang", good).is_some(), "kept on success");
    drop_session(good);
    assert!(snapshot("guard-project-2", "lang", good).is_none());
}

trait LowercaseIfInsensitive {
    fn to_lowercase_if_insensitive(self) -> String;
}

impl LowercaseIfInsensitive for String {
    fn to_lowercase_if_insensitive(self) -> String {
        if cfg!(any(windows, target_os = "macos")) {
            self.to_lowercase()
        } else {
            self
        }
    }
}
