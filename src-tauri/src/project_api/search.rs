//! `litria_files_search` (Project API contract brief §7.3, §10).
//!
//! Effective semantics with complete buffer coverage, or an explicit gap:
//! 1. The editor's buffer index comes first, through the bridge. If it cannot
//!    be fetched the call fails: searching disk instead would silently miss
//!    exactly the unsaved text that matters.
//! 2. Every allowed document in the index is searched in its buffer, never on
//!    disk — including buffers whose file no longer exists.
//! 3. Every other allowed, indexed file is searched on disk.
//! 4. A buffer that could not be searched is reported (`bufferCoverage`),
//!    never dropped.
//!
//! Disk files and buffers are visited as one sequence in path order, so the
//! matches reported are always the first ones in path order: the search can
//! stop as soon as `maxResults` matches precede everything left to visit.
//! Buffer text arrives in pages (`editor.documents`) and is fetched only when
//! the walk reaches it.

use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use super::bridge::{self, malformed, Bridge};
use super::paths::is_valid_api_path;
use super::policy::{classify, classify_directory, Class};
use super::reader::{identity, read_disk_capped, resolves_to_itself, DiskRead, Identity};
use super::walk::Walker;
use super::{workspace, MAX_RESPONSE_BYTES};
use crate::contracts::context::CallContext;
use crate::contracts::error::{ContractError, ErrorCode};
use crate::contracts::project_api::files_read::{DocumentSource, MAX_BYTES_PER_DOCUMENT, MAX_DOCUMENTS};
use crate::contracts::project_api::files_search::{
    FilesSearchRequest, FilesSearchResult, SearchMatch, SearchScope, SearchTarget, SkippedCounts, TruncationReason,
    DEFAULT_RESULTS, PREVIEW_LENGTH,
};
use crate::contracts::project_api_bridge::editor::{
    BufferIndexOp, BufferIndexRequest, BufferIndexResult, DocumentEntry, DocumentQuery, DocumentsOp,
    DocumentsRequest, DocumentsResult, MAX_INDEX_ENTRIES,
};

/// Files and buffers searched per call (brief §10).
pub(crate) const MAX_FILES_SCANNED: u32 = 20_000;
/// Bytes scanned per file or buffer; larger ones are counted as too large.
pub(crate) const SCAN_CAP_BYTES: u32 = 1024 * 1024;
pub(crate) const TIME_BUDGET: Duration = Duration::from_secs(2);
/// Searches running at once, across all principals; more get `busy`.
pub(crate) const MAX_CONCURRENT_SEARCHES: usize = 2;
/// Directory entries the walker examines per call. Bounds its memory: a
/// directory with millions of entries ends the walk (`filesScanned`) instead
/// of being collected and sorted.
pub(crate) const MAX_ENTRIES_EXAMINED: usize = 100_000;
/// Text requested per buffer per page: the bridge's per-document ceiling.
/// A buffer is fetched in line-aligned chunks of at most this size.
const CHUNK_BYTES: u32 = MAX_BYTES_PER_DOCUMENT;
/// Text requested per page, across its buffers.
const PAGE_TEXT_BYTES: u32 = 256 * 1024;
/// Characters of a preview shown before the match when the line is clipped.
const PREVIEW_BEFORE: usize = 40;

pub(crate) fn handle(context: &CallContext, request: FilesSearchRequest) -> Result<FilesSearchResult, ContractError> {
    handle_with(context, request, bridge::global(), global_searches())
}

pub(crate) fn handle_with(
    context: &CallContext,
    request: FilesSearchRequest,
    bridge: &Bridge,
    searches: &Searches,
) -> Result<FilesSearchResult, ContractError> {
    let _slot = searches.acquire()?;
    workspace::fenced(context, |root| {
        let mut editor = BridgeEditor {
            bridge,
            epoch: &context.epoch,
        };
        search(root, &request, &mut editor, &mut Budget::standard())
    })
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

/// A ceiling on searches running at once.
pub(crate) struct Searches {
    active: AtomicUsize,
    max: usize,
}

pub(crate) struct SearchSlot<'a>(&'a Searches);

impl Searches {
    pub(crate) const fn new(max: usize) -> Self {
        Self {
            active: AtomicUsize::new(0),
            max,
        }
    }

    pub(crate) fn acquire(&self) -> Result<SearchSlot<'_>, ContractError> {
        self.active
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
                (active < self.max).then_some(active + 1)
            })
            .map(|_| SearchSlot(self))
            .map_err(|_| {
                ContractError::new(
                    ErrorCode::Busy,
                    "too many searches are running; retry shortly",
                )
            })
    }
}

impl Drop for SearchSlot<'_> {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, Ordering::AcqRel);
    }
}

fn global_searches() -> &'static Searches {
    static SEARCHES: Searches = Searches::new(MAX_CONCURRENT_SEARCHES);
    &SEARCHES
}

// ---------------------------------------------------------------------------
// The editor's side
// ---------------------------------------------------------------------------

/// Where buffer state comes from: the bridge in production, a script in tests.
pub(crate) trait SearchEditor {
    fn buffer_index(&mut self) -> Result<BufferIndexResult, ContractError>;
    fn page(&mut self, request: &DocumentsRequest) -> Result<DocumentsResult, ContractError>;
}

struct BridgeEditor<'a> {
    bridge: &'a Bridge,
    epoch: &'a str,
}

impl SearchEditor for BridgeEditor<'_> {
    fn buffer_index(&mut self) -> Result<BufferIndexResult, ContractError> {
        self.bridge.call::<BufferIndexOp>(
            self.epoch,
            &BufferIndexRequest {
                max_entries: MAX_INDEX_ENTRIES,
            },
        )
    }

    fn page(&mut self, request: &DocumentsRequest) -> Result<DocumentsResult, ContractError> {
        self.bridge.call::<DocumentsOp>(self.epoch, request)
    }
}

/// Work limits for one search. Tests shrink them.
pub(crate) struct Budget {
    pub max_files: u32,
    pub max_entries: usize,
    pub scan_cap: u32,
    pub ceiling: usize,
    /// True once the time budget has run out.
    pub expired: Box<dyn FnMut() -> bool>,
    /// Tests: handed to the walker (its directory-enter window).
    #[cfg(test)]
    pub before_enter: Option<Box<dyn FnMut(&str)>>,
}

