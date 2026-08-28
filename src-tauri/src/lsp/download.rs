//! Verified-artifact download manager (ADR-005 §1-§2, Slice 4).
//!
//! Staged install pipeline: download to `servers/.staging/` → **verify
//! SHA-256 before extraction** → extract into the version-stamped dir →
//! write receipt → activate. Failure at any step cleans staging and leaves
//! any previous version untouched and running (Windows lock safety: a new
//! version installs beside — never over — a possibly-running one).
//!
//! Directory layout (ADR §1 — `app_data_dir()`, NOT `~/.litria/`):
//!   `app_data_dir()/servers/<server_id>/<version>/...`      artifacts
//!   `app_data_dir()/servers/<server_id>/installed.json`     receipt
//!   `app_data_dir()/servers/.staging/`                      downloads
//!
//! Synchronous by design (`ureq`) — the LSP stack is tokio-free; commands
//! wrap calls in `spawn_blocking`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::errors::{CommandError, CommandResult};
use crate::lsp::registry;

const RECEIPT_FILE: &str = "installed.json";
const RECEIPT_SCHEMA: u32 = 1;
/// Progress events are throttled to roughly this interval.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(150);

/// Hard ceiling on a single artifact download (audit #13). The largest current
/// managed artifact (clangd) is ~50 MiB; this bounds a compromised or redirected
/// endpoint's ability to fill the disk before the SHA-256 check (which runs only
/// after the whole file lands) can reject it.
const MAX_ARTIFACT_BYTES: u64 = 512 * 1024 * 1024;

fn exceeds_size_cap(received: u64) -> bool {
    received > MAX_ARTIFACT_BYTES
}

/// Custom (unverified) install URLs still must use HTTPS (audit #14). Their
/// integrity is unverifiable without a pinned SHA — that is the consent UI's
/// warning — but a cleartext transport is refused outright so the download can't
/// be silently MITM'd.
fn require_https_custom_url(url: &str) -> CommandResult<()> {
    if url.starts_with("https://") {
        Ok(())
    } else {
        Err(CommandError::invalid_path(
            "lsp.install.custom_url_insecure",
            "Custom language-server URLs must use https:// so the transport is encrypted.",
        ))
    }
}

/// The one HTTP client for artifact downloads — never a bare `ureq::get`.
///
/// `https_only(true)` is the load-bearing setting. `require_https_custom_url`
/// above only checks the URL the caller typed; ureq's default config then
/// follows up to 10 redirects with https-only OFF, so an https endpoint could
/// bounce the download to cleartext http and walk straight around the check
/// that audit #14 accepted as the custom-URL mitigation. ureq re-tests the
/// scheme on every redirect hop (`call_run`), so setting it here refuses a
/// downgrade anywhere in the chain, not just on the first request.
///
/// Residual risk this does NOT cover: a custom URL still has no SHA pin (ADR
/// §8, by design — the consent UI carries that warning), so an https endpoint
/// the user chose to trust can still serve whatever it likes.
fn download_agent() -> ureq::Agent {
    ureq::Agent::new_with_config(ureq::Agent::config_builder().https_only(true).build())
}

// ---------------------------------------------------------------------------
// Receipts (ADR §1)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct ReceiptFile {
    pub schema: u32,
    /// The active version — selects which version-stamped dir resolves.
    pub current: String,
    /// version → install record (older versions linger until GC'd).
    pub installs: HashMap<String, InstallRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallRecord {
    /// "managed" (registry, verified) or "custom" (user URL, unverified).
    pub kind: String,
    pub url: String,
    /// SHA-256 actually computed over the downloaded bytes.
    pub sha256: String,
    pub version: String,
    pub installed_at: String,
    /// Binary path relative to the version dir.
    pub binary: String,
    /// SHA-256 of the extracted binary at install time (Slice 7 re-verify
    /// baseline). Optional: receipts written before the field existed have
    /// nothing to compare against and re-verify reports "unrecorded".
    #[serde(default)]
    pub binary_sha256: Option<String>,
}

fn receipt_path(servers_root: &Path, server_id: &str) -> PathBuf {
    servers_root.join(server_id).join(RECEIPT_FILE)
}

