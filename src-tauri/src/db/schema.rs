use super::DbError;
use rusqlite::Connection;

/// Per-project workspace database schema (v1).
pub(crate) const WORKSPACE_SCHEMA_V1: &str = r#"
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS project (
    instance_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    app_version TEXT NOT NULL,
    language TEXT,
    framework TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pieces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    scale REAL NOT NULL DEFAULT 1.0,
    color TEXT,
    is_hidden INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder_path TEXT,
    is_collapsed INTEGER NOT NULL DEFAULT 1,
    parent_id TEXT,
    theme_id TEXT,
    color TEXT,
    seed_x REAL,
    seed_y REAL,
    seed_w REAL,
    seed_h REAL,
    FOREIGN KEY (parent_id) REFERENCES groups(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS group_pieces (
    group_id TEXT NOT NULL,
    piece_id INTEGER NOT NULL,
    UNIQUE(group_id, piece_id),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (piece_id) REFERENCES pieces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_piece_id INTEGER NOT NULL,
    to_piece_id INTEGER NOT NULL,
    source_side TEXT,
    target_side TEXT,
    type TEXT,
    FOREIGN KEY (from_piece_id) REFERENCES pieces(id) ON DELETE CASCADE,
    FOREIGN KEY (to_piece_id) REFERENCES pieces(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS editor_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hidden_paths (
    path TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS viewport (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    scale REAL NOT NULL DEFAULT 1.0
);
"#;

/// App-level database schema (recent projects + preferences).
pub(crate) const APP_SCHEMA_V1: &str = r#"
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS projects (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_opened_at TEXT NOT NULL,
    framework TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    prefs_file TEXT
);

CREATE TABLE IF NOT EXISTS preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

pub(crate) const CURRENT_SCHEMA_VERSION: i32 = 3;

/// One additive column: `(table, column, declaration)`. Table and column
/// names are compile-time literals and must stay so: they are interpolated
/// into `PRAGMA table_info` / `ALTER TABLE`, which take no bound parameters.
type AddColumn = (&'static str, &'static str, &'static str);

/// v1 -> v2: nullable `source_side` / `target_side` / `type` on `connections`
/// so a connection's anchor edges survive a reopen instead of being recomputed.
const V2_COLUMNS: &[AddColumn] = &[
    ("connections", "source_side", "TEXT"),
    ("connections", "target_side", "TEXT"),
    ("connections", "type", "TEXT"),
];

/// v2 -> v3: nullable `seed_x/y/w/h` on `groups`: seed geometry for
/// memberless manual groups (ADR-018 box-first); NULL for folder groups.
const V3_COLUMNS: &[AddColumn] = &[
    ("groups", "seed_x", "REAL"),
    ("groups", "seed_y", "REAL"),
    ("groups", "seed_w", "REAL"),
    ("groups", "seed_h", "REAL"),
];

/// Initialize the workspace database schema and set the version.
///
/// The `CREATE TABLE` statements above reflect the LATEST schema, so a brand-new
/// database is created at `CURRENT_SCHEMA_VERSION` directly. Existing databases
/// created by an older app version are brought forward by `migrate_workspace_schema`.
pub(crate) fn initialize_workspace_schema(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(WORKSPACE_SCHEMA_V1)
        .map_err(DbError::sqlite("Failed to initialize workspace schema"))?;

    // Set schema version if not already set
    let count: i32 = conn
        .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
        .map_err(DbError::sqlite("Failed to check schema version"))?;

    if count == 0 {
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            [CURRENT_SCHEMA_VERSION],
        )
        .map_err(DbError::sqlite("Failed to set schema version"))?;
    }

    Ok(())
}

/// Bring an existing workspace database forward to `CURRENT_SCHEMA_VERSION`.
///
/// Called on every open after `initialize_workspace_schema`. Each version step
/// runs as ONE transaction together with its `schema_version` bump (ADR-026
/// decision 1), so a file is always at a whole version: a crash inside a step
/// rolls back to the previous one. Additive steps skip columns that already
/// exist, which heals files an older build left between statements (audit
/// T6/T7: `duplicate column name` on every open, forever). A database already
/// at the current version is untouched, and a freshly-created one (stamped
/// current above) skips every step.
pub(crate) fn migrate_workspace_schema(conn: &Connection) -> Result<(), DbError> {
    let version = get_schema_version(conn)?;

    if version < 2 {
        apply_additive_step(conn, 2, V2_COLUMNS)?;
    }
    if version < 3 {
        apply_additive_step(conn, 3, V3_COLUMNS)?;
    }

    Ok(())
}

/// Run one additive migration step atomically: every `ADD COLUMN` plus the
/// version bump in a single transaction. Rolls back on any failure.
fn apply_additive_step(conn: &Connection, target: i32, columns: &[AddColumn]) -> Result<(), DbError> {
    let tx = conn
        .unchecked_transaction()
        .map_err(DbError::sqlite(format!("Failed to begin migration to v{target}")))?;
    for (table, column, decl) in columns {
        add_column_if_missing(&tx, table, column, decl)?;
    }
    tx.execute("UPDATE schema_version SET version = ?1", [target])
        .map_err(DbError::sqlite(format!("Failed to bump schema version to v{target}")))?;
    tx.commit()
        .map_err(DbError::sqlite(format!("Failed to commit migration to v{target}")))?;
    Ok(())
}

/// `ALTER TABLE ... ADD COLUMN` guarded by `PRAGMA table_info`, so re-running
/// a step is a no-op instead of `duplicate column name`.
fn add_column_if_missing(conn: &Connection, table: &str, column: &str, decl: &str) -> Result<(), DbError> {
    if column_exists(conn, table, column)? {
        return Ok(());
    }
    conn.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}"), [])
        .map_err(DbError::sqlite(format!("Failed to add column {table}.{column}")))?;
    Ok(())
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool, DbError> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .map_err(DbError::sqlite(format!("Failed to inspect table {table}")))?;
    let names = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(DbError::sqlite(format!("Failed to read columns of {table}")))?;
    for name in names {
        let name = name.map_err(DbError::sqlite(format!("Failed to read a column of {table}")))?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

/// Initialize the app-level database schema.
pub(crate) fn initialize_app_schema(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(APP_SCHEMA_V1)
        .map_err(DbError::sqlite("Failed to initialize app schema"))?;

    // The app DB has no version table; additive columns are applied as
    // guarded idempotent ALTERs.
    // prefs_file: ADR-019 fast-path mapping project -> preferences filename
    // (rebuildable by scanning the preferences folder's [meta] blocks).
    add_column_if_missing(conn, "projects", "prefs_file", "TEXT")
}

/// Read the current schema version from a workspace database.
pub(crate) fn get_schema_version(conn: &Connection) -> Result<i32, DbError> {
    conn.query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
        row.get(0)
    })
    .map_err(DbError::sqlite("Failed to read schema version"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    #[test]
    fn workspace_schema_creates_all_tables() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_workspace_schema(&conn).unwrap();

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(tables.contains(&"schema_version".to_string()));
        assert!(tables.contains(&"project".to_string()));
        assert!(tables.contains(&"pieces".to_string()));
        assert!(tables.contains(&"groups".to_string()));
        assert!(tables.contains(&"group_pieces".to_string()));
        assert!(tables.contains(&"connections".to_string()));
        assert!(tables.contains(&"editor_state".to_string()));
        assert!(tables.contains(&"hidden_paths".to_string()));
        assert!(tables.contains(&"viewport".to_string()));
    }

    #[test]
    fn schema_version_is_set() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_workspace_schema(&conn).unwrap();
        let version = get_schema_version(&conn).unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }

    /// Column names present on a table, via PRAGMA table_info.
    fn columns(conn: &Connection, table: &str) -> Vec<String> {
        conn.prepare(&format!("PRAGMA table_info({table})"))
            .unwrap()
            .query_map([], |row| row.get::<_, String>(1))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect()
    }

    /// Number of foreign-key constraints declared on a table.
    fn foreign_key_count(conn: &Connection, table: &str) -> usize {
        conn.prepare(&format!("PRAGMA foreign_key_list({table})"))
            .unwrap()
            .query_map([], |row| row.get::<_, i64>(0))
            .unwrap()
            .count()
    }

    /// An on-disk v1 database as v1.0.0 wrote it: `connections` WITHOUT the
    /// side columns, `groups` WITHOUT the seed columns, and the same FOREIGN
    /// KEY clauses the production DDL carries (audit H6), schema_version 1.
    fn v1_fixture(conn: &Connection) {
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version (version) VALUES (1);
             CREATE TABLE pieces (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                file_path TEXT NOT NULL UNIQUE,
                label TEXT NOT NULL
             );
             CREATE TABLE connections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_piece_id INTEGER NOT NULL,
                to_piece_id INTEGER NOT NULL,
                FOREIGN KEY (from_piece_id) REFERENCES pieces(id) ON DELETE CASCADE,
                FOREIGN KEY (to_piece_id) REFERENCES pieces(id) ON DELETE CASCADE
             );
             CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                folder_path TEXT,
                is_collapsed INTEGER NOT NULL DEFAULT 1,
                parent_id TEXT,
                theme_id TEXT,
                color TEXT,
                FOREIGN KEY (parent_id) REFERENCES groups(id) ON DELETE SET NULL
             );",
        )
        .unwrap();
    }

    fn assert_at_current_version_with_all_columns(conn: &Connection) {
        let cols = columns(conn, "connections");
        assert!(cols.contains(&"source_side".to_string()));
        assert!(cols.contains(&"target_side".to_string()));
        assert!(cols.contains(&"type".to_string()));
        let gcols = columns(conn, "groups");
        assert!(gcols.contains(&"seed_x".to_string()));
        assert!(gcols.contains(&"seed_y".to_string()));
        assert!(gcols.contains(&"seed_w".to_string()));
        assert!(gcols.contains(&"seed_h".to_string()));
        assert_eq!(get_schema_version(conn).unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn fresh_db_has_connection_side_columns_at_current_version() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_workspace_schema(&conn).unwrap();
        migrate_workspace_schema(&conn).unwrap();

        let cols = columns(&conn, "connections");
        assert!(cols.contains(&"source_side".to_string()));
        assert!(cols.contains(&"target_side".to_string()));
        assert!(cols.contains(&"type".to_string()));
        assert_eq!(get_schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn migrate_upgrades_a_v1_database() {
        let conn = Connection::open_in_memory().unwrap();
        v1_fixture(&conn);
        assert_eq!(get_schema_version(&conn).unwrap(), 1);
        assert!(!columns(&conn, "connections").contains(&"source_side".to_string()));
        assert!(!columns(&conn, "groups").contains(&"seed_x".to_string()));

        migrate_workspace_schema(&conn).unwrap();

        assert_at_current_version_with_all_columns(&conn);
        // ADD COLUMN must leave the v1 constraints in place (H6).
        assert_eq!(foreign_key_count(&conn, "connections"), 2);
        assert_eq!(foreign_key_count(&conn, "groups"), 1);
    }

    #[test]
    fn migrate_upgrades_a_v2_database_with_group_seed_columns() {
        // v2 on disk: connections already have side columns; groups lack seeds.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version (version) VALUES (2);
             CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                folder_path TEXT,
                is_collapsed INTEGER NOT NULL DEFAULT 1,
                parent_id TEXT,
                theme_id TEXT,
                color TEXT,
                FOREIGN KEY (parent_id) REFERENCES groups(id) ON DELETE SET NULL
             );",
        )
        .unwrap();

        migrate_workspace_schema(&conn).unwrap();

        let gcols = columns(&conn, "groups");
        assert!(gcols.contains(&"seed_x".to_string()));
        assert!(gcols.contains(&"seed_y".to_string()));
        assert!(gcols.contains(&"seed_w".to_string()));
        assert!(gcols.contains(&"seed_h".to_string()));
        assert_eq!(foreign_key_count(&conn, "groups"), 1);
        assert_eq!(get_schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
    }

    /// Audit T6: an older build died after the first ALTER of the v2 step.
    /// The file has `source_side` but not the other two, and is still v1.
    #[test]
    fn migrate_heals_partial_v1_to_v2_step() {
        let conn = Connection::open_in_memory().unwrap();
        v1_fixture(&conn);
        conn.execute_batch("ALTER TABLE connections ADD COLUMN source_side TEXT;")
            .unwrap();

        migrate_workspace_schema(&conn).unwrap();

        assert_at_current_version_with_all_columns(&conn);
    }

    /// Audit T7: every v2 column landed but the process died before the
    /// version bump. Still v1 on disk.
    #[test]
    fn migrate_heals_completed_step_without_bump() {
        let conn = Connection::open_in_memory().unwrap();
        v1_fixture(&conn);
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN source_side TEXT;
             ALTER TABLE connections ADD COLUMN target_side TEXT;
             ALTER TABLE connections ADD COLUMN type TEXT;",
        )
        .unwrap();

        migrate_workspace_schema(&conn).unwrap();

        assert_at_current_version_with_all_columns(&conn);
    }

    /// A step that fails leaves the database at the previous WHOLE version:
    /// the v2 step commits (with its bump), the v3 step rolls back entirely.
    #[test]
    fn migrate_failed_step_leaves_previous_whole_version() {
        let conn = Connection::open_in_memory().unwrap();
        v1_fixture(&conn);
        conn.execute_batch("DROP TABLE groups;").unwrap();

        let err = migrate_workspace_schema(&conn).expect_err("v3 step must fail without groups");
        assert!(err.to_string().contains("groups"), "{err}");

        assert_eq!(get_schema_version(&conn).unwrap(), 2);
        let cols = columns(&conn, "connections");
        assert!(cols.contains(&"source_side".to_string()));
        assert!(cols.contains(&"type".to_string()));
    }

    #[test]
    fn fresh_db_has_group_seed_columns_at_current_version() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_workspace_schema(&conn).unwrap();
        migrate_workspace_schema(&conn).unwrap();

        let gcols = columns(&conn, "groups");
        assert!(gcols.contains(&"seed_x".to_string()));
        assert!(gcols.contains(&"seed_h".to_string()));
        assert_eq!(get_schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn migrate_is_idempotent() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_workspace_schema(&conn).unwrap();
        migrate_workspace_schema(&conn).unwrap();
        // Second run must not error (e.g. duplicate-column) or change the version.
        migrate_workspace_schema(&conn).unwrap();
        assert_eq!(get_schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
    }

    #[test]
    fn app_schema_creates_tables() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_app_schema(&conn).unwrap();

        let tables: Vec<String> = conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();

        assert!(tables.contains(&"projects".to_string()));
        assert!(tables.contains(&"preferences".to_string()));
        assert!(columns(&conn, "projects").contains(&"prefs_file".to_string()));
        // Second init must not trip over the already-present prefs_file column.
        initialize_app_schema(&conn).unwrap();
    }

    #[test]
    fn idempotent_schema_init() {
        let conn = Connection::open_in_memory().unwrap();
        initialize_workspace_schema(&conn).unwrap();
        // Second call should not error
        initialize_workspace_schema(&conn).unwrap();
        let version = get_schema_version(&conn).unwrap();
        assert_eq!(version, CURRENT_SCHEMA_VERSION);
    }
}
