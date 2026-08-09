# ADR-015: SQLite Persistence Layer — Replace JSON Manifest with Relational Storage

## Status
- Amended (2026-08-01 — the one-time JSON→SQLite migration converter is closed
  as obsolete: never built, and no live reader of the legacy manifest remains.
  See the erratum under Consequences → Neutral.)
- Accepted — Implemented (`4d837a1`, PR #35/#36, 2026-04-06)

## Date
- 2026-04-05

## Context

Litria persists all workspace state in a single `litria.project.json` file per project. This file stores project metadata, piece definitions (including full file contents), group memberships (as arrays of piece IDs), and editor session state. Every save operation serializes the entire state tree and overwrites the file.

This approach served prototyping well but has reached its limits:

**1. No referential integrity.** Group membership is stored as a plain array of piece IDs (`pieceIds: [1, 2, 2, 2, ...]`). Nothing prevents duplicate IDs, orphan references, or IDs pointing to nonexistent pieces. A bug in the folder-to-canvas spawn produced 21 duplicate entries for the same piece ID — the JSON accepted it silently. The cascading UI failures (broken grid layout, non-functional expand, phantom file counts) were only discovered by manual inspection of the manifest.

**2. Whole-file read/write on every mutation.** Dragging a single piece updates two coordinates, but the save path must serialize every piece, every group, every editor tab, and rewrite the entire file. For a test project with 2 pieces, the manifest is already 43 KB / 504 lines. This scales linearly with no optimization path.

**3. No crash safety.** If the application terminates during a write, the file may be truncated or partially written. There is no transaction boundary, no rollback capability, and no write-ahead log. A corrupted manifest means a lost project.

**4. Code content stored in the manifest.** The current schema includes `code` and `workingCode` fields containing full file contents. This creates a shadow copy of every open file, diverges from the filesystem source of truth, and inflates the manifest unnecessarily. It also presents a security concern — the manifest becomes a single file containing every source file in the project.

**5. No cross-project querying.** The planned project-switching feature (live dropdown populated with recent projects) requires reading project metadata without fully parsing each project's manifest. The current architecture has no app-level index.

## Decision

Replace `litria.project.json` with a two-tier SQLite architecture using `rusqlite` compiled into the Tauri binary.

### Tier 1: Per-project database

Location: `<project-root>/.litria/workspace.db`

Stores workspace layout and canvas state — the data only Litria cares about. The filesystem remains the sole source of truth for file contents. No code is stored in the database.

**Schema:**

```sql
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

-- Canvas pieces — one row per file on the canvas
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

-- Junction table: group ↔ piece membership
CREATE TABLE group_pieces (
    group_id TEXT NOT NULL,
    piece_id INTEGER NOT NULL,
    UNIQUE(group_id, piece_id),
    FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
    FOREIGN KEY (piece_id) REFERENCES pieces(id) ON DELETE CASCADE
);

-- Editor session state (key-value)
CREATE TABLE editor_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

Key properties:
- `group_pieces` UNIQUE constraint prevents duplicate membership — the bug that triggered this ADR becomes a constraint violation instead of silent corruption
- Foreign keys with CASCADE ensure deleting a piece automatically cleans up group memberships
- `pieces.file_path` is UNIQUE — one piece per file on disk
- No `code` or `working_code` columns — the filesystem owns file content
- `is_hidden` tracks scaffold drawer visibility without removing the piece row

### Tier 2: App-level database

Location: `~/.litria/litria.db` (platform-appropriate app data directory)

Stores cross-project state for the project switcher dropdown and global preferences.

```sql
-- Recent / known projects
CREATE TABLE projects (
    path TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    last_opened_at TEXT NOT NULL,
    framework TEXT,
    pinned INTEGER NOT NULL DEFAULT 0
);

-- Global preferences
CREATE TABLE preferences (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
```

### Tier 3: Project marker file

Location: `<project-root>/litria.toml`

A small, human-readable file that identifies a directory as a Litria project:

```toml
[project]
name = "myawesomeapp"
schema_version = 1
created_at = "2026-04-05T16:53:30Z"
```

This file is the marker — not the persistence layer. It can be committed to version control or gitignored at the user's discretion. Litria creates it automatically when opening a folder for the first time.

### Why `rusqlite` over `tauri-plugin-sql`

At scale (thousands of pieces), IPC overhead matters. `tauri-plugin-sql` routes every query through the Tauri IPC bridge as serialized strings. `rusqlite` behind `#[tauri::command]` functions keeps database operations in Rust, batches mutations in transactions, and crosses the IPC boundary once per user action with typed structs. A batch move of 200 pieces is one IPC call and one transaction, not 200 round-trips.

Binary size cost: ~1-1.5 MB added to the Tauri binary (SQLite compiled in). RAM cost: ~500 KB-1 MB runtime. Both negligible against Litria's current 160 MB installed / ~100 MB RAM footprint.

## Consequences

### Positive
- Referential integrity enforced at the storage layer — duplicate IDs, orphan references, and phantom group memberships are structurally impossible
- Partial writes — updating a piece position touches one row, not the entire project state
- ACID transactions — crash during save cannot corrupt the database; writes either commit or roll back
- No code in the persistence layer — the filesystem is the single source of truth for file content, eliminating shadow copies and the associated security/staleness risks
- Per-project `.litria/workspace.db` is self-contained and moves with the project folder
- App-level `litria.db` enables the project switcher dropdown without opening each project
- Project open/close becomes connection management — open a handle, close a handle
- SQLite handles thousands of rows without perceptible latency

### Negative
- Migration effort — the existing `litria.project.json` reader/writer and all domain code that hydrates from it must be replaced with Tauri command invocations backed by SQL
- Schema evolution requires migration management (versioned SQL scripts or a migration library)
- `.litria/workspace.db` is a binary file — not human-readable, not diffable, requires tooling to inspect
- Developers lose the ability to hand-edit the project manifest (mitigated by `litria.toml` for metadata and the SQLite CLI for debugging)
- `rusqlite` means writing Rust functions for every DB operation rather than issuing SQL from JavaScript

### Neutral
- Canvas rendering, piece/group domain logic, editor drawer, and scaffold drawer are unchanged — only the persistence boundary moves
- The `.litria/` directory convention is consistent with `.vscode/`, `.idea/`, and similar editor state directories
- Existing projects with `litria.project.json` will need a one-time migration (converter reads JSON, writes to SQLite)

> **Erratum (2026-08-01, closure — converter obsolete):** the converter was
> never built, and it is no longer needed. Verified 2026-08-01:
> `db_open_project` (`src-tauri/src/db/commands.rs`) implements exactly three
> tiers — returning project (`.litria/workspace.db`), rebuild from marker
> (`litria.toml`), fresh bootstrap (neither; ADR-016) — with no JSON read
> path, and a repo-wide search finds no live reader of `litria.project.json`
> (the string survives only as arbitrary temp-file names in `write_ops.rs`
> test fixtures). All real projects crossed the SQLite cutover at `4d837a1`
> (2026-04-06). A hypothetical untouched manifest-era folder opens through the
> fresh-bootstrap tier: file contents are untouched (the filesystem was
> already the source of truth; manifest `code` fields were shadow copies) and
> only canvas layout/session state would need re-creating. No such folder is
> known to exist. Closed as obsolete rather than built.

## Alternatives Considered

### Add validation to the JSON manifest
Deduplication on save, ID resolution checks, schema validation. This addresses the symptom (duplicate IDs) but not the structural issues (whole-file writes, no transactions, no cross-project querying). It also places correctness responsibility on application code rather than the storage layer. Rejected — it patches the current approach without solving the scaling or crash-safety problems.

### Use `tauri-plugin-sql` instead of `rusqlite`
Lower Rust boilerplate — SQL queries issued directly from JavaScript. However, every query crosses the IPC bridge as a serialized string. No real transaction control from the JS side. At scale, the IPC overhead becomes the bottleneck. Rejected for performance-critical canvas operations; acceptable for low-frequency app-level queries if needed in the future.

### Use a key-value store (LevelDB, RocksDB, redb, sled)
No relational integrity — the duplicate-ID bug would still be possible. No SQL querying for cross-project lookups. Sled's maintainer has stepped back. Rejected — the core problem is relational, and the solution should be too.

### Use SpacetimeDB
Designed for real-time multiplayer, not local desktop persistence. Significant dependency for a single-user workspace file. Rejected — overkill for the use case.

## Scope Notes
- This ADR covers the persistence architecture only. UI changes for the project switcher dropdown are out of scope.
- The open-any-folder bootstrapping flow is covered in ADR-016.
- Schema migrations and versioning strategy will be defined in the build plan.

## References
- Trigger: Duplicate piece ID bug in `litria.project.json` (folder-to-canvas spawn, 2026-04-05)
- Related: ADR-016 (Open-Any-Folder Project Bootstrapping)
- Related: RFC `sqlite-persistence-migration.md`
- Related: PRD `sqlite-persistence-migration-prd.md`
- Current manifest code: `src/app/useScaffoldActions.js`, `src/app/groupDomain.js`
