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

/// Initialize the workspace database schema and set the version.
///
/// The `CREATE TABLE` statements above reflect the LATEST schema, so a brand-new
/// database is created at `CURRENT_SCHEMA_VERSION` directly. Existing databases
/// created by an older app version are brought forward by `migrate_workspace_schema`.
pub(crate) fn initialize_workspace_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(WORKSPACE_SCHEMA_V1)
        .map_err(|e| format!("Failed to initialize workspace schema: {e}"))?;

    // Set schema version if not already set
    let count: i32 = conn
        .query_row("SELECT COUNT(*) FROM schema_version", [], |row| row.get(0))
        .map_err(|e| format!("Failed to check schema version: {e}"))?;

    if count == 0 {
        conn.execute(
            "INSERT INTO schema_version (version) VALUES (?1)",
            [CURRENT_SCHEMA_VERSION],
        )
        .map_err(|e| format!("Failed to set schema version: {e}"))?;
    }

    Ok(())
}

/// Bring an existing workspace database forward to `CURRENT_SCHEMA_VERSION`.
///
/// Called on every open after `initialize_workspace_schema`. Migrations are
/// version-gated and idempotent — a database already at the current version is
/// untouched, and a freshly-created one (stamped current above) skips them all.
///
/// v1 → v2: add nullable `source_side` / `target_side` / `type` to `connections`
/// so a connection's anchor edges survive a reopen instead of being recomputed.
/// v2 → v3: add nullable `seed_x/y/w/h` to `groups` — seed geometry for
/// memberless manual groups (ADR-018 box-first); NULL for folder groups.
pub(crate) fn migrate_workspace_schema(conn: &Connection) -> Result<(), String> {
    let version = get_schema_version(conn)?;

    if version < 2 {
        // ADD COLUMN is only additive; existing rows get NULL (→ geometry
        // fallback on hydrate). New databases already have these columns from
        // the CREATE TABLE above and never reach this branch.
        conn.execute_batch(
            "ALTER TABLE connections ADD COLUMN source_side TEXT;
             ALTER TABLE connections ADD COLUMN target_side TEXT;
             ALTER TABLE connections ADD COLUMN type TEXT;",
        )
        .map_err(|e| format!("Failed to migrate connections to v2: {e}"))?;
    }

    if version < 3 {
        conn.execute_batch(
            "ALTER TABLE groups ADD COLUMN seed_x REAL;
             ALTER TABLE groups ADD COLUMN seed_y REAL;
             ALTER TABLE groups ADD COLUMN seed_w REAL;
             ALTER TABLE groups ADD COLUMN seed_h REAL;",
        )
        .map_err(|e| format!("Failed to migrate groups to v3: {e}"))?;
    }

    if version < CURRENT_SCHEMA_VERSION {
        conn.execute(
            "UPDATE schema_version SET version = ?1",
            [CURRENT_SCHEMA_VERSION],
        )
        .map_err(|e| format!("Failed to bump schema version: {e}"))?;
    }

    Ok(())
}

/// Initialize the app-level database schema.
pub(crate) fn initialize_app_schema(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(APP_SCHEMA_V1)
        .map_err(|e| format!("Failed to initialize app schema: {e}"))?;

    // The app DB has no version table; additive columns are applied as guarded
    // idempotent ALTERs (duplicate-column errors mean "already migrated").
    // prefs_file: ADR-019 fast-path mapping project -> preferences filename
    // (rebuildable by scanning the preferences folder's [meta] blocks).
    match conn.execute("ALTER TABLE projects ADD COLUMN prefs_file TEXT", []) {
        Ok(_) => {}
        Err(e) if e.to_string().contains("duplicate column name") => {}
        Err(e) => return Err(format!("Failed to add prefs_file column: {e}")),
    }
    Ok(())
}

/// Read the current schema version from a workspace database.
pub(crate) fn get_schema_version(conn: &Connection) -> Result<i32, String> {
    conn.query_row("SELECT version FROM schema_version LIMIT 1", [], |row| {
        row.get(0)
    })
    .map_err(|e| format!("Failed to read schema version: {e}"))
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
        // Simulate an on-disk v1 database: connections WITHOUT the side columns,
        // groups WITHOUT the seed columns, schema_version pinned at 1.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version (version) VALUES (1);
             CREATE TABLE connections (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                from_piece_id INTEGER NOT NULL,
                to_piece_id INTEGER NOT NULL
             );
             CREATE TABLE groups (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                folder_path TEXT,
                is_collapsed INTEGER NOT NULL DEFAULT 1,
                parent_id TEXT,
                theme_id TEXT,
                color TEXT
             );",
        )
        .unwrap();
        assert_eq!(get_schema_version(&conn).unwrap(), 1);
        assert!(!columns(&conn, "connections").contains(&"source_side".to_string()));
        assert!(!columns(&conn, "groups").contains(&"seed_x".to_string()));

        migrate_workspace_schema(&conn).unwrap();

        let cols = columns(&conn, "connections");
        assert!(cols.contains(&"source_side".to_string()));
        assert!(cols.contains(&"target_side".to_string()));
        assert!(cols.contains(&"type".to_string()));
        let gcols = columns(&conn, "groups");
        assert!(gcols.contains(&"seed_x".to_string()));
        assert!(gcols.contains(&"seed_h".to_string()));
        assert_eq!(get_schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
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
                color TEXT
             );",
        )
        .unwrap();

        migrate_workspace_schema(&conn).unwrap();

        let gcols = columns(&conn, "groups");
        assert!(gcols.contains(&"seed_x".to_string()));
        assert!(gcols.contains(&"seed_y".to_string()));
        assert!(gcols.contains(&"seed_w".to_string()));
        assert!(gcols.contains(&"seed_h".to_string()));
        assert_eq!(get_schema_version(&conn).unwrap(), CURRENT_SCHEMA_VERSION);
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
