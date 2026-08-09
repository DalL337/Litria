# Product Requirements Document: SQLite Persistence Migration

**PRD-SP-001 | Version 1.0 | April 5, 2026**

| Field | Value |
|---|---|
| Document ID | PRD-SP-001 |
| Version | 1.0 |
| Date | April 5, 2026 |
| Status | Proposed |
| Project | Litria |
| Component | Persistence layer — replace JSON manifest with SQLite + TOML |
| Tech Stack | Rust (`rusqlite` with `bundled` feature), Tauri v2 `#[command]`, React 19 |
| Prerequisites | ADR-015, ADR-016 |

---

## 1. Purpose and Scope

### 1.1 Purpose

Replace the `litria.project.json` manifest with a SQLite-backed persistence layer that provides referential integrity, partial writes, crash safety, and cross-project querying — while establishing the open-any-folder bootstrapping flow that removes the project creation gate for existing codebases.

### 1.2 Problems Solved

1. **Silent data corruption** — Group membership stored as plain arrays accepts duplicate IDs, orphan references, and phantom entries. A folder-to-canvas spawn bug inserted 21 duplicate piece IDs, causing cascading UI failures. SQLite's UNIQUE constraints and foreign keys make this class of bug structurally impossible.

2. **Full-file rewrites on every mutation** — Every state change (piece drag, tab switch, group collapse) serializes the entire state tree and overwrites the manifest file. A 2-piece test project produces 43 KB. SQLite writes only the changed rows.

3. **No crash safety** — A crash during manifest write produces a truncated file. SQLite's WAL journaling guarantees atomic commits.

4. **Shadow copies of file content** — The manifest stores `code` and `workingCode` fields with full file contents, diverging from the filesystem source of truth. The new architecture stores file paths only — the filesystem owns all code.

5. **Onboarding wall for existing projects** — Users cannot open an existing codebase without creating a `litria.project.json` through the wizard. The open-any-folder flow bootstraps `.litria/` automatically.

6. **No cross-project index** — The planned project switcher dropdown requires reading project metadata without fully parsing each manifest. The app-level database provides this.

### 1.3 Scope

- Per-project SQLite database (`.litria/workspace.db`) for canvas/editor state
- App-level SQLite database (`~/.litria/litria.db`) for recent projects and preferences
- `litria.toml` marker file for human-readable project identity
- Open-any-folder bootstrapping flow (ADR-016)
- One-time migration converter from `litria.project.json` to SQLite
- Rust `#[command]` interface for all database operations
- JavaScript domain layer refactor to use Tauri invocations instead of manifest I/O

### 1.4 Out of Scope

- Project switcher dropdown UI (separate feature, consumes the app-level DB)
- Live project switching UX and teardown animations
- Database encryption or access control
- Plugin/extension storage
- Multi-user or collaborative access
- Remote sync or cloud backup
- Changes to canvas rendering, piece/group domain logic, or editor drawer behavior

---

## 2. User Stories

### US-1: Open an existing project without a wizard
**As a** developer with an existing codebase, **I want to** open my project folder in Litria without going through the New Project Wizard, **so that** I can start working immediately.

### US-2: Reliable piece and group state
**As a** Litria user, **I want** my canvas layout (piece positions, group memberships, visibility) to be persisted reliably without data corruption, **so that** I don't encounter phantom files, broken grids, or lost arrangements.

### US-3: Fast saves that don't block interaction
**As a** Litria user dragging pieces on the canvas, **I want** saves to happen instantly without lag, **so that** the canvas feels responsive regardless of project size.

### US-4: Crash-safe persistence
**As a** Litria user, **I want** my project state to survive unexpected crashes without file corruption, **so that** I don't lose my workspace layout.

### US-5: Session restoration
**As a** Litria user reopening a project, **I want** my open tabs, active tab, and viewport position to be restored, **so that** I pick up where I left off.

