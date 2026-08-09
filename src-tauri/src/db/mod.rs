pub(crate) mod app_db;
pub(crate) mod commands;
pub(crate) mod schema;
pub(crate) mod types;

use rusqlite::Connection;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

/// Holds the currently open per-project workspace database connection.
static PROJECT_DB: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();

fn project_db_lock() -> &'static Mutex<Option<Connection>> {
    PROJECT_DB.get_or_init(|| Mutex::new(None))
}

/// Open a workspace database at `.litria/workspace.db` inside the given
/// project root. Creates the `.litria/` directory and schema if needed.
pub(crate) fn open_workspace_db(project_root: &Path) -> Result<(), String> {
    let litria_dir = project_root.join(".litria");
    if !litria_dir.exists() {
        std::fs::create_dir_all(&litria_dir)
            .map_err(|e| format!("Failed to create .litria directory: {e}"))?;
    }

    let db_path = litria_dir.join("workspace.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open workspace database: {e}"))?;

    // Enable WAL mode and foreign keys
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("Failed to set database pragmas: {e}"))?;

    schema::initialize_workspace_schema(&conn)?;
    schema::migrate_workspace_schema(&conn)?;

    let lock = project_db_lock();
    let mut guard = lock
        .lock()
        .map_err(|_| "Project database lock poisoned.".to_string())?;
    *guard = Some(conn);
    Ok(())
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

/// Execute a closure with an exclusive reference to the open workspace database.
/// Returns an error if no project is open.
pub(crate) fn with_workspace_db<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    let lock = project_db_lock();
    let guard = lock
        .lock()
        .map_err(|_| "Project database lock poisoned.".to_string())?;
    match guard.as_ref() {
        Some(conn) => f(conn),
        None => Err("No project is currently open.".to_string()),
    }
}

/// Check whether a workspace database exists at the given project root.
pub(crate) fn workspace_db_exists(project_root: &Path) -> bool {
    project_root.join(".litria").join("workspace.db").exists()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(prefix: &str) -> std::path::PathBuf {
        let mut dir = std::env::temp_dir();
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        dir.push(format!("litria-db-{prefix}-{}-{stamp}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn workspace_db_exists_false_when_no_dir() {
        let root = temp_dir("exists-check");
        assert!(!workspace_db_exists(&root));
        fs::remove_dir_all(&root).ok();
    }
}
