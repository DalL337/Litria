//! `litria_files_read` (Project API contract brief §5, §7.2, §10).
//!
//! `source: disk` reads the saved file. `source: effective` reads what the
//! editor holds: documents the session has open, or closed with unsaved
//! changes, come from the session's buffer through the bridge (build plan P2);
//! every other document comes from disk. A bridge that is not attached for
//! the workspace answers `ownerUnavailable` — never a silent fallback to disk,
//! which would hide unsaved buffers.

use std::path::Path;

use super::bridge::{self, malformed, Bridge};
use super::reader::{self, identity, DiskRead, Identity, Slice, HARD_CAP_BYTES};
use super::{workspace, MAX_RESPONSE_BYTES};
use crate::contracts::context::CallContext;
use crate::contracts::error::ContractError;
use crate::contracts::project_api::files_read::{
    DocumentOutcome, DocumentRequest, DocumentSource, FilesReadRequest, FilesReadResult, LineRange, ReadSource,
    DEFAULT_BYTES_PER_DOCUMENT, MIN_BYTES_PER_DOCUMENT,
};
use crate::contracts::project_api_bridge::editor::{
    BufferState, DocumentEntry, DocumentQuery, DocumentsOp, DocumentsRequest, DocumentsResult,
};

/// Raw text returned per response, across all documents (brief §10).
pub(crate) const MAX_TEXT_PER_RESPONSE: usize = 256 * 1024;

pub(crate) fn handle(context: &CallContext, request: FilesReadRequest) -> Result<FilesReadResult, ContractError> {
    handle_with(context, request, bridge::global())
}

pub(crate) fn handle_with(
    context: &CallContext,
    request: FilesReadRequest,
    bridge: &Bridge,
) -> Result<FilesReadResult, ContractError> {
    workspace::fenced(context, |root| match request.source {
        ReadSource::Disk => read_documents(root, &request, MAX_RESPONSE_BYTES, None),
        ReadSource::Effective => {
            let mut editor = EditorPages {
                bridge,
                epoch: &context.epoch,
            };
            read_documents(root, &request, MAX_RESPONSE_BYTES, Some(&mut editor))
        }
    })
}

/// Where buffer pages come from: the bridge in production, a script in tests.
pub(crate) trait BufferPages {
    fn page(&mut self, request: &DocumentsRequest) -> Result<DocumentsResult, ContractError>;
}

struct EditorPages<'a> {
    bridge: &'a Bridge,
    epoch: &'a str,
}

impl BufferPages for EditorPages<'_> {
    fn page(&mut self, request: &DocumentsRequest) -> Result<DocumentsResult, ContractError> {
        self.bridge.call::<DocumentsOp>(self.epoch, request)
    }
}

fn encoded_len(outcome: &DocumentOutcome) -> usize {
    serde_json::to_vec(outcome).map_or(usize::MAX, |bytes| bytes.len())
}

/// The largest outcome a document can produce without text: every non-read
/// outcome, and `skipped`, fits in it. Reserved up front for each document.
fn small_outcome_reserve(path: &str) -> usize {
    encoded_len(&DocumentOutcome::TooLarge {
        path: path.to_owned(),
        limit_bytes: u32::MAX,
    }) + 1 // the separating comma
}

/// A buffer slice as the bridge returned it, already checked against the
/// query it answers.
#[derive(Debug, Clone)]
struct BufferSlice {
    dirty: bool,
    revision: String,
    text: String,
    range: Option<(u32, u32)>,
    total_lines: u32,
    truncated: bool,
    line_cut: bool,
}

#[derive(Debug, Clone)]
enum Lookup {
    /// Not asked yet, or deferred by a full page.
    Unknown,
    NotBuffered,
    Buffer(BufferSlice),
}

