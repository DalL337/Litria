use crate::db;
use crate::db::app_db;
use crate::db::schema;
use crate::db::types::*;
use crate::errors::{CommandError, CommandResult};
use crate::write_ops;
use rusqlite::params;
use std::collections::HashMap;
use std::fs;
use std::path::Path;

// ═══════════════════════════════════════════════════════════════════════════
// TOML marker file
// ═══════════════════════════════════════════════════════════════════════════

fn write_litria_toml(
    project_root: &Path,
    name: &str,
    environment_python: Option<&str>,
) -> Result<(), String> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut content = format!(
        "[project]\nname = \"{}\"\nschema_version = {}\ncreated_at = \"{}\"\n",
        name.replace('\"', "\\\""),
        schema::CURRENT_SCHEMA_VERSION,
        now,
    );
    // `[environment]` (ADR-020, first writer): declared desired-state — the
    // team-shared floor, never machine-local facts (the resolved interpreter
    // path lives in workspace.db editor_state). Only a sane version floor is
    // accepted; anything else is silently omitted rather than corrupting the
    // marker file.
    if let Some(floor) = environment_python {
        let floor = floor.trim();
        let valid = !floor.is_empty()
            && floor.chars().all(|c| c.is_ascii_digit() || c == '.')
            && floor.chars().next().is_some_and(|c| c.is_ascii_digit())
            && !floor.ends_with('.')
            && !floor.contains("..");
        if valid {
            content.push_str(&format!("\n[environment]\npython = \">={}\"\n", floor));
        }
    }
    let toml_path = project_root.join("litria.toml");
    write_ops::atomic_write_string(&toml_path, &content)
        .map_err(|e| format!("Failed to write litria.toml: {e}"))
}

/// Read project name from litria.toml if it exists.
fn read_litria_toml_name(project_root: &Path) -> Option<String> {
    let toml_path = project_root.join("litria.toml");
    let content = fs::read_to_string(&toml_path).ok()?;
    let table: toml::Table = content.parse().ok()?;
    table
        .get("project")?
        .get("name")?
        .as_str()
        .map(|s| s.to_string())
}

// ═══════════════════════════════════════════════════════════════════════════
// PROJECT LIFECYCLE COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

