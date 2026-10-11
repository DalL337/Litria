//! `litria_diagnostics_list` (Project API contract brief §7.5, §10; build plan
//! P5b).
//!
//! The diagnostics come from the P5a detail store (`lsp::diagnostics_cache`),
//! for the live language-server sessions serving the bound root, with the
//! freshness the store proves. The kind of file — which server, if any,
//! produces its diagnostics — comes from the editor's capability table over
//! the `languages.capabilities` bridge op, the same table `project_context`
//! reports; it is fetched only when a named file has no diagnostics to show.
//!
//! Disclosure (brief §7.5): a published document is mapped to a project path
//! through its CANONICAL location, so a link cannot smuggle a denied file in
//! under an allowed name; only regular files are reported, so a name the
//! policy withholds only as a directory (`.env.example/`, a user's
//! `private/`) cannot pass a file check (Codex review F1); denied files are
//! never reported (omitted and uncounted when enumerating, `denied` when
//! named); related locations in denied files, outside the project, or that
//! are not files are dropped; path-like tokens in
//! messages that name a denied file become `[denied]`, and ones outside the
//! project become `[path]`. Token redaction is heuristic and tested — not a
//! guarantee that free text never mentions a denied file.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Component, Path};

use super::bridge::{self, Bridge};
use super::policy::{classify, Class};
use super::reader::{identity, Identity};
use super::{workspace, MAX_RESPONSE_BYTES};
use crate::contracts::context::CallContext;
use crate::contracts::error::ContractError;
use crate::contracts::project_api::diagnostics_list::{
    Diagnostic, DiagnosticRange, DiagnosticsListRequest, DiagnosticsListResult, FileDiagnostics, Freshness,
    FreshnessReason, RelatedLocation, Severity, TruncationReason, UnavailableReason, MAX_DIAGNOSTICS_PER_FILE,
    MAX_DIAGNOSTICS_PER_RESPONSE, MAX_MESSAGE_CHARS, MAX_RELATED_PER_DIAGNOSTIC,
};
use crate::contracts::project_api_bridge::languages::{
    CapabilitiesOp, CapabilitiesRequest, CapabilitiesResult, DiagnosticsSource,
};
use crate::lsp::diagnostics_cache::{self, uri_to_path, SessionSnapshot, StoredDiagnostic};
use crate::lsp::session::{live_sessions_for_root, LiveSession};

/// Kept free in the encoded budget for the result envelope.
const ENVELOPE_RESERVE: usize = 256;

pub(crate) fn handle(
    context: &CallContext,
    request: DiagnosticsListRequest,
) -> Result<DiagnosticsListResult, ContractError> {
    let mut sources = LiveSources {
        bridge: bridge::global(),
        epoch: &context.epoch,
    };
    handle_with(context, request, &mut sources, MAX_RESPONSE_BYTES)
}

pub(crate) fn handle_with(
    context: &CallContext,
    request: DiagnosticsListRequest,
    sources: &mut dyn DiagnosticsSources,
    ceiling: usize,
) -> Result<DiagnosticsListResult, ContractError> {
    workspace::fenced(context, |root| run(root, &request, sources, ceiling))
}

// ---------------------------------------------------------------------------
// Where the facts come from: the bridge + LSP store in production, a script in
// tests.
// ---------------------------------------------------------------------------

/// A live session and what the store holds for it (`None`: nothing recorded).
pub(crate) struct SessionDiagnostics {
    pub session: LiveSession,
    pub producer: String,
    pub snapshot: Option<SessionSnapshot>,
}

pub(crate) trait DiagnosticsSources {
    fn capabilities(&mut self) -> Result<CapabilitiesResult, ContractError>;
    fn sessions(&mut self, root: &Path) -> Vec<SessionDiagnostics>;
}

struct LiveSources<'a> {
    bridge: &'a Bridge,
    epoch: &'a str,
}

impl DiagnosticsSources for LiveSources<'_> {
    fn capabilities(&mut self) -> Result<CapabilitiesResult, ContractError> {
        self.bridge.call::<CapabilitiesOp>(self.epoch, &CapabilitiesRequest {})
    }

    fn sessions(&mut self, root: &Path) -> Vec<SessionDiagnostics> {
        live_sessions_for_root(root)
            .into_iter()
            .map(|session| {
                let snapshot =
                    diagnostics_cache::snapshot(&session.project_id, &session.language_id, &session.session_id);
                let producer = producer_name(&session.language_id);
                SessionDiagnostics {
                    session,
                    producer,
                    snapshot,
                }
            })
            .collect()
    }
}

