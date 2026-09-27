//! Per-workspace applied grid (ADR-030, brief-structural-grid §7).
//!
//! One singleton row in `workspace_grid` holds the lattice a workspace's
//! node positions were arranged on. It is shared project truth: it travels
//! with the positions, never with a personal preference or a theme. The
//! frontend's GridDomain owns the meaning; this module is the storage
//! boundary, so it validates what it writes and never overwrites a record
//! it cannot read or that a newer build wrote.

use super::types::WorkspaceGrid;
use super::DbError;
use rusqlite::types::Value;
use rusqlite::{params, Connection, OptionalExtension};

/// The record version this build reads and writes.
pub(crate) const GRID_SCHEMA_VERSION: i64 = 1;
pub(crate) const GRID_COORDINATE_SYSTEM: &str = "canvas-2d";

// Mirrors GRID_LIMITS in src/utils/gridGeometry.js; the frontend validates
// first, this is the storage boundary's own check.
const MIN_MAJOR: f64 = 10.0;
const MAX_MAJOR: f64 = 1000.0;
const MIN_DIVISIONS: i64 = 1;
const MAX_DIVISIONS: i64 = 10;

pub(crate) const CODE_GRID_INVALID: &str = "db.grid.invalid";
pub(crate) const CODE_GRID_LOCKED: &str = "db.grid.locked";

/// What a workspace's grid row holds on load.
#[derive(Debug, Clone, PartialEq)]
pub(crate) enum StoredGrid {
    /// No row: a workspace saved before the grid existed, or never edited.
    Absent,
    Readable(WorkspaceGrid),
    /// A row exists but cannot be decoded as this build's record. The
    /// frontend shows a fallback and must not overwrite it.
    Unreadable,
}

/// Read the workspace's grid row. Never fails the project open over a bad
/// row: a row that does not decode is reported as `Unreadable`.
pub(crate) fn load_grid(conn: &Connection) -> Result<StoredGrid, DbError> {
    // A read-only workspace saved before the grid is opened without
    // migrating, so the table may not exist: that is simply no record.
    let has_table: bool = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'workspace_grid')",
            [],
            |row| row.get(0),
        )
        .map_err(DbError::sqlite("Failed to look for the workspace grid table"))?;
    if !has_table {
        return Ok(StoredGrid::Absent);
    }
    let row = conn
        .query_row(
            "SELECT schema_version, coordinate_system, major_x, major_y, minor_divisions, sub_divisions
             FROM workspace_grid WHERE id = 1",
            [],
            |row| {
                Ok([
                    row.get::<_, Value>(0)?,
                    row.get::<_, Value>(1)?,
                    row.get::<_, Value>(2)?,
                    row.get::<_, Value>(3)?,
                    row.get::<_, Value>(4)?,
                    row.get::<_, Value>(5)?,
                ])
            },
        )
        .optional()
        .map_err(DbError::sqlite("Failed to load the workspace grid"))?;
    let Some([version, system, major_x, major_y, minor, sub]) = row else {
        return Ok(StoredGrid::Absent);
    };
    let decoded = (|| {
        Some(WorkspaceGrid {
            schema_version: as_integer(&version)?,
            coordinate_system: match system {
                Value::Text(text) => text,
                _ => return None,
            },
            major_x: as_real(&major_x)?,
            major_y: as_real(&major_y)?,
            minor_divisions: as_integer(&minor)?,
            sub_divisions: as_integer(&sub)?,
        })
    })();
    Ok(decoded.map_or(StoredGrid::Unreadable, StoredGrid::Readable))
}

fn as_integer(value: &Value) -> Option<i64> {
    match value {
        Value::Integer(n) => Some(*n),
        _ => None,
    }
}

fn as_real(value: &Value) -> Option<f64> {
    match value {
        Value::Real(n) => Some(*n),
        Value::Integer(n) => Some(*n as f64),
        _ => None,
    }
}

/// Check a record against this build's contract.
pub(crate) fn validate_grid(grid: &WorkspaceGrid) -> Result<(), String> {
    if grid.schema_version != GRID_SCHEMA_VERSION {
        return Err(format!("schemaVersion must be {GRID_SCHEMA_VERSION}"));
    }
    if grid.coordinate_system != GRID_COORDINATE_SYSTEM {
        return Err(format!("coordinateSystem must be \"{GRID_COORDINATE_SYSTEM}\""));
    }
    for (name, value) in [("majorX", grid.major_x), ("majorY", grid.major_y)] {
        if !value.is_finite() || !(MIN_MAJOR..=MAX_MAJOR).contains(&value) {
            return Err(format!("{name} must be between {MIN_MAJOR} and {MAX_MAJOR}"));
        }
    }
    for (name, value) in [("minorDivisions", grid.minor_divisions), ("subDivisions", grid.sub_divisions)] {
        if !(MIN_DIVISIONS..=MAX_DIVISIONS).contains(&value) {
            return Err(format!("{name} must be between {MIN_DIVISIONS} and {MAX_DIVISIONS}"));
        }
    }
    Ok(())
}

