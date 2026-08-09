# SQLite Persistence Migration — Build Plan

## Status
- Planning (2026-04-05)
- PRD: `docs/prds/sqlite-persistence-migration-prd.md`
- ADRs: `docs/adrs/015-sqlite-persistence-layer.md`, `docs/adrs/016-open-any-folder-project-bootstrapping.md`
- RFC: `docs/rfcs/sqlite-persistence-migration.md`

## Context

Replace the `litria.project.json` manifest with a two-tier SQLite architecture (`rusqlite` compiled into the Tauri binary). The migration spans both the Rust backend and the JavaScript domain layer. Slices are ordered by dependency — each slice produces a testable artifact.

The current manifest code surface area (~15 files across Rust and JS) is well-documented in the RFC Section 7.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  React Domain Layer                                          │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐   │
│  │ pieceDomain│  │groupDomain │  │ useProjectPersistence│   │
│  └─────┬──────┘  └─────┬──────┘  └──────────┬───────────┘   │
│        │               │                    │                │
│        └───────────────┼────────────────────┘                │
│                        │  invoke()                           │
├────────────────────────┼─────────────────────────────────────┤
│  Tauri IPC Bridge      │                                     │
├────────────────────────┼─────────────────────────────────────┤
│  Rust #[command] Layer │                                     │
│        ┌───────────────▼───────────────┐                     │
│        │      db.rs (connection mgmt)  │                     │
│        └───────────────┬───────────────┘                     │
│                        │                                     │
│        ┌───────────────▼───────────────┐                     │
│        │     rusqlite (bundled SQLite)  │                     │
│        └───────────────┬───────────────┘                     │
│                        │                                     │
│    ┌───────────────────┼────────────────────┐                │
│    ▼                   ▼                    ▼                │
│  .litria/           litria.toml         ~/.litria/           │
│  workspace.db       (marker)            litria.db            │
│  (per-project)                          (app-level)          │
└──────────────────────────────────────────────────────────────┘
```

---

## Slice A: Rust Dependency + Schema + Connection Management

**Goal**: `rusqlite` compiles, schema creates, connections open and close. No commands yet — just the foundation.

**Why first**: Everything depends on being able to open a database and create tables.

### A1. Add `rusqlite` dependency

Add to `src-tauri/Cargo.toml`:

```toml
[dependencies]
rusqlite = { version = "0.31", features = ["bundled"] }
```

Verify: `cargo build` succeeds with the new dependency. Check binary size delta.

### A2. Schema module

Create `src-tauri/src/db/schema.rs`:

- Embed schema SQL as `const SCHEMA_V1: &str`
- Include all tables: `schema_version`, `project`, `pieces`, `groups`, `group_pieces`, `connections`, `editor_state`, `hidden_paths`, `viewport`
- `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON`
- Function: `initialize_schema(conn: &Connection) -> Result<()>`
- Function: `get_schema_version(conn: &Connection) -> Result<i32>`

### A3. Connection management module

Create `src-tauri/src/db/mod.rs`:

- `ProjectDb` struct wrapping `rusqlite::Connection`
- `open_or_create(path: &Path) -> Result<ProjectDb>` — opens existing or creates new `.litria/workspace.db`
- `close(self)` — explicit close (also happens on drop)
- Tauri managed state: `Mutex<Option<ProjectDb>>` for the currently open project

### A4. App-level database

Create `src-tauri/src/db/app_db.rs`:

- Schema for `projects` and `preferences` tables
- `AppDb` struct wrapping connection to `~/.litria/litria.db`
- `open_or_create()` — creates app data directory if needed, opens DB
- Tauri managed state: `Mutex<AppDb>` (always open while app runs)

### A5. Verify

- `cargo build` succeeds
- `cargo test` — unit test creates in-memory DB, runs schema, verifies tables exist
- Binary size increase measured and logged

---

## Slice B: Piece + Group CRUD Commands

**Goal**: Full piece and group CRUD available as Tauri commands. Testable independently of the JS frontend.

**Why second**: Pieces and groups are the core data model. Everything else is built on top.

### B1. Piece commands

Create `src-tauri/src/db/piece_commands.rs`:

```rust
#[tauri::command]
fn create_piece(file_path: String, label: String, x: f64, y: f64, color: Option<String>) -> Result<i64, String>