impl Budget {
    pub(crate) fn standard() -> Self {
        let deadline = Instant::now() + TIME_BUDGET;
        Self {
            max_files: MAX_FILES_SCANNED,
            max_entries: MAX_ENTRIES_EXAMINED,
            scan_cap: SCAN_CAP_BYTES,
            ceiling: MAX_RESPONSE_BYTES,
            expired: Box::new(move || Instant::now() >= deadline),
            #[cfg(test)]
            before_enter: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/// The query as it is matched. With ASCII folding, haystack and needle are
/// both lower-cased with `to_ascii_lowercase`, which changes only ASCII
/// bytes: byte offsets, character boundaries and therefore columns stay
/// exactly those of the original text.
struct Needle {
    text: String,
    fold: bool,
}

impl Needle {
    fn new(query: &str, case_sensitive: bool) -> Self {
        Self {
            text: if case_sensitive {
                query.to_owned()
            } else {
                query.to_ascii_lowercase()
            },
            fold: !case_sensitive,
        }
    }

    fn haystack<'t>(&self, text: &'t str) -> Cow<'t, str> {
        if self.fold {
            Cow::Owned(text.to_ascii_lowercase())
        } else {
            Cow::Borrowed(text)
        }
    }
}

/// One occurrence: line (from `first_line`), 1-based column in code points,
/// and the preview.
#[derive(Debug, PartialEq)]
struct Found {
    line: u32,
    column: u32,
    preview: String,
}

/// Every non-overlapping occurrence of the needle in `text`, whose first line
/// is `first_line`, up to `limit` occurrences. Line breaks are `\n`; a `\r`
/// before one is not part of the preview.
fn find_all(text: &str, needle: &Needle, first_line: u32, limit: usize) -> Vec<Found> {
    let haystack = needle.haystack(text);
    let bytes = text.as_bytes();
    let mut found = Vec::new();
    let mut line = first_line;
    let mut line_start = 0usize;
    let mut scanned_to = 0usize;
    // Column of the previous match on the same line, to count incrementally.
    let mut column_at: Option<(usize, usize)> = None;
    for (offset, _) in haystack.match_indices(needle.text.as_str()) {
        if found.len() >= limit {
            break;
        }
        let segment = &bytes[scanned_to..offset];
        if let Some(last) = segment.iter().rposition(|byte| *byte == b'\n') {
            line += segment.iter().filter(|byte| **byte == b'\n').count() as u32;
            line_start = scanned_to + last + 1;
            column_at = None;
        }
        scanned_to = offset;
        let (from, counted) = column_at.unwrap_or((line_start, 0));
        let column = counted + text[from..offset].chars().count();
        column_at = Some((offset, column));
        let line_end = text[offset..].find('\n').map_or(text.len(), |index| offset + index);
        found.push(Found {
            line,
            column: column as u32 + 1,
            preview: preview(&text[line_start..line_end], offset - line_start),
        });
    }
    found
}

/// The line without its `\r`, clipped to `PREVIEW_LENGTH` characters around
/// the match at byte `at`: a little context before it, the rest after.
fn preview(line: &str, at: usize) -> String {
    let line = line.strip_suffix('\r').unwrap_or(line);
    if line.len() <= PREVIEW_LENGTH {
        return line.to_owned(); // bytes bound characters
    }
    let at = at.min(line.len());
    // Up to PREVIEW_BEFORE characters before the match…
    let mut start = line[..at]
        .char_indices()
        .rev()
        .take(PREVIEW_BEFORE)
        .last()
        .map_or(at, |(index, _)| index);
    // …then fill forward; if the line ends first, reach further back.
    let forward = line[start..].chars().take(PREVIEW_LENGTH).count();
    if forward < PREVIEW_LENGTH {
        start = line[..start]
            .char_indices()
            .rev()
            .take(PREVIEW_LENGTH - forward)
            .last()
            .map_or(start, |(index, _)| index);
    }
    line[start..].chars().take(PREVIEW_LENGTH).collect()
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

/// The first `capacity` matches in (path, line, column) order.
struct Collector {
    capacity: usize,
    matches: BTreeMap<(String, u32, u32), SearchMatch>,
}

impl Collector {
    fn new(capacity: usize) -> Self {
        Self {
            capacity,
            matches: BTreeMap::new(),
        }
    }

    fn add(&mut self, key: (String, u32, u32), found: SearchMatch) {
        self.matches.insert(key, found);
        if self.matches.len() > self.capacity {
            self.matches.pop_last();
        }
    }

    /// Full, and nothing at or after `path` could enter any more.
    fn closed_before(&self, path: &str) -> bool {
        self.matches.len() >= self.capacity
            && self
                .matches
                .last_key_value()
                .is_some_and(|((last, _, _), _)| last.as_str() < path)
    }
}

/// What became of one buffer.
#[derive(Debug)]
enum Fetch {
    /// Not fully fetched yet: the next line to ask for, the revision every
    /// chunk so far carried, matches so far, and bytes searched so far.
    Pending {
        next_line: u32,
        revision: Option<String>,
        found: Vec<Found>,
        bytes: usize,
    },
    Searched {
        revision: String,
        found: Vec<Found>,
    },
    TooLarge,
    /// The page failed, or the text changed between chunks.
    NotSearched,
    /// The editor no longer holds it: the document is read from disk.
    Unbuffered,
}

struct Buffer {
    /// The name the editor session holds it under (for `editor.documents`).
    session_path: String,
    fetch: Fetch,
}

#[derive(Default)]
struct Tally {
    reasons: BTreeSet<TruncationReason>,
    skipped: SkippedCounts,
    files_searched: u32,
    buffers_searched: u32,
}

pub(crate) fn search(
    root: &Path,
    request: &FilesSearchRequest,
    editor: &mut dyn SearchEditor,
    budget: &mut Budget,
) -> Result<FilesSearchResult, ContractError> {
    let max_results = request.max_results.unwrap_or(DEFAULT_RESULTS) as usize;
    let needle = Needle::new(&request.query, request.case_sensitive);
    let mut tally = Tally::default();

    // 1. The prefix, judged by name before anything is touched, so a denied
    // prefix reveals nothing about what exists.
    let prefix = match request.path_prefix.as_deref() {
        None => None,
        Some(prefix) if !is_valid_api_path(prefix) => return Ok(finish(SearchScope::PrefixInvalid, tally, Vec::new(), budget.ceiling)),
        Some(prefix) => match classify_directory(prefix) {
            Class::Denied => return Ok(finish(SearchScope::PrefixDenied, tally, Vec::new(), budget.ceiling)),
            Class::Unindexed => return Ok(finish(SearchScope::PrefixUnindexed, tally, Vec::new(), budget.ceiling)),
            Class::Allowed => Some(prefix),
        },
    };
    let within = |path: &str| {
        prefix.is_none_or(|prefix| path == prefix || path.strip_prefix(prefix).is_some_and(|rest| rest.starts_with('/')))
    };

    // 2. The buffer index. Entries are keyed by the document's identity —
    // the canonical path when the file exists — and filtered by the policy
    // on both names before anything is planned or counted.
    let index = editor.buffer_index()?;
    if index.omitted > 0 {
        // The unlisted buffers cannot be classified, so they are not counted:
        // a denied buffer must never contribute to a count.
        tally.reasons.insert(TruncationReason::BufferCoverage);
    }
    let mut buffers: BTreeMap<String, Buffer> = BTreeMap::new();
    for entry in index.entries {
        let Identity::Key(key) = identity(root, &entry.path) else {
            continue;
        };
        if classify(&key) != Class::Allowed || !within(&key) || buffers.contains_key(&key) {
            continue;
        }
        let fetch = if entry.byte_length > budget.scan_cap {
            Fetch::TooLarge
        } else {
            Fetch::Pending {
                next_line: 1,
                revision: None,
                found: Vec::new(),
                bytes: 0,
            }
        };
        buffers.insert(
            key,
            Buffer {
                session_path: entry.path,
                fetch,
            },
        );
    }
    let keys: Vec<String> = buffers.keys().cloned().collect();

    // 3. Walk the disk and the buffers together, in path order.
    let mut walker = Walker::new(root, prefix, budget.max_entries, !request.include_ignored);
    #[cfg(test)]
    {
        walker.before_enter = budget.before_enter.take();
    }
    let mut next_disk = walker.next();
    let mut next_buffer = 0usize;
    let mut collector = Collector::new(max_results + 1);
    let mut visited: u32 = 0;
    let mut stopped: Option<TruncationReason> = None;
    loop {
        let path = match (next_disk.as_deref(), keys.get(next_buffer).map(String::as_str)) {
            (None, None) => break,
            (Some(disk), None) => disk.to_owned(),
            (None, Some(buffer)) => buffer.to_owned(),
            (Some(disk), Some(buffer)) => disk.min(buffer).to_owned(),
        };
        if collector.closed_before(&path) {
            stopped = Some(TruncationReason::Results);
            break;
        }
        if (budget.expired)() {
            stopped = Some(TruncationReason::TimeBudget);
            break;
        }
        if visited >= budget.max_files {
            stopped = Some(TruncationReason::FilesScanned);
            break;
        }
        visited += 1;
        let on_disk = next_disk.as_deref() == Some(path.as_str());
        if on_disk {
            next_disk = walker.next();
        }
        let buffered = keys.get(next_buffer) == Some(&path);
        if buffered {
            next_buffer += 1;
        }

        if request.target == SearchTarget::Path {
            if needle.haystack(&path).contains(needle.text.as_str()) {
                let source = if buffered { DocumentSource::Editor } else { DocumentSource::Disk };
                collector.add((path.clone(), 0, 0), SearchMatch::Path { path: path.clone(), source });
            }
            if buffered {
                tally.buffers_searched += 1;
            } else {
                tally.files_searched += 1;
            }
            continue;
        }

        if buffered {
            let position = next_buffer - 1;
            if matches!(buffers[&path].fetch, Fetch::Pending { .. }) {
                fetch_buffers(editor, &mut buffers, &keys, position, &needle, max_results + 1, budget)?;
            }
            match &buffers[&path].fetch {
                Fetch::Searched { revision, found } => {
                    tally.buffers_searched += 1;
                    for hit in found {
                        collector.add(
                            (path.clone(), hit.line, hit.column),
                            SearchMatch::Text {
                                path: path.clone(),
                                line: hit.line,
                                column: hit.column,
                                preview: hit.preview.clone(),
                                source: DocumentSource::Editor,
                                revision: revision.clone(),
                            },
                        );
                    }
                }
                Fetch::TooLarge => tally.skipped.too_large += 1,
                Fetch::Pending { .. } | Fetch::NotSearched => {
                    tally.skipped.buffers_not_searched += 1;
                    tally.reasons.insert(TruncationReason::BufferCoverage);
                }
                Fetch::Unbuffered if on_disk => scan_disk(root, &path, &needle, max_results + 1, budget, &mut collector, &mut tally),
                Fetch::Unbuffered => {} // gone from the editor, and not on disk
            }
        } else {
            scan_disk(root, &path, &needle, max_results + 1, budget, &mut collector, &mut tally);
        }
    }

    if let Some(reason) = stopped {
        tally.reasons.insert(reason);
        // Stopping on the result count leaves nothing out that could precede
        // the reported matches. The work limits do: any buffer not yet
        // reached is a buffer the result does not cover.
        if reason != TruncationReason::Results {
            let unreached = keys[next_buffer..]
                .iter()
                .filter(|key| !matches!(buffers[*key].fetch, Fetch::TooLarge))
                .count() as u32;
            if unreached > 0 {
                tally.skipped.buffers_not_searched += unreached;
                tally.reasons.insert(TruncationReason::BufferCoverage);
            }
        }
    }
    if walker.exhausted {
        tally.reasons.insert(TruncationReason::FilesScanned);
    }
    tally.skipped.unreadable += walker.unreadable_files;
    tally.skipped.unreadable_directories += walker.unreadable_directories;
    tally.skipped.ignored_files += walker.ignored_files;
    tally.skipped.ignored_directories += walker.ignored_directories;

    // A name found on disk is reported only if it still names a file that
    // resolves to exactly itself. The walker lists a directory by path, so a
    // directory swapped for a link after its parent was listed is listed
    // through the link — and a path search reports names without reading
    // them (finding F2). A name that is not in the real directory any more is
    // dropped too. Dropped matches are not counted: they may be withheld ones.
    let mut verified: BTreeMap<String, bool> = BTreeMap::new();
    let mut matches: Vec<SearchMatch> = collector
        .matches
        .into_values()
        .filter(|found| {
            let (path, source) = match found {
                SearchMatch::Text { path, source, .. } | SearchMatch::Path { path, source } => (path, source),
            };
            *source != DocumentSource::Disk
                || *verified
                    .entry(path.clone())
                    .or_insert_with(|| resolves_to_itself(root, path))
        })
        .collect();
    if matches.len() > max_results {
        matches.truncate(max_results);
        tally.reasons.insert(TruncationReason::Results);
    }
    let scope = match prefix {
        None => SearchScope::Project,
        Some(_) if walker.scope_found || !keys.is_empty() => SearchScope::Prefix,
        Some(_) => SearchScope::PrefixNotFound,
    };
    Ok(finish(scope, tally, matches, budget.ceiling))
}

fn scan_disk(
    root: &Path,
    path: &str,
    needle: &Needle,
    limit: usize,
    budget: &Budget,
    collector: &mut Collector,
    tally: &mut Tally,
) {
    match read_disk_capped(root, path, u64::from(budget.scan_cap)) {
        DiskRead::Text { text, revision } => {
            tally.files_searched += 1;
            for hit in find_all(&text, needle, 1, limit) {
                collector.add(
                    (path.to_owned(), hit.line, hit.column),
                    SearchMatch::Text {
                        path: path.to_owned(),
                        line: hit.line,
                        column: hit.column,
                        preview: hit.preview,
                        source: DocumentSource::Disk,
                        revision: revision.clone(),
                    },
                );
            }
        }
        DiskRead::TooLarge => tally.skipped.too_large += 1,
        DiskRead::NotText => tally.skipped.not_text += 1,
        DiskRead::Unreadable | DiskRead::NotFile | DiskRead::InvalidPath => tally.skipped.unreadable += 1,
        // Deleted since it was listed: nothing to search.
        DiskRead::NotFound => {}
        // Swapped for a link to a withheld file since it was listed: withheld
        // paths are never counted.
        DiskRead::Denied => {}
    }
}

/// Fetch a page of buffer text starting with the buffer at `from` (in key
/// order), plus the next pending buffers up to a page's worth, until the
/// buffer at `from` is settled. Every chunk is searched as it arrives.
///
/// A reply that misanswers its page fails the call (a misbehaving owner is
/// an error, not an answer); `workspaceChanged` fails the call; any other
/// failure leaves the page's buffers not searched.
fn fetch_buffers(
    editor: &mut dyn SearchEditor,
    buffers: &mut BTreeMap<String, Buffer>,
    keys: &[String],
    from: usize,
    needle: &Needle,
    limit: usize,
    budget: &mut Budget,
) -> Result<(), ContractError> {
    while matches!(buffers[&keys[from]].fetch, Fetch::Pending { .. }) {
        if (budget.expired)() {
            return Ok(()); // still pending: counted as not searched
        }
        let mut page_keys = Vec::new();
        let mut queries = Vec::new();
        for key in &keys[from..] {
            if queries.len() >= MAX_DOCUMENTS {
                break;
            }
            let buffer = &buffers[key];
            if let Fetch::Pending { next_line, .. } = buffer.fetch {
                page_keys.push(key.clone());
                queries.push(DocumentQuery {
                    path: buffer.session_path.clone(),
                    start_line: (next_line > 1).then_some(next_line),
                    end_line: None,
                    max_bytes: CHUNK_BYTES,
                });
            }
        }
        let page = DocumentsRequest {
            documents: queries,
            max_text_bytes: PAGE_TEXT_BYTES,
        };
        let reply = match editor.page(&page) {
            Ok(reply) => reply,
            Err(error) if error.code == ErrorCode::WorkspaceChanged => return Err(error),
            Err(_) => {
                for key in &page_keys {
                    buffers.get_mut(key).expect("listed").fetch = Fetch::NotSearched;
                }
                return Ok(());
            }
        };
        if reply.documents.len() != page.documents.len() {
            return Err(malformed());
        }
        let mut text_used = 0usize;
        for (position, ((key, query), entry)) in page_keys.iter().zip(&page.documents).zip(reply.documents).enumerate() {
            let buffer = buffers.get_mut(key).expect("listed");
            match entry {
                DocumentEntry::Deferred { path } if path == query.path && position > 0 => {}
                DocumentEntry::NotBuffered { path, .. } if path == query.path => buffer.fetch = Fetch::Unbuffered,
                DocumentEntry::Buffer {
                    path,
                    revision,
                    text,
                    range,
                    total_lines,
                    line_cut,
                    ..
                } if path == query.path => {
                    text_used += text.len();
                    let first = query.start_line.unwrap_or(1);
                    let answers = match range {
                        None => text.is_empty() && !line_cut,
                        Some(range) => {
                            range.start_line == first
                                && range.start_line <= range.end_line
                                && range.end_line <= total_lines
                                && (!line_cut || range.start_line == range.end_line)
                        }
                    };
                    if !answers || text.len() > query.max_bytes as usize || text_used > page.max_text_bytes as usize {
                        return Err(malformed());
                    }
                    buffer.fetch = settle(
                        std::mem::replace(&mut buffer.fetch, Fetch::NotSearched),
                        Chunk {
                            revision,
                            text: &text,
                            first,
                            range_end: range.map(|range| range.end_line),
                            total_lines,
                            line_cut,
                        },
                        needle,
                        limit,
                        budget.scan_cap as usize,
                    );
                }
                _ => return Err(malformed()),
            }
        }
    }
    Ok(())
}

struct Chunk<'t> {
    revision: String,
    text: &'t str,
    first: u32,
    range_end: Option<u32>,
    total_lines: u32,
    line_cut: bool,
}

/// Fold one chunk into a pending buffer.
fn settle(fetch: Fetch, chunk: Chunk<'_>, needle: &Needle, limit: usize, scan_cap: usize) -> Fetch {
    let Fetch::Pending {
        revision: seen,
        mut found,
        bytes,
        ..
    } = fetch
    else {
        return fetch;
    };
    // The text changed between chunks: what was searched is not one text.
    if seen.as_ref().is_some_and(|seen| *seen != chunk.revision) {
        return Fetch::NotSearched;
    }
    // A line longer than one chunk cannot be fetched whole in v1.
    if chunk.line_cut {
        return Fetch::TooLarge;
    }
    let bytes = bytes + chunk.text.len();
    if bytes > scan_cap {
        return Fetch::TooLarge; // grew past the scan limit since the index
    }
    let Some(end) = chunk.range_end else {
        // No lines: an empty buffer is searched; anything else means the
        // text shrank under us since the last chunk.
        return if chunk.total_lines == 0 {
            Fetch::Searched {
                revision: chunk.revision,
                found,
            }
        } else {
            Fetch::NotSearched
        };
    };
    if found.len() < limit {
        found.extend(find_all(chunk.text, needle, chunk.first, limit - found.len()));
    }
    if end >= chunk.total_lines {
        Fetch::Searched {
            revision: chunk.revision,
            found,
        }
    } else {
        Fetch::Pending {
            next_line: end + 1,
            revision: Some(chunk.revision),
            found,
            bytes,
        }
    }
}

fn encoded_len<T: serde::Serialize>(value: &T) -> usize {
    serde_json::to_vec(value).map_or(usize::MAX, |bytes| bytes.len())
}

/// The result within the encoded `ceiling`: room is reserved for the largest
/// possible counts and every truncation reason, then matches are added in
/// order while they fit.
fn finish(scope: SearchScope, mut tally: Tally, collected: Vec<SearchMatch>, ceiling: usize) -> FilesSearchResult {
    let largest = FilesSearchResult {
        scope: SearchScope::PrefixUnindexed,
        matches: Vec::new(),
        truncated: true,
        truncated_by: vec![
            TruncationReason::Results,
            TruncationReason::FilesScanned,
            TruncationReason::TimeBudget,
            TruncationReason::BufferCoverage,
            TruncationReason::ResponseSize,
        ],
        skipped: SkippedCounts {
            too_large: u32::MAX,
            not_text: u32::MAX,
            unreadable: u32::MAX,
            unreadable_directories: u32::MAX,
            buffers_not_searched: u32::MAX,
            ignored_files: u32::MAX,
            ignored_directories: u32::MAX,
        },
        files_searched: u32::MAX,
        buffers_searched: u32::MAX,
    };
    let mut used = encoded_len(&largest);
    let mut matches = Vec::with_capacity(collected.len());
    for found in collected {
        let size = encoded_len(&found) + 1; // and its comma
        if used + size > ceiling {
            tally.reasons.insert(TruncationReason::ResponseSize);
            break;
        }
        used += size;
        matches.push(found);
    }
    let truncated_by: Vec<TruncationReason> = tally.reasons.into_iter().collect();
    FilesSearchResult {
        scope,
        matches,
        truncated: !truncated_by.is_empty(),
        truncated_by,
        skipped: tally.skipped,
        files_searched: tally.files_searched,
        buffers_searched: tally.buffers_searched,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::contracts::project_api_bridge::editor::{
        BufferIndexEntry, BufferRange, BufferState, UnbufferedState,
    };
    use crate::project_api::reader::{self, read_disk};
    use std::cell::Cell;
    use std::fs;
    use std::path::PathBuf;
    use std::rc::Rc;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_root(tag: &str) -> PathBuf {
        let stamp = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("litria-api-search-{tag}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(dir).unwrap()
    }

    fn put(root: &Path, path: &str, text: &str) {
        let full = root.join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, text).unwrap();
    }

    fn request(value: serde_json::Value) -> FilesSearchRequest {
        serde_json::from_value(value).unwrap()
    }

    fn query(text: &str) -> FilesSearchRequest {
        request(serde_json::json!({ "query": text }))
    }

    fn budget() -> Budget {
        Budget {
            max_files: MAX_FILES_SCANNED,
            max_entries: MAX_ENTRIES_EXAMINED,
            scan_cap: SCAN_CAP_BYTES,
            ceiling: MAX_RESPONSE_BYTES,
            expired: Box::new(|| false),
            before_enter: None,
        }
    }

    // --- A scripted editor: answers like the JavaScript owner would ---------

    #[derive(Clone)]
    struct Doc {
        path: String,
        state: BufferState,
        dirty: bool,
        text: String,
    }

    fn doc(path: &str, state: &str, text: &str) -> Doc {
        let (state, dirty) = match state {
            "open" => (BufferState::Open, false),
            "openDirty" => (BufferState::Open, true),
            "closedDirty" => (BufferState::ClosedDirty, true),
            other => panic!("unknown state {other}"),
        };
        Doc {
            path: path.into(),
            state,
            dirty,
            text: text.into(),
        }
    }

    fn buffer_revision(text: &str) -> String {
        format!("b1-{}", &reader::disk_revision(text.as_bytes())[3..])
    }

    #[derive(Default)]
    struct Scripted {
        docs: Vec<Doc>,
        omitted: u32,
        index_error: Option<ErrorCode>,
        page_error: Option<ErrorCode>,
        /// Called before each page is answered, with the page number (from 1).
        before_page: Option<Box<dyn FnMut(usize, &mut Vec<Doc>) + Send>>,
        pages: usize,
        /// Every path a page asked for, in order.
        asked: Vec<String>,
        /// Answer with this path instead of the one asked (a misbehaving owner).
        misanswer: bool,
    }

    impl Scripted {
        fn with(docs: Vec<Doc>) -> Self {
            Self {
                docs,
                ..Self::default()
            }
        }
    }

    impl SearchEditor for Scripted {
        fn buffer_index(&mut self) -> Result<BufferIndexResult, ContractError> {
            if let Some(code) = self.index_error {
                return Err(ContractError::new(code, "scripted"));
            }
            let mut entries: Vec<BufferIndexEntry> = self
                .docs
                .iter()
                .map(|doc| BufferIndexEntry {
                    path: doc.path.clone(),
                    state: doc.state,
                    dirty: doc.dirty,
                    revision: buffer_revision(&doc.text),
                    byte_length: doc.text.len() as u32,
                })
                .collect();
            entries.sort_by(|left, right| left.path.cmp(&right.path));
            Ok(BufferIndexResult {
                entries,
                omitted: self.omitted,
            })
        }

        fn page(&mut self, request: &DocumentsRequest) -> Result<DocumentsResult, ContractError> {
            self.pages += 1;
            if let Some(mut hook) = self.before_page.take() {
                hook(self.pages, &mut self.docs);
                self.before_page = Some(hook);
            }
            if let Some(code) = self.page_error {
                return Err(ContractError::new(code, "scripted"));
            }
            let mut text_left = request.max_text_bytes as usize;
            let mut deferring = false;
            let mut documents = Vec::new();
            for (position, query) in request.documents.iter().enumerate() {
                self.asked.push(query.path.clone());
                let path = if self.misanswer {
                    format!("{}x", query.path)
                } else {
                    query.path.clone()
                };
                let Some(found) = self.docs.iter().find(|doc| doc.path == query.path) else {
                    documents.push(DocumentEntry::NotBuffered {
                        path,
                        state: UnbufferedState::None,
                    });
                    continue;
                };
                if deferring {
                    documents.push(DocumentEntry::Deferred { path });
                    continue;
                }
                let budget = (query.max_bytes as usize).min(text_left);
                let slice = reader::slice(&found.text, query.start_line.unwrap_or(1), query.end_line, budget);
                if slice.range.is_none() && slice.truncated && position > 0 {
                    deferring = true;
                    documents.push(DocumentEntry::Deferred { path });
                    continue;
                }
                text_left -= slice.text.len();
                documents.push(DocumentEntry::Buffer {
                    path,
                    state: found.state,
                    dirty: found.dirty,
                    revision: buffer_revision(&found.text),
                    text: slice.text,
                    range: slice.range.map(|(start_line, end_line)| BufferRange { start_line, end_line }),
                    total_lines: slice.total_lines,
                    truncated: slice.truncated,
                    line_cut: slice.line_cut,
                });
            }
            Ok(DocumentsResult { documents })
        }
    }

    fn run(root: &Path, request: &FilesSearchRequest, editor: &mut Scripted) -> FilesSearchResult {
        search(root, request, editor, &mut budget()).unwrap()
    }

    /// `(path, line, column, source)` of every match.
    fn hits(result: &FilesSearchResult) -> Vec<(String, u32, u32, DocumentSource)> {
        result
            .matches
            .iter()
            .map(|found| match found {
                SearchMatch::Text {
                    path,
                    line,
                    column,
                    source,
                    ..
                } => (path.clone(), *line, *column, *source),
                SearchMatch::Path { path, source } => (path.clone(), 0, 0, *source),
            })
            .collect()
    }

    fn hit(path: &str, line: u32, column: u32, source: DocumentSource) -> (String, u32, u32, DocumentSource) {
        (path.into(), line, column, source)
    }

    use DocumentSource::{Disk, Editor};

    // --- Disk ----------------------------------------------------------------

    #[test]
    fn finds_text_in_path_order_with_the_revision_a_read_returns() {
        let root = temp_root("order");
        put(&root, "b.ts", "x\nsignIn();\n");
        put(&root, "a/c.ts", "signIn signIn\n");
        put(&root, "a.ts", "nothing\n");
        let result = run(&root, &query("signIn"), &mut Scripted::default());
        assert_eq!(
            hits(&result),
            [hit("a/c.ts", 1, 1, Disk), hit("a/c.ts", 1, 8, Disk), hit("b.ts", 2, 1, Disk)]
        );
        assert!(!result.truncated, "{:?}", result.truncated_by);
        assert_eq!((result.files_searched, result.buffers_searched), (3, 0));
        for found in &result.matches {
            let SearchMatch::Text { path, revision, preview, .. } = found else { panic!() };
            let DiskRead::Text { revision: read, .. } = read_disk(&root, path) else { panic!() };
            assert_eq!(revision, &read, "{path}: the match's revision is what a read returns");
            assert!(preview.contains("signIn"));
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn denied_paths_never_appear_or_count_on_disk_or_in_buffers() {
        let root = temp_root("denied");
        put(&root, ".env", "SECRET=signIn\n");
        put(&root, "keys/server.pem", "signIn\n");
        put(&root, ".git/config", "signIn\n");
        put(&root, "src/ok.ts", "signIn\n");
        let mut editor = Scripted::with(vec![
            doc(".env", "openDirty", "signIn\n"),
            doc("src/.env.local", "closedDirty", "signIn\n"),
            doc("src/ok.ts", "open", "signIn\n"),
        ]);
        let result = run(&root, &query("signIn"), &mut editor);
        assert_eq!(hits(&result), [hit("src/ok.ts", 1, 1, Editor)]);
        assert_eq!(result.skipped, SkippedCounts::default(), "nothing withheld is counted");
        assert_eq!((result.files_searched, result.buffers_searched), (0, 1));
        assert_eq!(editor.asked, ["src/ok.ts"], "denied buffer text never crosses the bridge");
        assert!(!result.truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn unindexed_directories_are_not_searched() {
        let root = temp_root("unindexed");
        put(&root, "node_modules/pkg/index.js", "signIn\n");
        put(&root, "packages/app/dist/bundle.js", "signIn\n");
        let mut editor = Scripted::with(vec![doc("node_modules/pkg/index.js", "openDirty", "signIn\n")]);
        let result = run(&root, &query("signIn"), &mut editor);
        assert!(result.matches.is_empty());
        assert!(editor.asked.is_empty());
        assert_eq!(result.skipped, SkippedCounts::default());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn links_are_not_followed() {
        let root = temp_root("links");
        let outside = temp_root("links-outside");
        put(&root, "real/a.ts", "signIn\n");
        put(&outside, "b.ts", "signIn\n");
        if !make_dir_link(&root.join("alias"), &root.join("real")) || !make_dir_link(&root.join("out"), &outside) {
            eprintln!("skipped: this host cannot create directory links");
            return;
        }
        let result = run(&root, &query("signIn"), &mut Scripted::default());
        assert_eq!(hits(&result), [hit("real/a.ts", 1, 1, Disk)]);
        remove_dir_link(&root.join("alias"));
        remove_dir_link(&root.join("out"));
        let _ = fs::remove_dir_all(&root);
        let _ = fs::remove_dir_all(&outside);
    }

    #[test]
    fn binary_large_and_non_utf8_files_are_counted_not_searched() {
        let root = temp_root("skipped");
        put(&root, "a.ts", "signIn\n");
        fs::write(root.join("b.bin"), b"signIn\0binary").unwrap();
        fs::write(root.join("c.txt"), b"signIn \xff\xfe").unwrap();
        put(&root, "d.log", &"signIn\n".repeat(10));
        let mut small = budget();
        small.scan_cap = 32;
        let result = search(&root, &query("signIn"), &mut Scripted::default(), &mut small).unwrap();
        assert_eq!(hits(&result), [hit("a.ts", 1, 1, Disk)]);
        assert_eq!((result.skipped.not_text, result.skipped.too_large), (2, 1));
        assert!(!result.truncated, "skips are counted, not truncation");
        let _ = fs::remove_dir_all(&root);
    }

    // --- Matching ------------------------------------------------------------

    #[test]
    fn ascii_case_folding_changes_no_column() {
        let root = temp_root("fold");
        put(&root, "a.txt", "ÄÖü SignIn\n");
        let folded = run(&root, &query("signin"), &mut Scripted::default());
        assert_eq!(hits(&folded), [hit("a.txt", 1, 5, Disk)], "column in code points: Ä Ö ü space S");
        let exact = request(serde_json::json!({ "query": "signin", "caseSensitive": true }));
        assert!(run(&root, &exact, &mut Scripted::default()).matches.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_non_ascii_query_matches_exactly() {
        let root = temp_root("non-ascii");
        put(&root, "a.txt", "ÄÖü\näöü\n");
        assert_eq!(hits(&run(&root, &query("äöü"), &mut Scripted::default())), [hit("a.txt", 2, 1, Disk)]);
        assert_eq!(hits(&run(&root, &query("ÄÖü"), &mut Scripted::default())), [hit("a.txt", 1, 1, Disk)]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn matches_do_not_overlap_and_columns_count_code_points() {
        let needle = Needle::new("aa", true);
        let found = find_all("😀aaaa\r\nxaa", &needle, 1, 10);
        assert_eq!(
            found.iter().map(|hit| (hit.line, hit.column)).collect::<Vec<_>>(),
            [(1, 2), (1, 4), (2, 2)]
        );
        assert_eq!(found[0].preview, "😀aaaa", "no carriage return in a preview");
        assert_eq!(find_all("aaaa", &needle, 7, 1).len(), 1, "the limit holds");
    }

    #[test]
    fn previews_are_clipped_around_the_match() {
        let line = format!("{}signIn{}", "a".repeat(500), "b".repeat(500));
        let found = find_all(&line, &Needle::new("signIn", true), 1, 1);
        let preview = &found[0].preview;
        assert_eq!(preview.chars().count(), PREVIEW_LENGTH);
        assert!(preview.starts_with(&"a".repeat(PREVIEW_BEFORE)) && preview.contains("signIn"));
        // Near the end of a long line, the window reaches back to stay full.
        let tail = format!("{}signIn", "c".repeat(500));
        let found = find_all(&tail, &Needle::new("signIn", true), 1, 1);
        assert_eq!(found[0].preview.chars().count(), PREVIEW_LENGTH);
        assert!(found[0].preview.ends_with("signIn"));
        // Multibyte text is clipped on character boundaries.
        let wide = format!("{}signIn{}", "é".repeat(300), "ü".repeat(300));
        let found = find_all(&wide, &Needle::new("signIn", true), 1, 1);
        assert_eq!(found[0].preview.chars().count(), PREVIEW_LENGTH);
    }

    #[test]
    fn path_search_matches_paths_and_labels_editor_only_documents() {
        let root = temp_root("paths");
        put(&root, "src/SignIn.tsx", "");
        put(&root, "src/other.ts", "signIn");
        put(&root, ".env.signin", "");
        let mut editor = Scripted::with(vec![
            doc("src/signInDraft.ts", "closedDirty", "x"),
            doc("src/other.ts", "open", "x"),
        ]);
        let result = run(&root, &request(serde_json::json!({ "query": "signin", "target": "path" })), &mut editor);
        assert_eq!(hits(&result), [hit("src/SignIn.tsx", 0, 0, Disk), hit("src/signInDraft.ts", 0, 0, Editor)]);
        assert!(editor.asked.is_empty(), "a path search never fetches text");
        assert_eq!((result.files_searched, result.buffers_searched), (1, 2), "other.ts is buffered");
        let _ = fs::remove_dir_all(&root);
    }

    // --- Truncation ----------------------------------------------------------

    #[test]
    fn the_result_limit_keeps_the_first_matches_in_path_order() {
        let root = temp_root("results");
        for name in ["c.ts", "a.ts", "b.ts"] {
            put(&root, name, "hit\n");
        }
        let two = request(serde_json::json!({ "query": "hit", "maxResults": 2 }));
        let result = run(&root, &two, &mut Scripted::default());
        assert_eq!(hits(&result), [hit("a.ts", 1, 1, Disk), hit("b.ts", 1, 1, Disk)]);
        assert_eq!(result.truncated_by, [TruncationReason::Results]);
        // Exactly as many matches as allowed: complete, not truncated.
        let three = request(serde_json::json!({ "query": "hit", "maxResults": 3 }));
        let result = run(&root, &three, &mut Scripted::default());
        assert_eq!(result.matches.len(), 3);
        assert!(!result.truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_files_scanned_limit_truncates() {
        let root = temp_root("files");
        for name in ["a.ts", "b.ts", "c.ts"] {
            put(&root, name, "hit\n");
        }
        let mut small = budget();
        small.max_files = 2;
        let result = search(&root, &query("hit"), &mut Scripted::default(), &mut small).unwrap();
        assert_eq!(hits(&result), [hit("a.ts", 1, 1, Disk), hit("b.ts", 1, 1, Disk)]);
        assert_eq!(result.truncated_by, [TruncationReason::FilesScanned]);
        // The walker's entry budget reports the same way.
        let mut tiny = budget();
        tiny.max_entries = 2;
        let result = search(&root, &query("hit"), &mut Scripted::default(), &mut tiny).unwrap();
        assert_eq!(result.truncated_by, [TruncationReason::FilesScanned]);
        let _ = fs::remove_dir_all(&root);
    }

    fn expiring_after(checks: usize) -> Box<dyn FnMut() -> bool> {
        let count = Rc::new(Cell::new(0usize));
        Box::new(move || {
            count.set(count.get() + 1);
            count.get() > checks
        })
    }

    #[test]
    fn the_time_budget_truncates() {
        let root = temp_root("time");
        for name in ["a.ts", "b.ts", "c.ts"] {
            put(&root, name, "hit\n");
        }
        let mut timed = budget();
        timed.expired = expiring_after(1);
        let result = search(&root, &query("hit"), &mut Scripted::default(), &mut timed).unwrap();
        assert_eq!(hits(&result), [hit("a.ts", 1, 1, Disk)]);
        assert_eq!(result.truncated_by, [TruncationReason::TimeBudget]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn the_encoded_response_ceiling_truncates_and_is_never_exceeded() {
        let root = temp_root("ceiling");
        // Previews of control characters escape to six bytes each.
        let line = format!("hit{}\n", "\u{1}".repeat(190));
        put(&root, "a.ts", &line.repeat(50));
        let mut small = budget();
        small.ceiling = 8 * 1024;
        let wide = request(serde_json::json!({ "query": "hit", "maxResults": 200 }));
        let result = search(&root, &wide, &mut Scripted::default(), &mut small).unwrap();
        assert!(result.truncated_by.contains(&TruncationReason::ResponseSize));
        assert!(!result.matches.is_empty() && result.matches.len() < 50);
        assert!(serde_json::to_vec(&result).unwrap().len() <= small.ceiling);
        let _ = fs::remove_dir_all(&root);
    }

    // --- Buffer coverage -----------------------------------------------------

    #[test]
    fn the_editors_text_wins_for_documents_it_holds() {
        let root = temp_root("buffers-win");
        put(&root, "a.ts", "saved hit\n");
        put(&root, "b.ts", "hit\n");
        let mut editor = Scripted::with(vec![doc("a.ts", "openDirty", "unsaved\nhit\n")]);
        let result = run(&root, &query("hit"), &mut editor);
        assert_eq!(hits(&result), [hit("a.ts", 2, 1, Editor), hit("b.ts", 1, 1, Disk)]);
        let saved = run(&root, &query("saved"), &mut Scripted::with(vec![doc("a.ts", "openDirty", "edited\n")]));
        assert!(saved.matches.is_empty(), "a buffered document is never searched on disk");
        // A clean open buffer is the editor's text too.
        let clean = run(&root, &query("hit"), &mut Scripted::with(vec![doc("b.ts", "open", "hit\n")]));
        assert_eq!(hits(&clean)[1], hit("b.ts", 1, 1, Editor));
        let _ = fs::remove_dir_all(&root);
    }

    /// P4 gate item 1: files a `.gitignore` excludes are skipped and counted,
    /// so a search over them is never silently clean; `includeIgnored` brings
    /// them back. A document open in the editor is searched either way.
    #[test]
    fn gitignored_files_are_skipped_and_counted_unless_included() {
        let root = temp_root("gitignore");
        put(&root, ".gitignore", "generated/\n*.log\n");
        put(&root, "src/a.ts", "needle\n");
        put(&root, "trace.log", "needle\n");
        put(&root, "generated/out.js", "needle\n");
        put(&root, "generated/more.js", "needle\n");

        let default = run(&root, &query("needle"), &mut Scripted::default());
        assert_eq!(hits(&default), [hit("src/a.ts", 1, 1, Disk)]);
        assert_eq!((default.skipped.ignored_files, default.skipped.ignored_directories), (1, 1));
        assert!(!default.truncated, "skipping ignored files is not truncation: {:?}", default.truncated_by);

        let included = run(
            &root,
            &request(serde_json::json!({ "query": "needle", "includeIgnored": true })),
            &mut Scripted::default(),
        );
        assert_eq!(
            hits(&included),
            [
                hit("generated/more.js", 1, 1, Disk),
                hit("generated/out.js", 1, 1, Disk),
                hit("src/a.ts", 1, 1, Disk),
                hit("trace.log", 1, 1, Disk),
            ]
        );
        assert_eq!((included.skipped.ignored_files, included.skipped.ignored_directories), (0, 0));

        let mut editor = Scripted::with(vec![doc("trace.log", "openDirty", "needle in the buffer\n")]);
        let open = run(&root, &query("needle"), &mut editor);
        assert_eq!(hits(&open), [hit("src/a.ts", 1, 1, Disk), hit("trace.log", 1, 1, Editor)]);
        let _ = fs::remove_dir_all(&root);
    }

    /// P4 gate item 6: the editor holds a buffer under a case variant of the
    /// file's name. On a case-insensitive volume (Windows, default macOS) the
    /// variant names the same file, so the document is searched once, in its
    /// buffer, under the name on disk — its disk text never. On a
    /// case-sensitive volume (Linux) the variant is a different document. Each
    /// OS asserts the volume kind it expects, so neither branch can pass by
    /// skipping (the case test in files_read used to return early silently).
    #[test]
    fn a_case_variant_buffer_is_the_same_document_only_on_a_case_insensitive_volume() {
        let root = temp_root("case-variant");
        put(&root, "Readme.md", "disk-only\n");
        let insensitive = root.join("README.MD").exists();
        #[cfg(any(windows, target_os = "macos"))]
        assert!(insensitive, "expected a case-insensitive volume on this OS");
        #[cfg(target_os = "linux")]
        assert!(!insensitive, "expected a case-sensitive volume on this OS");
        let mut editor = Scripted::with(vec![doc("README.MD", "openDirty", "buffer-only\n")]);

        let in_buffer = run(&root, &query("buffer-only"), &mut editor);
        let on_disk = run(&root, &query("disk-only"), &mut editor);

        if insensitive {
            assert_eq!(hits(&in_buffer), [hit("Readme.md", 1, 1, Editor)]);
            assert!(hits(&on_disk).is_empty(), "the disk copy of a buffered document was searched");
            assert_eq!((in_buffer.files_searched, in_buffer.buffers_searched), (0, 1));
        } else {
            assert_eq!(hits(&in_buffer), [hit("README.MD", 1, 1, Editor)]);
            assert_eq!(hits(&on_disk), [hit("Readme.md", 1, 1, Disk)]);
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_dirty_buffer_whose_file_was_deleted_is_searched_in_the_editor() {
        let root = temp_root("buffer-only");
        let mut editor = Scripted::with(vec![doc("gone/draft.ts", "closedDirty", "x\nhit\n")]);
        let result = run(&root, &query("hit"), &mut editor);
        assert_eq!(hits(&result), [hit("gone/draft.ts", 2, 1, Editor)]);
        let SearchMatch::Text { revision, .. } = &result.matches[0] else { panic!() };
        assert_eq!(revision, &buffer_revision("x\nhit\n"), "the buffer's own revision");
        assert!(!result.truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_dirty_buffer_over_the_scan_cap_is_too_large_and_never_searched_on_disk() {
        let root = temp_root("buffer-cap");
        put(&root, "a.ts", "hit\n");
        let mut editor = Scripted::with(vec![doc("a.ts", "openDirty", &"hit\n".repeat(10))]);
        let mut small = budget();
        small.scan_cap = 16;
        let result = search(&root, &query("hit"), &mut editor, &mut small).unwrap();
        assert!(result.matches.is_empty());
        assert_eq!(result.skipped.too_large, 1);
        assert!(editor.asked.is_empty(), "its text is never fetched");
        assert!(!result.truncated, "too large is a rule, not a coverage gap");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_index_over_its_limit_reports_buffer_coverage_without_counting() {
        let root = temp_root("index-overflow");
        put(&root, "a.ts", "hit\n");
        let mut editor = Scripted::with(vec![doc("b.ts", "openDirty", "hit\n")]);
        editor.omitted = 3;
        let result = run(&root, &query("hit"), &mut editor);
        assert_eq!(hits(&result), [hit("a.ts", 1, 1, Disk), hit("b.ts", 1, 1, Editor)]);
        assert_eq!(result.truncated_by, [TruncationReason::BufferCoverage]);
        assert_eq!(result.skipped.buffers_not_searched, 0, "unlisted buffers could be withheld ones");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_failed_page_reports_buffer_coverage_and_never_falls_back_to_disk() {
        let root = temp_root("page-failure");
        put(&root, "a.ts", "hit\n");
        put(&root, "b.ts", "hit\n");
        let mut editor = Scripted::with(vec![doc("a.ts", "openDirty", "hit\n"), doc("b.ts", "openDirty", "hit\n")]);
        editor.page_error = Some(ErrorCode::OwnerTimeout);
        let result = run(&root, &query("hit"), &mut editor);
        assert!(result.matches.is_empty(), "disk is stale for exactly these documents");
        assert_eq!(result.skipped.buffers_not_searched, 2);
        assert_eq!(result.truncated_by, [TruncationReason::BufferCoverage]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_time_budget_expiring_mid_buffers_reports_the_buffers_not_searched() {
        let root = temp_root("time-buffers");
        let mut editor = Scripted::with(vec![
            doc("a.ts", "openDirty", "hit\n"),
            doc("b.ts", "openDirty", "hit\n"),
            doc("c.ts", "closedDirty", "hit\n"),
        ]);
        let mut timed = budget();
        // The first visit's check, then the first page's check: b and c were
        // prefetched with a but are never reached.
        timed.expired = expiring_after(2);
        let result = search(&root, &query("hit"), &mut editor, &mut timed).unwrap();
        assert_eq!(hits(&result), [hit("a.ts", 1, 1, Editor)]);
        assert_eq!(result.skipped.buffers_not_searched, 2);
        assert_eq!(result.truncated_by, [TruncationReason::TimeBudget, TruncationReason::BufferCoverage]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_large_buffer_is_searched_across_chunks_with_its_own_line_numbers() {
        let root = temp_root("chunks");
        let text = format!("{}hit\n", "x\n".repeat(150_000)); // ~300 KiB: two chunks
        let mut editor = Scripted::with(vec![doc("big.ts", "openDirty", &text)]);
        let result = run(&root, &query("hit"), &mut editor);
        assert_eq!(hits(&result), [hit("big.ts", 150_001, 1, Editor)]);
        assert!(editor.pages >= 2);
        assert!(!result.truncated);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_buffer_edited_between_chunks_is_not_searched() {
        let root = temp_root("chunks-edited");
        let text = format!("hit\n{}", "x\n".repeat(150_000));
        let mut editor = Scripted::with(vec![doc("big.ts", "openDirty", &text)]);
        editor.before_page = Some(Box::new(|page, docs| {
            if page == 2 {
                docs[0].text.push_str("typed\n");
            }
        }));
        let result = run(&root, &query("hit"), &mut editor);
        assert!(result.matches.is_empty(), "the first chunk's match is from a text that no longer exists");
        assert_eq!(result.skipped.buffers_not_searched, 1);
        assert_eq!(result.truncated_by, [TruncationReason::BufferCoverage]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_buffer_line_longer_than_a_chunk_is_too_large() {
        let root = temp_root("long-line");
        let text = format!("{}hit", "x".repeat(300 * 1024));
        let mut editor = Scripted::with(vec![doc("min.js", "open", &text)]);
        let result = run(&root, &query("hit"), &mut editor);
        assert!(result.matches.is_empty());
        assert_eq!(result.skipped.too_large, 1);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_buffer_the_editor_let_go_of_is_read_from_disk() {
        let root = temp_root("let-go");
        put(&root, "a.ts", "hit on disk\n");
        let mut editor = Scripted::with(vec![doc("a.ts", "openDirty", "nothing\n")]);
        editor.before_page = Some(Box::new(|_, docs| docs.clear())); // saved and closed meanwhile
        let result = run(&root, &query("hit"), &mut editor);
        assert_eq!(hits(&result), [hit("a.ts", 1, 1, Disk)]);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_search_is_complete_only_when_every_buffer_was_searched() {
        let root = temp_root("complete");
        put(&root, "a.ts", "hit\n");
        let mut editor = Scripted::with(vec![doc("b.ts", "openDirty", "hit\n"), doc("c.ts", "open", "hit\n")]);
        let result = run(&root, &query("hit"), &mut editor);
        assert!(!result.truncated);
        assert_eq!(result.buffers_searched, 2);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn an_editor_that_cannot_answer_fails_the_search() {
        let root = temp_root("unavailable");
        put(&root, "a.ts", "hit\n");
        for code in [ErrorCode::OwnerUnavailable, ErrorCode::OwnerTimeout] {
            let mut editor = Scripted::default();
            editor.index_error = Some(code);
            let error = search(&root, &query("hit"), &mut editor, &mut budget()).unwrap_err();
            assert_eq!(error.code, code, "never a silent search of disk alone");
        }
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_workspace_switch_while_fetching_fails_the_search() {
        let root = temp_root("switch");
        let mut editor = Scripted::with(vec![doc("a.ts", "openDirty", "hit\n")]);
        editor.page_error = Some(ErrorCode::WorkspaceChanged);
        let error = search(&root, &query("hit"), &mut editor, &mut budget()).unwrap_err();
        assert_eq!(error.code, ErrorCode::WorkspaceChanged);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn a_page_that_misanswers_fails_the_search() {
        let root = temp_root("misanswer");
        let mut editor = Scripted::with(vec![doc("a.ts", "openDirty", "hit\n")]);
        editor.misanswer = true;
        let error = search(&root, &query("hit"), &mut editor, &mut budget()).unwrap_err();
        assert_eq!(error.code, ErrorCode::Internal);
        let _ = fs::remove_dir_all(&root);
    }

    // --- Prefix --------------------------------------------------------------

    fn scope_of(root: &Path, prefix: &str, editor: &mut Scripted) -> (SearchScope, usize) {
        let request = request(serde_json::json!({ "query": "hit", "pathPrefix": prefix }));
        let result = run(root, &request, editor);
        (result.scope, result.matches.len())
    }

    #[test]
    fn a_prefix_restricts_the_search_and_reports_its_scope() {
        let root = temp_root("prefix");
        put(&root, "src/a.ts", "hit\n");
        put(&root, "src/lib/b.ts", "hit\n");
        put(&root, "srcx/c.ts", "hit\n");
        put(&root, ".env", "hit\n");
        let none = &mut Scripted::default;
        assert_eq!(scope_of(&root, "src", &mut none()), (SearchScope::Prefix, 2));
        assert_eq!(scope_of(&root, "src/lib/b.ts", &mut none()), (SearchScope::Prefix, 1));
        assert_eq!(scope_of(&root, "nope", &mut none()), (SearchScope::PrefixNotFound, 0));
        assert_eq!(scope_of(&root, "../outside", &mut none()), (SearchScope::PrefixInvalid, 0));
        assert_eq!(scope_of(&root, "node_modules/pkg", &mut none()), (SearchScope::PrefixUnindexed, 0));
        // Denied by name, whether or not it exists: no existence oracle.
        assert_eq!(scope_of(&root, ".env", &mut none()), (SearchScope::PrefixDenied, 0));
        assert_eq!(scope_of(&root, ".ssh/none", &mut none()), (SearchScope::PrefixDenied, 0));
        // A buffer-only document makes its prefix real.
        let mut editor = Scripted::with(vec![doc("drafts/new.ts", "closedDirty", "hit\n")]);
        assert_eq!(scope_of(&root, "drafts", &mut editor), (SearchScope::Prefix, 1));
        // Buffers outside the prefix are neither searched nor counted.
        let mut editor = Scripted::with(vec![doc("srcx/c.ts", "openDirty", "hit\n")]);
        assert_eq!(scope_of(&root, "src", &mut editor), (SearchScope::Prefix, 2));
        assert!(editor.asked.is_empty());
        let _ = fs::remove_dir_all(&root);
    }

    // --- Concurrency and the bridge -----------------------------------------

    #[test]
    fn a_third_concurrent_search_is_busy() {
        let searches = Searches::new(MAX_CONCURRENT_SEARCHES);
        let first = searches.acquire().unwrap();
        let _second = searches.acquire().unwrap();
        let error = searches.acquire().err().expect("the third is refused");
        assert_eq!(error.code, ErrorCode::Busy);
        drop(first);
        drop(searches.acquire().expect("a finished search frees its slot"));
    }

    #[test]
    fn searches_through_the_bridge_and_a_following_read_sees_the_same_revision() {
        use crate::contracts::context::{Grant, Principal};
        use crate::contracts::project_api::files_read::FilesReadRequest;
        use crate::db;
        use crate::project_api::bridge::testing::answering;
        use crate::project_api::files_read;

        let _serial = db::serial_guard();
        let root = temp_root("bridge");
        put(&root, "a.ts", "saved\n");
        put(&root, "b.ts", "hit on disk\n");
        let (_ro, epoch) = db::open_workspace_db(&root).unwrap();
        let bridge: &'static Bridge = Box::leak(Box::new(Bridge::new(Duration::from_secs(5))));
        let owner = std::sync::Mutex::new(Scripted::with(vec![doc("a.ts", "openDirty", "unsaved hit\n")]));
        answering(bridge, move |event| {
            let mut owner = owner.lock().unwrap();
            let result = match event.op.as_str() {
                "editor.bufferIndex" => serde_json::to_value(index_json(owner.buffer_index().unwrap())).unwrap(),
                "editor.documents" => {
                    let request: DocumentsRequest = documents_request(&event.request);
                    serde_json::to_value(documents_json(owner.page(&request).unwrap())).unwrap()
                }
                other => panic!("unexpected {other}"),
            };
            Some(serde_json::json!({ "kind": "result", "result": result }).to_string())
        });
        let context = CallContext {
            principal: Principal::Test,
            grant: Grant::default(),
            epoch: epoch.clone(),
        };
        let searches = Searches::new(MAX_CONCURRENT_SEARCHES);
        let error = handle_with(&context, query("hit"), bridge, &searches).unwrap_err();
        assert_eq!(error.code, ErrorCode::OwnerUnavailable, "not attached yet: never a disk-only search");

        bridge.attach(&epoch, Some(&epoch)).unwrap();
        let result = handle_with(&context, query("hit"), bridge, &searches).unwrap();
        assert_eq!(hits(&result), [hit("a.ts", 1, 9, Editor), hit("b.ts", 1, 1, Disk)]);

        let read: FilesReadRequest =
            serde_json::from_value(serde_json::json!({ "documents": [{ "path": "a.ts" }, { "path": "b.ts" }] })).unwrap();
        let read = serde_json::to_value(files_read::handle_with(&context, read, bridge).unwrap()).unwrap();
        for (index, found) in result.matches.iter().enumerate() {
            let SearchMatch::Text { revision, .. } = found else { panic!() };
            assert_eq!(read["documents"][index]["revision"], revision.as_str(), "match {index}");
        }
        db::close_workspace_db().unwrap();
        let _ = fs::remove_dir_all(&root);
    }

    // The bridge carries JSON: these mirror the reply shapes the owner sends.
    fn index_json(index: BufferIndexResult) -> serde_json::Value {
        serde_json::json!({
            "entries": index.entries.iter().map(|entry| serde_json::json!({
                "path": entry.path,
                "state": if entry.state == BufferState::Open { "open" } else { "closedDirty" },
                "dirty": entry.dirty, "revision": entry.revision, "byteLength": entry.byte_length,
            })).collect::<Vec<_>>(),
            "omitted": index.omitted,
        })
    }

    fn documents_request(value: &serde_json::Value) -> DocumentsRequest {
        DocumentsRequest {
            documents: value["documents"]
                .as_array()
                .unwrap()
                .iter()
                .map(|query| DocumentQuery {
                    path: query["path"].as_str().unwrap().to_owned(),
                    start_line: query["startLine"].as_u64().map(|line| line as u32),
                    end_line: query["endLine"].as_u64().map(|line| line as u32),
                    max_bytes: query["maxBytes"].as_u64().unwrap() as u32,
                })
                .collect(),
            max_text_bytes: value["maxTextBytes"].as_u64().unwrap() as u32,
        }
    }

    fn documents_json(result: DocumentsResult) -> serde_json::Value {
        serde_json::json!({
            "documents": result.documents.into_iter().map(|entry| match entry {
                DocumentEntry::NotBuffered { path, .. } => serde_json::json!({ "kind": "notBuffered", "path": path, "state": "none" }),
                DocumentEntry::Deferred { path } => serde_json::json!({ "kind": "deferred", "path": path }),
                DocumentEntry::Buffer { path, state, dirty, revision, text, range, total_lines, truncated, line_cut } => {
                    let mut value = serde_json::json!({
                        "kind": "buffer", "path": path,
                        "state": if state == BufferState::Open { "open" } else { "closedDirty" },
                        "dirty": dirty, "revision": revision, "text": text,
                        "totalLines": total_lines, "truncated": truncated, "lineCut": line_cut,
                    });
                    if let Some(range) = range {
                        value["range"] = serde_json::json!({ "startLine": range.start_line, "endLine": range.end_line });
                    }
                    value
                }
            }).collect::<Vec<_>>(),
        })
    }

    /// Budget measurements for the contract brief §10 (build plan P3). Not a
    /// check: run on demand against a real tree, in a debug and a release
    /// build:
    ///   LITRIA_MEASURE_ROOT=<dir> cargo test [--release] measure_search -- --ignored --nocapture
    #[test]
    #[ignore = "a measurement, run on demand with LITRIA_MEASURE_ROOT"]
    fn measure_search() {
        let Ok(root) = std::env::var("LITRIA_MEASURE_ROOT") else {
            eprintln!("set LITRIA_MEASURE_ROOT to a directory to measure");
            return;
        };
        let root = fs::canonicalize(root).unwrap();
        let cases = [
            ("common word, text", serde_json::json!({ "query": "the", "maxResults": 200 })),
            ("rare word, text (full walk)", serde_json::json!({ "query": "zq_never_present_xj" })),
            ("rare word, case-sensitive", serde_json::json!({ "query": "zq_never_present_xj", "caseSensitive": true })),
            ("path, common", serde_json::json!({ "query": "test", "target": "path", "maxResults": 200 })),
            ("path, rare (full walk)", serde_json::json!({ "query": "zq_never_present_xj", "target": "path" })),
        ];
        for (label, value) in cases {
            let started = Instant::now();
            let result = search(&root, &request(value), &mut Scripted::default(), &mut Budget::standard()).unwrap();
            let elapsed = started.elapsed();
            let bytes = serde_json::to_vec(&result).unwrap().len();
            println!(
                "MEASURE | {label} | {} ms | {bytes} B | {} matches | truncatedBy {:?} | files {} | skipped {:?}",
                elapsed.as_millis(),
                result.matches.len(),
                result.truncated_by,
                result.files_searched,
                result.skipped,
            );
        }
    }

    // --- Adversarial pass (P3): reproductions ---------------------------------

    /// F2: a directory swapped for a link between being listed and being
    /// entered. The walker then lists the link's TARGET under the allowed
    /// name; a path search reports names without reading the files, so the
    /// names inside a withheld or outside directory must still never surface.
    #[test]
    fn a_directory_swapped_for_a_link_mid_walk_discloses_no_names() {
        for (tag, target_is_outside) in [("swap-denied", false), ("swap-outside", true)] {
            let root = temp_root(tag);
            let outside = temp_root(&format!("{tag}-outside"));
            put(&root, "src/a.ts", "x\n");
            put(&root, ".git/HEAD", "ref: refs/heads/secret-branch\n");
            put(&outside, "HEAD-outside.txt", "outside\n");
            let target = if target_is_outside { outside.clone() } else { root.join(".git") };
            let probe = root.join("probe");
            if !make_dir_link(&probe, &target) {
                eprintln!("skipped: this host cannot create directory links");
                return;
            }
            remove_dir_link(&probe);
            let (swap_root, swap_target) = (root.clone(), target.clone());
            let mut swapping = budget();
            swapping.before_enter = Some(Box::new(move |path: &str| {
                if path == "src" {
                    fs::rename(swap_root.join("src"), swap_root.join("src-real")).unwrap();
                    assert!(make_dir_link(&swap_root.join("src"), &swap_target));
                }
            }));
            let paths = request(serde_json::json!({ "query": "HEAD", "target": "path" }));
            let result = search(&root, &paths, &mut Scripted::default(), &mut swapping).unwrap();
            assert!(result.matches.is_empty(), "{tag}: names leaked: {:?}", hits(&result));
            assert_eq!(result.skipped, SkippedCounts::default(), "{tag}: nothing withheld is counted");
            remove_dir_link(&root.join("src"));
            let _ = fs::remove_dir_all(&root);
            let _ = fs::remove_dir_all(&outside);
        }
    }

    /// F3: a name the API cannot address that the policy denies by name
    /// (`.env.` — Windows strips the dot, so it would open `.env`) must not be
    /// counted: denied paths are never counted.
    #[test]
    fn a_denied_name_the_api_cannot_address_is_not_counted() {
        let root = temp_root("denied-invalid");
        put(&root, "a.ts", "hit\n");
        // The verbatim (\\?\) root keeps a trailing dot or space on Windows.
        for name in [".env.", "id_rsa ", "server.pem."] {
            fs::write(root.join(name), "hit\n").unwrap();
        }
        let listed = fs::read_dir(&root).unwrap().count();
        assert_eq!(listed, 4, "the odd names exist on this platform");
        let result = run(&root, &query("hit"), &mut Scripted::default());
        assert_eq!(hits(&result), [hit("a.ts", 1, 1, Disk)]);
        assert_eq!(result.skipped, SkippedCounts::default(), "a denied name is never counted");
        let _ = fs::remove_dir_all(&root);
    }

    /// F4: the editor holds a buffer under a name that resolves through a
    /// link whose target is gone (it was a withheld file when the buffer was
    /// opened). The name cannot be resolved, so it cannot be judged by what it
    /// names: it is withheld, never searched as if it were its own file.
    #[test]
    fn a_buffer_behind_a_dangling_link_is_withheld() {
        let root = temp_root("dangling");
        put(&root, ".ssh/config", "Host secret\n");
        if !make_dir_link(&root.join("cfg"), &root.join(".ssh")) {
            eprintln!("skipped: this host cannot create directory links");
            return;
        }
        fs::remove_dir_all(root.join(".ssh")).unwrap(); // the link now dangles
        let mut editor = Scripted::with(vec![doc("cfg/config", "closedDirty", "Host secret\n")]);
        let result = run(&root, &query("secret"), &mut editor);
        assert!(result.matches.is_empty(), "leaked: {:?}", hits(&result));
        assert!(editor.asked.is_empty(), "its text never crosses the bridge");
        assert_eq!(result.buffers_searched, 0);
        remove_dir_link(&root.join("cfg"));
        let _ = fs::remove_dir_all(&root);
    }

    #[cfg(windows)]
    fn make_dir_link(link: &Path, target: &Path) -> bool {
        std::process::Command::new("cmd")
            .args(["/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()
            .is_ok_and(|output| output.status.success())
    }

    #[cfg(unix)]
    fn make_dir_link(link: &Path, target: &Path) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    fn remove_dir_link(link: &Path) {
        #[cfg(windows)]
        let _ = fs::remove_dir(link);
        #[cfg(unix)]
        let _ = fs::remove_file(link);
    }
}
