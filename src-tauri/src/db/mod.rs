pub(crate) mod app_db;
pub(crate) mod commands;
pub(crate) mod schema;
pub(crate) mod types;

use crate::errors::CommandError;
use rusqlite::{Connection, DatabaseName, ErrorCode, OpenFlags};
use std::fmt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

// This file is the SQLite adapter (ADR-026 decision 8): open flags, the
// open-time integrity and writability probes, and the result-code ->
// `CommandError` mapping all live here so a future backend-neutral store
// contract can treat this file as "the SQLite backend" without moving them.

/// Pragmas applied to every connection of both databases. WAL for crash
/// safety and concurrent readers; foreign keys are already on by compile
/// default (`SQLITE_DEFAULT_FOREIGN_KEYS=1`), the pragma keeps the intent visible.
pub(crate) const CONNECTION_PRAGMAS: &str = "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;";

/// Recovery sentence carried by every `db.corrupt` message (ADR-026
/// decision 4). Litria never deletes or rewrites a corrupt file itself.
pub(crate) const CORRUPT_RECOVERY_HINT: &str = "Move or delete the project's .litria folder to rebuild the workspace from litria.toml; your files are untouched, the canvas layout will be reset.";

pub(crate) const CODE_CORRUPT: &str = "db.corrupt";
pub(crate) const CODE_READ_ONLY: &str = "db.read_only";
pub(crate) const CODE_BUSY: &str = "db.busy";
/// ADR-032 decision 3: a request aimed at a workspace that is no longer open.
/// This is a correctly FENCED write, not a failed one — the frontend must not
/// surface it as a persistence failure.
pub(crate) const CODE_WORKSPACE_CHANGED: &str = "db.workspace_changed";
pub(crate) const CODE_SQLITE: &str = "db.sqlite";

/// A failure on the database path. SQLite failures keep their
/// `rusqlite::Error` so the conversion to `CommandError` classifies by result
/// code (ADR-026 decision 5) instead of by message text.
#[derive(Debug)]
pub(crate) enum DbError {
    Sqlite {
        context: String,
        source: rusqlite::Error,
    },
    /// Integrity failure detected by Litria itself (zero-length file, failed
    /// `quick_check`). Always maps to `db.corrupt`.
    Corrupt(String),
    /// ADR-032 decision 1: the caller addressed a different workspace than the
    /// one currently open. Carries the expected and actual epochs.
    WorkspaceChanged {
        expected: String,
        open: Option<String>,
    },
    /// Anything else on the database path (I/O, lock poisoning, "no project open").
    Other(String),
}

impl DbError {
    /// Adapter for `.map_err(...)`: wraps a rusqlite error with its context.
    pub(crate) fn sqlite(context: impl Into<String>) -> impl FnOnce(rusqlite::Error) -> DbError {
        let context = context.into();
        move |source| DbError::Sqlite { context, source }
    }
}

impl From<String> for DbError {
    fn from(text: String) -> Self {
        DbError::Other(text)
    }
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DbError::Sqlite { context, source } => write!(f, "{context}: {source}"),
            DbError::Corrupt(text) | DbError::Other(text) => f.write_str(text),
            DbError::WorkspaceChanged { expected, open } => write!(
                f,
                "Request was issued for workspace {expected}, but {} is open.",
                open.as_deref().unwrap_or("no workspace")
            ),
        }
    }
}

impl From<DbError> for CommandError {
    fn from(err: DbError) -> Self {
        match err {
            DbError::Sqlite { context, source } => classify_sqlite(&context, &source),
            DbError::Corrupt(detail) => corrupt(&detail),
            DbError::Other(text) => CommandError::from_text(text),
            ref changed @ DbError::WorkspaceChanged { .. } => {
                CommandError::conflict(CODE_WORKSPACE_CHANGED, changed.to_string())
            }
        }
    }
}

fn corrupt(detail: &str) -> CommandError {
    let detail = detail.trim_end_matches('.');
    CommandError::internal(CODE_CORRUPT, format!("{detail}. {CORRUPT_RECOVERY_HINT}"))
}