/// Bootstrap a new project: create the project directory if needed, then
/// create `.litria/`, `workspace.db`, and `litria.toml` inside it.
#[tauri::command]
pub(crate) fn db_bootstrap_project(
    path: String,
    name: String,
    language: Option<String>,
    framework: Option<String>,
    environment_python: Option<String>,
) -> CommandResult<ProjectState> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(CommandError::invalid_path(
            "db.bootstrap.path_required",
            "Project path is required.",
        ));
    }
    if name.trim().is_empty() {
        return Err(CommandError::invalid_path(
            "db.bootstrap.name_required",
            "Project name is required.",
        ));
    }

    // Create the project directory if it doesn't exist (wizard may supply a
    // path that hasn't been created yet, e.g. parent/<new-name>).
    let project_root = Path::new(trimmed);
    if !project_root.exists() {
        fs::create_dir_all(project_root).map_err(|e| {
            CommandError::from_io("db.bootstrap.mkdir", &e, "Unable to create project directory")
        })?;
    } else if !project_root.is_dir() {
        return Err(CommandError::conflict(
            "db.bootstrap.not_dir",
            format!("Path exists but is not a directory: {trimmed}"),
        ));
    }

    db::open_workspace_db(project_root).map_err(CommandError::from_text)?;

    // Insert project metadata
    let now = chrono::Utc::now().to_rfc3339();
    let instance_id = format!("litria-{}", uuid_v4_simple());
    let app_version = env!("CARGO_PKG_VERSION").to_string();

    db::with_workspace_db(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO project (instance_id, name, app_version, language, framework, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![instance_id, name, app_version, language, framework, now, now],
        )
        .map_err(|e| format!("Failed to insert project metadata: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)?;

    // Write litria.toml marker
    write_litria_toml(project_root, &name, environment_python.as_deref())
        .map_err(CommandError::from_text)?;

    // Add .litria/ to .gitignore if one exists
    add_litria_to_gitignore(project_root);

    // Register in app-level database
    let _ = app_db::register_project(&path, &name, framework.as_deref());

    // Return empty project state
    Ok(ProjectState {
        project: ProjectMeta {
            instance_id,
            name,
            app_version,
            language,
            framework,
            created_at: now.clone(),
            updated_at: now,
        },
        pieces: vec![],
        groups: vec![],
        group_pieces: vec![],
        connections: vec![],
        editor_state: HashMap::new(),
        hidden_paths: vec![],
        viewport: None,
    })
}

/// Open a project. Handles: returning project, fresh bootstrap.
#[tauri::command]
pub(crate) fn db_open_project(path: String) -> CommandResult<ProjectState> {
    let project_root = Path::new(&path);
    if !project_root.is_dir() {
        return Err(CommandError::not_found(
            "db.open.not_dir",
            format!("Project path is not a directory: {path}"),
        ));
    }

    // Detection precedence (ADR-016):
    // 1. .litria/workspace.db exists → returning project
    // 2. litria.toml exists but no .litria/ → rebuild from marker
    // 3. Neither exists → fresh bootstrap (open-any-folder flow)

    if db::workspace_db_exists(project_root) {
        db::open_workspace_db(project_root).map_err(CommandError::from_text)?;
        let state = load_full_state().map_err(CommandError::from_text)?;
        let _ = app_db::register_project(&path, &state.project.name, state.project.framework.as_deref());
        return Ok(state);
    }

    let litria_toml = project_root.join("litria.toml");
    if litria_toml.exists() {
        let name = read_litria_toml_name(project_root)
            .unwrap_or_else(|| folder_name(project_root));
        return db_bootstrap_project(path, name, None, None, None);
    }

    // Fresh bootstrap (open-any-folder flow, ADR-016)
    let name = folder_name(project_root);
    db_bootstrap_project(path, name, None, None, None)
}

/// Close the currently open project.
#[tauri::command]
pub(crate) fn db_close_project() -> CommandResult<()> {
    db::close_workspace_db().map_err(CommandError::from_text)
}

// ═══════════════════════════════════════════════════════════════════════════
// PIECE COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub(crate) fn db_create_piece(
    file_path: String,
    label: String,
    x: f64,
    y: f64,
    color: Option<String>,
    scale: Option<f64>,
    is_hidden: Option<bool>,
) -> CommandResult<i64> {
    db::with_workspace_db(|conn| {
        conn.execute(
            "INSERT INTO pieces (file_path, label, x, y, scale, color, is_hidden)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                file_path,
                label,
                x,
                y,
                scale.unwrap_or(1.0),
                color,
                is_hidden.unwrap_or(false) as i32,
            ],
        )
        .map_err(|e| format!("Failed to create piece: {e}"))?;
        Ok(conn.last_insert_rowid())
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_create_pieces_batch(pieces: Vec<PieceInput>) -> CommandResult<Vec<i64>> {
    db::with_workspace_db(|conn| {
        let mut ids = Vec::with_capacity(pieces.len());
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction: {e}"))?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO pieces (file_path, label, x, y, scale, color, is_hidden)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(|e| format!("Failed to prepare batch insert: {e}"))?;

            for p in &pieces {
                stmt.execute(params![
                    p.file_path,
                    p.label,
                    p.x,
                    p.y,
                    p.scale.unwrap_or(1.0),
                    p.color,
                    p.is_hidden.unwrap_or(false) as i32,
                ])
                .map_err(|e| format!("Failed to insert piece '{}': {e}", p.file_path))?;
                ids.push(tx.last_insert_rowid());
            }
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit batch: {e}"))?;
        Ok(ids)
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_batch_move_pieces(moves: Vec<PieceMove>) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| format!("Failed to begin transaction: {e}"))?;
        {
            let mut stmt = tx
                .prepare("UPDATE pieces SET x = ?1, y = ?2 WHERE id = ?3")
                .map_err(|e| format!("Failed to prepare batch move: {e}"))?;

            for m in &moves {
                stmt.execute(params![m.x, m.y, m.id])
                    .map_err(|e| format!("Failed to move piece {}: {e}", m.id))?;
            }
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit moves: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_update_piece(id: i64, fields: PieceUpdate) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        let mut sets = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref fp) = fields.file_path {
            sets.push("file_path = ?");
            values.push(Box::new(fp.clone()));
        }
        if let Some(ref l) = fields.label {
            sets.push("label = ?");
            values.push(Box::new(l.clone()));
        }
        if let Some(x) = fields.x {
            sets.push("x = ?");
            values.push(Box::new(x));
        }
        if let Some(y) = fields.y {
            sets.push("y = ?");
            values.push(Box::new(y));
        }
        if let Some(s) = fields.scale {
            sets.push("scale = ?");
            values.push(Box::new(s));
        }
        if let Some(ref c) = fields.color {
            sets.push("color = ?");
            values.push(Box::new(c.clone()));
        }
        if let Some(h) = fields.is_hidden {
            sets.push("is_hidden = ?");
            values.push(Box::new(h as i32));
        }

        if sets.is_empty() {
            return Ok(());
        }

        values.push(Box::new(id));
        let sql = format!(
            "UPDATE pieces SET {} WHERE id = ?",
            sets.join(", ")
        );

        let params_ref: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        conn.execute(&sql, params_ref.as_slice())
            .map_err(|e| format!("Failed to update piece {id}: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_delete_piece(id: i64) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        conn.execute("DELETE FROM pieces WHERE id = ?1", [id])
            .map_err(|e| format!("Failed to delete piece {id}: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

// ═══════════════════════════════════════════════════════════════════════════
// GROUP COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub(crate) fn db_create_group(group: GroupInput) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        conn.execute(
            "INSERT INTO groups (id, name, folder_path, is_collapsed, parent_id, theme_id, color, seed_x, seed_y, seed_w, seed_h)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                group.id,
                group.name,
                group.folder_path,
                group.is_collapsed.unwrap_or(true) as i32,
                group.parent_id,
                group.theme_id,
                group.color,
                group.seed_x,
                group.seed_y,
                group.seed_w,
                group.seed_h,
            ],
        )
        .map_err(|e| format!("Failed to create group: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_update_group(id: String, fields: GroupUpdate) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        let mut sets = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::types::ToSql>> = Vec::new();

        if let Some(ref n) = fields.name {
            sets.push("name = ?");
            values.push(Box::new(n.clone()));
        }
        if let Some(ref fp) = fields.folder_path {
            sets.push("folder_path = ?");
            values.push(Box::new(fp.clone()));
        }
        if let Some(c) = fields.is_collapsed {
            sets.push("is_collapsed = ?");
            values.push(Box::new(c as i32));
        }
        // Nullable columns use the explicit-null wrapper: outer Some means the
        // caller sent the field (inner None = clear the column to NULL).
        if let Some(ref pid) = fields.parent_id {
            sets.push("parent_id = ?");
            values.push(Box::new(pid.clone()));
        }
        if let Some(ref tid) = fields.theme_id {
            sets.push("theme_id = ?");
            values.push(Box::new(tid.clone()));
        }
        if let Some(ref c) = fields.color {
            sets.push("color = ?");
            values.push(Box::new(c.clone()));
        }
        if let Some(sx) = fields.seed_x {
            sets.push("seed_x = ?");
            values.push(Box::new(sx));
        }
        if let Some(sy) = fields.seed_y {
            sets.push("seed_y = ?");
            values.push(Box::new(sy));
        }

        if sets.is_empty() {
            return Ok(());
        }

        values.push(Box::new(id.clone()));
        let sql = format!("UPDATE groups SET {} WHERE id = ?", sets.join(", "));
        let params_ref: Vec<&dyn rusqlite::types::ToSql> = values.iter().map(|b| b.as_ref()).collect();
        conn.execute(&sql, params_ref.as_slice())
            .map_err(|e| format!("Failed to update group {id}: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_delete_group(id: String) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        conn.execute("DELETE FROM groups WHERE id = ?1", [&id])
            .map_err(|e| format!("Failed to delete group {id}: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_add_piece_to_group(group_id: String, piece_id: i64) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO group_pieces (group_id, piece_id) VALUES (?1, ?2)",
            params![group_id, piece_id],
        )
        .map_err(|e| format!("Failed to add piece to group: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_remove_piece_from_group(group_id: String, piece_id: i64) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        conn.execute(
            "DELETE FROM group_pieces WHERE group_id = ?1 AND piece_id = ?2",
            params![group_id, piece_id],
        )
        .map_err(|e| format!("Failed to remove piece from group: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

// ═══════════════════════════════════════════════════════════════════════════
// CONNECTION COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub(crate) fn db_create_connection(
    from_piece_id: i64,
    to_piece_id: i64,
    source_side: Option<String>,
    target_side: Option<String>,
    r#type: Option<String>,
) -> CommandResult<i64> {
    db::with_workspace_db(|conn| {
        conn.execute(
            "INSERT INTO connections (from_piece_id, to_piece_id, source_side, target_side, type)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![from_piece_id, to_piece_id, source_side, target_side, r#type],
        )
        .map_err(|e| format!("Failed to create connection: {e}"))?;
        Ok(conn.last_insert_rowid())
    })
    .map_err(CommandError::from_text)
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE COMMANDS (Editor, Viewport, Hidden Paths)
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub(crate) fn db_save_editor_state(key: String, value: String) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO editor_state (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| format!("Failed to save editor state: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_load_editor_state() -> CommandResult<HashMap<String, String>> {
    db::with_workspace_db(|conn| {
        let mut stmt = conn
            .prepare("SELECT key, value FROM editor_state")
            .map_err(|e| format!("Failed to prepare editor state query: {e}"))?;
        let rows = stmt
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
            .map_err(|e| format!("Failed to query editor state: {e}"))?;
        let mut map = HashMap::new();
        for row in rows {
            let (k, v) = row.map_err(|e| format!("Failed to read editor state: {e}"))?;
            map.insert(k, v);
        }
        Ok(map)
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_save_viewport(x: f64, y: f64, scale: f64) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO viewport (id, x, y, scale) VALUES (1, ?1, ?2, ?3)",
            params![x, y, scale],
        )
        .map_err(|e| format!("Failed to save viewport: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_add_hidden_path(path: String) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        conn.execute(
            "INSERT OR IGNORE INTO hidden_paths (path) VALUES (?1)",
            [&path],
        )
        .map_err(|e| format!("Failed to add hidden path: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_remove_hidden_path(path: String) -> CommandResult<()> {
    db::with_workspace_db(|conn| {
        conn.execute("DELETE FROM hidden_paths WHERE path = ?1", [&path])
            .map_err(|e| format!("Failed to remove hidden path: {e}"))?;
        Ok(())
    })
    .map_err(CommandError::from_text)
}

// ═══════════════════════════════════════════════════════════════════════════
// APP-LEVEL COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

#[tauri::command]
pub(crate) fn db_list_recent_projects() -> CommandResult<Vec<RecentProject>> {
    app_db::list_recent_projects().map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_register_project(
    path: String,
    name: String,
    framework: Option<String>,
) -> CommandResult<()> {
    app_db::register_project(&path, &name, framework.as_deref()).map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_remove_project(path: String) -> CommandResult<()> {
    app_db::remove_project(&path).map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_pin_project(path: String, pinned: bool) -> CommandResult<()> {
    app_db::pin_project(&path, pinned).map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_save_preference(key: String, value: String) -> CommandResult<()> {
    app_db::save_preference(&key, &value).map_err(CommandError::from_text)
}

#[tauri::command]
pub(crate) fn db_load_preferences() -> CommandResult<HashMap<String, String>> {
    app_db::load_preferences().map_err(CommandError::from_text)
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/// Load full project state from the open workspace database.
fn load_full_state() -> Result<ProjectState, String> {
    db::with_workspace_db(|conn| {
        // Project metadata
        let project = conn
            .query_row(
                "SELECT instance_id, name, app_version, language, framework, created_at, updated_at
                 FROM project LIMIT 1",
                [],
                |row| {
                    Ok(ProjectMeta {
                        instance_id: row.get(0)?,
                        name: row.get(1)?,
                        app_version: row.get(2)?,
                        language: row.get(3)?,
                        framework: row.get(4)?,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                },
            )
            .map_err(|e| format!("Failed to load project metadata: {e}"))?;

        // Pieces
        let pieces = {
            let mut stmt = conn
                .prepare("SELECT id, file_path, label, x, y, scale, color, is_hidden FROM pieces")
                .map_err(|e| format!("Failed to prepare pieces query: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(Piece {
                        id: row.get(0)?,
                        file_path: row.get(1)?,
                        label: row.get(2)?,
                        x: row.get(3)?,
                        y: row.get(4)?,
                        scale: row.get(5)?,
                        color: row.get(6)?,
                        is_hidden: row.get::<_, i32>(7)? != 0,
                    })
                })
                .map_err(|e| format!("Failed to query pieces: {e}"))?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row.map_err(|e| format!("Failed to read piece: {e}"))?);
            }
            v
        };

        // Groups
        let groups = {
            let mut stmt = conn
                .prepare("SELECT id, name, folder_path, is_collapsed, parent_id, theme_id, color, seed_x, seed_y, seed_w, seed_h FROM groups")
                .map_err(|e| format!("Failed to prepare groups query: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(Group {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        folder_path: row.get(2)?,
                        is_collapsed: row.get::<_, i32>(3)? != 0,
                        parent_id: row.get(4)?,
                        theme_id: row.get(5)?,
                        color: row.get(6)?,
                        seed_x: row.get(7)?,
                        seed_y: row.get(8)?,
                        seed_w: row.get(9)?,
                        seed_h: row.get(10)?,
                    })
                })
                .map_err(|e| format!("Failed to query groups: {e}"))?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row.map_err(|e| format!("Failed to read group: {e}"))?);
            }
            v
        };

        // Group pieces
        let group_pieces = {
            let mut stmt = conn
                .prepare("SELECT group_id, piece_id FROM group_pieces")
                .map_err(|e| format!("Failed to prepare group_pieces query: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(GroupPiece {
                        group_id: row.get(0)?,
                        piece_id: row.get(1)?,
                    })
                })
                .map_err(|e| format!("Failed to query group_pieces: {e}"))?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row.map_err(|e| format!("Failed to read group_piece: {e}"))?);
            }
            v
        };

        // Connections
        let connections = {
            let mut stmt = conn
                .prepare(
                    "SELECT id, from_piece_id, to_piece_id, source_side, target_side, type
                     FROM connections",
                )
                .map_err(|e| format!("Failed to prepare connections query: {e}"))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(Connection {
                        id: row.get(0)?,
                        from_piece_id: row.get(1)?,
                        to_piece_id: row.get(2)?,
                        source_side: row.get(3)?,
                        target_side: row.get(4)?,
                        r#type: row.get(5)?,
                    })
                })
                .map_err(|e| format!("Failed to query connections: {e}"))?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row.map_err(|e| format!("Failed to read connection: {e}"))?);
            }
            v
        };

        // Editor state
        let editor_state = {
            let mut stmt = conn
                .prepare("SELECT key, value FROM editor_state")
                .map_err(|e| format!("Failed to prepare editor_state query: {e}"))?;
            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| format!("Failed to query editor_state: {e}"))?;
            let mut map = HashMap::new();
            for row in rows {
                let (k, v) = row.map_err(|e| format!("Failed to read editor_state: {e}"))?;
                map.insert(k, v);
            }
            map
        };

        // Hidden paths
        let hidden_paths = {
            let mut stmt = conn
                .prepare("SELECT path FROM hidden_paths")
                .map_err(|e| format!("Failed to prepare hidden_paths query: {e}"))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|e| format!("Failed to query hidden_paths: {e}"))?;
            let mut v = Vec::new();
            for row in rows {
                v.push(row.map_err(|e| format!("Failed to read hidden_path: {e}"))?);
            }
            v
        };

        // Viewport
        let viewport = conn
            .query_row(
                "SELECT x, y, scale FROM viewport WHERE id = 1",
                [],
                |row| {
                    Ok(Viewport {
                        x: row.get(0)?,
                        y: row.get(1)?,
                        scale: row.get(2)?,
                    })
                },
            )
            .ok();

        Ok(ProjectState {
            project,
            pieces,
            groups,
            group_pieces,
            connections,
            editor_state,
            hidden_paths,
            viewport,
        })
    })
}

/// Derive a project name from the folder name.
fn folder_name(path: &Path) -> String {
    path.file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Untitled")
        .to_string()
}

/// Simple UUID-v4-like ID generator (no external dep).
fn uuid_v4_simple() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id();
    format!("{:x}-{:x}-{:04x}", nanos, pid, rand_u16())
}

fn rand_u16() -> u16 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    use std::time::SystemTime;
    let mut hasher = DefaultHasher::new();
    SystemTime::now().hash(&mut hasher);
    std::thread::current().id().hash(&mut hasher);
    (hasher.finish() & 0xFFFF) as u16
}

/// Add `.litria/` to `.gitignore` if one exists and doesn't already contain it.
fn add_litria_to_gitignore(project_root: &Path) {
    let gitignore = project_root.join(".gitignore");
    if !gitignore.exists() {
        return;
    }
    let content = match fs::read_to_string(&gitignore) {
        Ok(c) => c,
        Err(_) => return,
    };
    // Check if .litria/ or .litria is already in the gitignore
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == ".litria/" || trimmed == ".litria" || trimmed == "/.litria/" || trimmed == "/.litria" {
            return;
        }
    }
    // Append .litria/ to the gitignore
    let addition = if content.ends_with('\n') || content.is_empty() {
        ".litria/\n".to_string()
    } else {
        "\n.litria/\n".to_string()
    };
    let new_content = format!("{content}{addition}");
    let _ = fs::write(&gitignore, new_content);
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::schema;
    use rusqlite::Connection;

    fn mem_db() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        schema::initialize_workspace_schema(&conn).unwrap();
        conn
    }

    #[test]
    fn create_and_read_piece() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO pieces (file_path, label, x, y) VALUES ('src/main.rs', 'main.rs', 100.0, 200.0)",
            [],
        )
        .unwrap();
        let id = conn.last_insert_rowid();
        assert!(id > 0);

        let (fp, x, y): (String, f64, f64) = conn
            .query_row(
                "SELECT file_path, x, y FROM pieces WHERE id = ?1",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(fp, "src/main.rs");
        assert_eq!(x, 100.0);
        assert_eq!(y, 200.0);
    }

    #[test]
    fn unique_file_path_rejects_duplicate() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO pieces (file_path, label, x, y) VALUES ('src/a.js', 'a', 0, 0)",
            [],
        )
        .unwrap();
        let result = conn.execute(
            "INSERT INTO pieces (file_path, label, x, y) VALUES ('src/a.js', 'b', 0, 0)",
            [],
        );
        assert!(result.is_err());
    }

    #[test]
    fn group_pieces_unique_constraint() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO pieces (file_path, label, x, y) VALUES ('a.js', 'a', 0, 0)",
            [],
        )
        .unwrap();
        let pid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO groups (id, name) VALUES ('g1', 'Group 1')",
            [],
        )
        .unwrap();

        // First insert succeeds
        conn.execute(
            "INSERT INTO group_pieces (group_id, piece_id) VALUES ('g1', ?1)",
            [pid],
        )
        .unwrap();

        // Duplicate rejected
        let result = conn.execute(
            "INSERT INTO group_pieces (group_id, piece_id) VALUES ('g1', ?1)",
            [pid],
        );
        assert!(result.is_err());
    }

    #[test]
    fn cascade_delete_piece_removes_group_membership() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO pieces (file_path, label, x, y) VALUES ('a.js', 'a', 0, 0)",
            [],
        )
        .unwrap();
        let pid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO groups (id, name) VALUES ('g1', 'Group')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO group_pieces (group_id, piece_id) VALUES ('g1', ?1)",
            [pid],
        )
        .unwrap();

        // Delete piece → cascade should remove group_pieces row
        conn.execute("DELETE FROM pieces WHERE id = ?1", [pid])
            .unwrap();

        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM group_pieces", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn cascade_delete_group_removes_membership() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO pieces (file_path, label, x, y) VALUES ('a.js', 'a', 0, 0)",
            [],
        )
        .unwrap();
        let pid = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO groups (id, name) VALUES ('g1', 'Group')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO group_pieces (group_id, piece_id) VALUES ('g1', ?1)",
            [pid],
        )
        .unwrap();

        // Delete group → cascade removes group_pieces
        conn.execute("DELETE FROM groups WHERE id = 'g1'", [])
            .unwrap();

        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM group_pieces", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);

        // Piece still exists
        let piece_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM pieces", [], |row| row.get(0))
            .unwrap();
        assert_eq!(piece_count, 1);
    }

    #[test]
    fn editor_state_insert_or_replace() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO editor_state (key, value) VALUES ('active_tab', '5')",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO editor_state (key, value) VALUES ('active_tab', '7')",
            [],
        )
        .unwrap();
        let val: String = conn
            .query_row(
                "SELECT value FROM editor_state WHERE key = 'active_tab'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(val, "7");
    }

    #[test]
    fn viewport_single_row() {
        let conn = mem_db();
        conn.execute(
            "INSERT OR REPLACE INTO viewport (id, x, y, scale) VALUES (1, 100.0, 200.0, 0.5)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT OR REPLACE INTO viewport (id, x, y, scale) VALUES (1, 300.0, 400.0, 1.5)",
            [],
        )
        .unwrap();

        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM viewport", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);

        let (x, y, s): (f64, f64, f64) = conn
            .query_row("SELECT x, y, scale FROM viewport WHERE id = 1", [], |row| {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            })
            .unwrap();
        assert_eq!(x, 300.0);
        assert_eq!(y, 400.0);
        assert_eq!(s, 1.5);
    }

    #[test]
    fn batch_move_transaction() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO pieces (file_path, label, x, y) VALUES ('a.js', 'a', 0, 0)",
            [],
        )
        .unwrap();
        let id1 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO pieces (file_path, label, x, y) VALUES ('b.js', 'b', 0, 0)",
            [],
        )
        .unwrap();
        let id2 = conn.last_insert_rowid();

        let tx = conn.unchecked_transaction().unwrap();
        tx.execute("UPDATE pieces SET x = 10.0, y = 20.0 WHERE id = ?1", [id1])
            .unwrap();
        tx.execute("UPDATE pieces SET x = 30.0, y = 40.0 WHERE id = ?1", [id2])
            .unwrap();
        tx.commit().unwrap();

        let (x1, y1): (f64, f64) = conn
            .query_row("SELECT x, y FROM pieces WHERE id = ?1", [id1], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap();
        assert_eq!((x1, y1), (10.0, 20.0));
    }

    #[test]
    fn connection_cascade_on_piece_delete() {
        let conn = mem_db();
        conn.execute(
            "INSERT INTO pieces (file_path, label, x, y) VALUES ('a.js', 'a', 0, 0)",
            [],
        )
        .unwrap();
        let p1 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO pieces (file_path, label, x, y) VALUES ('b.js', 'b', 0, 0)",
            [],
        )
        .unwrap();
        let p2 = conn.last_insert_rowid();
        conn.execute(
            "INSERT INTO connections (from_piece_id, to_piece_id) VALUES (?1, ?2)",
            params![p1, p2],
        )
        .unwrap();

        conn.execute("DELETE FROM pieces WHERE id = ?1", [p1])
            .unwrap();

        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM connections", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 0);
    }
}