/// Write the workspace's grid record. Refuses an invalid record, and refuses
/// to replace a stored row this build cannot read or that has a newer
/// schema version. Nodes are untouched: applying spacing never moves them.
pub(crate) fn save_grid(conn: &Connection, grid: &WorkspaceGrid) -> Result<(), DbError> {
    validate_grid(grid).map_err(|detail| DbError::Rejected {
        code: CODE_GRID_INVALID,
        message: format!("Invalid grid record: {detail}"),
    })?;
    match load_grid(conn)? {
        StoredGrid::Unreadable => {
            return Err(DbError::Rejected {
                code: CODE_GRID_LOCKED,
                message: "The workspace grid record cannot be read, so it is kept as is.".to_string(),
            })
        }
        StoredGrid::Readable(existing) if existing.schema_version > GRID_SCHEMA_VERSION => {
            return Err(DbError::Rejected {
                code: CODE_GRID_LOCKED,
                message: format!(
                    "The workspace grid was saved by a newer Litria (record version {}), so it is kept as is.",
                    existing.schema_version
                ),
            })
        }
        _ => {}
    }
    conn.execute(
        "INSERT OR REPLACE INTO workspace_grid
             (id, schema_version, coordinate_system, major_x, major_y, minor_divisions, sub_divisions, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            grid.schema_version,
            grid.coordinate_system,
            grid.major_x,
            grid.major_y,
            grid.minor_divisions,
            grid.sub_divisions,
            chrono::Utc::now().to_rfc3339(),
        ],
    )
    .map_err(DbError::sqlite("Failed to save the workspace grid"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::initialize_workspace_schema(&conn).unwrap();
        conn
    }

    fn record() -> WorkspaceGrid {
        WorkspaceGrid {
            schema_version: GRID_SCHEMA_VERSION,
            coordinate_system: GRID_COORDINATE_SYSTEM.to_string(),
            major_x: 100.0,
            major_y: 100.0,
            minor_divisions: 5,
            sub_divisions: 2,
        }
    }

    #[test]
    fn a_fresh_workspace_has_no_grid_row() {
        assert_eq!(load_grid(&mem_db()).unwrap(), StoredGrid::Absent);
    }

    #[test]
    fn save_then_load_round_trips() {
        let conn = mem_db();
        let grid = WorkspaceGrid { major_x: 50.0, major_y: 60.0, sub_divisions: 4, ..record() };
        save_grid(&conn, &grid).unwrap();
        assert_eq!(load_grid(&conn).unwrap(), StoredGrid::Readable(grid));
    }

    #[test]
    fn saving_again_replaces_the_singleton() {
        let conn = mem_db();
        save_grid(&conn, &record()).unwrap();
        save_grid(&conn, &WorkspaceGrid { major_x: 50.0, major_y: 50.0, ..record() }).unwrap();
        let rows: i64 = conn.query_row("SELECT COUNT(*) FROM workspace_grid", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        assert!(matches!(load_grid(&conn).unwrap(), StoredGrid::Readable(g) if g.major_x == 50.0));
    }

    #[test]
    fn invalid_records_are_refused() {
        let conn = mem_db();
        let cases = [
            WorkspaceGrid { major_x: 5.0, ..record() },
            WorkspaceGrid { major_y: f64::NAN, ..record() },
            WorkspaceGrid { minor_divisions: 0, ..record() },
            WorkspaceGrid { sub_divisions: 11, ..record() },
            WorkspaceGrid { coordinate_system: "room-3d".to_string(), ..record() },
            WorkspaceGrid { schema_version: 2, ..record() },
        ];
        for grid in cases {
            let err = save_grid(&conn, &grid).expect_err("must refuse");
            assert!(matches!(err, DbError::Rejected { code: CODE_GRID_INVALID, .. }), "{grid:?}");
        }
        assert_eq!(load_grid(&conn).unwrap(), StoredGrid::Absent);
    }

    #[test]
    fn a_newer_record_is_never_overwritten() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO workspace_grid (id, schema_version, coordinate_system, major_x, major_y, minor_divisions, sub_divisions, updated_at)
             VALUES (1, 2, 'canvas-2d', 40.0, 40.0, 4, 2, 'later')",
            [],
        )
        .unwrap();
        let err = save_grid(&conn, &record()).expect_err("must refuse");
        assert!(matches!(err, DbError::Rejected { code: CODE_GRID_LOCKED, .. }));
        assert!(matches!(load_grid(&conn).unwrap(), StoredGrid::Readable(g) if g.schema_version == 2 && g.major_x == 40.0));
    }

    #[test]
    fn an_unreadable_row_loads_as_unreadable_and_is_kept() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO workspace_grid (id, schema_version, coordinate_system, major_x, major_y, minor_divisions, sub_divisions, updated_at)
             VALUES (1, 1, 'canvas-2d', 'wide', 100.0, 5, 2, 'x')",
            [],
        )
        .unwrap();
        assert_eq!(load_grid(&conn).unwrap(), StoredGrid::Unreadable);
        let err = save_grid(&conn, &record()).expect_err("must refuse");
        assert!(matches!(err, DbError::Rejected { code: CODE_GRID_LOCKED, .. }));
    }

    #[test]
    fn integer_stored_steps_read_as_reals() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO workspace_grid (id, schema_version, coordinate_system, major_x, major_y, minor_divisions, sub_divisions, updated_at)
             VALUES (1, 1, 'canvas-2d', 100, 100, 5, 2, 'x')",
            [],
        )
        .unwrap();
        assert_eq!(load_grid(&conn).unwrap(), StoredGrid::Readable(record()));
    }
}