/// Map a rusqlite error to a `CommandError` by primary result code.
fn classify_sqlite(context: &str, source: &rusqlite::Error) -> CommandError {
    let detail = format!("{context}: {source}");
    let code = match source {
        rusqlite::Error::SqliteFailure(ffi, _) => Some(ffi.code),
        _ => None,
    };
    match code {
        Some(ErrorCode::DatabaseCorrupt | ErrorCode::NotADatabase) => corrupt(&detail),
        Some(ErrorCode::ReadOnly) => CommandError::access_denied(CODE_READ_ONLY, detail),
        Some(ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked) => {
            CommandError::conflict(CODE_BUSY, detail)
        }
        Some(ErrorCode::CannotOpen) => {
            // The OS reason travels in the message; keep the existing
            // access/not-found categories for it.
            let lower = detail.to_lowercase();
            if lower.contains("permission denied") || lower.contains("access is denied") {
                CommandError::access_denied("db.access_denied", detail)
            } else if lower.contains("not found") || lower.contains("no such file") {
                CommandError::not_found("db.not_found", detail)
            } else {
                CommandError::internal("db.cannot_open", detail)
            }
        }
        _ => CommandError::internal(CODE_SQLITE, detail),
    }
}

/// Open flags for both databases: rusqlite's defaults minus `SQLITE_OPEN_URI`.
///
/// Defence in depth only. The bundled SQLite is compiled with
/// `SQLITE_USE_URI` (libsqlite3-sys `build.rs`), which turns URI parsing on
/// for every connection regardless of this flag; `open_connection` therefore
/// refuses the one prefix SQLite treats as a URI (ADR-026 decision 6 erratum).
pub(crate) fn open_flags() -> OpenFlags {
    OpenFlags::default() - OpenFlags::SQLITE_OPEN_URI
}

/// The only filename prefix SQLite parses as a URI (`sqlite3ParseUri`).
const URI_PREFIX: &str = "file:";

/// Open a database file with Litria's flags. `what` names the database in
/// error messages ("workspace database" / "app database").
///
/// A path that begins with `file:` is refused so the filename is always
/// literal (ADR-026 decision 6): SQLite would otherwise read `?mode=memory`
/// and friends out of it. Absolute paths never carry the prefix, so this
/// only bites on the attack shape.
pub(crate) fn open_connection(db_path: &Path, what: &str) -> Result<Connection, DbError> {
    if db_path.to_string_lossy().starts_with(URI_PREFIX) {
        return Err(DbError::Other(format!(
            "Failed to open {what}: database path must be a literal filename, \
             not a URI (starts with {URI_PREFIX:?})"
        )));
    }
    Connection::open_with_flags(db_path, open_flags())
        .map_err(DbError::sqlite(format!("Failed to open {what}")))
}

/// A file that exists but is empty is never treated as a new database: SQLite
/// would silently initialize a fresh schema into it and mask whatever
/// truncated it (audit T11b).
fn refuse_zero_length(db_path: &Path) -> Result<(), DbError> {
    match std::fs::metadata(db_path) {
        Ok(meta) if meta.len() == 0 => Err(DbError::Corrupt(
            "workspace.db exists but is empty (zero bytes)".to_string(),
        )),
        _ => Ok(()),
    }
}

/// `PRAGMA quick_check` must answer exactly `ok`; the first line of anything
/// else becomes the `db.corrupt` message.
fn quick_check(conn: &Connection) -> Result<(), DbError> {
    let verdict: String = conn
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(DbError::sqlite("Integrity check could not run"))?;
    if verdict == "ok" {
        Ok(())
    } else {
        Err(DbError::Corrupt(format!(
            "workspace.db failed its integrity check ({verdict})"
        )))
    }
}

/// Holds the currently open per-project workspace database connection, tagged
/// with the epoch minted when it was opened (ADR-032 decision 1).
///
/// The epoch is what gives the connection an identity. Without it every
/// `db_*` command resolves to "whatever is open right now", so a request
/// issued for project A — a queued write, an unawaited promise, a React
/// effect cleanup that runs after the switch — executes against project B.
/// Piece ids are per-workspace autoincrement and overlap, so that lands on
/// real rows.
static PROJECT_DB: OnceLock<Mutex<Option<OpenWorkspace>>> = OnceLock::new();