fn load_receipt(servers_root: &Path, server_id: &str) -> Option<ReceiptFile> {
    let text = std::fs::read_to_string(receipt_path(servers_root, server_id)).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_receipt(
    servers_root: &Path,
    server_id: &str,
    receipt: &ReceiptFile,
) -> Result<(), String> {
    let path = receipt_path(servers_root, server_id);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("creating {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(receipt)
        .map_err(|e| format!("serializing receipt: {e}"))?;
    crate::write_ops::atomic_write_string(&path, &json)
}

/// The active managed binary for a registry language, if a receipt selects
/// one and the file is still on disk. Pure with respect to `servers_root`
/// so the resolver's managed tier is testable without an AppHandle.
pub(crate) fn managed_binary_for_language(
    servers_root: &Path,
    language_id: &str,
) -> Option<PathBuf> {
    let entry = registry::get_language_entry(language_id)?;
    let receipt = load_receipt(servers_root, &entry.server)?;
    let record = receipt.installs.get(&receipt.current)?;
    let binary = servers_root
        .join(&entry.server)
        .join(&receipt.current)
        .join(&record.binary);
    binary.exists().then_some(binary)
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// SHA-256 of a file on disk, lowercase hex. Downloads hash in flight; this
/// standalone form records the install-time binary baseline and answers the
/// Slice 7 re-verify surface.
pub(crate) fn file_sha256(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("opening {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("reading: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(to_hex(&hasher.finalize()))
}

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

static CANCEL_FLAGS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancel_flag(server_id: &str) -> Arc<AtomicBool> {
    let map = CANCEL_FLAGS.get_or_init(|| Mutex::new(HashMap::new()));
    map.lock()
        .unwrap()
        .entry(server_id.to_string())
        .or_insert_with(|| Arc::new(AtomicBool::new(false)))
        .clone()
}

/// Request cancellation of an in-flight install for this server.
pub(crate) fn cancel_install(server_id: &str) {
    cancel_flag(server_id).store(true, Ordering::Relaxed);
}

// ---------------------------------------------------------------------------
// Download (streamed, hashed in flight, progress-evented)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgress<'a> {
    server_id: &'a str,
    received_bytes: u64,
    total_bytes: Option<u64>,
}

fn download_to(
    app: &AppHandle,
    server_id: &str,
    url: &str,
    dest: &Path,
    cancel: &AtomicBool,
) -> Result<String, String> {
    let mut response = download_agent()
        .get(url)
        .call()
        .map_err(|e| format!("download failed ({e}) — check your connection and retry"))?;

    let total_bytes: Option<u64> = response
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok());

    // Early reject when the server advertises an over-cap size (audit #13);
    // the in-loop guard below is the authoritative enforcement — content-length
    // is advisory and can lie or be absent.
    if let Some(total) = total_bytes {
        if exceeds_size_cap(total) {
            return Err(format!(
                "artifact reports {} MiB, over the {} MiB limit — refusing to download",
                total / (1024 * 1024),
                MAX_ARTIFACT_BYTES / (1024 * 1024)
            ));
        }
    }

    let mut reader = response.body_mut().as_reader();
    let mut out = std::fs::File::create(dest)
        .map_err(|e| format!("creating {}: {e}", dest.display()))?;

    let mut hasher = Sha256::new();
    let mut received: u64 = 0;
    let mut last_emit = Instant::now();
    let mut buf = [0u8; 64 * 1024];

    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("install cancelled".into());
        }
        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("download interrupted ({e}) — retry when back online"))?;
        if n == 0 {
            break;
        }
        out.write_all(&buf[..n])
            .map_err(|e| format!("writing download ({e}) — check free disk space"))?;
        hasher.update(&buf[..n]);
        received += n as u64;

        // Authoritative size enforcement (audit #13): bound actual bytes
        // written regardless of a missing/false content-length. The caller
        // cleans the staging file on any error return.
        if exceeds_size_cap(received) {
            return Err(format!(
                "download exceeded the {} MiB size limit — aborting",
                MAX_ARTIFACT_BYTES / (1024 * 1024)
            ));
        }

        if last_emit.elapsed() >= PROGRESS_INTERVAL {
            last_emit = Instant::now();
            let _ = app.emit(
                "lsp:download-progress",
                DownloadProgress {
                    server_id,
                    received_bytes: received,
                    total_bytes,
                },
            );
        }
    }
    out.flush().map_err(|e| format!("flushing download: {e}"))?;
    Ok(to_hex(&hasher.finalize()))
}

// ---------------------------------------------------------------------------
// Extraction (verify happened FIRST — callers enforce the order)
// ---------------------------------------------------------------------------

/// Ceiling on what one artifact may expand to. `MAX_ARTIFACT_BYTES` caps the
/// *compressed* download and bounds nothing about disk: deflate reaches ~1000:1
/// on crafted input, so a well-behaved 10 MiB download can still ask for
/// hundreds of GiB on extraction. clangd, the largest real artifact, expands to
/// a few hundred MiB, so this leaves ample headroom.
const MAX_EXPANDED_BYTES: u64 = 1024 * 1024 * 1024;

/// Ceiling on archive entries. A "many tiny files" archive exhausts inodes and
/// directory space long before it troubles a byte budget.
const MAX_ARCHIVE_ENTRIES: usize = 50_000;

/// A reader that fails once it has produced more than `limit` bytes.
///
/// Deliberately not `Read::take`, which reports a clean EOF at the limit: gzip
/// and tar would read that as a truncated-but-complete stream and we would
/// install a silently half-extracted server. An error is the only honest
/// outcome, and it propagates to the caller that removes the partial directory.
struct BoundedRead<R> {
    inner: R,
    limit: u64,
    seen: u64,
}

impl<R: Read> BoundedRead<R> {
    fn new(inner: R, limit: u64) -> Self {
        Self {
            inner,
            limit,
            seen: 0,
        }
    }
}

impl<R: Read> Read for BoundedRead<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.seen += n as u64;
        if self.seen > self.limit {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!(
                    "archive expands past the {} MiB limit",
                    self.limit / (1024 * 1024)
                ),
            ));
        }
        Ok(n)
    }
}

/// Decompress every zip entry to a sink — no disk writes — purely to learn what
/// the archive ACTUALLY expands to before a single byte lands.
///
/// The entries' declared uncompressed sizes cannot be used for this: zip 2.4.2
/// bounds an entry reader with `.take(compressed_size)` (`read.rs:347`), so the
/// declared uncompressed size is never enforced during extraction and a crafted
/// archive is free to under-report it.
///
/// Measuring first, then calling the crate's own `extract`, keeps zip-slip
/// protection, symlink handling, and the unix-mode pass exactly as audited
/// (2026-07-16) rather than re-implementing them around a byte counter. The
/// cost is decompressing twice; for a legitimate artifact that is well under a
/// second, and a bomb is abandoned as soon as it crosses the budget.
fn ensure_zip_expansion_is_bounded(archive: &Path) -> Result<(), String> {
    ensure_zip_expansion_within(archive, MAX_EXPANDED_BYTES, MAX_ARCHIVE_ENTRIES)
}

