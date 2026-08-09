# RFC: SQLite Persistence Migration — Replace JSON Manifest with Relational Storage

**Status:** Proposed
**Date:** 2026-04-05
**Owner:** Litria (solo)
**Relates to:** ADR-015, ADR-016, PRD-SP-001

---

## 1. Problem

Litria stores all workspace state in a single `litria.project.json` file per project. This architecture has three structural failures:

1. **No referential integrity** — group membership is a plain array of piece IDs. Nothing prevents duplicates, orphans, or dangling references. A folder-to-canvas spawn bug produced 21 duplicate entries for the same piece ID, causing cascading UI failures (broken grid layout, phantom file counts, non-functional expand/collapse). The JSON accepted the malformed data silently.

2. **Whole-file persistence** — every state mutation (piece drag, tab switch, group collapse) serializes the entire state tree and overwrites the file. A 2-piece test project produces a 43 KB / 504-line manifest. This scales linearly with no optimization path.

3. **No cross-project access** — the planned project switcher dropdown needs to read project names and timestamps from multiple projects. The current architecture requires fully parsing each project's manifest to extract metadata.

Additionally, the manifest stores full file contents (`code` and `workingCode` fields), creating a shadow copy of every open file that diverges from the filesystem source of truth.

---

## 2. Design Overview

Replace the JSON manifest with a two-tier SQLite architecture backed by `rusqlite`, plus a lightweight TOML marker file.

```
Project Directory                       App Data Directory
─────────────────                       ──────────────────
myawesomeapp/                           ~/.litria/
├── litria.toml          (marker)       └── litria.db    (app-level DB)
├── .litria/                                 ├── projects table
│   ├── workspace.db     (project DB)        └── preferences table
│   └── unsaved/         (hot exit)
├── src/
├── src-tauri/
└── ...
```

### Data ownership boundaries

| Data | Owner | Why |
|------|-------|-----|
| File content (source code) | Filesystem | Git tracks it, compilers read it, other editors touch it |
| Canvas layout (positions, groups, visibility) | `.litria/workspace.db` | Only Litria cares about spatial arrangement |
| Editor session (open tabs, active tab) | `.litria/workspace.db` | Ephemeral but worth restoring across sessions |
| Unsaved buffers | `.litria/unsaved/` temp files | Filesystem-based hot exit, no code in DB |
| Project identity (name, version) | `litria.toml` | Human-readable, optionally version-controlled |
| Cross-project index (recent list) | `~/.litria/litria.db` | Needed for project switcher without scanning disk |

---

## 3. Data Flow

### Current flow (JSON)

```
State change (e.g., piece drag)
    │
    ▼
projectDomain.commands.persistWorkspaceState()    ← 400ms debounce
    │
    ▼
Serialize ENTIRE state tree → JSON.stringify()
    │
    ▼
storage.writeProjectManifest() → Tauri IPC
    │
    ▼
project_ops::write_project_manifest()             ← Rust
    │
    ▼
atomic_write_string_with_backup()                 ← overwrites full file
```

### Proposed flow (SQLite)

```
State change (e.g., piece drag)
    │
    ▼
Tauri invoke('batch_move_pieces', [{id, x, y}])   ← single IPC call
    │
    ▼
#[tauri::command] batch_move_pieces()              ← Rust
    │
    ▼
BEGIN TRANSACTION
  UPDATE pieces SET x=?, y=? WHERE id=?            ← one row per piece
COMMIT                                             ← sub-millisecond
```

Key differences:
- No serialization of the full state tree
- No debounce needed — individual writes are cheap enough to fire directly
- One IPC round-trip per user action, not per piece
- Transaction guarantees atomicity

### Hydration flow

```
Project open
    │
    ▼
Tauri invoke('open_project', { path })
    │
    ▼
Rust: open workspace.db connection
    │
    ├── SELECT * FROM project                    → project metadata
    ├── SELECT * FROM pieces                     → all pieces (positions, visibility)
    ├── SELECT * FROM groups                     → all groups
    ├── SELECT * FROM group_pieces               → membership map
    └── SELECT * FROM editor_state               → session restoration
    │
    ▼
Return structured data to React (one IPC response)
    │
    ▼
React hydrates pieceDomain, groupDomain, editorDomain
```

### Project switch flow

```
User selects project from dropdown
    │
    ▼
Rust: persist any pending state → close current workspace.db connection
    │
    ▼
Rust: open new workspace.db → hydrate
    │
    ▼
Rust: UPDATE projects SET last_opened_at=NOW() in app-level litria.db
    │
    ▼
React receives new state, re-renders canvas
```

---

## 4. Schema Design

### Per-project: `.litria/workspace.db`