/// Build the result within the encoded `ceiling`.
///
/// Space for every later document's worst small outcome is reserved before a
/// document's text is sized, so later documents always fit as at least
/// `skipped`. The FIRST document is shrunk to fit (fewer lines, then a cut
/// line) so every response makes progress; a later document that does not fit
/// becomes `skipped` (brief §10).
///
/// With `editor`, documents are read effectively: each is looked up in the
/// editor session first, in pages fetched lazily in request order. Denied and
/// invalid paths are answered here and never reach the bridge (the policy has
/// one owner, brief §8).
pub(crate) fn read_documents(
    root: &Path,
    request: &FilesReadRequest,
    ceiling: usize,
    mut editor: Option<&mut dyn BufferPages>,
) -> Result<FilesReadResult, ContractError> {
    let per_document = request
        .max_bytes_per_document
        .unwrap_or(DEFAULT_BYTES_PER_DOCUMENT) as usize;
    let reserves: Vec<usize> = request
        .documents
        .iter()
        .map(|document| small_outcome_reserve(&document.path))
        .collect();
    let identities: Vec<Option<Identity>> = request
        .documents
        .iter()
        .map(|document| editor.is_some().then(|| identity(root, &document.path)))
        .collect();
    let mut lookups = vec![Lookup::Unknown; request.documents.len()];
    let mut reserved_after: usize = reserves.iter().sum();
    let mut encoded = br#"{"documents":[]}"#.len();
    let mut text_left = MAX_TEXT_PER_RESPONSE;
    let mut documents = Vec::with_capacity(request.documents.len());

    for (index, document) in request.documents.iter().enumerate() {
        reserved_after -= reserves[index];
        let room = ceiling.saturating_sub(encoded + reserved_after + 1);
        let path = || document.path.clone();
        let budget = per_document.min(text_left);
        let first = index == 0;

        let buffered = match (&mut editor, &identities[index]) {
            (Some(_), Some(Identity::InvalidPath)) => Some(DocumentOutcome::InvalidPath { path: path() }),
            (Some(_), Some(Identity::Denied)) => Some(DocumentOutcome::Denied { path: path() }),
            (Some(pages), Some(Identity::Key(_))) => {
                if matches!(lookups[index], Lookup::Unknown) {
                    fetch_page(&mut **pages, request, &identities, &mut lookups, index, per_document, text_left)?;
                }
                match &lookups[index] {
                    Lookup::Buffer(slice) => Some(if text_left == 0 {
                        DocumentOutcome::Skipped { path: path() }
                    } else {
                        fit_read(
                            document,
                            DocumentSource::Editor,
                            slice.dirty,
                            &slice.revision,
                            |budget| reslice(slice, budget),
                            budget,
                            room,
                            first,
                        )
                        .unwrap_or(DocumentOutcome::Skipped { path: path() })
                    }),
                    Lookup::NotBuffered => None,
                    // fetch_page guarantees the first entry of a page is answered.
                    Lookup::Unknown => return Err(malformed()),
                }
            }
            _ => None,
        };

        let outcome = match buffered {
            Some(outcome) => outcome,
            None => match reader::read_disk(root, &document.path) {
                DiskRead::Text { text, revision } if text_left > 0 => {
                    let (start, end) = (document.start_line.unwrap_or(1), document.end_line);
                    fit_read(
                        document,
                        DocumentSource::Disk,
                        false,
                        &revision,
                        |budget| reader::slice(&text, start, end, budget),
                        budget,
                        room,
                        first,
                    )
                    .unwrap_or(DocumentOutcome::Skipped { path: path() })
                }
                DiskRead::Text { .. } => DocumentOutcome::Skipped { path: path() },
                DiskRead::NotFound => DocumentOutcome::NotFound { path: path() },
                DiskRead::Denied => DocumentOutcome::Denied { path: path() },
                DiskRead::NotFile => DocumentOutcome::NotFile { path: path() },
                DiskRead::NotText => DocumentOutcome::NotText { path: path() },
                DiskRead::TooLarge => DocumentOutcome::TooLarge {
                    path: path(),
                    limit_bytes: HARD_CAP_BYTES as u32,
                },
                DiskRead::InvalidPath => DocumentOutcome::InvalidPath { path: path() },
                DiskRead::Unreadable => DocumentOutcome::Unreadable { path: path() },
            },
        };
        if let DocumentOutcome::Read { text, .. } = &outcome {
            text_left -= text.len().min(text_left);
        }
        encoded += encoded_len(&outcome) + 1;
        documents.push(outcome);
    }
    Ok(FilesReadResult { documents })
}

/// Ask the editor for one page: every not-yet-answered, lookup-able document
/// from `from` on, in request order. The bridge spends `text_left` in order
/// and defers the tail when its reply ceiling fills; the first entry of a page
/// is always answered, so pages always make progress.
///
/// The reply is checked against the query it answers — the same paths in the
/// same order, strict byte budgets, ranges inside what was asked — and any
/// mismatch fails the call: a misbehaving owner is an error, not an answer.
fn fetch_page(
    pages: &mut dyn BufferPages,
    request: &FilesReadRequest,
    identities: &[Option<Identity>],
    lookups: &mut [Lookup],
    from: usize,
    per_document: usize,
    text_left: usize,
) -> Result<(), ContractError> {
    let mut indices = Vec::new();
    let mut queries = Vec::new();
    for index in from..request.documents.len() {
        if let (Some(Identity::Key(key)), Lookup::Unknown) = (&identities[index], &lookups[index]) {
            let document = &request.documents[index];
            indices.push(index);
            queries.push(DocumentQuery {
                path: key.clone(),
                start_line: document.start_line,
                end_line: document.end_line,
                max_bytes: per_document as u32,
            });
        }
    }
    let page = DocumentsRequest {
        documents: queries,
        max_text_bytes: text_left as u32,
    };
    let reply = pages.page(&page)?;
    if reply.documents.len() != page.documents.len() {
        return Err(malformed());
    }
    let mut text_used = 0usize;
    let mut deferring = false;
    for (position, (query, entry)) in page.documents.iter().zip(reply.documents).enumerate() {
        let lookup = match entry {
            DocumentEntry::Deferred { path } if path == query.path && position > 0 => {
                deferring = true;
                Lookup::Unknown
            }
            _ if deferring => return Err(malformed()),
            DocumentEntry::NotBuffered { path, .. } if path == query.path => Lookup::NotBuffered,
            DocumentEntry::Buffer {
                path,
                dirty,
                revision,
                text,
                range,
                total_lines,
                truncated,
                line_cut,
                state,
            } if path == query.path => {
                text_used += text.len();
                let range = range.map(|range| (range.start_line, range.end_line));
                // A closed buffer is only kept because it is unsaved.
                if (state == BufferState::ClosedDirty && !dirty)
                    || text.len() > query.max_bytes as usize
                    || text_used > page.max_text_bytes as usize
                    || !range_answers(query, range, total_lines, &text, line_cut)
                {
                    return Err(malformed());
                }
                Lookup::Buffer(BufferSlice {
                    dirty,
                    revision,
                    text,
                    range,
                    total_lines,
                    truncated,
                    line_cut,
                })
            }
            _ => return Err(malformed()),
        };
        lookups[indices[position]] = lookup;
    }
    Ok(())
}