/// Limits are parameters so tests can prove the refusal with a small archive
/// instead of manufacturing a real gigabyte.
fn ensure_zip_expansion_within(
    archive: &Path,
    max_bytes: u64,
    max_entries: usize,
) -> Result<(), String> {
    let file = std::fs::File::open(archive).map_err(|e| format!("opening archive: {e}"))?;
    let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("reading zip: {e}"))?;

    if zip.len() > max_entries {
        return Err(format!(
            "archive declares {} entries, over the {max_entries} limit — refusing to extract",
            zip.len()
        ));
    }

    let mut total: u64 = 0;
    for i in 0..zip.len() {
        let mut entry = zip
            .by_index(i)
            .map_err(|e| format!("reading zip entry {i}: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        // `max_bytes - total` cannot underflow: an entry never contributes more
        // than the budget left, so `total` tops out at `max_bytes` exactly.
        let mut bounded = BoundedRead::new(&mut entry, max_bytes - total);
        let written = std::io::copy(&mut bounded, &mut std::io::sink()).map_err(|_| {
            format!(
                "archive expands past the {} MiB limit — refusing to extract",
                max_bytes / (1024 * 1024)
            )
        })?;
        total += written;
    }
    Ok(())
}

/// Extract an archive into `dest_dir` based on the URL/file extension:
/// `.zip` (Windows + clangd all-platform), single-file `.gz`
/// (rust-analyzer unix), `.tar.gz`/`.tgz` (future entries).
///
/// Every path is bounded against decompression bombs. On refusal the error
/// propagates to `install_server`, whose `cleanup(Some(&version_dir))` removes
/// the partially written directory.
fn extract_archive(
    archive: &Path,
    url: &str,
    dest_dir: &Path,
    command: &str,
) -> Result<(), String> {
    std::fs::create_dir_all(dest_dir)
        .map_err(|e| format!("creating {}: {e}", dest_dir.display()))?;

    let lower = url.to_ascii_lowercase();
    if lower.ends_with(".zip") {
        // Measure before writing (see above — declared sizes are attacker
        // controlled), then extract through the crate's audited path unchanged.
        ensure_zip_expansion_is_bounded(archive)?;
        let file = std::fs::File::open(archive).map_err(|e| format!("opening archive: {e}"))?;
        let mut zip = zip::ZipArchive::new(file).map_err(|e| format!("reading zip: {e}"))?;
        zip.extract(dest_dir).map_err(|e| format!("extracting zip: {e}"))?;
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        // Streaming formats need no measure pass: bounding the decompressed
        // stream bounds what `unpack` can ever write.
        //
        // Byte-bounded only. A tar of millions of empty files stays small in
        // bytes while being large in entries; `unpack()` gives no entry hook
        // without hand-rolling per-entry extraction, which would put this path's
        // traversal safety back in our hands. No current artifact uses tar (zip
        // for Windows + clangd, single .gz for rust-analyzer unix), so the
        // trade holds until one does.
        let file = std::fs::File::open(archive).map_err(|e| format!("opening archive: {e}"))?;
        let tar = BoundedRead::new(flate2::read::GzDecoder::new(file), MAX_EXPANDED_BYTES);
        tar::Archive::new(tar)
            .unpack(dest_dir)
            .map_err(|e| format!("extracting tar.gz: {e}"))?;
    } else if lower.ends_with(".gz") {
        // Single compressed binary (rust-analyzer's unix artifacts): the
        // decompressed file IS the server, named after the pack command.
        let file = std::fs::File::open(archive).map_err(|e| format!("opening archive: {e}"))?;
        let mut decoder =
            BoundedRead::new(flate2::read::GzDecoder::new(file), MAX_EXPANDED_BYTES);
        let out_path = dest_dir.join(command);
        let mut out =
            std::fs::File::create(&out_path).map_err(|e| format!("creating binary: {e}"))?;
        std::io::copy(&mut decoder, &mut out).map_err(|e| format!("decompressing: {e}"))?;
    } else {
        return Err(format!(
            "unsupported artifact format for '{url}' — expected .zip, .gz, or .tar.gz"
        ));
    }
    Ok(())
}

/// Locate the server binary inside the extracted tree (clangd's zip nests it
/// under `clangd_<ver>/bin/`), searching for `command` (+ `.exe` on Windows).
fn find_binary(dir: &Path, command: &str) -> Option<PathBuf> {
    let exe = format!("{command}.exe");
    let mut queue = vec![dir.to_path_buf()];
    while let Some(current) = queue.pop() {
        let entries = std::fs::read_dir(&current).ok()?;
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                queue.push(path);
            } else if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                if name == command || name == exe {
                    return Some(path);
                }
            }
        }
    }
    None
}

#[cfg(unix)]
fn mark_executable(path: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
        .map_err(|e| format!("marking executable: {e}"))
}

#[cfg(not(unix))]
fn mark_executable(_path: &Path) -> Result<(), String> {
    Ok(())
}

// ---------------------------------------------------------------------------
// Install pipeline (ADR §2 flow)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InstallResultPayload {
    pub language_id: String,
    pub server: String,
    pub version: String,
    pub binary_path: String,
    /// "managed" or "custom" — mirrors the receipt kind.
    pub kind: String,
}

pub(crate) fn servers_root() -> Result<PathBuf, String> {
    Ok(crate::db::app_db::app_data_dir()?.join("servers"))
}

/// server_id → active (receipt `current`) version, for every receipt under
/// the managed root. Feeds the registry payload so the consent surface can
/// tell installed from available without starting sessions.
pub(crate) fn installed_versions() -> HashMap<String, String> {
    servers_root()
        .map(|root| installed_versions_at(&root))
        .unwrap_or_default()
}

fn installed_versions_at(root: &Path) -> HashMap<String, String> {
    let mut installed = HashMap::new();
    let Ok(entries) = std::fs::read_dir(root) else {
        return installed;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(server_id) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if server_id.starts_with('.') {
            continue; // .staging
        }
        if let Some(receipt) = load_receipt(root, server_id) {
            installed.insert(server_id.to_string(), receipt.current);
        }
    }
    installed
}

// ---------------------------------------------------------------------------
// Slice 7: inventory / uninstall / re-verify (settings "Language Servers")
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerInventoryRow {
    pub language_id: String,
    pub name: String,
    /// Server binary identity (registry `server`, or the pack command for
    /// non-registry languages).
    pub server: String,
    /// Version the baked registry pins, None for non-registry languages.
    pub registry_version: Option<String>,
    /// How the resolver currently finds the server: global/managed/bundled,
    /// or None when nothing resolves.
    pub tier: Option<String>,
    /// Receipt data (managed installs only).
    pub installed_version: Option<String>,
    pub installed_at: Option<String>,
    pub install_kind: Option<String>,
    /// Total size of the server's managed dir (all versions + receipt).
    pub size_bytes: Option<u64>,
    /// Receipt version differs from the registry pin (local diff — zero
    /// network, ADR §4).
    pub update_available: bool,
    /// A managed dir exists to remove. Bundled/global-only rows are never
    /// uninstallable (build plan 7c).
    pub can_uninstall: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ServerInventoryPayload {
    pub rows: Vec<ServerInventoryRow>,
    pub managed_total_bytes: u64,
}

/// Recursive size of a directory tree; 0 when absent.
fn dir_size_bytes(dir: &Path) -> u64 {
    let mut total = 0u64;
    let mut queue = vec![dir.to_path_buf()];
    while let Some(current) = queue.pop() {
        let Ok(entries) = std::fs::read_dir(&current) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                queue.push(path);
            } else if let Ok(meta) = entry.metadata() {
                total += meta.len();
            }
        }
    }
    total
}