```sql
PRAGMA journal_mode=WAL;          -- write-ahead logging for concurrent reads
PRAGMA foreign_keys=ON;           -- enforce referential integrity

-- Schema version tracking
CREATE TABLE schema_version (
    version INTEGER NOT NULL
);

-- Project metadata (single row)
CREATE TABLE project (
    instance_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    app_version TEXT NOT NULL,
    language TEXT,
    framework TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Canvas pieces
CREATE TABLE pieces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    scale REAL NOT NULL DEFAULT 1.0,
    color TEXT,
    is_hidden INTEGER NOT NULL DEFAULT 0
);

-- Folder groups
CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    folder_path TEXT,
    is_collapsed INTEGER NOT NULL DEFAULT 1,
    parent_id TEXT,
    theme_id TEXT,
    color TEXT,
    FOREIGN KEY (parent_id) REFERENCES groups(id) ON DELETE SET NULL
);

-- Group ↔ piece membership (junction table)
CREATE TABLE group_pieces (
    group_id TEXT NOT NULL,
    piece_id INTEGER NOT NULL,
    UNIQUE(group_id, piece_id),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (piece_id) REFERENCES pieces(id) ON DELETE CASCADE
);

-- Inter-piece connections
CREATE TABLE connections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_piece_id INTEGER NOT NULL,
    to_piece_id INTEGER NOT NULL,
    FOREIGN KEY (from_piece_id) REFERENCES pieces(id) ON DELETE CASCADE,
    FOREIGN KEY (to_piece_id) REFERENCES pieces(id) ON DELETE CASCADE
);

-- Editor session state (key-value)
CREATE TABLE editor_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

-- Scaffold drawer hidden paths
CREATE TABLE hidden_paths (
    path TEXT PRIMARY KEY
);

-- Viewport state
CREATE TABLE viewport (
    id INTEGER PRIMARY KEY CHECK (id = 1),  -- single row
    x REAL NOT NULL DEFAULT 0,
    y REAL NOT NULL DEFAULT 0,
    scale REAL NOT NULL DEFAULT 1.0
);
```

### App-level: `~/.litria/litria.db`

```sql
CREATE TABLE projects (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_opened_at TEXT NOT NULL,
    framework TEXT,
    pinned INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

---

## 5. Rust Command Interface

The React frontend communicates with SQLite through Tauri `#[command]` functions. Each command maps to one logical user action and one IPC round-trip.

### Project lifecycle

| Command | Input | Output | SQL |
|---------|-------|--------|-----|
| `open_project(path)` | folder path | full project state | Multi-SELECT across all tables |
| `close_project()` | — | — | Close connection |
| `bootstrap_project(path)` | folder path | new project state | CREATE tables + INSERT defaults |

### Piece operations

| Command | Input | Output | SQL |
|---------|-------|--------|-----|
| `create_piece(file_path, label, x, y)` | piece data | new piece ID | INSERT INTO pieces |
| `create_pieces_batch(pieces)` | Vec of piece data | Vec of IDs | INSERT in transaction |
| `batch_move_pieces(moves)` | Vec of (id, x, y) | — | UPDATE in transaction |
| `update_piece(id, fields)` | piece ID + changed fields | — | UPDATE pieces SET ... WHERE id=? |
| `delete_piece(id)` | piece ID | — | DELETE (cascades to group_pieces) |
| `set_piece_hidden(id, hidden)` | piece ID + bool | — | UPDATE pieces SET is_hidden=? |

### Group operations

| Command | Input | Output | SQL |
|---------|-------|--------|-----|
| `create_group(id, name, folder_path)` | group data | — | INSERT INTO groups |
| `add_piece_to_group(group_id, piece_id)` | IDs | — | INSERT INTO group_pieces (rejects duplicates) |
| `remove_piece_from_group(group_id, piece_id)` | IDs | — | DELETE FROM group_pieces |
| `delete_group(id)` | group ID | — | DELETE (cascades memberships) |
| `update_group(id, fields)` | group ID + changed fields | — | UPDATE groups SET ... |

### Editor state

| Command | Input | Output | SQL |
|---------|-------|--------|-----|
| `save_editor_state(key, value)` | key-value pair | — | INSERT OR REPLACE INTO editor_state |
| `load_editor_state()` | — | all key-value pairs | SELECT * FROM editor_state |

### Viewport

| Command | Input | Output | SQL |
|---------|-------|--------|-----|
| `save_viewport(x, y, scale)` | viewport state | — | INSERT OR REPLACE INTO viewport |

### App-level

| Command | Input | Output | SQL |
|---------|-------|--------|-----|
| `list_recent_projects()` | — | Vec of projects | SELECT FROM projects ORDER BY last_opened_at |
| `register_project(path, name)` | project data | — | INSERT OR REPLACE INTO projects |
| `remove_project(path)` | path | — | DELETE FROM projects |
| `pin_project(path, pinned)` | path + bool | — | UPDATE projects SET pinned=? |

---

## 6. Migration Path

### One-time converter: `litria.project.json` → SQLite

Existing projects have a `litria.project.json` file. On first open after the migration:

1. Detect `litria.project.json` exists but `.litria/workspace.db` does not
2. Parse the JSON manifest
3. Create `.litria/workspace.db` with schema
4. Migrate data:
   - `pieces[]` → INSERT INTO pieces (strip `code`/`workingCode`, keep path + position + color)
   - `groups[]` → INSERT INTO groups + INSERT INTO group_pieces (deduplicate pieceIds)
   - `editor` → INSERT INTO editor_state
   - `connections[]` → INSERT INTO connections
   - Viewport, hidden paths, settings → respective tables
5. Write `litria.toml` from project metadata
6. Rename `litria.project.json` → `litria.project.json.migrated` (keep as backup, don't delete)
7. Register in app-level `litria.db`

The converter handles the legacy `cm.project.json` path as well (already supported in current Rust code).

### Legacy `nextPieceId` / `nextGroupId`

The JSON manifest tracks auto-increment counters manually (`nextPieceId`, `nextGroupId`). SQLite handles this natively via `AUTOINCREMENT` for pieces. Group IDs are strings in the current schema and remain application-generated.

---

## 7. Current Code Surface Area

### Files that must change

**Rust side (replace manifest I/O with SQLite):**

| File | Current role | Migration |
|------|-------------|-----------|
| `src-tauri/src/project_ops.rs` | `create_project_instance`, `read_project_manifest`, `write_project_manifest` | Replace with SQLite connection management + migration converter |
| `src-tauri/src/write_ops.rs` | Atomic file writes, backup creation, write locks | Remove manifest-specific write logic. Atomic writes still needed for `litria.toml` and file I/O |
| `src-tauri/src/commands.rs` | Tauri command handlers for manifest read/write | Replace with granular piece/group/editor commands |
| `src-tauri/src/project_tree.rs` | Excludes manifest filenames from tree scan | Update ignored names list (`.litria/` directory instead of manifest files) |
| `src-tauri/src/lib.rs` | Command registration | Register new SQLite-backed commands |
| `src-tauri/Cargo.toml` | Dependencies | Add `rusqlite` with `bundled` feature |

**JavaScript side (replace manifest hydration/persistence with Tauri invocations):**

| File | Current role | Migration |
|------|-------------|-----------|
| `src/project/manifest.js` | Manifest constants, normalization | Remove or reduce to `litria.toml` constants only |
| `src/project/storage.js` | `readProjectManifest`, `writeProjectManifest` | Remove manifest I/O. File I/O (`readProjectFile`, `writeProjectFile`) unchanged |
| `src/project/projectDomain.js` | All manifest read/write commands (load, save, persist workspace/editor, updatePieceFileMap) | Replace with Tauri `invoke()` calls to new SQLite commands |
| `src/project/useProjectPersistence.js` | Debounced manifest writes, hydration effects | Simplify — direct invocations replace debounced full-state writes |
| `src/app/useProjectLaunch.js` | Manifest validation gate at line 123 | Replace with `.litria/` directory detection or bootstrap flow |
| `src/app/filesystemWriteManager.js` | `queueManifestCommand` for piece file map updates | Replace with direct `invoke()` to piece update commands |
| `src/app/useThemeActions.js` | Manifest update for theme/appearance | Replace with `invoke()` to preference/setting commands |
| `src/app/useGroupMenuActions.js` | Manifest update for group changes | Replace with `invoke()` to group commands |
| `src/app/usePieceUiActions.js` | Manifest update for piece changes | Replace with `invoke()` to piece commands |

---

## 8. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Migration converter loses data from existing projects | Low | High | Keep original JSON as `.migrated` backup. Validate row counts post-migration. |
| Schema evolution breaks existing `.litria/workspace.db` files | Medium | High | Version the schema via `schema_version` table. Run migration scripts on open if version < current. |
| Rust command surface area is large (many individual commands) | Medium | Medium | Group related operations into batch commands. Start with coarse commands, refine granularity as needed. |
| Debounce removal causes excessive IPC for rapid interactions (e.g., drag) | Medium | Low | Batch position updates client-side during drag, fire single `batch_move_pieces` on drag end. |
| `.litria/` directory not gitignored by default | Low | Low | Bootstrap flow adds `.litria/` to `.gitignore` if one exists. Document recommendation. |

---

## 9. Non-Goals

- Real-time collaboration or multi-user access to the same project database
- Full-text search of file contents via SQLite (the filesystem owns code)
- Plugin/extension storage in the workspace database (future concern)
- Encryption of the workspace database
- Remote/cloud sync of workspace state

---

## 10. References

- ADR-015: SQLite Persistence Layer
- ADR-016: Open-Any-Folder Project Bootstrapping
- PRD-SP-001: SQLite Persistence Migration
- Current manifest code: `src/project/projectDomain.js`, `src-tauri/src/project_ops.rs`
- Trigger: Duplicate piece ID bug in folder-to-canvas spawn (2026-04-05)