/// The server's executable name, which is what users and agents know it by.
fn producer_name(language_id: &str) -> String {
    crate::lsp::packs::get_pack(language_id)
        .map(|pack| pack.command.to_string())
        .unwrap_or_else(|| language_id.to_string())
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

/// One published document, mapped to its canonical project path.
struct Published {
    producer: String,
    freshness: Freshness,
    freshness_reason: Option<FreshnessReason>,
    diagnostics: Vec<StoredDiagnostic>,
    store_truncated: bool,
}

pub(crate) fn run(
    root: &Path,
    request: &DiagnosticsListRequest,
    sources: &mut dyn DiagnosticsSources,
    ceiling: usize,
) -> Result<DiagnosticsListResult, ContractError> {
    let sessions = sources.sessions(root);
    let published = published_files(root, &sessions);
    let mut out = Output::new(ceiling);
    // The store dropped some documents to stay bounded (Codex review F4): a
    // file it no longer holds is indistinguishable from one never analysed.
    let evicted = sessions
        .iter()
        .any(|source| source.snapshot.as_ref().is_some_and(|snapshot| snapshot.documents_evicted));

    match &request.paths {
        Some(paths) => {
            // What skipping every later path would cost, reserved before each
            // entry is accepted: the response can then always end in `skipped`
            // entries without crossing the ceiling. (Requests are at most
            // 64 KiB, so the whole tail is far below the 384 KiB ceiling.)
            let mut tail = vec![0usize; paths.len()];
            for index in (0..paths.len().saturating_sub(1)).rev() {
                tail[index] = tail[index + 1] + Output::skipped_len(&paths[index + 1]);
            }
            // Fetched at most once, and only when a named file has nothing published.
            let mut capabilities: Option<CapabilitiesResult> = None;
            for (index, path) in paths.iter().enumerate() {
                if out.stopped {
                    out.push_skipped(path);
                    continue;
                }
                let entry = match identity(root, path) {
                    Identity::InvalidPath => Some(FileDiagnostics::InvalidPath { path: path.clone() }),
                    Identity::Denied => Some(FileDiagnostics::Denied { path: path.clone() }),
                    Identity::Key(key) => match published.get(&key) {
                        Some(file) => available(root, path, &key, file, request.min_severity, &mut out),
                        None => {
                            if capabilities.is_none() {
                                capabilities = Some(sources.capabilities()?);
                            }
                            Some(without_diagnostics(path, &key, capabilities.as_ref().unwrap(), &sessions))
                        }
                    },
                };
                if evicted
                    && matches!(
                        &entry,
                        Some(FileDiagnostics::Unavailable { reason: UnavailableReason::NotAnalyzed, .. })
                    )
                {
                    out.reason(TruncationReason::StoreEvicted);
                }
                match entry {
                    Some(entry) => out.push_or_skip(entry, path, tail[index]),
                    None => {
                        out.stop(TruncationReason::Diagnostics);
                        out.push_skipped(path);
                    }
                }
            }
        }
        None => {
            if evicted {
                out.reason(TruncationReason::StoreEvicted);
            }
            for (key, file) in &published {
                if out.stopped {
                    break;
                }
                // Enumeration skips what search and graph skip.
                if classify(key) == Class::Unindexed {
                    continue;
                }
                match available(root, key, key, file, request.min_severity, &mut out) {
                    Some(entry) => {
                        // A file whose list is incomplete is listed even when
                        // nothing could be kept: never dropped as "no errors"
                        // (Codex review F3).
                        let has_any = matches!(&entry, FileDiagnostics::Available { diagnostics, truncated, .. }
                            if !diagnostics.is_empty() || *truncated);
                        if has_any {
                            out.push_or_stop(entry);
                        }
                    }
                    None => out.stop(TruncationReason::Diagnostics),
                }
            }
        }
    }
    Ok(out.finish())
}

/// Every document a live session published for, keyed by canonical project
/// path. Denied documents never enter the map; documents outside the root or
/// no longer on disk cannot be mapped and are left out.
fn published_files(root: &Path, sessions: &[SessionDiagnostics]) -> BTreeMap<String, Published> {
    let mut map = BTreeMap::new();
    for source in sessions {
        let Some(snapshot) = &source.snapshot else { continue };
        for document in &snapshot.documents {
            // Check versus use (adversarial F1): the server diagnosed what the URI
            // led to when it PUBLISHED. Report it only if the URI still leads
            // there; a link swapped since then cannot rename a denied file.
            let Some(now) = uri_to_path(&document.uri).and_then(|path| fs::canonicalize(path).ok()) else {
                continue;
            };
            if document.canonical_at_publish.as_deref() != Some(now.as_path()) {
                continue;
            }
            // Diagnostics are about files. A directory is judged by other
            // rules (`.env.example/`, `private/`) that a file check would miss.
            if !is_regular_file(&now) {
                continue;
            }
            let Some(key) = canonical_relative(root, &now) else { continue };
            if classify(&key) == Class::Denied {
                continue;
            }
            let (freshness, freshness_reason) = public_freshness(document.freshness);
            map.entry(key).or_insert_with(|| Published {
                producer: source.producer.clone(),
                freshness,
                freshness_reason,
                diagnostics: document.diagnostics.clone(),
                store_truncated: document.store_truncated,
            });
        }
    }
    map
}

fn public_freshness(freshness: diagnostics_cache::Freshness) -> (Freshness, Option<FreshnessReason>) {
    use diagnostics_cache::{Freshness as F, StaleReason as S, UnknownReason as U};
    match freshness {
        F::Current => (Freshness::Current, None),
        F::Stale(S::OlderVersion) => (Freshness::Stale, Some(FreshnessReason::OlderVersion)),
        F::Stale(S::Reopened) => (Freshness::Stale, Some(FreshnessReason::Reopened)),
        F::Unknown(U::ProducerOmitsVersion) => (Freshness::Unknown, Some(FreshnessReason::ProducerOmitsVersion)),
        F::Unknown(U::ClosedFile) => (Freshness::Unknown, Some(FreshnessReason::ClosedFile)),
        F::Unknown(U::VersionAhead) => (Freshness::Unknown, Some(FreshnessReason::VersionAhead)),
        F::Unknown(U::NoSentVersion) => (Freshness::Unknown, Some(FreshnessReason::NoSentVersion)),
        F::Unknown(U::ReusedVersion) => (Freshness::Unknown, Some(FreshnessReason::ReusedVersion)),
    }
}

/// `None` when the file has matching diagnostics but the response's
/// diagnostic budget is spent: the caller reports it `skipped` — never as an
/// empty (no-errors-looking) list.
fn available(
    root: &Path,
    path: &str,
    key: &str,
    file: &Published,
    min_severity: Severity,
    out: &mut Output,
) -> Option<FileDiagnostics> {
    let file_dir = key.rsplit_once('/').map(|(dir, _)| dir).unwrap_or("");
    let mut matching: Vec<&StoredDiagnostic> = file
        .diagnostics
        .iter()
        .filter(|d| severity_of(d) <= min_severity)
        .collect();
    let budget = out.diagnostics_left();
    if !matching.is_empty() && budget == 0 {
        return None;
    }
    let mut truncated = file.store_truncated;
    if matching.len() > MAX_DIAGNOSTICS_PER_FILE as usize {
        matching.truncate(MAX_DIAGNOSTICS_PER_FILE as usize);
        truncated = true;
    }
    if truncated {
        out.reason(TruncationReason::PerFile);
    }
    if matching.len() > budget {
        matching.truncate(budget);
        truncated = true;
        out.stop(TruncationReason::Diagnostics);
    }
    let mut shortened = false;
    let diagnostics: Vec<Diagnostic> = matching
        .into_iter()
        .map(|d| {
            let (diagnostic, clipped) = public_diagnostic(root, file_dir, d, &file.producer);
            shortened |= clipped;
            diagnostic
        })
        .collect();
    if shortened {
        truncated = true;
        out.reason(TruncationReason::Details);
    }
    out.count_diagnostics(diagnostics.len());
    Some(FileDiagnostics::Available {
        path: path.to_string(),
        producer: file.producer.clone(),
        freshness: file.freshness,
        freshness_reason: file.freshness_reason,
        diagnostics,
        truncated,
    })
}

/// A named file nothing has published for: what the editor's table says
/// about its kind decides between `noProducer` and the `unavailable` reasons.
fn without_diagnostics(
    path: &str,
    key: &str,
    capabilities: &CapabilitiesResult,
    sessions: &[SessionDiagnostics],
) -> FileDiagnostics {
    let extension = key
        .rsplit_once('/')
        .map(|(_, name)| name)
        .unwrap_or(key)
        .rsplit_once('.')
        .map(|(_, ext)| format!(".{}", ext.to_ascii_lowercase()));
    let row = extension.and_then(|ext| {
        capabilities
            .languages
            .iter()
            .find(|row| row.extensions.iter().any(|candidate| candidate.eq_ignore_ascii_case(&ext)))
    });
    let path = path.to_string();
    match row.map(|row| (row.diagnostics_source, row.server.as_deref())) {
        None | Some((DiagnosticsSource::None, _)) => FileDiagnostics::NoProducer { path },
        Some((DiagnosticsSource::Editor, _)) => FileDiagnostics::Unavailable {
            path,
            reason: UnavailableReason::NotBridged,
        },
        Some((DiagnosticsSource::Server, server)) => {
            let running = server.is_some_and(|pack| sessions.iter().any(|s| s.session.language_id == pack));
            FileDiagnostics::Unavailable {
                path,
                reason: if running {
                    UnavailableReason::NotAnalyzed
                } else {
                    UnavailableReason::ProducerNotRunning
                },
            }
        }
    }
}

/// LSP leaves a missing severity to the client; it is reported as an error,
/// the conservative reading.
fn severity_of(diagnostic: &StoredDiagnostic) -> Severity {
    match diagnostic.severity {
        Some(2) => Severity::Warning,
        Some(3) => Severity::Information,
        Some(4) => Severity::Hint,
        _ => Severity::Error,
    }
}

/// The public diagnostic, and whether any of it was shortened or left out to
/// fit a bound (Codex review F5). Related locations the POLICY removes never
/// count: a flag for them would hint that a denied file is involved.
fn public_diagnostic(root: &Path, file_dir: &str, diagnostic: &StoredDiagnostic, producer: &str) -> (Diagnostic, bool) {
    let mut clipped = diagnostic.clipped;
    let mut related = Vec::new();
    for location in &diagnostic.related {
        let Some(path) = project_file_of_uri(root, &location.uri) else { continue };
        if classify(&path) == Class::Denied {
            continue;
        }
        if related.len() == MAX_RELATED_PER_DIAGNOSTIC as usize {
            clipped = true;
            break;
        }
        let (message, cut) = redact_bounded(&location.message, root, file_dir);
        clipped |= cut || location.clipped;
        related.push(RelatedLocation {
            path,
            range: public_range(location.range),
            message,
        });
    }
    let (message, cut) = redact_bounded(&diagnostic.message, root, file_dir);
    clipped |= cut;
    // Free server text like the message (adversarial F3).
    let code = diagnostic.code.as_deref().map(|code| {
        let (code, cut) = redact_bounded(code, root, file_dir);
        clipped |= cut;
        code
    });
    let public = Diagnostic {
        severity: severity_of(diagnostic),
        message,
        range: public_range(diagnostic.range),
        code,
        producer: producer.to_string(),
        related,
    };
    (public, clipped)
}

/// LSP positions are 0-based UTF-16 offsets; the API's are 1-based (brief §5).
fn public_range(range: diagnostics_cache::Range) -> DiagnosticRange {
    DiagnosticRange {
        start_line: range.start.line.saturating_add(1),
        start_column: range.start.character.saturating_add(1),
        end_line: range.end.line.saturating_add(1),
        end_column: range.end.character.saturating_add(1),
    }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// The canonical project path of a related location: decoded, canonicalized
/// (resolving links to what they name), a regular file, and inside the root.
/// `None` for anything that is not, or no longer, there.
fn project_file_of_uri(root: &Path, uri: &str) -> Option<String> {
    let path = uri_to_path(uri)?;
    let canonical = fs::canonicalize(path).ok()?;
    if !is_regular_file(&canonical) {
        return None;
    }
    canonical_relative(root, &canonical)
}

/// A canonical path (no links left to follow) that names a regular file.
fn is_regular_file(canonical: &Path) -> bool {
    fs::metadata(canonical).is_ok_and(|metadata| metadata.is_file())
}

fn canonical_relative(root: &Path, target: &Path) -> Option<String> {
    let relative = target.strip_prefix(root).ok()?;
    let mut segments = Vec::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => segments.push(part.to_str()?.to_owned()),
            _ => return None,
        }
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

// ---------------------------------------------------------------------------
// Message redaction (brief §7.5): heuristic, conservative, tested.
// ---------------------------------------------------------------------------

/// The redacted text alone (tests).
#[cfg(test)]
pub(crate) fn redact_message(message: &str, root: &Path, file_dir: &str) -> String {
    redact_bounded(message, root, file_dir).0
}

/// Replace path-like tokens that name a denied file with `[denied]`, and
/// absolute paths outside the project (or relative ones that climb out of it)
/// with `[path]`; an absolute path inside the project becomes its project
/// path. Then bound the text to 1,000 characters, and say whether that cut
/// it: shortened text must be reported as such (Codex review F5).
fn redact_bounded(message: &str, root: &Path, file_dir: &str) -> (String, bool) {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while !rest.is_empty() {
        // Copy whitespace through unchanged.
        let token_start = rest.find(|c: char| !c.is_whitespace()).unwrap_or(rest.len());
        out.push_str(&rest[..token_start]);
        rest = &rest[token_start..];
        if rest.is_empty() {
            break;
        }
        let token_end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        out.push_str(&redact_token(&rest[..token_end], root, file_dir));
        rest = &rest[token_end..];
    }
    let kept = bounded(&out, MAX_MESSAGE_CHARS as usize);
    let cut = kept.len() < out.len();
    (kept, cut)
}

fn redact_token(token: &str, root: &Path, file_dir: &str) -> String {
    const WRAPPERS: &[char] = &['\'', '"', '`', '(', ')', '[', ']', '{', '}', '<', '>', ',', ';'];
    let trimmed_start = token.trim_start_matches(WRAPPERS);
    // Wrappers and sentence punctuation in any order ("(.env).", "'./.env'.",
    // "x.ts:"), until stable — but never the colon of a bare drive ("C:").
    let mut core = trimmed_start;
    loop {
        let before = core.len();
        core = core.trim_end_matches(WRAPPERS);
        if core.len() > 2 && (core.ends_with('.') || core.ends_with(':')) {
            core = &core[..core.len() - 1];
        }
        if core.len() == before {
            break;
        }
    }
    if core.is_empty() {
        return token.to_string();
    }
    match judge(core, root, file_dir) {
        Some(replacement) => {
            let start = token.len() - trimmed_start.len();
            format!("{}{}{}", &token[..start], replacement, &token[start + core.len()..])
        }
        None => token.to_string(),
    }
}

/// `Some(replacement)` when `raw` must not appear as written.
fn judge(raw: &str, root: &Path, file_dir: &str) -> Option<String> {
    // A file URI names an absolute path.
    let decoded;
    let candidate = match raw.strip_prefix("file://") {
        Some(rest) => {
            decoded = match uri_to_path(&format!("file://{rest}")) {
                Some(path) => path.to_string_lossy().into_owned(),
                None => return Some("[path]".into()),
            };
            decoded.as_str()
        }
        None => raw,
    };
    let normalized = candidate.replace('\\', "/");
    if is_absolute_text(&normalized) {
        return Some(match project_path_of_text(root, &normalized) {
            Some(relative) if !relative.is_empty() && classify(&relative) == Class::Denied => "[denied]".into(),
            Some(relative) if !relative.is_empty() => relative,
            _ => "[path]".into(),
        });
    }
    // Relative or bare: judged where a module specifier resolves (the
    // diagnosed file's folder) and from the project root; basename rules
    // (`.env`, `id_rsa*`, `*.pem`) match either way.
    let Some(from_file) = join_normalized(file_dir, &normalized) else {
        // Climbs out of the project.
        return Some("[path]".into());
    };
    let from_root = join_normalized("", &normalized);
    let denied = |path: &str| !path.is_empty() && classify(path) == Class::Denied;
    if denied(&from_file) || from_root.as_deref().is_some_and(denied) {
        return Some("[denied]".into());
    }
    None
}

/// Absolute on any platform this message may have come from: a Unix path, a
/// UNC path (`//server/share`), or a drive path (`C:/…`), separators already
/// normalized to `/`.
fn is_absolute_text(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/') || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && bytes[2] == b'/')
}

/// The project path an absolute path names, judged lexically (a message may
/// name a file that does not exist): `None` when it lies outside the root or
/// climbs out of it.
fn project_path_of_text(root: &Path, absolute: &str) -> Option<String> {
    let root_text = root_text(root);
    let rest = strip_prefix_ignoring_case(absolute, &root_text)?;
    if !(rest.is_empty() || rest.starts_with('/')) {
        return None;
    }
    join_normalized("", rest.trim_start_matches('/'))
}

/// The canonical root as a message would spell it: no `\\?\` verbatim prefix,
/// `/` separators.
fn root_text(root: &Path) -> String {
    let text = root.to_string_lossy().replace('\\', "/");
    if let Some(unc) = text.strip_prefix("//?/UNC/") {
        format!("//{unc}")
    } else if let Some(local) = text.strip_prefix("//?/") {
        local.to_string()
    } else {
        text
    }
}

/// `text` minus `prefix`, comparing case-insensitively where the default file
/// system is (Windows, macOS) and exactly elsewhere.
fn strip_prefix_ignoring_case<'a>(text: &'a str, prefix: &str) -> Option<&'a str> {
    let insensitive = cfg!(any(windows, target_os = "macos"));
    let mut text_chars = text.char_indices();
    for expected in prefix.chars() {
        let (_, actual) = text_chars.next()?;
        let same = if insensitive {
            actual.to_lowercase().eq(expected.to_lowercase())
        } else {
            actual == expected
        };
        if !same {
            return None;
        }
    }
    let at = text_chars.next().map(|(index, _)| index).unwrap_or(text.len());
    Some(&text[at..])
}