#[tauri::command]
fn create_pieces_batch(pieces: Vec<PieceInput>) -> Result<Vec<i64>, String>

#[tauri::command]
fn batch_move_pieces(moves: Vec<PieceMove>) -> Result<(), String>

#[tauri::command]
fn update_piece(id: i64, fields: PieceUpdate) -> Result<(), String>

#[tauri::command]
fn delete_piece(id: i64) -> Result<(), String>

#[tauri::command]
fn set_piece_hidden(id: i64, hidden: bool) -> Result<(), String>
```

All batch operations wrapped in a single transaction.

### B2. Group commands

Create `src-tauri/src/db/group_commands.rs`:

```rust
#[tauri::command]
fn create_group(id: String, name: String, folder_path: Option<String>, is_collapsed: bool) -> Result<(), String>

#[tauri::command]
fn add_piece_to_group(group_id: String, piece_id: i64) -> Result<(), String>
// Returns error if UNIQUE(group_id, piece_id) violated — this is the key integrity guarantee

#[tauri::command]
fn remove_piece_from_group(group_id: String, piece_id: i64) -> Result<(), String>

#[tauri::command]
fn delete_group(id: String) -> Result<(), String>
// CASCADE deletes group_pieces rows

#[tauri::command]
fn update_group(id: String, fields: GroupUpdate) -> Result<(), String>
```

### B3. Connection commands

```rust
#[tauri::command]
fn create_connection(from_piece_id: i64, to_piece_id: i64) -> Result<i64, String>

#[tauri::command]
fn delete_connection(id: i64) -> Result<(), String>
```

### B4. Register commands in `lib.rs`

Add all new commands to `invoke_handler![]`.

### B5. Verify

- Unit tests: create pieces, create groups, add pieces to groups, verify UNIQUE constraint rejects duplicates
- Unit tests: delete piece → verify CASCADE removes group_pieces rows
- Unit tests: batch operations → verify transaction atomicity (partial failure rolls back)

---

## Slice C: State Commands (Editor, Viewport, Hidden Paths, Preferences)

**Goal**: All remaining state persistence commands. After this slice, the Rust layer is feature-complete.

### C1. Editor state commands

```rust
#[tauri::command]
fn save_editor_state(key: String, value: String) -> Result<(), String>
// INSERT OR REPLACE into editor_state

#[tauri::command]
fn load_editor_state() -> Result<HashMap<String, String>, String>
```

Keys: `active_tab_piece_id`, `open_tab_piece_ids` (JSON array as string), `last_session_at`.

### C2. Viewport command

```rust
#[tauri::command]
fn save_viewport(x: f64, y: f64, scale: f64) -> Result<(), String>
// INSERT OR REPLACE into viewport (single-row table)
```

### C3. Hidden paths commands

```rust
#[tauri::command]
fn add_hidden_path(path: String) -> Result<(), String>

#[tauri::command]
fn remove_hidden_path(path: String) -> Result<(), String>

#[tauri::command]
fn list_hidden_paths() -> Result<Vec<String>, String>
```

### C4. Project open/close (composite commands)

```rust
#[tauri::command]
fn open_project(path: String) -> Result<ProjectState, String>
// Opens workspace.db, SELECTs all tables, returns full state as one struct

#[tauri::command]
fn close_project() -> Result<(), String>
// Drops connection

#[tauri::command]
fn bootstrap_project(path: String, name: String) -> Result<ProjectState, String>
// Creates .litria/, workspace.db with schema, litria.toml
// Returns empty state ready for canvas
```

`ProjectState` is a Rust struct with all domain data, serialized to JS as one JSON object:

```rust
#[derive(Serialize)]
struct ProjectState {
    project: ProjectMeta,
    pieces: Vec<Piece>,
    groups: Vec<Group>,
    group_pieces: Vec<GroupPiece>,
    connections: Vec<Connection>,
    editor_state: HashMap<String, String>,
    hidden_paths: Vec<String>,
    viewport: Option<Viewport>,
}
```

### C5. App-level commands

```rust
#[tauri::command]
fn list_recent_projects() -> Result<Vec<RecentProject>, String>

