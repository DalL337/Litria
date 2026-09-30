//! `litria_files_read` (Project API contract brief §5, §7.2, §10).
//!
//! P1 serves `source: disk` in full. `source: effective` needs the editor
//! bridge (build plan P2) and answers `ownerUnavailable` until then — never a
//! silent fallback to disk, which would hide unsaved buffers.

use std::path::Path;

use super::reader::{self, DiskRead, HARD_CAP_BYTES};
use super::{workspace, MAX_RESPONSE_BYTES};
use crate::contracts::context::CallContext;
use crate::contracts::error::{ContractError, ErrorCode};
use crate::contracts::project_api::files_read::{
    DocumentOutcome, DocumentRequest, DocumentSource, FilesReadRequest, FilesReadResult, LineRange, ReadSource,
    DEFAULT_BYTES_PER_DOCUMENT,
};

/// Raw text returned per response, across all documents (brief §10).
pub(crate) const MAX_TEXT_PER_RESPONSE: usize = 256 * 1024;

pub(crate) fn handle(context: &CallContext, request: FilesReadRequest) -> Result<FilesReadResult, ContractError> {
    workspace::fenced(context, |root| {
        if request.source == ReadSource::Effective {
            return Err(ContractError::new(
                ErrorCode::OwnerUnavailable,
                "effective reads need the editor bridge, which is not connected; use source \"disk\" for saved content",
            ));
        }
        Ok(read_documents(root, &request, MAX_RESPONSE_BYTES))
    })
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

/// Build the result within the encoded `ceiling`.
///
/// Space for every later document's worst small outcome is reserved before a
/// document's text is sized, so later documents always fit as at least
/// `skipped`. The FIRST document is shrunk to fit (fewer lines, then a cut
/// line) so every response makes progress; a later document that does not fit
/// becomes `skipped` (brief §10).
pub(crate) fn read_documents(root: &Path, request: &FilesReadRequest, ceiling: usize) -> FilesReadResult {
    let per_document = request
        .max_bytes_per_document
        .unwrap_or(DEFAULT_BYTES_PER_DOCUMENT) as usize;
    let reserves: Vec<usize> = request
        .documents
        .iter()
        .map(|document| small_outcome_reserve(&document.path))
        .collect();
    let mut reserved_after: usize = reserves.iter().sum();
    let mut encoded = br#"{"documents":[]}"#.len();
    let mut text_left = MAX_TEXT_PER_RESPONSE;
    let mut documents = Vec::with_capacity(request.documents.len());

    for (index, document) in request.documents.iter().enumerate() {
        reserved_after -= reserves[index];
        let room = ceiling.saturating_sub(encoded + reserved_after + 1);
        let path = || document.path.clone();
        let outcome = match reader::read_disk(root, &document.path) {
            DiskRead::Text { text, revision } if text_left > 0 => fit_read(
                document,
                &text,
                revision,
                per_document.min(text_left),
                room,
                index == 0,
            )
            .unwrap_or(DocumentOutcome::Skipped { path: path() }),
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
        };
        if let DocumentOutcome::Read { text, .. } = &outcome {
            text_left -= text.len().min(text_left);
        }
        encoded += encoded_len(&outcome) + 1;
        documents.push(outcome);
    }
    FilesReadResult { documents }
}

/// A `read` outcome no larger than `room` encoded bytes, or `None`. With
/// `shrink`, the text budget halves until it fits; one character always does.
fn fit_read(
    document: &DocumentRequest,
    text: &str,
    revision: String,
    mut budget: usize,
    room: usize,
    shrink: bool,
) -> Option<DocumentOutcome> {
    loop {
        let slice = reader::slice(text, document.start_line.unwrap_or(1), document.end_line, budget);
        let outcome = DocumentOutcome::Read {
            path: document.path.clone(),
            source: DocumentSource::Disk,
            dirty: false,
            revision: revision.clone(),
            text: slice.text,
            range: slice.range.map(|(start_line, end_line)| LineRange { start_line, end_line }),
            total_lines: slice.total_lines,
            truncated: slice.truncated,
            line_cut: slice.line_cut,
        };
        if encoded_len(&outcome) <= room {
            return Some(outcome);
        }
        if !shrink || budget <= 1 {
            return None;
        }
        budget /= 2;
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
        let result = read_documents(&root, &request(&paths, Some(64 * 1024)), MAX_RESPONSE_BYTES);
        assert_eq!(kinds(&result), ["read", "read", "read", "read", "skipped", "skipped"]);
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
        let result = read_documents(
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
        let result = read_documents(&root, &request(&paths, None), MAX_RESPONSE_BYTES);
        assert!(kinds(&result).iter().all(|kind| kind == "invalidPath"));
        assert!(serde_json::to_vec(&result).unwrap().len() <= MAX_RESPONSE_BYTES);
        let _ = fs::remove_dir_all(&root);
    }
}