### US-6: Migrate existing projects seamlessly
**As a** Litria user with projects created under the JSON manifest, **I want** them to be automatically migrated to the new format on first open, **so that** I don't lose any workspace state.

---

## 3. Milestones

### Milestone 1: Rust Foundation
**Goal:** `rusqlite` integrated, schema defined, basic CRUD commands working.

- [ ] Add `rusqlite` with `bundled` feature to `src-tauri/Cargo.toml`
- [ ] Define schema SQL as embedded Rust constants
- [ ] Implement database connection management (open, close, per-project state)
- [ ] Implement `bootstrap_project` command — creates `.litria/`, `workspace.db`, `litria.toml`
- [ ] Implement piece CRUD commands (`create_piece`, `create_pieces_batch`, `batch_move_pieces`, `update_piece`, `delete_piece`, `set_piece_hidden`)
- [ ] Implement group CRUD commands (`create_group`, `update_group`, `delete_group`, `add_piece_to_group`, `remove_piece_from_group`)
- [ ] Implement connection commands (`create_connection`, `delete_connection`)
- [ ] Implement editor state commands (`save_editor_state`, `load_editor_state`)
- [ ] Implement viewport command (`save_viewport`)
- [ ] Implement hidden paths commands (`add_hidden_path`, `remove_hidden_path`, `list_hidden_paths`)
- [ ] Implement `open_project` command — opens `workspace.db`, returns full state
- [ ] Implement `close_project` command — flushes and closes connection
- [ ] Register all new commands in `lib.rs`
- [ ] Unit tests for all Rust commands (in-memory SQLite)

### Milestone 2: App-Level Database
**Goal:** Recent projects list and global preferences working.

- [ ] Implement app-level database initialization (`~/.litria/litria.db`)
- [ ] Implement `register_project` command
- [ ] Implement `list_recent_projects` command
- [ ] Implement `remove_project` command
- [ ] Implement `pin_project` command
- [ ] Implement `save_preference` / `load_preferences` commands
- [ ] Auto-register project in app-level DB during `open_project` / `bootstrap_project`
- [ ] Unit tests for app-level commands

### Milestone 3: JavaScript Domain Refactor
**Goal:** React domain layer talks to SQLite via Tauri commands instead of JSON manifest.

- [ ] Refactor `projectDomain.js` — replace `loadWorkspaceState` / `persistWorkspaceState` with `invoke('open_project')` / granular `invoke()` calls
- [ ] Refactor `projectDomain.js` — replace `loadEditorState` / `persistEditorState` with `invoke('save_editor_state')` / `invoke('load_editor_state')`
- [ ] Refactor `projectDomain.js` — remove `updatePieceFileMap`, `updateManifest`, `saveTabState` (piece file map is now implicit from `pieces.file_path`)
- [ ] Refactor `useProjectPersistence.js` — replace debounced full-state writes with direct invocations on state change
- [ ] Refactor `useProjectLaunch.js` — replace manifest validation gate with `.litria/` detection + bootstrap flow
- [ ] Refactor `filesystemWriteManager.js` — replace `queueManifestCommand` calls with `invoke('update_piece')` for file path changes
- [ ] Refactor `useThemeActions.js` — replace manifest update with `invoke('save_preference')`
- [ ] Refactor `useGroupMenuActions.js` — replace manifest update with group `invoke()` calls
- [ ] Refactor `usePieceUiActions.js` — replace manifest update with piece `invoke()` calls
- [ ] Refactor `useScaffoldActions.js` — folder spawn uses `invoke('create_pieces_batch')` + `invoke('add_piece_to_group')` instead of building arrays
- [ ] Remove or gut `src/project/manifest.js` (retain only `litria.toml` constants if needed)
- [ ] Remove or gut `src/project/storage.js` manifest functions (retain file I/O functions)
- [ ] Remove `code` and `workingCode` from piece hydration — editor reads from disk on open