/// `base` + `relative`, with `.` and empty segments dropped and `..` applied.
/// `None` when `..` climbs above the project root.
fn join_normalized(base: &str, relative: &str) -> Option<String> {
    let mut segments: Vec<&str> = Vec::new();
    for segment in base.split('/').chain(relative.split('/')) {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            other => segments.push(other),
        }
    }
    Some(segments.join("/"))
}

fn bounded(text: &str, max: usize) -> String {
    match text.char_indices().nth(max) {
        Some((cut, _)) => text[..cut].to_string(),
        None => text.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Response accounting
// ---------------------------------------------------------------------------

struct Output {
    files: Vec<FileDiagnostics>,
    reasons: Vec<TruncationReason>,
    diagnostics: usize,
    bytes: usize,
    ceiling: usize,
    stopped: bool,
}

impl Output {
    fn new(ceiling: usize) -> Self {
        Self {
            files: Vec::new(),
            reasons: Vec::new(),
            diagnostics: 0,
            bytes: ENVELOPE_RESERVE,
            ceiling,
            stopped: false,
        }
    }

    fn diagnostics_left(&self) -> usize {
        (MAX_DIAGNOSTICS_PER_RESPONSE as usize).saturating_sub(self.diagnostics)
    }

    fn count_diagnostics(&mut self, n: usize) {
        self.diagnostics += n;
    }

    fn reason(&mut self, reason: TruncationReason) {
        if !self.reasons.contains(&reason) {
            self.reasons.push(reason);
        }
    }

    fn stop(&mut self, reason: TruncationReason) {
        self.reason(reason);
        self.stopped = true;
    }

    /// Encoded size of an entry plus its separating comma.
    fn encoded_len(entry: &FileDiagnostics) -> usize {
        serde_json::to_vec(entry).map(|bytes| bytes.len() + 1).unwrap_or(usize::MAX)
    }

    fn skipped_len(path: &str) -> usize {
        Self::encoded_len(&FileDiagnostics::Skipped { path: path.to_string() })
    }

    /// Named-path mode: an entry that would leave no room for skipping the
    /// remaining paths (`tail`) becomes `skipped` itself.
    fn push_or_skip(&mut self, entry: FileDiagnostics, path: &str, tail: usize) {
        let size = Self::encoded_len(&entry);
        if self.bytes.saturating_add(size).saturating_add(tail) > self.ceiling {
            self.stop(TruncationReason::ResponseSize);
            self.push_skipped(path);
            return;
        }
        self.bytes += size;
        self.files.push(entry);
    }

    fn push_skipped(&mut self, path: &str) {
        self.bytes = self.bytes.saturating_add(Self::skipped_len(path));
        self.files.push(FileDiagnostics::Skipped { path: path.to_string() });
    }

    /// Enumeration mode: an entry that does not fit ends the response.
    fn push_or_stop(&mut self, entry: FileDiagnostics) {
        let size = Self::encoded_len(&entry);
        if self.bytes.saturating_add(size) > self.ceiling {
            self.stop(TruncationReason::ResponseSize);
            return;
        }
        self.bytes += size;
        self.files.push(entry);
    }

    fn finish(mut self) -> DiagnosticsListResult {
        self.reasons.sort();
        DiagnosticsListResult {
            truncated: !self.reasons.is_empty(),
            truncated_by: self.reasons,
            files: self.files,
        }
    }
}

#[cfg(test)]
mod tests;