/// The returned range lies inside the requested one: it starts where asked,
/// ends no later than asked or than the document, and a cut line is a single
/// line. No range means no text.
fn range_answers(query: &DocumentQuery, range: Option<(u32, u32)>, total_lines: u32, text: &str, line_cut: bool) -> bool {
    match range {
        None => text.is_empty() && !line_cut,
        Some((start, end)) => {
            start == query.start_line.unwrap_or(1)
                && start <= end
                && end <= total_lines
                && query.end_line.is_none_or(|wanted| end <= wanted)
                && (!line_cut || start == end)
        }
    }
}

/// Re-slice a bridge slice to a smaller `budget`, keeping its line numbers.
/// With a budget at least the slice's length, the slice comes back unchanged.
fn reslice(slice: &BufferSlice, budget: usize) -> Slice {
    let Some((start, _)) = slice.range else {
        return Slice {
            text: String::new(),
            range: None,
            total_lines: slice.total_lines,
            truncated: slice.truncated,
            line_cut: false,
        };
    };
    let inner = reader::slice(&slice.text, 1, None, budget);
    Slice {
        text: inner.text,
        range: inner.range.map(|(first, last)| (start + first - 1, start + last - 1)),
        total_lines: slice.total_lines,
        truncated: slice.truncated || inner.truncated,
        line_cut: slice.line_cut || inner.line_cut,
    }
}