fn display_name(language_id: &str) -> String {
    match language_id {
        "python" => "Python".into(),
        "typescript" => "TypeScript / JavaScript".into(),
        "go" => "Go".into(),
        other => registry::get_language_entry(other)
            .map(|e| e.name.clone())
            .unwrap_or_else(|| other.to_string()),
    }
}

/// Receipt/registry half of an inventory row — pure with respect to
/// `servers_root` so it is testable without an AppHandle; the command layer
/// fills in the resolver tier.
fn inventory_row_at(root: &Path, language_id: &str) -> ServerInventoryRow {
    let entry = registry::get_language_entry(language_id);
    let server = entry
        .map(|e| e.server.clone())
        .or_else(|| crate::lsp::packs::get_pack(language_id).map(|p| p.command.to_string()))
        .unwrap_or_else(|| language_id.to_string());

    let receipt = entry.and_then(|e| load_receipt(root, &e.server));
    let record = receipt
        .as_ref()
        .and_then(|r| r.installs.get(&r.current).cloned());
    let server_dir = entry.map(|e| root.join(&e.server));
    let size_bytes = server_dir
        .as_ref()
        .filter(|dir| dir.exists())
        .map(|dir| dir_size_bytes(dir));

    let registry_version = entry.map(|e| e.version.clone());
    let installed_version = receipt.as_ref().map(|r| r.current.clone());
    let update_available = matches!(
        (&registry_version, &installed_version),
        (Some(reg), Some(inst)) if reg != inst
    );

    ServerInventoryRow {
        language_id: language_id.to_string(),
        name: display_name(language_id),
        server,
        registry_version,
        tier: None,
        installed_version,
        installed_at: record.as_ref().map(|r| r.installed_at.clone()),
        install_kind: record.as_ref().map(|r| r.kind.clone()),
        size_bytes,
        update_available,
        can_uninstall: size_bytes.is_some(),
    }
}