#[tauri::command]
fn register_project(path: String, name: String, framework: Option<String>) -> Result<(), String>

#[tauri::command]
fn remove_project(path: String) -> Result<(), String>

#[tauri::command]
fn pin_project(path: String, pinned: bool) -> Result<(), String>

#[tauri::command]
fn save_preference(key: String, value: String) -> Result<(), String>

#[tauri::command]
fn load_preferences() -> Result<HashMap<String, String>, String>
```

### C6. `litria.toml` writer

Utility function (not a command) called by `bootstrap_project` and the migration converter:

```rust
fn write_litria_toml(path: &Path, name: &str, schema_version: i32) -> Result<()>
```

Writes a minimal TOML marker file. Uses `atomic_write_string` from existing `write_ops.rs`.

### C7. Register all remaining commands in `lib.rs`

### C8. Verify

- Unit tests for all state commands
- Integration test: `bootstrap_project` → `open_project` → verify round-trip
- Integration test: `open_project` returns correct `ProjectState` struct

---

## Slice D: Migration Converter

**Goal**: Existing `litria.project.json` (and legacy `cm.project.json`) projects auto-migrate on first open.

**Why here**: Depends on all CRUD commands from Slices B and C. Must work before the JS layer is refactored.

### D1. Detection logic

In the `open_project` command flow:

```
1. Check for .litria/workspace.db → if exists, open normally (returning project)
2. Check for litria.toml without .litria/ → rebuild workspace.db from marker metadata
3. Check for litria.project.json → trigger migration
4. Check for cm.project.json → trigger migration (legacy path)
5. None of the above → bootstrap as new project (ADR-016 flow)
```

### D2. JSON parser

```rust
fn parse_manifest_json(json: &str) -> Result<ManifestData>
```

Extracts:
- `pieces[]` → strip `code`/`workingCode`, keep `id`, `filename`→`file_path`, `label`, `x`, `y`, `scale`, `color`
- `groups[]` → `id`, `name`, `folderPath`→`folder_path`, `isCollapsed`, `parentId`, `color`
- `groups[].pieceIds` → deduplicated before insertion into `group_pieces`
- `connections[]` → `id`, `fromPieceId`, `toPieceId`
- `editor` → `openTabPieceIds`, `activeTabPieceId`, `lastSessionAt`
- `scaffold.hiddenPaths` → array of path strings
- `viewport` → `x`, `y`, `scale` (extracted from settings/appearance)
- Project metadata → `instanceId`, `name`, `appVersion`, `language`, `framework`, `createdAt`

### D3. Migration writer

```rust
fn migrate_json_to_sqlite(project_root: &Path, manifest: ManifestData) -> Result<ProjectState>
```

1. Create `.litria/` directory
2. Create `workspace.db` with schema
3. INSERT project metadata
4. INSERT pieces (remap old sequential IDs to new AUTOINCREMENT IDs, maintain a mapping)
5. INSERT groups
6. INSERT group_pieces using ID mapping (deduplicated — skip duplicates silently)
7. INSERT connections using ID mapping
8. INSERT editor_state key-value pairs (remap piece IDs in `openTabPieceIds`)
9. INSERT hidden_paths
10. INSERT viewport
11. Write `litria.toml`
12. Rename `litria.project.json` → `litria.project.json.migrated`
13. Register in app-level database
14. Return `ProjectState` (ready for immediate use)

### D4. Validation

Post-migration checks:
- Row count in `pieces` matches unique piece count in JSON (not the duplicated count)
- Row count in `group_pieces` matches deduplicated membership count
- All foreign keys resolve (no orphan group_pieces)
- `litria.toml` exists and is valid
- `.migrated` backup exists

### D5. Verify

- Unit test: round-trip a known manifest JSON through converter, assert all data preserved
- Unit test: manifest with duplicate pieceIds → verify deduplication (21 dupes → 1 row)
- Unit test: manifest with orphan pieceIds (ID references nonexistent piece) → verify graceful skip
- Unit test: legacy `cm.project.json` path works
- Integration test: place a `litria.project.json` in a test directory, call `open_project`, verify SQLite created and JSON renamed

---

## Slice E: JavaScript Domain Refactor

**Goal**: The React layer talks to SQLite through Tauri commands. The JSON manifest code is disconnected.

**Why here**: The Rust layer must be feature-complete (Slices A-D) before the JS layer can switch to it.

This is the largest slice. It touches the most files but each change is mechanical — replace a manifest read/write with a `invoke()` call.

### E1. Project open flow

**File**: `src/app/useProjectLaunch.js`

Replace:
```javascript
// Old: readProjectManifest(path) → validate → set state
```
With:
```javascript
// New: invoke('open_project', { path }) → returns ProjectState or triggers bootstrap
```

Detection logic:
- `invoke('open_project', { path })` handles all detection (returning project, migration, bootstrap) on the Rust side
- JS receives a `ProjectState` object regardless of which path was taken
- Remove the `litria.project.json` existence check at line 123
- Remove the error message referencing `litria.project.json` at line 130

### E2. State hydration

**File**: `src/project/projectDomain.js`

Replace `commands.loadWorkspaceState()` (lines 171-265):
- The `ProjectState` returned by `open_project` already contains all data
- Hydrate `pieceDomain`, `groupDomain`, `connectionDomain`, `viewportDomain` directly from the response
- No separate manifest read step

Replace `commands.loadEditorState()` (lines 266-322):
- Editor state comes from `ProjectState.editor_state` (key-value pairs)
- `open_tab_piece_ids` is a JSON string in the DB → parse on the JS side

### E3. State persistence

**File**: `src/project/useProjectPersistence.js`

The debounced full-state write pattern (400ms debounce → serialize everything → rewrite manifest) is replaced with granular writes:

| Trigger | Old path | New path |
|---------|----------|----------|
| Piece drag ends | `persistWorkspaceState()` (full rewrite) | `invoke('batch_move_pieces', moves)` |
| Tab opened/closed | `persistEditorState()` (full rewrite) | `invoke('save_editor_state', { key: 'open_tab_piece_ids', value })` |
| Group collapsed | `persistWorkspaceState()` (full rewrite) | `invoke('update_group', { id, fields: { is_collapsed } })` |
| Piece created | `persistWorkspaceState()` (full rewrite) | `invoke('create_piece', piece)` |
| Viewport changed | `persistWorkspaceState()` (full rewrite) | `invoke('save_viewport', { x, y, scale })` — debounce this one (pan/zoom is high-frequency) |

Remove `queueManifestCommand()` and the manifest command queue entirely.

### E4. Domain-specific refactors

**`src/app/filesystemWriteManager.js`**:
- Move pipeline (lines 244-248): replace `queueManifestCommand → updatePieceFileMap` with `invoke('update_piece', { id, fields: { file_path, label } })`
- Delete pipeline (lines 408-412): replace with `invoke('delete_piece', { id })`

**`src/app/useThemeActions.js`**:
- Replace manifest update (lines 53-56) with `invoke('save_preference', { key: 'theme', value })`

**`src/app/useGroupMenuActions.js`**:
- Replace manifest updates with `invoke('create_group')`, `invoke('update_group')`, `invoke('delete_group')`, `invoke('add_piece_to_group')`, `invoke('remove_piece_from_group')`

**`src/app/usePieceUiActions.js`**:
- Replace manifest updates with piece `invoke()` calls

**`src/app/useScaffoldActions.js`**:
- The folder-to-canvas spawn now calls `invoke('create_pieces_batch')` + `invoke('add_piece_to_group')` for each created piece
- The UNIQUE constraint on `group_pieces` prevents the duplicate ID bug at the storage layer

### E5. Remove dead code

- `src/project/manifest.js` — remove or reduce to TOML-related constants
- `src/project/storage.js` — remove `readProjectManifest`, `writeProjectManifest`, `getManifestPath`. Keep `readProjectFile`, `writeProjectFile`, `listProjectTree`
- `src/project/projectDomain.js` — remove `updateManifest`, `updatePieceFileMap`, `saveTabState`, `persistWorkspaceState`, `persistEditorState`

### E6. Verify

- Manual test: open bootstrapped project → empty canvas, scaffold drawer shows file tree
- Manual test: drag piece, close app, reopen → position restored
- Manual test: open tabs, close app, reopen → tabs restored
- Manual test: create group, add pieces, close and reopen → group intact
- Verify no references to `readProjectManifest` or `writeProjectManifest` remain in JS code

---

## Slice F: Rust Cleanup

**Goal**: Remove all dead manifest code from the Rust side.

### F1. Remove from `project_ops.rs`

- Remove `create_project_instance()` (replaced by `bootstrap_project`)
- Remove `read_project_manifest()` (replaced by `open_project`)
- Remove `write_project_manifest()` (no longer needed)
- Remove manifest-related constants (`MANIFEST_FILENAME`, `MANIFEST_BACKUP_FILENAME`, `LEGACY_MANIFEST_FILENAME`)
- Keep `read_project_file()`, `write_project_file()` (file I/O still needed)

### F2. Update `write_ops.rs`

- Remove manifest-specific write logic if no longer used
- Keep `atomic_write_string` for `litria.toml` writes and general file I/O

### F3. Update `project_tree.rs`

- Remove manifest filenames from `IGNORED_NAMES`
- Add `.litria` directory to ignored names

### F4. Update `commands.rs`

- Remove old manifest command handlers
- Old commands replaced by Slice B/C commands

### F5. Update `lib.rs`

- Remove old command registrations
- Verify new commands are registered

### F6. Verify

- `cargo build` — no dead code warnings related to removed functions
- `cargo test` — all tests pass
- Full integration test: fresh clone → `cargo build` → app launches → project open works

---

## Slice Dependency Graph

```
A (foundation) ──→ B (piece/group CRUD) ──→ C (state commands)
                                                     │
                                                     ▼
                                              D (migration converter)
                                                     │
                                                     ▼
                                              E (JS domain refactor)
                                                     │
                                                     ▼
                                              F (Rust cleanup)