/// A `read` outcome within `budget` raw bytes and `room` encoded bytes, or
/// `None` (the caller answers `skipped`). With `shrink`, the budget halves
/// until the outcome fits, but never below `MIN_BYTES_PER_DOCUMENT` — the
/// largest UTF-8 character — so the first document always returns something.
#[allow(clippy::too_many_arguments)]
fn fit_read(
    document: &DocumentRequest,
    source: DocumentSource,
    dirty: bool,
    revision: &str,
    slicer: impl Fn(usize) -> Slice,
    mut budget: usize,
    room: usize,
    shrink: bool,
) -> Option<DocumentOutcome> {
    let floor = MIN_BYTES_PER_DOCUMENT as usize;
    loop {
        let slice = slicer(budget);
        if slice.range.is_none() && slice.truncated {
            // Lines were wanted but not one character fits the budget left.
            return None;
        }
        let outcome = DocumentOutcome::Read {
            path: document.path.clone(),
            source,
            dirty,
            revision: revision.to_owned(),
            text: slice.text,
            range: slice.range.map(|(start_line, end_line)| LineRange { start_line, end_line }),
            total_lines: slice.total_lines,
            truncated: slice.truncated,
            line_cut: slice.line_cut,
        };
        if encoded_len(&outcome) <= room {
            return Some(outcome);
        }
        if !shrink || budget <= floor {
            return None;
        }
        budget = (budget / 2).max(floor);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::context::{Grant, Principal};
    use crate::contracts::project_api::files_read::FilesReadOp;
    use crate::contracts::catalog::Operation;
    use crate::db;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("litria-api-files-{tag}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn request(paths: &[&str], max_bytes: Option<u32>) -> FilesReadRequest {
        let raw = serde_json::json!({
            "documents": paths.iter().map(|path| serde_json::json!({ "path": path })).collect::<Vec<_>>(),
            "source": "disk",
            "maxBytesPerDocument": max_bytes,
        });
        serde_json::from_value(raw).unwrap()
    }

    fn kinds(result: &FilesReadResult) -> Vec<String> {
        let value = serde_json::to_value(result).unwrap();
        value["documents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|document| document["kind"].as_str().unwrap().to_owned())
            .collect()
    }

    fn read_on_disk(root: &Path, request: &FilesReadRequest, ceiling: usize) -> FilesReadResult {
        read_documents(root, request, ceiling, None).unwrap()
    }

    /// End to end through the real service dispatcher: grant, boundary,
    /// fence, reader, budgets.
    #[test]
    fn reads_from_disk_through_the_service() {
        let _serial = db::serial_guard();
        let root = temp_root("service");
        fs::write(root.join("a.txt"), "alpha\nbeta\n").unwrap();
        fs::write(root.join(".env"), "SECRET=1").unwrap();
        let (_ro, epoch) = db::open_workspace_db(&root).unwrap();
        let context = CallContext {
            principal: Principal::Test,
            grant: Grant::of([FilesReadOp::CAPABILITY]),
            epoch,
        };
        let raw = br#"{"documents":[{"path":"a.txt","startLine":2},{"path":".env"},{"path":"gone.txt"}],"source":"disk"}"#;
        let value = super::super::dispatcher().dispatch(&context, FilesReadOp::NAME, raw).unwrap();
        let documents = value["documents"].as_array().unwrap();
        assert_eq!(documents[0]["kind"], "read");
        assert_eq!(documents[0]["text"], "beta\n");
        assert_eq!(documents[0]["range"], serde_json::json!({ "startLine": 2, "endLine": 2 }));
        assert_eq!(documents[0]["totalLines"], 2);
        assert_eq!(documents[0]["source"], "disk");
        assert_eq!(documents[0]["dirty"], false);
        assert_eq!(documents[1], serde_json::json!({ "kind": "denied", "path": ".env" }));
        assert_eq!(documents[2]["kind"], "notFound");

        // No absolute path anywhere in the answer.
        let root_text = root.to_string_lossy().replace('\\', "\\\\");
        assert!(!value.to_string().contains(&root_text), "the root leaked into the result");

        // Effective reads wait for the bridge: an explicit error, never disk.
        let effective = br#"{"documents":[{"path":"a.txt"}]}"#;
        let error = super::super::dispatcher().dispatch(&context, FilesReadOp::NAME, effective).unwrap_err();
        assert_eq!(error.code, ErrorCode::OwnerUnavailable);
        assert!(!error.message.contains(&*root.to_string_lossy()));

        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    /// The raw text budget per response turns later documents into `skipped`.
    #[test]
    fn the_response_text_budget_skips_later_documents() {
        let root = temp_root("text-budget");
        let body = "x".repeat(64 * 1024 - 1) + "\n"; // exactly 64 KiB
        let names: Vec<String> = (0..6).map(|index| format!("f{index}.txt")).collect();
        for name in &names {
            fs::write(root.join(name), &body).unwrap();
        }
        let paths: Vec<&str> = names.iter().map(String::as_str).collect();
        let result = read_on_disk(&root, &request(&paths, Some(64 * 1024)), MAX_RESPONSE_BYTES);
        assert_eq!(kinds(&result), ["read", "read", "read", "read", "skipped", "skipped"]);
        let _ = fs::remove_dir_all(&root);
    }

    /// Codex review finding 4: 262,143 ASCII bytes leave 1 byte of the
    /// response budget; a following emoji must be skipped, not squeezed in.
    #[test]
    fn the_response_text_budget_is_never_exceeded_by_a_multibyte_character() {
        let root = temp_root("multibyte");
        fs::write(root.join("big.txt"), "a".repeat(MAX_TEXT_PER_RESPONSE - 1)).unwrap();
        fs::write(root.join("emoji.txt"), "😀").unwrap();
        let result = read_on_disk(
            &root,
            &request(&["big.txt", "emoji.txt"], Some(256 * 1024)),
            MAX_RESPONSE_BYTES,
        );
        let returned: usize = result
            .documents
            .iter()
            .map(|document| match document {
                DocumentOutcome::Read { text, .. } => text.len(),
                _ => 0,
            })
            .sum();
        assert!(returned <= MAX_TEXT_PER_RESPONSE, "{returned} bytes against {MAX_TEXT_PER_RESPONSE}");
        assert_eq!(kinds(&result), ["read", "skipped"]);
        let _ = fs::remove_dir_all(&root);
    }

    /// Escape-heavy text: a control character encodes to six bytes. The first
    /// document shrinks to fit and is marked truncated; a later one that cannot
    /// fit is skipped; the whole message stays under the ceiling.
    #[test]
    fn escape_heavy_text_shrinks_the_first_document_and_skips_later_ones() {
        let root = temp_root("escape");
        let heavy = "\u{1}".repeat(200 * 1024); // 200 KiB raw, ~1.2 MB encoded
        fs::write(root.join("first.txt"), &heavy).unwrap();
        fs::write(root.join("second.txt"), &heavy).unwrap();
        fs::write(root.join("third.txt"), "small\n").unwrap();
        let result = read_on_disk(
            &root,
            &request(&["first.txt", "second.txt", "third.txt"], Some(256 * 1024)),
            MAX_RESPONSE_BYTES,
        );
        assert_eq!(kinds(&result), ["read", "skipped", "read"]);
        let DocumentOutcome::Read { truncated, line_cut, text, .. } = &result.documents[0] else { panic!() };
        assert!(*truncated && *line_cut && !text.is_empty());
        let encoded = serde_json::to_vec(&result).unwrap().len();
        assert!(encoded <= MAX_RESPONSE_BYTES, "{encoded} bytes exceeds the ceiling");
        let _ = fs::remove_dir_all(&root);
    }

    /// Twenty documents of the longest escape-heavy paths still fit: the
    /// reserves guarantee every later document at least a small outcome.
    #[test]
    fn many_long_paths_never_overflow_the_ceiling() {
        let root = temp_root("reserve");
        let long = "\u{1}".repeat(1024); // an invalid path, so every outcome is small
        let paths: Vec<&str> = (0..20).map(|_| long.as_str()).collect();
        let result = read_on_disk(&root, &request(&paths, None), MAX_RESPONSE_BYTES);
        assert!(kinds(&result).iter().all(|kind| kind == "invalidPath"));
        assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_RESPONSE_BYTES);
        let _ = fs::remove_dir_all(&root);
    }

    // --- effective reads (build plan P2) -------------------------------------
    //
    // A scripted editor session stands in for the JavaScript owner. It answers
    // pages with JSON text that goes through the real reply boundary, slicing
    // with the same rules the JavaScript port follows.

    use crate::contracts::boundary::accept_within;
    use crate::contracts::error::ErrorCode;
    use crate::contracts::project_api_bridge::{BridgeReply, MAX_REPLY_BYTES};
    use crate::project_api::bridge::testing::answering;
    use serde_json::{json, Value};
    use std::collections::BTreeMap;
    use std::time::Duration;

    #[derive(Clone)]
    struct SessionDoc {
        state: &'static str,
        text: String,
    }

    type Session = BTreeMap<String, SessionDoc>;

    fn session(entries: &[(&str, &'static str, &str)]) -> Session {
        entries
            .iter()
            .map(|(path, state, text)| {
                (
                    (*path).to_owned(),
                    SessionDoc {
                        state,
                        text: (*text).to_owned(),
                    },
                )
            })
            .collect()
    }

    fn buffer_revision(text: &str) -> String {
        format!("b1-test-{}", reader::disk_revision(text.as_bytes()))
    }

    /// The owner's reply to an `editor.documents` request, as JSON text.
    /// `capacity` entries are answered; the rest are deferred.
    fn scripted_reply(session: &Session, request: &Value, capacity: usize) -> String {
        let mut text_left = request["maxTextBytes"].as_u64().unwrap() as usize;
        let documents: Vec<Value> = request["documents"]
            .as_array()
            .unwrap()
            .iter()
            .enumerate()
            .map(|(position, query)| {
                let path = query["path"].as_str().unwrap();
                if position >= capacity {
                    return json!({ "kind": "deferred", "path": path });
                }
                match session.get(path) {
                    None => json!({ "kind": "notBuffered", "path": path, "state": "none" }),
                    Some(doc) if doc.state == "closedClean" => {
                        json!({ "kind": "notBuffered", "path": path, "state": "closedClean" })
                    }
                    Some(doc) => {
                        let budget = (query["maxBytes"].as_u64().unwrap() as usize).min(text_left);
                        let start = query["startLine"].as_u64().map_or(1, |line| line as u32);
                        let end = query["endLine"].as_u64().map(|line| line as u32);
                        let slice = reader::slice(&doc.text, start, end, budget);
                        text_left -= slice.text.len();
                        let mut entry = json!({
                            "kind": "buffer",
                            "path": path,
                            "state": doc.state,
                            "dirty": doc.state == "closedDirty" || doc.text.ends_with("*dirty*\n"),
                            "revision": buffer_revision(&doc.text),
                            "text": slice.text,
                            "totalLines": slice.total_lines,
                            "truncated": slice.truncated,
                            "lineCut": slice.line_cut,
                        });
                        if let Some((start_line, end_line)) = slice.range {
                            entry["range"] = json!({ "startLine": start_line, "endLine": end_line });
                        }
                        entry
                    }
                }
            })
            .collect();
        json!({ "kind": "result", "result": { "documents": documents } }).to_string()
    }

    /// Pages answered in process, through the real reply boundary; every page
    /// request is recorded.
    struct Scripted {
        session: Session,
        capacity: usize,
        pages: Vec<Value>,
        tamper: fn(Value) -> Value,
    }

    impl Scripted {
        fn new(session: Session) -> Self {
            Self {
                session,
                capacity: usize::MAX,
                pages: Vec::new(),
                tamper: |reply| reply,
            }
        }

        fn requested_paths(&self) -> Vec<String> {
            self.pages
                .iter()
                .flat_map(|page| page["documents"].as_array().unwrap().clone())
                .map(|query| query["path"].as_str().unwrap().to_owned())
                .collect()
        }
    }

    impl BufferPages for Scripted {
        fn page(&mut self, request: &DocumentsRequest) -> Result<DocumentsResult, ContractError> {
            let value = serde_json::to_value(request).unwrap();
            let reply: Value = serde_json::from_str(&scripted_reply(&self.session, &value, self.capacity)).unwrap();
            self.pages.push(value);
            let raw = (self.tamper)(reply).to_string();
            match accept_within::<BridgeReply<DocumentsResult>>(raw.as_bytes(), MAX_REPLY_BYTES) {
                Ok(BridgeReply::Result { result }) => Ok(result),
                _ => Err(malformed()),
            }
        }
    }

    fn effective(documents: Value, max_bytes: Option<u32>) -> FilesReadRequest {
        serde_json::from_value(json!({ "documents": documents, "maxBytesPerDocument": max_bytes })).unwrap()
    }

    fn paths(paths: &[&str]) -> Value {
        Value::Array(paths.iter().map(|path| json!({ "path": path })).collect())
    }

    fn effectively(root: &Path, request: &FilesReadRequest, editor: &mut Scripted) -> Result<Value, ContractError> {
        read_documents(root, request, MAX_RESPONSE_BYTES, Some(editor)).map(|result| serde_json::to_value(result).unwrap())
    }

    /// Open and closed-dirty documents come from the buffer, closed-clean and
    /// unknown ones from disk; a buffer whose file is gone is still read; a
    /// denied path is answered in Rust and never sent to the bridge.
    #[test]
    fn effective_reads_take_buffers_where_the_editor_holds_them() {
        let root = temp_root("effective");
        fs::write(root.join("open.txt"), "saved\n").unwrap();
        fs::write(root.join("closed-dirty.txt"), "saved\n").unwrap();
        fs::write(root.join("closed-clean.txt"), "on disk\n").unwrap();
        fs::write(root.join("untouched.txt"), "untouched\n").unwrap();
        fs::write(root.join(".env"), "SECRET=1\n").unwrap();
        let mut editor = Scripted::new(session(&[
            ("open.txt", "open", "unsaved *dirty*\n"),
            ("closed-dirty.txt", "closedDirty", "kept in the session\n"),
            ("closed-clean.txt", "closedClean", "stale session copy\n"),
            ("gone.txt", "closedDirty", "only in the editor\n"),
            (".env", "open", "SECRET=from the buffer\n"),
        ]));
        let request = effective(
            paths(&["open.txt", "closed-dirty.txt", "closed-clean.txt", "untouched.txt", ".env", "gone.txt", "../x"]),
            None,
        );
        let value = effectively(&root, &request, &mut editor).unwrap();
        let documents = value["documents"].as_array().unwrap();

        assert_eq!(documents[0]["source"], "editor");
        assert_eq!(documents[0]["text"], "unsaved *dirty*\n");
        assert_eq!(documents[0]["dirty"], true);
        assert!(documents[0]["revision"].as_str().unwrap().starts_with("b1-"));

        assert_eq!(documents[1]["source"], "editor");
        assert_eq!(documents[1]["text"], "kept in the session\n");
        assert_eq!(documents[1]["dirty"], true);

        assert_eq!(documents[2]["source"], "disk");
        assert_eq!(documents[2]["text"], "on disk\n");
        assert_eq!(documents[2]["dirty"], false);
        assert!(documents[2]["revision"].as_str().unwrap().starts_with("d1-"));

        assert_eq!(documents[3]["source"], "disk");
        assert_eq!(documents[3]["text"], "untouched\n");

        assert_eq!(documents[4], json!({ "kind": "denied", "path": ".env" }));
        assert_eq!(documents[5]["source"], "editor");
        assert_eq!(documents[5]["text"], "only in the editor\n");
        assert_eq!(documents[6]["kind"], "invalidPath");

        let asked = editor.requested_paths();
        assert!(!asked.iter().any(|path| path.contains(".env")), "denied path reached the bridge: {asked:?}");
        assert!(!asked.iter().any(|path| path.contains("..")), "invalid path reached the bridge: {asked:?}");
        assert_eq!(editor.pages.len(), 1, "one page answers everything here");
        let _ = fs::remove_dir_all(&root);
    }

    /// Ranges and budgets apply to buffers exactly as to disk, and the
    /// revision always describes the whole buffer.
    #[test]
    fn buffer_slices_follow_the_read_rules() {
        let root = temp_root("effective-slices");
        let text = "one\ntwo\nthree\nfour\n";
        let mut editor = Scripted::new(session(&[("a.txt", "open", text)]));
        let request = effective(json!([{ "path": "a.txt", "startLine": 2, "endLine": 3 }]), None);
        let value = effectively(&root, &request, &mut editor).unwrap();
        let read = &value["documents"][0];
        assert_eq!(read["text"], "two\nthree\n");
        assert_eq!(read["range"], json!({ "startLine": 2, "endLine": 3 }));
        assert_eq!(read["totalLines"], 4);
        assert_eq!(read["revision"], buffer_revision(text));

        // A budget smaller than the first line cuts it.
        let request = effective(json!([{ "path": "a.txt", "startLine": 3 }]), Some(4));
        let value = effectively(&root, &request, &mut editor).unwrap();
        let read = &value["documents"][0];
        assert_eq!(read["text"], "thre");
        assert_eq!(read["lineCut"], true);
        assert_eq!(read["truncated"], true);
        let _ = fs::remove_dir_all(&root);
    }

    /// A page that fills defers the rest; Rust asks again from the first
    /// deferred document, and every document is answered once, in order.
    #[test]
    fn deferred_documents_are_fetched_in_later_pages() {
        let root = temp_root("effective-pages");
        fs::write(root.join("disk.txt"), "disk\n").unwrap();
        let mut editor = Scripted::new(session(&[
            ("a.txt", "open", "a\n"),
            ("b.txt", "closedDirty", "b\n"),
            ("c.txt", "open", "c\n"),
        ]));
        editor.capacity = 1;
        let request = effective(paths(&["a.txt", "disk.txt", "b.txt", "c.txt"]), None);
        let value = effectively(&root, &request, &mut editor).unwrap();
        let texts: Vec<&str> = value["documents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|document| document["text"].as_str().unwrap())
            .collect();
        assert_eq!(texts, ["a\n", "disk\n", "b\n", "c\n"]);
        let firsts: Vec<String> = editor
            .pages
            .iter()
            .map(|page| page["documents"][0]["path"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(firsts, ["a.txt", "disk.txt", "b.txt", "c.txt"]);
        let _ = fs::remove_dir_all(&root);
    }

    /// The response's text budget is shared by buffers and disk reads alike.
    #[test]
    fn buffers_share_the_response_text_budget() {
        let root = temp_root("effective-budget");
        let big = "x".repeat(64 * 1024 - 1) + "\n"; // exactly 64 KiB
        let entries: Vec<(String, &'static str, String)> =
            (0..6).map(|index| (format!("f{index}.txt"), "open", big.clone())).collect();
        let mut editor = Scripted::new(
            entries
                .iter()
                .map(|(path, state, text)| (path.clone(), SessionDoc { state, text: text.clone() }))
                .collect(),
        );
        let names: Vec<&str> = entries.iter().map(|(path, _, _)| path.as_str()).collect();
        let value = effectively(&root, &effective(paths(&names), Some(64 * 1024)), &mut editor).unwrap();
        let kinds: Vec<&str> = value["documents"]
            .as_array()
            .unwrap()
            .iter()
            .map(|document| document["kind"].as_str().unwrap())
            .collect();
        assert_eq!(kinds, ["read", "read", "read", "read", "skipped", "skipped"]);
        let _ = fs::remove_dir_all(&root);
    }

    /// Escape-heavy buffer text: the first document is re-sliced by Rust to
    /// fit the encoded ceiling and marked truncated; the message fits.
    #[test]
    fn escape_heavy_buffers_shrink_to_fit() {
        let root = temp_root("effective-escape");
        // ~420 KiB encoded: inside the bridge reply ceiling (one document
        // per page here), beyond the response ceiling, so Rust re-slices.
        let heavy = "\u{1}".repeat(70 * 1024);
        let mut editor = Scripted::new(session(&[("first.txt", "open", &heavy), ("second.txt", "open", &heavy)]));
        editor.capacity = 1;
        let request = effective(paths(&["first.txt", "second.txt"]), Some(256 * 1024));
        let result = read_documents(&root, &request, MAX_RESPONSE_BYTES, Some(&mut editor)).unwrap();
        assert_eq!(kinds(&result), ["read", "skipped"]);
        let DocumentOutcome::Read {
            truncated,
            line_cut,
            text,
            source,
            ..
        } = &result.documents[0]
        else {
            panic!()
        };
        assert!(*truncated && *line_cut && !text.is_empty());
        assert_eq!(*source, DocumentSource::Editor);
        assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_RESPONSE_BYTES);
        let _ = fs::remove_dir_all(&root);
    }

    /// A reply that does not answer what was asked fails the call.
    #[test]
    fn a_reply_that_misanswers_the_page_fails_the_call() {
        let root = temp_root("effective-misanswer");
        let tampers: [(&str, fn(Value) -> Value); 5] = [
            ("wrong path", |mut reply| {
                reply["result"]["documents"][0]["path"] = json!("other.txt");
                reply
            }),
            ("missing entry", |mut reply| {
                reply["result"]["documents"].as_array_mut().unwrap().pop();
                reply
            }),
            ("first entry deferred", |mut reply| {
                reply["result"]["documents"][0] = json!({ "kind": "deferred", "path": "a.txt" });
                reply
            }),
            ("text over the budget", |mut reply| {
                reply["result"]["documents"][0]["text"] = json!("0123456789");
                reply["result"]["documents"][0]["range"] = json!({ "startLine": 1, "endLine": 1 });
                reply
            }),
            ("range outside the request", |mut reply| {
                reply["result"]["documents"][0]["range"] = json!({ "startLine": 2, "endLine": 2 });
                reply
            }),
        ];
        for (name, tamper) in tampers {
            let mut editor = Scripted::new(session(&[("a.txt", "open", "abc\ndef\n"), ("b.txt", "open", "b\n")]));
            editor.tamper = tamper;
            let request = effective(paths(&["a.txt", "b.txt"]), Some(4));
            let error = effectively(&root, &request, &mut editor).unwrap_err();
            assert_eq!(error.code, ErrorCode::Internal, "{name}");
        }
        let _ = fs::remove_dir_all(&root);
    }

    /// A directory link inside the project: the buffer is found under the
    /// name of the file the link leads to.
    #[test]
    fn a_link_alias_finds_the_buffer_of_the_file_it_names() {
        let root = temp_root("effective-link");
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.txt"), "saved\n").unwrap();
        dir_link(&root.join("lnk"), &root.join("src"));
        let mut editor = Scripted::new(session(&[("src/a.txt", "open", "unsaved\n")]));
        let value = effectively(&root, &effective(paths(&["lnk/a.txt"]), None), &mut editor).unwrap();
        assert_eq!(value["documents"][0]["path"], "lnk/a.txt", "the requested name is echoed");
        assert_eq!(value["documents"][0]["source"], "editor");
        assert_eq!(value["documents"][0]["text"], "unsaved\n");
        assert_eq!(editor.requested_paths(), ["src/a.txt"]);
        remove_dir_link(&root.join("lnk"));
        let _ = fs::remove_dir_all(&root);
    }

    /// A link to a denied file is denied before the bridge is asked.
    #[test]
    fn a_link_to_a_denied_directory_never_reaches_the_bridge() {
        let root = temp_root("effective-denied-link");
        fs::create_dir_all(root.join(".git")).unwrap();
        fs::write(root.join(".git/config"), "[core]\n").unwrap();
        dir_link(&root.join("innocent"), &root.join(".git"));
        let mut editor = Scripted::new(session(&[("innocent/config", "open", "buffer\n")]));
        let value = effectively(&root, &effective(paths(&["innocent/config"]), None), &mut editor).unwrap();
        assert_eq!(value["documents"][0], json!({ "kind": "denied", "path": "innocent/config" }));
        assert!(editor.pages.is_empty(), "the bridge was asked: {:?}", editor.pages);
        remove_dir_link(&root.join("innocent"));
        let _ = fs::remove_dir_all(&root);
    }

    /// On a case-insensitive volume (Windows, default macOS), a case variant
    /// names the same file, so it finds the same buffer. Skipped where the
    /// volume is case-sensitive: there the variant is another file.
    #[test]
    fn a_case_variant_finds_the_buffer_on_a_case_insensitive_volume() {
        let root = temp_root("effective-case");
        fs::write(root.join("Readme.md"), "saved\n").unwrap();
        if !root.join("README.MD").exists() {
            let _ = fs::remove_dir_all(&root);
            return; // case-sensitive volume
        }
        let mut editor = Scripted::new(session(&[("Readme.md", "open", "unsaved\n")]));
        let value = effectively(&root, &effective(paths(&["README.MD"]), None), &mut editor).unwrap();
        assert_eq!(value["documents"][0]["source"], "editor");
        assert_eq!(value["documents"][0]["path"], "README.MD");
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    fn dir_link(link: &Path, target: &Path) {
        let status = std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .status()
            .unwrap();
        assert!(status.success(), "mklink /J");
    }

    #[cfg(unix)]
    fn dir_link(link: &Path, target: &Path) {
        std::os::unix::fs::symlink(target, link).unwrap();
    }

    /// Remove the link itself, never what it points at.
    fn remove_dir_link(link: &Path) {
        #[cfg(windows)]
        fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        fs::remove_file(link).unwrap();
    }

    fn context_for(epoch: String) -> CallContext {
        CallContext {
            principal: Principal::Test,
            grant: Grant::of([FilesReadOp::CAPABILITY]),
            epoch,
        }
    }

    /// End to end over the wire: request event → scripted owner → reply
    /// command path → boundary → result, with the epoch fence around it.
    #[test]
    fn effective_reads_through_the_bridge() {
        let _serial = db::serial_guard();
        let root = temp_root("effective-bridge");
        fs::write(root.join("a.txt"), "saved\n").unwrap();
        let (_ro, epoch) = db::open_workspace_db(&root).unwrap();
        let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
        let owner_session = session(&[("a.txt", "open", "unsaved\n")]);
        answering(bridge, move |event| Some(scripted_reply(&owner_session, &event.request, usize::MAX)));

        // Not attached yet (the editor is still loading): ownerUnavailable.
        let request = || effective(paths(&["a.txt"]), None);
        let error = handle_with(&context_for(epoch.clone()), request(), bridge).unwrap_err();
        assert_eq!(error.code, ErrorCode::OwnerUnavailable);

        bridge.attach(&epoch, Some(&epoch)).unwrap();
        let result = handle_with(&context_for(epoch.clone()), request(), bridge).unwrap();
        let value = serde_json::to_value(result).unwrap();
        assert_eq!(value["documents"][0]["source"], "editor");
        assert_eq!(value["documents"][0]["text"], "unsaved\n");

        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    /// The project switches while the editor is answering: the answer is
    /// discarded and the call reports `workspaceChanged`.
    #[test]
    fn a_switch_while_the_editor_answers_discards_the_answer() {
        let _serial = db::serial_guard();
        let first = temp_root("effective-switch-a");
        let second = temp_root("effective-switch-b");
        let (_ro, epoch) = db::open_workspace_db(&first).unwrap();
        let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
        bridge.attach(&epoch, Some(&epoch)).unwrap();
        let owner_session = session(&[("a.txt", "open", "a buffer from the first project\n")]);
        let switch_to = second.clone();
        answering(bridge, move |event| {
            db::open_workspace_db(&switch_to).unwrap();
            Some(scripted_reply(&owner_session, &event.request, usize::MAX))
        });
        let error = handle_with(&context_for(epoch), effective(paths(&["a.txt"]), None), bridge).unwrap_err();
        assert_eq!(error.code, ErrorCode::WorkspaceChanged);
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&first);
        let _ = fs::remove_dir_all(&second);
    }
}