/// Inventory over every pack language; tier comes from the resolver so the
/// settings surface shows how each server would actually be found today.
pub(crate) fn server_inventory(app: &AppHandle) -> CommandResult<ServerInventoryPayload> {
    let root = servers_root()
        .map_err(|e| CommandError::internal("lsp.inventory.no_app_dir", e))?;
    let mut rows = Vec::new();
    for language_id in crate::lsp::packs::all_language_ids() {
        let mut row = inventory_row_at(&root, language_id);
        if let Some(pack) = crate::lsp::packs::get_pack(language_id) {
            row.tier = crate::lsp::resolver::resolve_server(&pack, app)
                .map(|r| r.tier.to_string());
        }
        rows.push(row);
    }
    let managed_total_bytes = rows.iter().filter_map(|r| r.size_bytes).sum();
    Ok(ServerInventoryPayload {
        rows,
        managed_total_bytes,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UninstallResultPayload {
    pub language_id: String,
    pub server: String,
    pub freed_bytes: u64,
    pub stopped_sessions: usize,
}

/// Remove a managed server entirely: stop its sessions, then delete the
/// server dir (all versions + receipt). Registry languages only — bundled
/// and global-tier servers are not ours to remove (build plan 7c).
pub(crate) fn uninstall_server(
    app: &AppHandle,
    language_id: &str,
) -> CommandResult<UninstallResultPayload> {
    let entry = registry::get_language_entry(language_id).ok_or_else(|| {
        CommandError::not_found(
            "lsp.uninstall.unknown_language",
            format!("No managed server exists for '{language_id}'."),
        )
    })?;
    let root = servers_root()
        .map_err(|e| CommandError::internal("lsp.uninstall.no_app_dir", e))?;
    let server_dir = root.join(&entry.server);
    if !server_dir.exists() {
        return Err(CommandError::not_found(
            "lsp.uninstall.not_installed",
            format!("{} has no managed install to remove.", entry.server),
        ));
    }

    // Stop sessions BEFORE removal — a running server holds its binary
    // locked on Windows and remove_dir_all would fail underneath it.
    let stopped_sessions =
        crate::lsp::session::stop_sessions_for_language(app, language_id);

    let freed_bytes = dir_size_bytes(&server_dir);
    std::fs::remove_dir_all(&server_dir).map_err(|e| {
        CommandError::conflict(
            "lsp.uninstall.remove_failed",
            format!(
                "Could not remove {}: {e}. If a session is still running, \
                 retry in a moment.",
                server_dir.display()
            ),
        )
    })?;

    // Same-session consumers (the file-open offer pill) cache installed
    // state per project open — tell them the receipts changed so an
    // uninstall re-offers without a project reopen.
    crate::lsp::ipc_bridge::emit_server_uninstalled(app, language_id, &entry.server);

    Ok(UninstallResultPayload {
        language_id: language_id.to_string(),
        server: entry.server.clone(),
        freed_bytes,
        stopped_sessions,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReverifyResultPayload {
    pub language_id: String,
    pub server: String,
    /// "verified" | "mismatch" | "unrecorded" | "binary_missing"
    pub status: String,
    pub expected_sha256: Option<String>,
    pub actual_sha256: Option<String>,
}

/// Re-hash the active managed binary against the install-time baseline
/// (`binary_sha256`). Pure with respect to `servers_root` for testability.
pub(crate) fn reverify_server_at(
    root: &Path,
    language_id: &str,
) -> CommandResult<ReverifyResultPayload> {
    let entry = registry::get_language_entry(language_id).ok_or_else(|| {
        CommandError::not_found(
            "lsp.reverify.unknown_language",
            format!("No managed server exists for '{language_id}'."),
        )
    })?;
    let receipt = load_receipt(root, &entry.server).ok_or_else(|| {
        CommandError::not_found(
            "lsp.reverify.not_installed",
            format!("{} has no managed install to verify.", entry.server),
        )
    })?;
    let record = receipt.installs.get(&receipt.current).ok_or_else(|| {
        CommandError::internal(
            "lsp.reverify.receipt_incomplete",
            format!("Receipt for {} names no active install.", entry.server),
        )
    })?;

    let result = |status: &str, actual: Option<String>| ReverifyResultPayload {
        language_id: language_id.to_string(),
        server: entry.server.clone(),
        status: status.into(),
        expected_sha256: record.binary_sha256.clone(),
        actual_sha256: actual,
    };

    let binary = root
        .join(&entry.server)
        .join(&receipt.current)
        .join(&record.binary);
    if !binary.exists() {
        return Ok(result("binary_missing", None));
    }
    let actual = file_sha256(&binary)
        .map_err(|e| CommandError::internal("lsp.reverify.hash_failed", e))?;
    let Some(expected) = &record.binary_sha256 else {
        return Ok(result("unrecorded", Some(actual)));
    };
    let status = if actual.eq_ignore_ascii_case(expected) {
        "verified"
    } else {
        "mismatch"
    };
    Ok(result(status, Some(actual)))
}

pub(crate) fn reverify_server(language_id: &str) -> CommandResult<ReverifyResultPayload> {
    let root = servers_root()
        .map_err(|e| CommandError::internal("lsp.reverify.no_app_dir", e))?;
    reverify_server_at(&root, language_id)
}

/// Full staged install for a registry language. `custom_url` follows ADR §8:
/// Best-effort sweep of a server's non-current version dirs. Installs
/// extract beside any running version (Windows lock safety), so an update
/// leaves the previous version on disk; this reclaims those dirs once a
/// newer install is durably active. A dir whose binary is still locked by a
/// running old session fails `remove_dir_all` and simply survives until the
/// next sweep. Records are pruned only for dirs no longer on disk, so the
/// receipt keeps describing reality. Returns true when anything was pruned
/// (caller re-saves the receipt).
fn gc_stale_versions(root: &Path, server_id: &str, receipt: &mut ReceiptFile) -> bool {
    let server_dir = root.join(server_id);
    let stale: Vec<String> = receipt
        .installs
        .keys()
        .filter(|version| **version != receipt.current)
        .cloned()
        .collect();
    let mut pruned = false;
    for version in stale {
        let dir = server_dir.join(&version);
        if dir.exists() && std::fs::remove_dir_all(&dir).is_err() {
            // Locked — an old session still holds the binary. Next sweep.
            continue;
        }
        receipt.installs.remove(&version);
        pruned = true;
    }
    pruned
}

/// allowed, recorded as kind "custom", integrity explicitly unverifiable
/// (the consent UI carries the warning; this layer records honestly).
pub(crate) fn install_server(
    app: &AppHandle,
    language_id: &str,
    custom_url: Option<String>,
) -> CommandResult<InstallResultPayload> {
    let entry = registry::get_language_entry(language_id).ok_or_else(|| {
        CommandError::not_found(
            "lsp.install.unknown_language",
            format!("No curated server exists for '{language_id}'."),
        )
    })?;

    let (url, pinned_sha) = match &custom_url {
        Some(url) => {
            require_https_custom_url(url)?;
            (url.clone(), None)
        }
        None => {
            let artifact = registry::resolve_artifact(entry)
                .map_err(|e| CommandError::not_found("lsp.install.unsupported_platform", e))?;
            (artifact.url.clone(), Some(artifact.sha256.clone()))
        }
    };

    let root = servers_root()
        .map_err(|e| CommandError::internal("lsp.install.no_app_dir", e))?;
    let staging_dir = root.join(".staging");
    std::fs::create_dir_all(&staging_dir).map_err(|e| {
        CommandError::internal("lsp.install.staging_dir", format!("{e}"))
    })?;
    let staging_file = staging_dir.join(format!("{}-{}.download", entry.server, entry.version));

    let cancel = cancel_flag(&entry.server);
    cancel.store(false, Ordering::Relaxed);

    // Download (streamed + hashed). Any failure below cleans staging and
    // leaves whatever version is currently active untouched.
    let cleanup = |version_dir: Option<&Path>| {
        let _ = std::fs::remove_file(&staging_file);
        if let Some(dir) = version_dir {
            let _ = std::fs::remove_dir_all(dir);
        }
    };

    let actual_sha = download_to(app, &entry.server, &url, &staging_file, &cancel)
        .map_err(|e| {
            cleanup(None);
            CommandError::internal("lsp.install.download_failed", e)
        })?;

    // Verify BEFORE extraction (ADR §2) — pinned installs only; custom URLs
    // have no pin to verify against and are recorded as such.
    if let Some(expected) = &pinned_sha {
        if !actual_sha.eq_ignore_ascii_case(expected) {
            cleanup(None);
            return Err(CommandError::conflict(
                "lsp.install.checksum_mismatch",
                format!(
                    "{} {} failed integrity verification (expected sha256 {expected}, \
                     got {actual_sha}). The download was discarded; nothing was installed.",
                    entry.server, entry.version
                ),
            ));
        }
    }

    // Extract into the version-stamped dir, beside any running version.
    let version_dir = root.join(&entry.server).join(&entry.version);
    if version_dir.exists() {
        std::fs::remove_dir_all(&version_dir).map_err(|e| {
            cleanup(None);
            CommandError::conflict(
                "lsp.install.version_dir_locked",
                format!(
                    "Cannot replace {}: {e}. If this version is currently running, \
                     close its sessions and retry.",
                    version_dir.display()
                ),
            )
        })?;
    }
    extract_archive(&staging_file, &url, &version_dir, &entry.command).map_err(|e| {
        cleanup(Some(&version_dir));
        CommandError::internal("lsp.install.extract_failed", e)
    })?;

    let binary = find_binary(&version_dir, &entry.command).ok_or_else(|| {
        cleanup(Some(&version_dir));
        CommandError::internal(
            "lsp.install.binary_missing",
            format!(
                "'{}' was not found inside the extracted archive.",
                entry.command
            ),
        )
    })?;
    mark_executable(&binary)
        .map_err(|e| CommandError::internal("lsp.install.chmod_failed", e))?;

    // Baseline for the re-verify surface: hash the extracted binary now,
    // while it is provably the artifact that just passed verification.
    let binary_sha256 = file_sha256(&binary).ok();

    // Receipt: record the install and point `current` at it (activation).
    let relative_binary = binary
        .strip_prefix(&version_dir)
        .unwrap_or(&binary)
        .to_string_lossy()
        .into_owned();
    let mut receipt = load_receipt(&root, &entry.server).unwrap_or(ReceiptFile {
        schema: RECEIPT_SCHEMA,
        current: entry.version.clone(),
        installs: HashMap::new(),
    });
    receipt.current = entry.version.clone();
    receipt.installs.insert(
        entry.version.clone(),
        InstallRecord {
            kind: if custom_url.is_some() { "custom" } else { "managed" }.into(),
            url,
            sha256: actual_sha,
            version: entry.version.clone(),
            installed_at: chrono::Utc::now().to_rfc3339(),
            binary: relative_binary,
            binary_sha256,
        },
    );
    save_receipt(&root, &entry.server, &receipt).map_err(|e| {
        cleanup(Some(&version_dir));
        CommandError::internal("lsp.install.receipt_failed", e)
    })?;

    // GC stale versions now that the new receipt is durably active (an
    // update extracts BESIDE the running version, so the previous dir
    // lingered "until GC'd" — this is the GC). Prune only what was actually
    // removed; a failed re-save leaves harmless cosmetic records (inventory
    // and reverify read `current` only).
    if gc_stale_versions(&root, &entry.server, &mut receipt) {
        let _ = save_receipt(&root, &entry.server, &receipt);
    }

    let _ = std::fs::remove_file(&staging_file);
    let payload = InstallResultPayload {
        language_id: language_id.to_string(),
        server: entry.server.clone(),
        version: entry.version.clone(),
        binary_path: binary.to_string_lossy().into_owned(),
        kind: if custom_url.is_some() { "custom" } else { "managed" }.into(),
    };
    let _ = app.emit("lsp:download-complete", &payload);
    Ok(payload)
}

// ---------------------------------------------------------------------------
// Tests (no network — pipeline pieces are exercised on local files)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "litria_dl_{tag}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn custom_url_must_be_https() {
        assert!(require_https_custom_url("https://example.com/a.zip").is_ok());
        assert!(require_https_custom_url("http://example.com/a.zip").is_err());
        assert!(require_https_custom_url("file:///etc/passwd").is_err());
        assert!(require_https_custom_url("ftp://x/y.zip").is_err());
        // Case: uppercase scheme is not the exact https:// prefix — refused.
        assert!(require_https_custom_url("HTTPS://example.com/a.zip").is_err());
    }

    /// The scheme check on the typed URL is only half the mitigation — without
    /// this the client would follow a redirect down to cleartext http and the
    /// audit-#14 https guarantee would be decorative.
    #[test]
    fn download_agent_refuses_non_https_redirects() {
        assert!(
            download_agent().config().https_only(),
            "artifact downloads must refuse any non-https hop, redirects included"
        );
    }

    #[test]
    fn bounded_read_allows_exactly_the_limit_and_fails_past_it() {
        let data = vec![7u8; 100];
        let mut ok = BoundedRead::new(&data[..], 100);
        assert_eq!(
            std::io::copy(&mut ok, &mut std::io::sink()).unwrap(),
            100,
            "a stream exactly at the limit is legitimate and must pass"
        );

        let mut over = BoundedRead::new(&data[..], 99);
        let err = std::io::copy(&mut over, &mut std::io::sink()).unwrap_err();
        // Must be an error, never a silent EOF: gzip and tar would read a
        // truncated-but-clean stream as a successful extraction.
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }

    /// Builds a real (small) decompression bomb: highly compressible input that
    /// expands far past the budget it is measured against.
    #[test]
    fn zip_guard_refuses_an_archive_that_expands_past_the_budget() {
        let root = temp_dir("zipbomb");
        let archive = root.join("bomb.zip");
        let file = std::fs::File::create(&archive).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        writer
            .start_file("payload.bin", zip::write::SimpleFileOptions::default())
            .unwrap();
        // 4 MiB of zeros deflates to a few KiB — the ratio is the whole point.
        writer.write_all(&vec![0u8; 4 * 1024 * 1024]).unwrap();
        writer.finish().unwrap();

        let compressed = std::fs::metadata(&archive).unwrap().len();
        assert!(
            compressed < 64 * 1024,
            "fixture must actually be a bomb, compressed to {compressed} bytes"
        );

        // The declared size is not what saves us — the guard measures real
        // output — so a budget below the true expansion must refuse.
        let err = ensure_zip_expansion_within(&archive, 1024 * 1024, MAX_ARCHIVE_ENTRIES)
            .expect_err("4 MiB of output must not pass a 1 MiB budget");
        assert!(err.contains("expands past"), "got {err}");

        // Same archive, honest budget: allowed.
        assert!(ensure_zip_expansion_within(&archive, 8 * 1024 * 1024, MAX_ARCHIVE_ENTRIES).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_guard_refuses_too_many_entries() {
        let root = temp_dir("zipcount");
        let archive = root.join("many.zip");
        let file = std::fs::File::create(&archive).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        for i in 0..10 {
            writer
                .start_file(format!("f{i}.txt"), zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"x").unwrap();
        }
        writer.finish().unwrap();

        // Tiny in bytes, over budget in entries — the case a byte cap misses.
        let err = ensure_zip_expansion_within(&archive, MAX_EXPANDED_BYTES, 5)
            .expect_err("10 entries must not pass a 5-entry limit");
        assert!(err.contains("entries"), "got {err}");
        assert!(ensure_zip_expansion_within(&archive, MAX_EXPANDED_BYTES, 50).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn size_cap_rejects_only_over_ceiling() {
        assert!(!exceeds_size_cap(0));
        assert!(!exceeds_size_cap(50 * 1024 * 1024)); // clangd-sized artifact
        assert!(!exceeds_size_cap(MAX_ARTIFACT_BYTES)); // exactly at the cap is allowed
        assert!(exceeds_size_cap(MAX_ARTIFACT_BYTES + 1));
    }

    #[test]
    fn sha256_matches_known_vector() {
        let dir = temp_dir("sha");
        let file = dir.join("abc.txt");
        std::fs::write(&file, b"abc").unwrap();
        assert_eq!(
            file_sha256(&file).unwrap(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tampered_file_fails_verification() {
        let dir = temp_dir("tamper");
        let file = dir.join("artifact.bin");
        std::fs::write(&file, b"legitimate contents").unwrap();
        let good = file_sha256(&file).unwrap();
        std::fs::write(&file, b"legitimate contentsX").unwrap();
        assert_ne!(file_sha256(&file).unwrap(), good);
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn record_for(version: &str) -> InstallRecord {
        InstallRecord {
            kind: "managed".into(),
            url: "https://example.invalid/a.zip".into(),
            sha256: "00".repeat(32),
            version: version.into(),
            installed_at: "2026-07-13T00:00:00Z".into(),
            binary: "server.exe".into(),
            binary_sha256: None,
        }
    }

    #[test]
    fn gc_removes_stale_version_dirs_and_prunes_their_records() {
        let root = temp_dir("gc_stale");
        let server = "rust-analyzer";
        std::fs::create_dir_all(root.join(server).join("old")).unwrap();
        std::fs::write(root.join(server).join("old").join("server.exe"), b"x").unwrap();
        std::fs::create_dir_all(root.join(server).join("new")).unwrap();

        let mut installs = HashMap::new();
        installs.insert("old".to_string(), record_for("old"));
        installs.insert("new".to_string(), record_for("new"));
        let mut receipt = ReceiptFile {
            schema: RECEIPT_SCHEMA,
            current: "new".into(),
            installs,
        };

        assert!(gc_stale_versions(&root, server, &mut receipt));
        assert!(!root.join(server).join("old").exists(), "stale dir reclaimed");
        assert!(root.join(server).join("new").exists(), "active dir untouched");
        assert!(receipt.installs.contains_key("new"));
        assert!(!receipt.installs.contains_key("old"), "stale record pruned");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gc_is_a_noop_when_only_the_current_version_exists() {
        let root = temp_dir("gc_noop");
        let server = "clangd";
        std::fs::create_dir_all(root.join(server).join("22.1.6")).unwrap();
        let mut installs = HashMap::new();
        installs.insert("22.1.6".to_string(), record_for("22.1.6"));
        let mut receipt = ReceiptFile {
            schema: RECEIPT_SCHEMA,
            current: "22.1.6".into(),
            installs,
        };
        assert!(!gc_stale_versions(&root, server, &mut receipt));
        assert!(root.join(server).join("22.1.6").exists());
        assert_eq!(receipt.installs.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn gc_prunes_records_whose_dirs_are_already_gone() {
        // Receipt truthing: a manually-deleted stale dir still gets its
        // record dropped so the receipt matches disk.
        let root = temp_dir("gc_ghost");
        let server = "rust-analyzer";
        std::fs::create_dir_all(root.join(server).join("new")).unwrap();
        let mut installs = HashMap::new();
        installs.insert("ghost".to_string(), record_for("ghost"));
        installs.insert("new".to_string(), record_for("new"));
        let mut receipt = ReceiptFile {
            schema: RECEIPT_SCHEMA,
            current: "new".into(),
            installs,
        };
        assert!(gc_stale_versions(&root, server, &mut receipt));
        assert!(!receipt.installs.contains_key("ghost"));
        assert!(receipt.installs.contains_key("new"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn receipt_round_trips_and_selects_binary() {
        let root = temp_dir("receipt");
        let version_dir = root.join("rust-analyzer").join("2026-07-06");
        std::fs::create_dir_all(&version_dir).unwrap();
        let bin_name = if cfg!(windows) { "rust-analyzer.exe" } else { "rust-analyzer" };
        std::fs::write(version_dir.join(bin_name), b"fake").unwrap();

        let mut installs = HashMap::new();
        installs.insert(
            "2026-07-06".to_string(),
            InstallRecord {
                kind: "managed".into(),
                url: "https://example.invalid/a.zip".into(),
                sha256: "00".repeat(32),
                version: "2026-07-06".into(),
                installed_at: "2026-07-13T00:00:00Z".into(),
                binary: bin_name.into(),
                binary_sha256: None,
            },
        );
        let receipt = ReceiptFile {
            schema: RECEIPT_SCHEMA,
            current: "2026-07-06".into(),
            installs,
        };
        save_receipt(&root, "rust-analyzer", &receipt).unwrap();

        // The managed probe path: registry language → receipt → binary.
        let resolved = managed_binary_for_language(&root, "rust").unwrap();
        assert!(resolved.ends_with(bin_name));

        // Missing binary on disk → None (stale receipt is not a resolution).
        std::fs::remove_file(version_dir.join(bin_name)).unwrap();
        assert!(managed_binary_for_language(&root, "rust").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn installed_versions_reads_receipts_and_skips_staging() {
        let root = temp_dir("versions");
        std::fs::create_dir_all(root.join(".staging")).unwrap();
        std::fs::create_dir_all(root.join("no-receipt-dir")).unwrap();
        let receipt = ReceiptFile {
            schema: RECEIPT_SCHEMA,
            current: "22.1.6".into(),
            installs: HashMap::new(),
        };
        save_receipt(&root, "clangd", &receipt).unwrap();

        let installed = installed_versions_at(&root);
        assert_eq!(installed.get("clangd").map(String::as_str), Some("22.1.6"));
        assert_eq!(installed.len(), 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn write_fake_install(
        root: &Path,
        server: &str,
        version: &str,
        contents: &[u8],
        record_hash: bool,
    ) -> PathBuf {
        let version_dir = root.join(server).join(version);
        std::fs::create_dir_all(&version_dir).unwrap();
        let bin_name = if cfg!(windows) {
            format!("{server}.exe")
        } else {
            server.to_string()
        };
        let binary = version_dir.join(&bin_name);
        std::fs::write(&binary, contents).unwrap();

        let mut installs = HashMap::new();
        installs.insert(
            version.to_string(),
            InstallRecord {
                kind: "managed".into(),
                url: "https://example.invalid/a.zip".into(),
                sha256: "00".repeat(32),
                version: version.into(),
                installed_at: "2026-07-16T00:00:00Z".into(),
                binary: bin_name,
                binary_sha256: record_hash.then(|| file_sha256(&binary).unwrap()),
            },
        );
        save_receipt(
            root,
            server,
            &ReceiptFile {
                schema: RECEIPT_SCHEMA,
                current: version.into(),
                installs,
            },
        )
        .unwrap();
        binary
    }

    #[test]
    fn inventory_row_reports_receipt_size_and_update_flag() {
        let root = temp_dir("inv");
        // Installed at an OLDER version than the registry pin → update flag.
        write_fake_install(&root, "rust-analyzer", "2026-01-01", b"0123456789", true);

        let row = inventory_row_at(&root, "rust");
        assert_eq!(row.name, "Rust");
        assert_eq!(row.server, "rust-analyzer");
        assert_eq!(row.installed_version.as_deref(), Some("2026-01-01"));
        assert_eq!(row.registry_version.as_deref(), Some("2026-07-06"));
        assert!(row.update_available);
        assert!(row.can_uninstall);
        assert!(row.size_bytes.unwrap() >= 10);
        assert_eq!(row.install_kind.as_deref(), Some("managed"));

        // No managed dir → available-only row, nothing to uninstall.
        let cpp = inventory_row_at(&root, "cpp");
        assert_eq!(cpp.installed_version, None);
        assert!(!cpp.update_available);
        assert!(!cpp.can_uninstall);
        assert_eq!(cpp.size_bytes, None);

        // Non-registry languages carry no registry version and no receipt.
        let go = inventory_row_at(&root, "go");
        assert_eq!(go.name, "Go");
        assert_eq!(go.server, "gopls");
        assert_eq!(go.registry_version, None);
        assert!(!go.can_uninstall);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn inventory_update_flag_clears_when_versions_match() {
        let root = temp_dir("inv_current");
        write_fake_install(&root, "rust-analyzer", "2026-07-06", b"bin", true);
        let row = inventory_row_at(&root, "rust");
        assert!(!row.update_available);
        assert_eq!(row.installed_version.as_deref(), Some("2026-07-06"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reverify_reports_verified_mismatch_and_missing() {
        let root = temp_dir("reverify");
        let binary = write_fake_install(&root, "rust-analyzer", "2026-07-06", b"legit", true);

        let ok = reverify_server_at(&root, "rust").unwrap();
        assert_eq!(ok.status, "verified");
        assert_eq!(ok.expected_sha256, ok.actual_sha256);

        // Tamper with the binary → mismatch, hashes differ.
        std::fs::write(&binary, b"tampered").unwrap();
        let bad = reverify_server_at(&root, "rust").unwrap();
        assert_eq!(bad.status, "mismatch");
        assert_ne!(bad.expected_sha256, bad.actual_sha256);

        // Remove the binary → binary_missing.
        std::fs::remove_file(&binary).unwrap();
        let gone = reverify_server_at(&root, "rust").unwrap();
        assert_eq!(gone.status, "binary_missing");
        assert_eq!(gone.actual_sha256, None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reverify_legacy_receipt_without_baseline_is_unrecorded() {
        let root = temp_dir("reverify_legacy");
        write_fake_install(&root, "rust-analyzer", "2026-07-06", b"legit", false);
        let result = reverify_server_at(&root, "rust").unwrap();
        assert_eq!(result.status, "unrecorded");
        assert_eq!(result.expected_sha256, None);
        assert!(result.actual_sha256.is_some());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reverify_errors_cleanly_when_not_installed() {
        let root = temp_dir("reverify_none");
        let err = reverify_server_at(&root, "rust").unwrap_err();
        assert_eq!(err.code(), "lsp.reverify.not_installed");
        let err = reverify_server_at(&root, "python").unwrap_err();
        assert_eq!(err.code(), "lsp.reverify.unknown_language");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn dir_size_sums_nested_files_and_zeroes_missing() {
        let root = temp_dir("dirsize");
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("a/x.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(root.join("a/b/y.bin"), vec![0u8; 50]).unwrap();
        assert_eq!(dir_size_bytes(&root.join("a")), 150);
        assert_eq!(dir_size_bytes(&root.join("missing")), 0);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn managed_probe_ignores_non_registry_languages() {
        let root = temp_dir("nonreg");
        // python/typescript are bundled-tier languages, not registry entries.
        assert!(managed_binary_for_language(&root, "python").is_none());
        assert!(managed_binary_for_language(&root, "unknown").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn find_binary_locates_nested_command() {
        let root = temp_dir("nested");
        // clangd's zip shape: clangd_22.1.6/bin/clangd(.exe)
        let nested = root.join("clangd_22.1.6").join("bin");
        std::fs::create_dir_all(&nested).unwrap();
        let name = if cfg!(windows) { "clangd.exe" } else { "clangd" };
        std::fs::write(nested.join(name), b"fake").unwrap();
        std::fs::write(root.join("LICENSE.TXT"), b"noise").unwrap();

        let found = find_binary(&root, "clangd").unwrap();
        assert!(found.ends_with(name));
        assert!(find_binary(&root, "gopls").is_none());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn single_gz_extracts_to_command_name() {
        use flate2::write::GzEncoder;
        use flate2::Compression;
        let root = temp_dir("gz");
        let archive = root.join("rust-analyzer-x86_64.gz");
        let mut encoder = GzEncoder::new(
            std::fs::File::create(&archive).unwrap(),
            Compression::default(),
        );
        encoder.write_all(b"#!fake-binary").unwrap();
        encoder.finish().unwrap();

        let dest = root.join("out");
        extract_archive(&archive, "https://x/rust-analyzer-x86_64.gz", &dest, "rust-analyzer")
            .unwrap();
        assert_eq!(
            std::fs::read(dest.join("rust-analyzer")).unwrap(),
            b"#!fake-binary"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn zip_extracts_nested_tree() {
        let root = temp_dir("zip");
        let archive = root.join("clangd.zip");
        let file = std::fs::File::create(&archive).unwrap();
        let mut writer = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        writer
            .start_file("clangd_22.1.6/bin/clangd.exe", options)
            .unwrap();
        writer.write_all(b"fake-clangd").unwrap();
        writer.finish().unwrap();

        let dest = root.join("out");
        extract_archive(&archive, "https://x/clangd.zip", &dest, "clangd").unwrap();
        let found = find_binary(&dest, "clangd").unwrap();
        assert_eq!(std::fs::read(found).unwrap(), b"fake-clangd");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unsupported_format_is_refused() {
        let root = temp_dir("fmt");
        let archive = root.join("server.xz");
        std::fs::write(&archive, b"x").unwrap();
        let err =
            extract_archive(&archive, "https://x/server.xz", &root.join("out"), "s").unwrap_err();
        assert!(err.contains("unsupported artifact format"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