### Milestone 4: Migration Converter
**Goal:** Existing projects with `litria.project.json` migrate automatically on first open.

- [ ] Implement Rust migration function: detect `litria.project.json` without `.litria/workspace.db`
- [ ] Parse JSON manifest and extract pieces, groups, connections, editor state, viewport, hidden paths
- [ ] Insert extracted data into new SQLite schema (deduplicate group pieceIds during migration)
- [ ] Write `litria.toml` from manifest metadata
- [ ] Rename `litria.project.json` → `litria.project.json.migrated`
- [ ] Handle legacy `cm.project.json` path (existing migration logic)
- [ ] Register migrated project in app-level database
- [ ] Integration test: round-trip a known manifest through converter, verify all data preserved

### Milestone 5: Cleanup and Validation
**Goal:** Old manifest code removed, all paths tested end-to-end.

- [ ] Remove dead manifest code from Rust (`read_project_manifest`, `write_project_manifest`, `create_project_instance` old path)
- [ ] Remove dead manifest code from JavaScript (manifest normalization, JSON serialization)
- [ ] Update `project_tree.rs` ignored names — exclude `.litria/` directory instead of manifest filenames
- [ ] Update `.gitignore` template to include `.litria/`
- [ ] End-to-end test: create new project via wizard → verify `.litria/workspace.db` created
- [ ] End-to-end test: open existing folder → verify bootstrap flow creates `.litria/`
- [ ] End-to-end test: open project with `litria.project.json` → verify auto-migration
- [ ] End-to-end test: piece drag → verify only piece row updated (no full-state write)
- [ ] End-to-end test: create group with duplicate piece IDs → verify constraint rejection
- [ ] Verify app binary size increase is within budget (~1-1.5 MB)
- [ ] Verify RAM footprint increase is within budget (~500 KB-1 MB)

---

## 4. Success Metrics

| Metric | Target | How to measure |
|--------|--------|----------------|
| Duplicate piece ID in group | Impossible | UNIQUE constraint rejects at DB layer |
| Save latency (single piece move) | < 5ms | Rust-side timing in `batch_move_pieces` |
| Project open time (500 pieces) | < 50ms | Rust-side timing in `open_project` |
| Binary size increase | < 2 MB | Compare installer sizes before/after |
| RAM increase | < 2 MB | Compare idle memory before/after |
| Existing project migration | 100% data preserved | Automated test comparing JSON → SQLite → re-read |
| Open-any-folder bootstrap | < 100ms | Rust-side timing in `bootstrap_project` |

---

## 5. Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `rusqlite` | Latest stable | SQLite bindings for Rust |
| `rusqlite` feature: `bundled` | — | Compiles SQLite into the binary, no system dependency |
| `toml` (Rust crate) | Latest stable | Write `litria.toml` marker file |

No new JavaScript dependencies required.

---

## 6. Risks

| Risk | Mitigation |
|------|------------|
| Migration converter loses data | Keep original JSON as `.migrated` backup; validate row counts post-migration |
| Schema evolution breaks existing `.litria/workspace.db` | Version via `schema_version` table; run migration scripts on open |
| Excessive IPC during rapid canvas interactions | Batch position updates client-side during drag; fire single command on drag-end |
| `.litria/` accidentally committed to git | Bootstrap adds `.litria/` to `.gitignore` if one exists |
| Developers accustomed to hand-editing the manifest | `litria.toml` covers metadata; SQLite CLI available for debugging; `.migrated` backup preserved |

---

## 7. References

- ADR-015: SQLite Persistence Layer
- ADR-016: Open-Any-Folder Project Bootstrapping
- RFC: `sqlite-persistence-migration.md`
- Trigger: Duplicate piece ID bug in folder-to-canvas spawn (2026-04-05)
- Current manifest code: `src/project/projectDomain.js` (450 lines), `src-tauri/src/project_ops.rs` (254 lines)
