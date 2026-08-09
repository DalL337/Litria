use crate::db::schema;
use crate::db::types::RecentProject;
use rusqlite::Connection;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

static APP_DB: OnceLock<Mutex<Option<Connection>>> = OnceLock::new();

fn app_db_lock() -> &'static Mutex<Option<Connection>> {
    APP_DB.get_or_init(|| Mutex::new(None))
}

/// Platform-appropriate app data directory for Litria.
/// Also used by the crash system for its internal state (markers/mirrors).
pub(crate) fn app_data_dir() -> Result<PathBuf, String> {
    #[cfg(target_os = "windows")]
    {
        std::env::var("LOCALAPPDATA")
            .map(|p| PathBuf::from(p).join("com.litria.app"))
            .map_err(|_| "Cannot determine LOCALAPPDATA.".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        std::env::var("HOME")
            .map(|p| {
                PathBuf::from(p)
                    .join("Library")
                    .join("Application Support")
                    .join("com.litria.app")
            })
            .map_err(|_| "Cannot determine HOME.".to_string())
    }
    #[cfg(target_os = "linux")]
    {
        std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                PathBuf::from(home).join(".local").join("share")
            })
            .join("com.litria.app");
        // Re-do to return Result
        Ok(std::env::var("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
                PathBuf::from(home).join(".local").join("share")
            })
            .join("com.litria.app"))
    }
}

/// Open (or create) the app-level database at `~/.litria/litria.db`
/// (platform-appropriate location).
pub(crate) fn open_app_db() -> Result<(), String> {
    let dir = app_data_dir()?;
    if !dir.exists() {
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create app data directory: {e}"))?;
    }
    let db_path = dir.join("litria.db");
    let conn = Connection::open(&db_path)
        .map_err(|e| format!("Failed to open app database: {e}"))?;

    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
        .map_err(|e| format!("Failed to set app database pragmas: {e}"))?;

    schema::initialize_app_schema(&conn)?;

    let lock = app_db_lock();
    let mut guard = lock
        .lock()
        .map_err(|_| "App database lock poisoned.".to_string())?;
    *guard = Some(conn);
    Ok(())
}

/// Execute a closure with a reference to the app-level database.
pub(crate) fn with_app_db<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&Connection) -> Result<T, String>,
{
    let lock = app_db_lock();
    let guard = lock
        .lock()
        .map_err(|_| "App database lock poisoned.".to_string())?;
    match guard.as_ref() {
        Some(conn) => f(conn),
        None => Err("App database is not open.".to_string()),
    }
}

// ---------------------------------------------------------------------------
// App-level operations
// ---------------------------------------------------------------------------

pub(crate) fn register_project(
    path: &str,
    name: &str,
    framework: Option<&str>,
) -> Result<(), String> {
    with_app_db(|conn| {
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT OR REPLACE INTO projects (path, name, last_opened_at, framework, pinned)
             VALUES (?1, ?2, ?3, ?4, COALESCE((SELECT pinned FROM projects WHERE path = ?1), 0))",
            rusqlite::params![path, name, now, framework],
        )
        .map_err(|e| format!("Failed to register project: {e}"))?;
        Ok(())
    })
}

pub(crate) fn list_recent_projects() -> Result<Vec<RecentProject>, String> {
    with_app_db(|conn| {
        let mut stmt = conn
            .prepare(
                "SELECT path, name, last_opened_at, framework, pinned
                 FROM projects ORDER BY pinned DESC, last_opened_at DESC",
            )
            .map_err(|e| format!("Failed to prepare recent projects query: {e}"))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(RecentProject {
                    path: row.get(0)?,
                    name: row.get(1)?,
                    last_opened_at: row.get(2)?,
                    framework: row.get(3)?,
                    pinned: row.get::<_, i32>(4)? != 0,
                })
            })
            .map_err(|e| format!("Failed to query recent projects: {e}"))?;

        let mut projects = Vec::new();
        for row in rows {
            projects.push(row.map_err(|e| format!("Failed to read project row: {e}"))?);
        }
        // Hide projects whose folder no longer exists. Non-destructive: the row
        // is kept, so a project on a temporarily-unmounted external/network
        // drive reappears once the drive is back. Keeps deleted dev projects
        // from lingering in the recents UI (and as switch targets).
        projects.retain(|p| std::path::Path::new(&p.path).is_dir());
        Ok(projects)
    })
}

pub(crate) fn remove_project(path: &str) -> Result<(), String> {
    with_app_db(|conn| {
        conn.execute("DELETE FROM projects WHERE path = ?1", [path])
            .map_err(|e| format!("Failed to remove project: {e}"))?;
        Ok(())
    })
}

pub(crate) fn pin_project(path: &str, pinned: bool) -> Result<(), String> {
    with_app_db(|conn| {
        conn.execute(
            "UPDATE projects SET pinned = ?1 WHERE path = ?2",
            rusqlite::params![pinned as i32, path],
        )
        .map_err(|e| format!("Failed to pin project: {e}"))?;
        Ok(())
    })
}

/// ADR-019: fast-path mapping project -> preferences filename. The mapping is
/// a rebuildable index — the files self-describe via their [meta] block, so a
/// missing/stale row only costs a folder scan, never data.
pub(crate) fn get_project_prefs_file(path: &str) -> Result<Option<String>, String> {
    with_app_db(|conn| {
        conn.query_row(
            "SELECT prefs_file FROM projects WHERE path = ?1",
            [path],
            |row| row.get::<_, Option<String>>(0),
        )
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => "unregistered".to_string(),
            other => format!("Failed to read prefs_file: {other}"),
        })
        .or_else(|e| if e == "unregistered" { Ok(None) } else { Err(e) })
    })
}

pub(crate) fn set_project_prefs_file(path: &str, file: &str) -> Result<(), String> {
    with_app_db(|conn| {
        conn.execute(
            "UPDATE projects SET prefs_file = ?1 WHERE path = ?2",
            rusqlite::params![file, path],
        )
        .map_err(|e| format!("Failed to store prefs_file mapping: {e}"))?;
        Ok(())
    })
}

pub(crate) fn get_project_name(path: &str) -> Result<Option<String>, String> {
    with_app_db(|conn| {
        conn.query_row("SELECT name FROM projects WHERE path = ?1", [path], |row| {
            row.get::<_, String>(0)
        })
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(format!("Failed to read project name: {other}")),
        })
    })
}

pub(crate) fn save_preference(key: &str, value: &str) -> Result<(), String> {
    with_app_db(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO preferences (key, value) VALUES (?1, ?2)",
            [key, value],
        )
        .map_err(|e| format!("Failed to save preference: {e}"))?;
        Ok(())
    })
}

pub(crate) fn load_preferences() -> Result<HashMap<String, String>, String> {
    with_app_db(|conn| {
        let mut stmt = conn
            .prepare("SELECT key, value FROM preferences")
            .map_err(|e| format!("Failed to prepare preferences query: {e}"))?;

        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| format!("Failed to query preferences: {e}"))?;

        let mut map = HashMap::new();
        for row in rows {
            let (k, v) = row.map_err(|e| format!("Failed to read preference: {e}"))?;
            map.insert(k, v);
        }
        Ok(map)
    })
}
