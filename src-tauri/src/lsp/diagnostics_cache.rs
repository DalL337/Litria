//! Diagnostics detail store — Project API P5a (contract brief §7.5).
//!
//! Owner ruling 2026-10-11: the detail store lives in Rust, in the LSP bridge.
//! Every document notification Litria sends (`session_notify`) and every
//! notification a server pushes (`ipc_bridge::dispatch_notification`) passes
//! through this process, so this is the one place that can tie a server's
//! diagnostics to the session that produced them and to the document version
//! they describe. Freshness is decided by session + version, never by arrival
//! time.
//!
//! Inputs:
//! - [`begin_session`] when a session id is minted. A restarted server replaces
//!   every older session for the same project + language, so its diagnostics
//!   never outlive it. [`drop_session`] on stop and crash; [`clear`] on app
//!   teardown.
//! - [`record_sent`] for `didOpen` / `didChange` / `didClose`, called BEFORE the
//!   write reaches the server: a fast reply can then never be filed against an
//!   older opening of the document, so any race errs toward "not current".
//! - [`record_publish`] for `textDocument/publishDiagnostics`, parsed into
//!   bounded, typed entries. A server's output is not trusted to be small or
//!   well formed; a malformed publish is ignored rather than read as "no errors".
//!
//! The webview resets a document's version to 1 on every reopen
//! (`src/lsp/documentSync.js`), so a version number alone can repeat inside one
//! session. Every document therefore counts its openings (`open_generation`),
//! and a diagnostic is only current for the opening it arrived in.
//!
//! Some servers publish no `version` (typescript-language-server sends only
//! `uri` + `diagnostics`). Their freshness is `Unknown(ProducerOmitsVersion)`
//! by owner ruling: a session match alone is not proof of the version.

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::{Mutex, MutexGuard, OnceLock};

/// Diagnostics kept per document. The tool returns at most 100 per file, but
/// severity filtering happens at read time, so more are kept than are returned.
pub(crate) const MAX_STORED_DIAGNOSTICS_PER_DOCUMENT: usize = 1_000;
/// Stored message length. The tool's output bound (1,000) is applied later.
pub(crate) const MAX_STORED_MESSAGE_CHARS: usize = 2_000;
pub(crate) const MAX_RELATED_PER_DIAGNOSTIC: usize = 16;
/// A related location's message ("declared here") is short; the cap is lower.
pub(crate) const MAX_STORED_RELATED_MESSAGE_CHARS: usize = 500;
/// URIs (document and related) kept per entry.
pub(crate) const MAX_STORED_URI_CHARS: usize = 2_048;
/// Documents tracked per session before the least recently touched is evicted.
pub(crate) const MAX_DOCUMENTS_PER_SESSION: usize = 10_000;
/// Approximate stored bytes per document; beyond it the rest is dropped and
/// the document says `store_truncated` (adversarial F2).
pub(crate) const MAX_STORED_BYTES_PER_DOCUMENT: usize = 2 * 1024 * 1024;
/// Approximate stored bytes per session; beyond it whole documents are evicted,
/// least recently touched and closed first (adversarial F2).
pub(crate) const MAX_STORED_BYTES_PER_SESSION: usize = 32 * 1024 * 1024;
const MAX_SHORT_FIELD_CHARS: usize = 128;