```

A → B → C are sequential (each builds on the previous).
D depends on B + C (needs all CRUD commands for the converter).
E depends on A + B + C + D (needs the full Rust layer).
F depends on E (can't remove old code until new code is wired up).

---

## Size and Performance Budget

| Metric | Before | After (expected) | Budget |
|--------|--------|-------------------|--------|
| Installed binary size | ~160 MB | ~161.5 MB | < 163 MB |
| Idle RAM | ~100 MB | ~101 MB | < 103 MB |
| Save latency (piece drag) | 400ms debounce + full file write | < 5ms (single row UPDATE) | < 10ms |
| Project open (500 pieces) | Full JSON parse | < 50ms (SQL SELECTs) | < 100ms |
| Bootstrap new project | N/A (wizard required) | < 100ms (create DB + schema) | < 200ms |

---

## Testing Strategy

### Unit tests (Rust, in-memory SQLite)
- Schema creation and version check
- All CRUD commands: create, read, update, delete
- Constraint enforcement: duplicate group_pieces rejected, CASCADE deletes work
- Transaction atomicity: partial failure rolls back
- Migration converter: known JSON → SQLite → verify all data

### Integration tests (Rust, temp directory)
- `bootstrap_project` creates `.litria/`, `workspace.db`, `litria.toml`
- `open_project` detects and handles: returning project, migration, fresh bootstrap
- `close_project` releases connection cleanly
- App-level DB: register, list, pin, remove projects

### Manual E2E tests
- Create project via wizard → verify SQLite path
- Open existing folder → verify bootstrap flow
- Open legacy `litria.project.json` project → verify auto-migration
- Piece operations: create, drag, hide, delete → verify persistence
- Group operations: create, add pieces, collapse, delete → verify cascade
- Session restore: open tabs, viewport, hidden paths survive close/reopen
- Constraint test: attempt duplicate group membership → verify rejection (Rust error returned, not silent corruption)