struct OpenWorkspace {
    epoch: String,
    conn: Connection,
}

fn project_db_lock() -> &'static Mutex<Option<OpenWorkspace>> {
    PROJECT_DB.get_or_init(|| Mutex::new(None))
}

/// Mint an epoch for a newly opened workspace.
///
/// A monotonic counter is sufficient and deliberately dependency-free: the
/// epoch is process-lifetime state, never persisted and never compared across
/// processes (multi-process workspace ownership is out of scope — ADR-032
/// costs). It is not a persistent entity id, so implementation-policy Rule 9's
/// UUID requirement does not apply. Crucially it still distinguishes a
/// close/reopen of the SAME folder, which a path hash would not.
static EPOCH_COUNTER: AtomicU64 = AtomicU64::new(1);

fn mint_epoch() -> String {
    format!("ws-{}", EPOCH_COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// Open a workspace database at `.litria/workspace.db` inside the given
/// project root. Creates the `.litria/` directory and schema if needed.
///
/// Returns whether the database opened read-only (ADR-026 decision 3): a
/// read-only file is still opened so the canvas can be viewed; the caller
/// reports the flag and every later write fails with `db.read_only`.
pub(crate) fn open_workspace_db(project_root: &Path) -> Result<(bool, String), DbError> {
    let litria_dir = project_root.join(".litria");
    if !litria_dir.exists() {
        std::fs::create_dir_all(&litria_dir)
            .map_err(|e| format!("Failed to create .litria directory: {e}"))?;
    }

    let db_path = litria_dir.join("workspace.db");
    refuse_zero_length(&db_path)?;
    let conn = open_connection(&db_path, "workspace database")?;

    conn.execute_batch(CONNECTION_PRAGMAS)
        .map_err(DbError::sqlite("Failed to set database pragmas"))?;
    quick_check(&conn)?;

    schema::initialize_workspace_schema(&conn)?;
    schema::migrate_workspace_schema(&conn)?;

    let read_only = conn
        .is_readonly(DatabaseName::Main)
        .map_err(DbError::sqlite("Failed to probe workspace writability"))?;

    // The epoch is minted and published under the SAME lock that installs the
    // connection, so no request can observe a connection without its identity.
    let epoch = mint_epoch();
    let lock = project_db_lock();
    let mut guard = lock
        .lock()
        .map_err(|_| "Project database lock poisoned.".to_string())?;
    *guard = Some(OpenWorkspace {
        epoch: epoch.clone(),
        conn,
    });
    Ok((read_only, epoch))
}

/// Close the currently open workspace database.
pub(crate) fn close_workspace_db() -> Result<(), String> {
    let lock = project_db_lock();
    let mut guard = lock
        .lock()
        .map_err(|_| "Project database lock poisoned.".to_string())?;
    *guard = None;
    Ok(())
}

/// Execute a closure against the workspace the caller addressed.
///
/// ADR-032 decision 1: `expected` is the epoch the caller believes is open.
/// The comparison happens under the same lock that hands out the connection,
/// so a request for a workspace that has since been closed or replaced can
/// never reach the wrong database. Rust owns this check because the stale
/// notion of "the current project" lives in the frontend — asking that layer
/// to detect its own staleness is the assumption that produced the defect.
pub(crate) fn with_workspace_db<T, F>(expected: &str, f: F) -> Result<T, DbError>
where
    F: FnOnce(&Connection) -> Result<T, DbError>,
{
    let lock = project_db_lock();
    let guard = lock
        .lock()
        .map_err(|_| "Project database lock poisoned.".to_string())?;
    match guard.as_ref() {
        Some(open) if open.epoch == expected => f(&open.conn),
        Some(open) => Err(DbError::WorkspaceChanged {
            expected: expected.to_string(),
            open: Some(open.epoch.clone()),
        }),
        None => Err(DbError::WorkspaceChanged {
            expected: expected.to_string(),
            open: None,
        }),
    }
}

/// Check whether a workspace database exists at the given project root.
pub(crate) fn workspace_db_exists(project_root: &Path) -> bool {
    project_root.join(".litria").join("workspace.db").exists()
}

/// Tests that open a real workspace share the process-wide `PROJECT_DB`
/// slot; hold this guard for the whole test so parallel tests cannot swap
/// each other's connection out from under them.
#[cfg(test)]
pub(crate) fn serial_guard() -> std::sync::MutexGuard<'static, ()> {
    static SERIAL: Mutex<()> = Mutex::new(());
    SERIAL.lock().unwrap_or_else(|e| e.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::{Seek, SeekFrom, Write};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> PathBuf {
        let mut dir = std::env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        dir.push(format!("litria-db-{prefix}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn db_path(root: &Path) -> PathBuf {
        root.join(".litria").join("workspace.db")
    }

    /// Create a fresh workspace on disk and release it (checkpoints the WAL
    /// so the main file holds every page).
    fn create_and_close(root: &Path) {
        let (read_only, _epoch) = open_workspace_db(root).expect("fresh open");
        assert!(!read_only);
        close_workspace_db().unwrap();
    }

    fn overwrite_at(path: &Path, offset: u64, bytes: &[u8]) {
        let mut file = fs::OpenOptions::new().write(true).open(path).unwrap();
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(bytes).unwrap();
    }

    fn command_error(err: DbError) -> CommandError {
        CommandError::from(err)
    }

    fn sqlite_failure(code: i32) -> rusqlite::Error {
        rusqlite::Error::SqliteFailure(rusqlite::ffi::Error::new(code), None)
    }

    #[test]
    fn workspace_db_exists_false_when_no_dir() {
        let root = temp_dir("exists-check");
        assert!(!workspace_db_exists(&root));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn open_flags_exclude_uri() {
        let flags = open_flags();
        assert!(!flags.contains(OpenFlags::SQLITE_OPEN_URI));
        assert!(flags.contains(OpenFlags::SQLITE_OPEN_READ_WRITE));
        assert!(flags.contains(OpenFlags::SQLITE_OPEN_CREATE));
    }

    #[test]
    fn classify_maps_result_codes_to_codes() {
        let err = command_error(DbError::sqlite("ctx")(sqlite_failure(rusqlite::ffi::SQLITE_READONLY)));
        assert_eq!(err.code(), CODE_READ_ONLY);

        let err = command_error(DbError::sqlite("ctx")(sqlite_failure(rusqlite::ffi::SQLITE_BUSY)));
        assert_eq!(err.code(), CODE_BUSY);
        let err = command_error(DbError::sqlite("ctx")(sqlite_failure(rusqlite::ffi::SQLITE_LOCKED)));
        assert_eq!(err.code(), CODE_BUSY);

        let err = command_error(DbError::sqlite("ctx")(sqlite_failure(rusqlite::ffi::SQLITE_CORRUPT)));
        assert_eq!(err.code(), CODE_CORRUPT);
        assert!(err.message().ends_with(CORRUPT_RECOVERY_HINT));
        let err = command_error(DbError::sqlite("ctx")(sqlite_failure(rusqlite::ffi::SQLITE_NOTADB)));
        assert_eq!(err.code(), CODE_CORRUPT);

        let err = command_error(DbError::sqlite("ctx")(rusqlite::Error::QueryReturnedNoRows));
        assert_eq!(err.code(), CODE_SQLITE);
        assert!(err.message().starts_with("ctx: "));

        let err = command_error(DbError::Other("Path is not within project root.".into()));
        assert_eq!(err.code(), "path.invalid");
    }

    #[test]
    fn open_refuses_zero_length_file() {
        let _serial = serial_guard();
        let root = temp_dir("zero-length");
        fs::create_dir_all(root.join(".litria")).unwrap();
        fs::write(db_path(&root), b"").unwrap();

        let err = command_error(open_workspace_db(&root).expect_err("zero-length must be refused"));
        assert_eq!(err.code(), CODE_CORRUPT);
        assert!(err.message().contains("empty"));
        assert!(err.message().ends_with(CORRUPT_RECOVERY_HINT));
        assert_eq!(
            fs::metadata(db_path(&root)).unwrap().len(),
            0,
            "an existing file must never be re-initialized"
        );
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn open_reports_corrupt_on_truncated_file() {
        let _serial = serial_guard();
        let root = temp_dir("truncated");
        create_and_close(&root);
        let file = fs::OpenOptions::new().write(true).open(db_path(&root)).unwrap();
        file.set_len(512).unwrap();
        drop(file);

        let err = command_error(open_workspace_db(&root).expect_err("truncated file must be refused"));
        assert_eq!(err.code(), CODE_CORRUPT);
        assert!(err.message().ends_with(CORRUPT_RECOVERY_HINT));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn open_reports_corrupt_on_bad_header() {
        let _serial = serial_guard();
        let root = temp_dir("bad-header");
        create_and_close(&root);
        overwrite_at(&db_path(&root), 0, b"XXXXXXXXXXXXXXXX");

        let err = command_error(open_workspace_db(&root).expect_err("non-database must be refused"));
        assert_eq!(err.code(), CODE_CORRUPT);
        assert!(err.message().ends_with(CORRUPT_RECOVERY_HINT));
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn open_reports_corrupt_from_quick_check() {
        let _serial = serial_guard();
        let root = temp_dir("quick-check");
        create_and_close(&root);
        // Page 1 (header + sqlite_master) stays intact so the pragma batch
        // passes; page 2 is garbage that only an integrity walk notices.
        overwrite_at(&db_path(&root), 4096, &[0xFF; 4096]);

        let err = command_error(open_workspace_db(&root).expect_err("quick_check must refuse"));
        assert_eq!(err.code(), CODE_CORRUPT);
        assert!(err.message().contains("integrity check"), "{}", err.message());
        assert!(err.message().ends_with(CORRUPT_RECOVERY_HINT));
        fs::remove_dir_all(&root).ok();
    }

    // ── ADR-032 D1: the workspace epoch fence ──────────────────────────────

    #[test]
    fn a_request_for_a_closed_workspace_is_fenced() {
        let _serial = serial_guard();
        let root = temp_dir("fence-closed");
        let (_read_only, epoch) = open_workspace_db(&root).expect("fresh open");
        close_workspace_db().unwrap();

        let err = with_workspace_db(&epoch, |_conn| Ok(()))
            .expect_err("a request for a closed workspace must not execute");
        assert_eq!(command_error(err).code(), CODE_WORKSPACE_CHANGED);

        fs::remove_dir_all(&root).ok();
    }

    /// The D1 shape: work issued for project A arriving after B is open.
    #[test]
    fn a_request_for_the_previous_workspace_never_reaches_the_new_one() {
        let _serial = serial_guard();
        let root_a = temp_dir("fence-a");
        let root_b = temp_dir("fence-b");

        let (_ro_a, epoch_a) = open_workspace_db(&root_a).expect("open A");
        with_workspace_db(&epoch_a, |conn| {
            conn.execute(
                "INSERT INTO editor_state (key, value) VALUES ('owner', 'A')",
                [],
            )
            .map(|_| ())
            .map_err(DbError::sqlite("seed A"))
        })
        .unwrap();
        close_workspace_db().unwrap();

        let (_ro_b, epoch_b) = open_workspace_db(&root_b).expect("open B");
        assert_ne!(epoch_a, epoch_b, "each open mints its own epoch");

        // A's epoch is now stale. Without the fence this write would land in B.
        let err = with_workspace_db(&epoch_a, |conn| {
            conn.execute(
                "INSERT INTO editor_state (key, value) VALUES ('owner', 'A-LEAKED')",
                [],
            )
            .map(|_| ())
            .map_err(DbError::sqlite("stale write"))
        })
        .expect_err("a stale request must be refused");
        assert_eq!(command_error(err).code(), CODE_WORKSPACE_CHANGED);

        let leaked: i64 = with_workspace_db(&epoch_b, |conn| {
            conn.query_row(
                "SELECT COUNT(*) FROM editor_state WHERE key = 'owner'",
                [],
                |row| row.get(0),
            )
            .map_err(DbError::sqlite("count B"))
        })
        .unwrap();
        assert_eq!(leaked, 0, "D1: project A's write reached project B");

        close_workspace_db().unwrap();
        fs::remove_dir_all(&root_a).ok();
        fs::remove_dir_all(&root_b).ok();
    }

    /// A close/reopen of the SAME folder must not revive the old epoch — the
    /// reason the epoch is a minted token rather than a path or a row id.
    #[test]
    fn reopening_the_same_workspace_mints_a_new_epoch() {
        let _serial = serial_guard();
        let root = temp_dir("fence-reopen");
        let (_ro_first, first) = open_workspace_db(&root).expect("first open");
        close_workspace_db().unwrap();
        let (_ro_second, second) = open_workspace_db(&root).expect("second open");

        assert_ne!(first, second);
        let err = with_workspace_db(&first, |_conn| Ok(()))
            .expect_err("the previous session's epoch must stay dead");
        assert_eq!(command_error(err).code(), CODE_WORKSPACE_CHANGED);
        with_workspace_db(&second, |_conn| Ok(())).expect("the current epoch works");

        close_workspace_db().unwrap();
        fs::remove_dir_all(&root).ok();
    }

    #[test]
    fn open_reports_read_only() {
        let _serial = serial_guard();
        let root = temp_dir("read-only");
        create_and_close(&root);
        let path = db_path(&root);
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_readonly(true);
        fs::set_permissions(&path, perms).unwrap();

        let (read_only, epoch) = open_workspace_db(&root).expect("a read-only file still opens");
        assert!(read_only, "writability probe must report read-only");

        let err = with_workspace_db(&epoch, |conn| {
            conn.execute(
                "INSERT INTO editor_state (key, value) VALUES ('probe', '1')",
                [],
            )
            .map(|_| ())
            .map_err(DbError::sqlite("Write probe"))
        })
        .expect_err("writes to a read-only workspace must fail");
        assert_eq!(command_error(err).code(), CODE_READ_ONLY);
        close_workspace_db().unwrap();

        let mut perms = fs::metadata(&path).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        perms.set_readonly(false);
        fs::set_permissions(&path, perms).unwrap();
        fs::remove_dir_all(&root).ok();
    }

    /// The file an open connection is backed by (`PRAGMA database_list`);
    /// empty for an in-memory database.
    fn backing_file(conn: &Connection) -> String {
        conn.query_row("PRAGMA database_list", [], |row| row.get(2))
            .unwrap()
    }

    /// Audit T19: `file:<path>?mode=memory` is parsed as a URI and yields an
    /// in-memory database. The positive control shows that this happens with
    /// rusqlite's default flags, and (because the bundled SQLite is built
    /// with `SQLITE_USE_URI`) would also happen with `open_flags()` alone;
    /// `open_connection` must refuse the name outright.
    #[test]
    fn open_does_not_parse_uri() {
        let root = temp_dir("uri");
        let uri = format!("file:{}?mode=memory", root.join("x").display());

        // Positive control: the detector sees URI parsing when it is enabled.
        let parsed = Connection::open_with_flags(&uri, OpenFlags::default())
            .expect("URI parsing enabled: in-memory database");
        assert_eq!(backing_file(&parsed), "", "control: URI must yield in-memory");
        drop(parsed);

        let err = command_error(
            open_connection(Path::new(&uri), "test database")
                .expect_err("a file: name must be refused, never parsed"),
        );
        assert!(err.message().contains("literal filename"), "{}", err.message());
        assert!(!root.join("x").exists());

        // Ordinary absolute paths are unaffected.
        let plain = open_connection(&root.join("plain.db"), "test database").unwrap();
        assert!(backing_file(&plain).ends_with("plain.db"));
        drop(plain);
        fs::remove_dir_all(&root).ok();
    }
}