// ---------------------------------------------------------------------------
// Read-side types, consumed by the P5b `litria_diagnostics_list` handler
// (`project_api::diagnostics`).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Position {
    pub line: u32,
    pub character: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Range {
    pub start: Position,
    pub end: Position,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RelatedLocation {
    /// As the server spelled it. P5b maps it to a project path and removes it
    /// when that path is denied.
    pub uri: String,
    pub range: Range,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StoredDiagnostic {
    /// LSP DiagnosticSeverity 1 (error) ..= 4 (hint); `None` when absent or invalid.
    pub severity: Option<u8>,
    pub message: String,
    pub range: Range,
    pub code: Option<String>,
    pub source: Option<String>,
    pub related: Vec<RelatedLocation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StaleReason {
    /// The server diagnosed an earlier version than the one Litria last sent.
    OlderVersion,
    /// The diagnostics arrived during an earlier opening of the document.
    Reopened,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnknownReason {
    /// The server publishes no document version (typescript-language-server).
    ProducerOmitsVersion,
    /// The document is not open in Litria: the server diagnosed disk content
    /// whose version nobody sent.
    ClosedFile,
    /// The server reported a version newer than any Litria sent.
    VersionAhead,
    /// Open, but no version was recorded for this opening.
    NoSentVersion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Freshness {
    Current,
    Stale(StaleReason),
    Unknown(UnknownReason),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DocumentDiagnostics {
    /// As the server published it.
    pub uri: String,
    /// Normalized key ([`document_key`]).
    pub key: String,
    pub diagnostics: Vec<StoredDiagnostic>,
    /// The server sent more than the store keeps (count or byte cap).
    pub store_truncated: bool,
    pub freshness: Freshness,
    /// Where the URI led when the server published (links resolved). A reader
    /// reports the document only if it still leads there (adversarial F1).
    pub canonical_at_publish: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SessionSnapshot {
    pub session_id: String,
    pub language_id: String,
    /// Only documents the server has published for, sorted by key.
    pub documents: Vec<DocumentDiagnostics>,
    /// Some document was evicted at the per-session cap, so an absent document
    /// does not prove the server never published for it.
    pub documents_evicted: bool,
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct Published {
    uri: String,
    diagnostics: Vec<StoredDiagnostic>,
    store_truncated: bool,
    version: Option<i64>,
    /// The document's opening this publish arrived in.
    open_generation: u64,
    canonical: Option<PathBuf>,
    /// Approximate stored bytes (see [`approx_bytes`]).
    bytes: usize,
}

#[derive(Debug, Default)]
struct DocState {
    open_generation: u64,
    is_open: bool,
    sent_version: Option<i64>,
    published: Option<Published>,
    /// Store-wide sequence of the last touch; drives eviction.
    touched: u64,
}

#[derive(Debug)]
struct SessionEntry {
    project_id: String,
    language_id: String,
    docs: HashMap<String, DocState>,
    evicted: bool,
    stored_bytes: usize,
}

#[derive(Debug, Default)]
pub(crate) struct Cache {
    sessions: HashMap<String, SessionEntry>,
    seq: u64,
}

impl Cache {
    pub(crate) fn begin_session(&mut self, session_id: &str, project_id: &str, language_id: &str) {
        self.sessions
            .retain(|_, s| !(s.project_id == project_id && s.language_id == language_id));
        self.sessions.insert(
            session_id.to_string(),
            SessionEntry {
                project_id: project_id.to_string(),
                language_id: language_id.to_string(),
                docs: HashMap::new(),
                evicted: false,
                stored_bytes: 0,
            },
        );
    }

    pub(crate) fn drop_session(&mut self, session_id: &str) {
        self.sessions.remove(session_id);
    }

    pub(crate) fn clear(&mut self) {
        self.sessions.clear();
    }

    pub(crate) fn record_sent(&mut self, session_id: &str, method: &str, params: &Value) {
        let kind = match method {
            "textDocument/didOpen" => SentKind::Open,
            "textDocument/didChange" => SentKind::Change,
            "textDocument/didClose" => SentKind::Close,
            _ => return,
        };
        let Some(uri) = params.pointer("/textDocument/uri").and_then(Value::as_str) else {
            return;
        };
        let version = params.pointer("/textDocument/version").and_then(Value::as_i64);
        self.seq += 1;
        let seq = self.seq;
        let Some(session) = self.sessions.get_mut(session_id) else {
            return;
        };
        let doc = session.doc_mut(document_key(uri), seq);
        match kind {
            SentKind::Open => {
                doc.open_generation += 1;
                doc.is_open = true;
                doc.sent_version = version;
            }
            SentKind::Change => {
                if version.is_some() {
                    doc.sent_version = version;
                }
            }
            SentKind::Close => {
                doc.is_open = false;
                doc.sent_version = None;
            }
        }
    }

    /// Test entry point; production goes through the process-wide wrapper,
    /// which resolves the canonical path before taking the lock.
    #[cfg(test)]
    pub(crate) fn record_publish(&mut self, session_id: &str, params: &Value) {
        let canonical = canonical_of_publish(params);
        self.record_publish_at(session_id, params, canonical);
    }

    /// [`Cache::record_publish`] with the URI's canonical path already resolved
    /// (the process-wide store resolves it before taking its lock).
    fn record_publish_at(&mut self, session_id: &str, params: &Value, canonical: Option<PathBuf>) {
        let Some(uri) = params.get("uri").and_then(Value::as_str) else {
            return;
        };
        // Garbage is ignored, never stored as an empty ("no errors") list.
        let Some(raw) = params.get("diagnostics").and_then(Value::as_array) else {
            return;
        };
        let version = params.get("version").and_then(Value::as_i64);
        let mut diagnostics = Vec::with_capacity(raw.len().min(MAX_STORED_DIAGNOSTICS_PER_DOCUMENT));
        let uri = bounded(uri, MAX_STORED_URI_CHARS);
        let mut bytes = uri.len();
        let mut store_truncated = false;
        for item in raw {
            if diagnostics.len() == MAX_STORED_DIAGNOSTICS_PER_DOCUMENT {
                store_truncated = true;
                break;
            }
            if let Some(d) = parse_diagnostic(item) {
                let size = approx_bytes(&d);
                if bytes + size > MAX_STORED_BYTES_PER_DOCUMENT {
                    store_truncated = true;
                    break;
                }
                bytes += size;
                diagnostics.push(d);
            }
        }
        self.seq += 1;
        let seq = self.seq;
        let Some(session) = self.sessions.get_mut(session_id) else {
            return;
        };
        let key = document_key(&uri);
        let doc = session.doc_mut(key.clone(), seq);
        let replaced = doc.published.as_ref().map_or(0, |p| p.bytes);
        doc.published = Some(Published {
            uri,
            diagnostics,
            store_truncated,
            version,
            open_generation: doc.open_generation,
            canonical,
            bytes,
        });
        session.stored_bytes = session.stored_bytes - replaced + bytes;
        session.enforce_byte_budget(&key);
    }

    /// Approximate bytes a session's stored diagnostics occupy (strings plus a
    /// fixed per-entry overhead). The memory bound is enforced on this measure.
    #[cfg(test)]
    pub(crate) fn approx_session_bytes(&self, session_id: &str) -> usize {
        self.sessions.get(session_id).map_or(0, |session| {
            session
                .docs
                .values()
                .filter_map(|doc| doc.published.as_ref())
                .map(|p| p.uri.len() + p.diagnostics.iter().map(approx_bytes).sum::<usize>())
                .sum()
        })
    }

    pub(crate) fn snapshot(&self, project_id: &str, language_id: &str, session_id: &str) -> Option<SessionSnapshot> {
        let session = self.sessions.get(session_id)?;
        if session.project_id != project_id || session.language_id != language_id {
            return None;
        }
        let mut documents: Vec<DocumentDiagnostics> = session
            .docs
            .iter()
            .filter_map(|(key, doc)| {
                let published = doc.published.as_ref()?;
                Some(DocumentDiagnostics {
                    uri: published.uri.clone(),
                    key: key.clone(),
                    diagnostics: published.diagnostics.clone(),
                    store_truncated: published.store_truncated,
                    freshness: freshness(doc, published),
                    canonical_at_publish: published.canonical.clone(),
                })
            })
            .collect();
        documents.sort_by(|a, b| a.key.cmp(&b.key));
        Some(SessionSnapshot {
            session_id: session_id.to_string(),
            language_id: session.language_id.clone(),
            documents,
            documents_evicted: session.evicted,
        })
    }
}

#[derive(Clone, Copy)]
enum SentKind {
    Open,
    Change,
    Close,
}

impl SessionEntry {
    fn doc_mut(&mut self, key: String, seq: u64) -> &mut DocState {
        if !self.docs.contains_key(&key) && self.docs.len() >= MAX_DOCUMENTS_PER_SESSION {
            // Evict the least recently touched document, closed ones first: an
            // open document's sent version is what makes its freshness provable.
            let victim = self
                .docs
                .iter()
                .min_by_key(|(_, d)| (d.is_open, d.touched))
                .map(|(k, _)| k.clone());
            if let Some(victim) = victim {
                if let Some(removed) = self.docs.remove(&victim) {
                    self.stored_bytes -= removed.published.map_or(0, |p| p.bytes);
                }
                self.evicted = true;
            }
        }
        let doc = self.docs.entry(key).or_default();
        doc.touched = seq;
        doc
    }

    /// Over the session budget: drop the stored diagnostics of other documents,
    /// least recently touched and closed first, until it fits. A document keeps
    /// its sent-version state; only what the server published goes.
    fn enforce_byte_budget(&mut self, keep: &str) {
        while self.stored_bytes > MAX_STORED_BYTES_PER_SESSION {
            let victim = self
                .docs
                .iter()
                .filter(|(key, doc)| key.as_str() != keep && doc.published.is_some())
                .min_by_key(|(_, doc)| (doc.is_open, doc.touched))
                .map(|(key, _)| key.clone());
            let Some(victim) = victim else { break };
            if let Some(published) = self.docs.get_mut(&victim).and_then(|doc| doc.published.take()) {
                self.stored_bytes -= published.bytes;
            }
            self.evicted = true;
        }
    }
}

/// Freshness of a document's stored publish, by session (implied: entries
/// live only as long as their session) + opening + version.
fn freshness(doc: &DocState, published: &Published) -> Freshness {
    if published.open_generation != doc.open_generation {
        return Freshness::Stale(StaleReason::Reopened);
    }
    if !doc.is_open {
        return Freshness::Unknown(UnknownReason::ClosedFile);
    }
    let Some(version) = published.version else {
        return Freshness::Unknown(UnknownReason::ProducerOmitsVersion);
    };
    match doc.sent_version {
        Some(sent) if version == sent => Freshness::Current,
        Some(sent) if version < sent => Freshness::Stale(StaleReason::OlderVersion),
        Some(_) => Freshness::Unknown(UnknownReason::VersionAhead),
        None => Freshness::Unknown(UnknownReason::NoSentVersion),
    }
}

// ---------------------------------------------------------------------------
// Parsing (server output is untrusted: typed, bounded, lenient only where safe)
// ---------------------------------------------------------------------------

fn parse_diagnostic(value: &Value) -> Option<StoredDiagnostic> {
    let range = parse_range(value.get("range")?)?;
    let message = bounded(value.get("message")?.as_str()?, MAX_STORED_MESSAGE_CHARS);
    let severity = value
        .get("severity")
        .and_then(Value::as_u64)
        .filter(|s| (1..=4).contains(s))
        .map(|s| s as u8);
    let code = match value.get("code") {
        Some(Value::String(s)) => Some(bounded(s, MAX_SHORT_FIELD_CHARS)),
        Some(Value::Number(n)) => Some(bounded(&n.to_string(), MAX_SHORT_FIELD_CHARS)),
        _ => None,
    };
    let source = value
        .get("source")
        .and_then(Value::as_str)
        .map(|s| bounded(s, MAX_SHORT_FIELD_CHARS));
    let related = value
        .get("relatedInformation")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|r| {
                    let location = r.get("location")?;
                    Some(RelatedLocation {
                        uri: bounded(location.get("uri")?.as_str()?, MAX_STORED_URI_CHARS),
                        range: parse_range(location.get("range")?)?,
                        message: bounded(
                            r.get("message").and_then(Value::as_str).unwrap_or(""),
                            MAX_STORED_RELATED_MESSAGE_CHARS,
                        ),
                    })
                })
                .take(MAX_RELATED_PER_DIAGNOSTIC)
                .collect()
        })
        .unwrap_or_default();
    Some(StoredDiagnostic { severity, message, range, code, source, related })
}

/// What one stored diagnostic costs, approximately: its strings plus a fixed
/// overhead for the struct and the vectors that hold it.
fn approx_bytes(diagnostic: &StoredDiagnostic) -> usize {
    const ENTRY_OVERHEAD: usize = 64;
    const RELATED_OVERHEAD: usize = 32;
    ENTRY_OVERHEAD
        + diagnostic.message.len()
        + diagnostic.code.as_ref().map_or(0, String::len)
        + diagnostic.source.as_ref().map_or(0, String::len)
        + diagnostic
            .related
            .iter()
            .map(|r| RELATED_OVERHEAD + r.uri.len() + r.message.len())
            .sum::<usize>()
}

fn parse_range(value: &Value) -> Option<Range> {
    Some(Range {
        start: parse_position(value.get("start")?)?,
        end: parse_position(value.get("end")?)?,
    })
}

fn parse_position(value: &Value) -> Option<Position> {
    let line = u32::try_from(value.get("line")?.as_u64()?).ok()?;
    let character = u32::try_from(value.get("character")?.as_u64()?).ok()?;
    Some(Position { line, character })
}

/// At most `max` characters, cut on a character boundary.
fn bounded(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => text[..cut].to_string(),
        None => text.to_string(),
    }
}

/// Normalize a document URI so the spelling Litria sends (`file:///C:/x/a.ts`)
/// and the spelling a server publishes (`file:///c%3A/x/a.ts`) meet on one key:
/// percent-decoded, `\` → `/`, the slash before a drive letter dropped, and
/// lowercased where the default file system is case-insensitive.
pub(crate) fn document_key(uri: &str) -> String {
    let rest = uri.strip_prefix("file://").unwrap_or(uri);
    let mut path = percent_decode(rest).replace('\\', "/");
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
        path.remove(0);
    }
    if cfg!(any(windows, target_os = "macos")) {
        path.to_lowercase()
    } else {
        path
    }
}

fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = |b: u8| (b as char).to_digit(16);
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// A `file:` URI (as a server spells it) to a native path; `None` for any
/// other scheme.
pub(crate) fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let decoded = percent_decode(rest);
    let bytes = decoded.as_bytes();
    // file:///C:/x -> C:/x ; file:///home/x -> /home/x ; file://server/share -> //server/share
    let path = if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b':' {
        decoded[1..].to_string()
    } else if decoded.starts_with('/') {
        decoded
    } else {
        format!("//{decoded}")
    };
    Some(PathBuf::from(path))
}

/// Where a publish's URI leads right now, links resolved (adversarial F1).
fn canonical_of_publish(params: &Value) -> Option<PathBuf> {
    let uri = params.get("uri").and_then(Value::as_str)?;
    fs::canonicalize(uri_to_path(uri)?).ok()
}

// ---------------------------------------------------------------------------
// Process-wide store
// ---------------------------------------------------------------------------

static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

fn store() -> MutexGuard<'static, Cache> {
    // A panic elsewhere while holding the lock must not take diagnostics down
    // with it: the data is a cache, and every entry is rebuilt by the next publish.
    CACHE
        .get_or_init(|| Mutex::new(Cache::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

pub(crate) fn begin_session(session_id: &str, project_id: &str, language_id: &str) {
    store().begin_session(session_id, project_id, language_id);
}

pub(crate) fn drop_session(session_id: &str) {
    store().drop_session(session_id);
}

pub(crate) fn clear() {
    store().clear();
}

pub(crate) fn record_sent(session_id: &str, method: &str, params: &Value) {
    store().record_sent(session_id, method, params);
}

pub(crate) fn record_publish(session_id: &str, params: &Value) {
    // Resolved before the lock: a filesystem call never blocks readers.
    let canonical = canonical_of_publish(params);
    store().record_publish_at(session_id, params, canonical);
}

pub(crate) fn snapshot(project_id: &str, language_id: &str, session_id: &str) -> Option<SessionSnapshot> {
    store().snapshot(project_id, language_id, session_id)
}

/// Drops the session's entries when dropped, unless [`SessionGuard::keep`] ran.
/// Lets `start_session` register a session before the server can publish,
/// without leaving an entry behind when a later start step fails.
pub(crate) struct SessionGuard {
    session_id: Option<String>,
}

impl SessionGuard {
    pub(crate) fn begin(session_id: &str, project_id: &str, language_id: &str) -> Self {
        begin_session(session_id, project_id, language_id);
        Self { session_id: Some(session_id.to_string()) }
    }

    pub(crate) fn keep(mut self) {
        self.session_id = None;
    }
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        if let Some(session_id) = self.session_id.take() {
            drop_session(&session_id);
        }
    }
}

#[cfg(test)]
mod tests;
