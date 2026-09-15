# Litria SQLite Layer — Security and Durability Audit

| Field | Value |
|---|---|
| Date | 2026-09-14 |
| Branch | `main` |
| Commit | `0b1717495d0490a720cb9ad1654f21a06de020d8` ("chore(release): 1.0.5") |
| Litria version | 1.0.5 (`package.json:2`, `src-tauri/Cargo.toml:3`, `src-tauri/tauri.conf.json:4`) |
| SQLite | 3.45.0 bundled via `rusqlite 0.31.0` / `libsqlite3-sys 0.28.0` (`src-tauri/Cargo.toml:31`, `src-tauri/Cargo.lock:3693-3696`, `:2378-2381`) |
| Audit type | Audit only. No application, test, schema, config, dependency or lockfile change. This report is the only tracked repository change. |

**Evidence labels used throughout:** **confirmed** = observed at runtime against a disposable database or read directly in source at the cited line; **inferred** = follows from cited source without a runtime reproduction; **unverified** = could not be established with the artifacts available.

**Scope note.** Litria has two SQLite databases sharing one code path: the per-project `.litria/workspace.db` (the "project SQLite layer" this audit targets) and the app-level `%LOCALAPPDATA%/com.litria.ide/litria.db` (recents + persisted UI state). The app DB is covered wherever a pass reaches it (connections, data at rest, drift), because the same module opens both.

**Runtime method.** All runtime work used disposable databases under the session scratchpad. No real user project or app database was opened, migrated or mutated. Two harnesses were used:

1. **Real release binary.** `src-tauri/target/release/litria.exe` (on disk, `ProductVersion` 1.0.4, built 2026-09-07) launched with `LOCALAPPDATA` redirected to a scratch directory and WebView2 remote debugging enabled, then driven over CDP to invoke the production Tauri command `db_bootstrap_project`. The `src-tauri/src/db/` directory is byte-identical across every tag from `v1.0.0` to `v1.0.5` (`git diff --stat v1.0.0 HEAD -- src-tauri/src/db/` is empty; `schema.rs` md5 `525cdece43981f1a972e99124d472d2e`, `mod.rs` md5 `f68cab3afe16e6b6b87a815c152d8c42` at all six tags and HEAD), so this binary executes the same DB code as 1.0.5. A fresh 1.0.5 binary was **not** rebuilt: the release build's `beforeBuildCommand` moves sourcemaps into `release-sourcemaps/1.0.5/` (`scripts/extract-sourcemaps.mjs:14,36-41`), which would overwrite the owner's archived 1.0.5 symbolication maps. See Audit limitations.
2. **Verbatim-source harness.** A scratch Rust crate (outside the repo) that compiles the real `src-tauri/src/db/schema.rs` from the `v1.0.5` tag unchanged via `#[path]`, and reproduces `open_workspace_db` line-for-line from `src-tauri/src/db/mod.rs:18-38` (minus the static-mutex store) and `open_app_db` from `src-tauri/src/db/app_db.rs:60-73`. The module is `pub(crate)`, so it cannot be called from outside `litria_lib` without modifying the repo; this is the closest non-modifying route to the production initialization path, and its output was checked against the real binary (identical, Pass 2).

---

## Pass 1 — Schema inventory

Search used: `rg --no-ignore` over the whole tree (excluding `node_modules`, `target`, `dist`, `release-sourcemaps`, bundled `resources/`) for `rusqlite|PRAGMA|CREATE (TABLE|INDEX|TRIGGER|VIEW)|ALTER TABLE|DROP|user_version|integrity_check|quick_check|ATTACH DATABASE|load_extension|workspace\.db|litria\.db|tauri-plugin-sql`, plus a filename search for `*migrat*`, `*schema*`, `*.sql`. Every SQL-bearing hit is inside `src-tauri/src/db/`; hits elsewhere are comments, the Cargo dependency line, and frontend path strings.

| Location | Role | Executes when | Class | Can create/mutate a user's project DB |
|---|---|---|---|---|
| `src-tauri/src/db/schema.rs:4-82` `WORKSPACE_SCHEMA_V1` | Full latest project DDL (9 `CREATE TABLE IF NOT EXISTS`) preceded by `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;` | Every project open and bootstrap, via `initialize_workspace_schema` | Production | Yes (creates tables) |
| `src-tauri/src/db/schema.rs:85-102` `APP_SCHEMA_V1` | App DB DDL (`projects`, `preferences`) + same pragmas | App startup | Production | No (app DB) |
| `src-tauri/src/db/schema.rs:104` `CURRENT_SCHEMA_VERSION = 3` | Version constant | — | Production | — |
| `src-tauri/src/db/schema.rs:111-129` `initialize_workspace_schema` | Runs the DDL batch; inserts `schema_version` row if table empty | Every open (`mod.rs:36`) | Production | Yes |
| `src-tauri/src/db/schema.rs:141-175` `migrate_workspace_schema` | v1→v2 (`ALTER TABLE connections ADD COLUMN source_side/target_side/type`), v2→v3 (`ALTER TABLE groups ADD COLUMN seed_x/y/w/h`), then `UPDATE schema_version` | Every open after initialize (`mod.rs:37`) | Production | Yes (ALTER) |
| `src-tauri/src/db/schema.rs:178-192` `initialize_app_schema` | App DDL + try-`ALTER TABLE projects ADD COLUMN prefs_file` treating "duplicate column name" as already migrated | App startup | Production | No |
| `src-tauri/src/db/schema.rs:195-200` `get_schema_version` | `SELECT version FROM schema_version LIMIT 1` | Every open | Production | No |
| `src-tauri/src/db/mod.rs:18-42` `open_workspace_db` | Creates `.litria/`, `Connection::open`, pragma batch, init, migrate, stores connection in `static PROJECT_DB: OnceLock<Mutex<Option<Connection>>>` (`:11`) | Bootstrap and open commands | Production | Yes (creates the file) |
| `src-tauri/src/db/mod.rs:44-51`, `:55-69`, `:72-74` | close / `with_workspace_db` accessor / `workspace_db_exists` | On demand | Production | No |
| `src-tauri/src/db/app_db.rs:28-56` `app_data_dir` | Resolves `%LOCALAPPDATA%\com.litria.ide` (Windows, `:31`), macOS/Linux equivalents | App startup | Production | No |
| `src-tauri/src/db/app_db.rs:60-81` `open_app_db` | Creates dir, opens `litria.db`, pragma batch, `initialize_app_schema` | `src-tauri/src/lib.rs:158-160` (setup hook; failure only `eprintln!`) | Production | No |
| `src-tauri/src/db/commands.rs:68-150` `db_bootstrap_project` | Creates project dir if missing, `open_workspace_db`, `INSERT OR REPLACE INTO project`, writes `litria.toml` (`:16-47`), dedup-appends `.litria/` to an existing `.gitignore` (`:822-846`), registers in app DB | Wizard completion (`src/app/useProjectLaunch.js:131`) and the two fallback branches of `db_open_project` | Production | Yes |
| `src-tauri/src/db/commands.rs:154-185` `db_open_project` | ADR-016 precedence: existing `workspace.db` → open; `litria.toml` only → bootstrap; neither → bootstrap | Launcher typed path / recents / folder picker (`src/components/LaunchScreen.jsx:118-160`, `:82-107`) | Production | Yes (may bootstrap) |
| `src-tauri/src/db/commands.rs:16-47` `write_litria_toml` | Stamps `schema_version = 3` into `litria.toml` (not a DB schema source) | Bootstrap | Production | No |
| `src-tauri/src/preferences.rs:351` | Reads legacy `preferences` rows for the one-time toml migration (read only) | First global prefs load | Production | No |
| `src-tauri/src/db/schema.rs:202-379` tests | In-memory DBs; hand-written **v1 fixture** (`:267-284`) and **v2 fixture** (`:306-318`) used by migration tests; test-only `PRAGMA table_info({table})` (`:241`) | `cargo test` | Test-only | No |
| `src-tauri/src/db/commands.rs:852-1110` tests | `mem_db()` (`:858-862`) calls the production `initialize_workspace_schema` on `:memory:` | `cargo test` | Test-only | No |
| `src-tauri/src/db/mod.rs:76-99` tests | `workspace_db_exists` only; no test calls `open_workspace_db` | `cargo test` | Test-only | No |
| JS tests (`test/`) | Mock `dbStorage` invocations; build no SQL schema (search: `rg -l 'sqlite|workspace\.db' test` → only comments/fixture path strings, e.g. `test/domains/untitledSession.test.mjs:59`) | `node --test` | Test-only | No |
| Migration files / runners / seed / repair / import / upgrade scripts | **None found** (filename search above; `scripts/` contains only guards, bundling and sourcemap tooling) | — | — | — |
| `PRAGMA user_version` | **Not used** anywhere. Versioning is the `schema_version` table (`schema.rs:8-10`). | — | — | — |
| Legacy JSON-manifest migration | Closed as never built (`docs/adrs/015-sqlite-persistence-layer.md` status block; `src/app/useProjectLaunch.js:315-316`) | — | Legacy (no code) | — |

**Authoritative source of schema truth (confirmed):** `src-tauri/src/db/schema.rs` is the single source: `WORKSPACE_SCHEMA_V1` defines the latest shape applied with `CREATE TABLE IF NOT EXISTS` on every open, and `migrate_workspace_schema` brings older files forward with additive `ALTER`s gated on the `schema_version` table. There is no competing source; at runtime `initialize_workspace_schema` always runs first (creating any missing table at latest shape) and `migrate_workspace_schema` second (`mod.rs:36-37`). ADR-015 documents an older shape and is descriptive only.

---

## Pass 2 — Schema drift

### 2.1 Database created as the app does it (real binary)

Command record:

```
# release binary on disk (db/ module byte-identical to v1.0.5 tag, see Runtime method)
LOCALAPPDATA=<scratch>\realapp\localappdata
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222
C:\projects\Litria\src-tauri\target\release\litria.exe
# CDP Runtime.evaluate on the app page (http://tauri.localhost/):
window.__TAURI_INTERNALS__.invoke('db_bootstrap_project',
  {path:'<scratch>\\realapp\\project', name:'AuditRealBinary', language:null, framework:null, environmentPython:null})
window.__TAURI_INTERNALS__.invoke('db_close_project')
# result
db_bootstrap_project -> {"ok":{"project":{"instanceId":"litria-18d557ac03f0b474-1238-91da","name":"AuditRealBinary","appVersion":"1.0.4",...}}}
sqlite3 <scratch>/realapp/project/.litria/workspace.db ".schema" > realbin.schema.sql
sqlite3 ... "select * from schema_version; pragma journal_mode;"   -> 3 / wal
```

Artifacts produced by the real path: `.litria/workspace.db` (69,632 bytes), `litria.toml` (`[project] name / schema_version = 3 / created_at`), one `projects` row in the scratch `litria.db`. No `.gitignore` existed in the scratch folder, so none was written (`commands.rs:823-826`).

### 2.2 Databases from the harness and the migration chain

```
harness create  <scratch>/dbs/fresh          # production wrapper + verbatim schema.rs  -> OK schema_version=Ok(3)
harness fixture v1 <scratch>/dbs/mig1 && harness open <scratch>/dbs/mig1   # v1 fixture (schema.rs:267-284) -> migrate -> 3
harness fixture v2 <scratch>/dbs/mig2 && harness open <scratch>/dbs/mig2   # v2 fixture (schema.rs:306-318) -> migrate -> 3
harness app <scratch>/dbs/appdata                                          # app DB
sqlite3 <db> ".schema" > <name>.schema.sql   (sqlite3 3.52.0)
```

Dump digests (md5 of `.schema` output, no normalization applied):

| Dump | md5 |
|---|---|
| `realbin.schema.sql` (real binary) | `ee31d23e16f3656559270cc358730c2c` |
| `fresh.schema.sql` (harness, v1.0.5 `schema.rs`) | `ee31d23e16f3656559270cc358730c2c` |
| `mig1.schema.sql` (v1 fixture → migrated) | `8f900f39d4da364bd27178bcd89509b3` |
| `mig2.schema.sql` (v2 fixture → migrated) | `aa6d21a0cae78a7ecd9470d1e707859c` |
| `realbin-app.schema.sql` / `app.schema.sql` | `00c02a627c57925cd7b6b036da38b6f6` (identical) |

**Real binary vs harness: identical, byte for byte (confirmed).** The `.schema` of the fresh production DB (also the real binary's) is:

```sql
CREATE TABLE schema_version (version INTEGER NOT NULL);
CREATE TABLE project (instance_id TEXT PRIMARY KEY, name TEXT NOT NULL, app_version TEXT NOT NULL, language TEXT, framework TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE pieces (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT NOT NULL UNIQUE, label TEXT NOT NULL, x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0, scale REAL NOT NULL DEFAULT 1.0, color TEXT, is_hidden INTEGER NOT NULL DEFAULT 0);
CREATE TABLE sqlite_sequence(name,seq);
CREATE TABLE groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, folder_path TEXT, is_collapsed INTEGER NOT NULL DEFAULT 1, parent_id TEXT, theme_id TEXT, color TEXT, seed_x REAL, seed_y REAL, seed_w REAL, seed_h REAL, FOREIGN KEY (parent_id) REFERENCES groups(id) ON DELETE SET NULL);
CREATE TABLE group_pieces (group_id TEXT NOT NULL, piece_id INTEGER NOT NULL, UNIQUE(group_id, piece_id), FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE, FOREIGN KEY (piece_id) REFERENCES pieces(id) ON DELETE CASCADE);
CREATE TABLE connections (id INTEGER PRIMARY KEY AUTOINCREMENT, from_piece_id INTEGER NOT NULL, to_piece_id INTEGER NOT NULL, source_side TEXT, target_side TEXT, type TEXT, FOREIGN KEY (from_piece_id) REFERENCES pieces(id) ON DELETE CASCADE, FOREIGN KEY (to_piece_id) REFERENCES pieces(id) ON DELETE CASCADE);
CREATE TABLE editor_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE hidden_paths (path TEXT PRIMARY KEY);
CREATE TABLE viewport (id INTEGER PRIMARY KEY CHECK (id = 1), x REAL NOT NULL DEFAULT 0, y REAL NOT NULL DEFAULT 0, scale REAL NOT NULL DEFAULT 1.0);
```
(whitespace collapsed here for readability; the raw dumps are multi-line and were diffed raw.)

Indexes: only `sqlite_autoindex_*` from PRIMARY KEY / UNIQUE on `project`, `pieces`, `groups`, `group_pieces`, `editor_state`, `hidden_paths`. No explicit indexes, triggers or views (`select type,name,tbl_name from sqlite_master where type in ('index','trigger','view')`).

### 2.3 Diff: production-fresh vs v1-fixture-migrated (`diff -u fresh.schema.sql mig1.schema.sql`, excerpt)

```diff
-CREATE TABLE groups (
-    ...
-    seed_h REAL,
-    FOREIGN KEY (parent_id) REFERENCES groups(id) ON DELETE SET NULL
-);
+CREATE TABLE groups (
+                id TEXT PRIMARY KEY, ... color TEXT
+             , seed_x REAL, seed_y REAL, seed_w REAL, seed_h REAL);
-CREATE TABLE connections (
-    ...
-    FOREIGN KEY (from_piece_id) REFERENCES pieces(id) ON DELETE CASCADE,
-    FOREIGN KEY (to_piece_id) REFERENCES pieces(id) ON DELETE CASCADE
-);
+CREATE TABLE connections (
+                id INTEGER PRIMARY KEY AUTOINCREMENT, from_piece_id INTEGER NOT NULL, to_piece_id INTEGER NOT NULL
+             , source_side TEXT, target_side TEXT, type TEXT);
```

`PRAGMA foreign_key_list(groups)` / `(connections)` on `mig1` returns **no rows**; on `fresh` it returns the three declared keys.

### 2.4 Drift findings

| # | Comparison | Difference | Substantive? | Can tests pass against a schema users never receive? |
|---|---|---|---|---|
| D1 | real binary vs harness fresh | none | — | — |
| D2 | fresh vs `mig1` (v1 fixture → 3) | `groups` lacks `FOREIGN KEY (parent_id) … ON DELETE SET NULL`; `connections` lacks both `FOREIGN KEY … ON DELETE CASCADE`; `sqlite_sequence` and table ordering differ; `ALTER`-appended column text is cosmetic | **Yes** (missing FKs) | **Yes.** The migration tests (`schema.rs:263-300`) assert only column presence and version, on a fixture that omits the FK clauses. Whether real 2026-era v1 files carried those FKs is **unverified** (no pre-2026-08-09 history exists; ADR-015 shows FKs in the v1 design). If they did, the fixture under-specifies; if they did not, production has un-cascaded rows the tests do not model. |
| D3 | fresh vs `mig2` (v2 fixture → 3) | `groups` lacks the `parent_id` FK; ordering/`ALTER` text cosmetic | **Yes** (missing FK) | Same as D2 |
| D4 | fresh vs `mem_db()` (`commands.rs:858-862`) | none by construction (same constant, same function); the 20 `db::` tests pass unmodified (`cargo test --offline --lib -- db::` → `20 passed; 0 failed`) | No | No |
| D5 | `schema_version` values | 3 on every side | No | — |
| D6 | column type / default / nullability / CHECK | none on any side | No | — |
| D7 | app DB: real binary vs harness | none | — | — |

---

## Pass 3 — Query and input safety

### 3.1 Dynamically constructed SQL

| `file:line` | Constructed SQL | Values that reach it | Origin / trust | Validation boundary | Bound params | Outcome if validation fails |
|---|---|---|---|---|---|---|
| `src-tauri/src/db/commands.rs:326-329` | `UPDATE pieces SET {sets} WHERE id = ?` | `sets` is built only from the string literals at `:293,297,301,305,309,313,317` (`"file_path = ?"` …); values pushed as boxed `ToSql` (`:294-319`) | `PieceUpdate` fields come from the frontend (`src/project/dbStorage.js:87`) — file paths, labels, colors are user/project-controlled | Column names are a closed set of compile-time literals; no caller-supplied identifier reaches the SQL text | Yes, all values | None: SQL text is caller-independent |
| `src-tauri/src/db/commands.rs:425` | `UPDATE groups SET {sets} WHERE id = ?` | literals at `:386-417`; values boxed | `GroupUpdate` from `dbStorage.js:106` | Same closed literal set | Yes | None |
| `src-tauri/src/db/schema.rs:241` | `PRAGMA table_info({table})` | test-only, literal table names | Test code | `#[cfg(test)]` | n/a (PRAGMA cannot bind) | Not reachable in production |
| `src-tauri/src/db/schema.rs:186` | `ALTER TABLE projects ADD COLUMN prefs_file TEXT` (static) | none | — | — | — | — |
| Every other statement in `commands.rs`, `app_db.rs`, `schema.rs` | static text with `?N` placeholders | user/project strings (`file_path`, `label`, `color`, group ids, `folder_path`, hidden paths, editor-state key/value, preference key/value, project path/name) | user- and project-controlled | none needed | Yes (`params![]` / slices) | No injection surface |
| Non-SQL formatted output noted for completeness | `commands.rs:22-27` builds `litria.toml` text with `format!` (name has only `"` escaped) | project name | user-controlled | quote escaping only | — | Out of SQL scope; a name containing a newline yields an unparsable toml (`read_litria_toml_name` returns `None`, `:50-59`), not SQL exposure |

No query-builder API, no string concatenation of SQL fragments, no wrapper that assembles SQL away from the call site exists (search: `format!\(.*(SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)` and `prepare\(&` across `src-tauri/`).

### 3.2 Value paths into sensitive positions

| Sink | Reachable from | Path | Validation | Assessment |
|---|---|---|---|---|
| SQL text | — | none: no user value is ever interpolated into SQL text | — | **None found** (search above) |
| Dynamic identifier | — | only the two literal-set `UPDATE` builders | closed allowlist by construction | Safe |
| `ATTACH DATABASE` | — | no `ATTACH` statement exists (`rg -i 'ATTACH'` over `src-tauri/src`, `src`, `scripts`, `test`) | — | **None found** |
| PRAGMA | — | all PRAGMAs are literal (`mod.rs:32`, `app_db.rs:70`, `schema.rs:5-6,86-87`) | — | **None found** dynamic in production |
| **Database filename/path** | Tauri command `db_bootstrap_project(path)` (`commands.rs:68`) and `db_open_project(path)` (`:154`) | `Path::new(path.trim())` → `join(".litria").join("workspace.db")` (`mod.rs:19,26`) → `Connection::open` (`mod.rs:27`) | `trim()` non-empty; `is_dir()` or `create_dir_all` (`commands.rs:75-101,155-161`). No `path_guard` call, no canonicalization, no allowlist. | `rusqlite::Connection::open` uses `OpenFlags::default()` which includes `SQLITE_OPEN_URI` (rusqlite `src/lib.rs:1174-1182`) and the bundled build defines `SQLITE_USE_URI` (`libsqlite3-sys build.rs:138`), so a path beginning with `file:` is parsed as a URI. **Confirmed:** `harness uri "file:<dir>/x?mode=memory&cache=shared"` opened an in-memory database (`PRAGMA database_list` → `("main","")`); `?mode=ro` was honoured. **Confirmed on Windows:** the joined project path cannot be created (`?` is illegal → os error 123), so the sink is unreachable here. **Unverified on Linux/macOS**, where `?` and `:` are legal in directory names and `create_dir_all` would succeed. Origins of `path`: launcher typed input (`LaunchScreen.jsx:118-132`), recents rows (app DB, originally the same inputs), the Rust-owned folder picker (`LaunchScreen.jsx:82-107`, ADR-022), and the wizard's `resolveProjectRootPath` (`useProjectLaunch.js:81,127`). All are the local user acting on their own machine; no privilege boundary is crossed. See finding H3. |
| DB creation / migration / repair | same two commands | creation and migration are side effects of opening | as above | Migration is triggered by any open; there is no repair path |
| Extension / plugin / agent / generated action | — | no extension, plugin or agent execution surface exists in 1.0.5; the IPC surface is the fixed `generate_handler!` list (`src-tauri/src/lib.rs:43-136`) | — | **None found** |
| Imported project | `db_open_project` on a foreign folder | opens whatever `.litria/workspace.db` is there and runs `initialize` + `migrate` against it | none (any SQLite file is accepted; `schema_version` is trusted) | A foreign workspace.db is executed as schema truth: a malicious file cannot inject SQL (Litria's statements are static) but can carry any row content and any `schema_version`. Consequences are data-shape, not code execution. |

### 3.3 Extension loading

- Litria never calls `load_extension`, `sqlite3_enable_load_extension` or `SELECT load_extension(...)` (search over `src-tauri/`, `src/`, `scripts/`, `test/`: no hits) — **confirmed**.
- `rusqlite` is compiled with only the `bundled` feature (`src-tauri/Cargo.toml:31`); the `load_extension` Rust API is behind a feature that is off (rusqlite `Cargo.toml` `[features] load_extension = []`) — **confirmed**.
- The bundled C library is compiled with `-DSQLITE_ENABLE_LOAD_EXTENSION=1` (`libsqlite3-sys-0.28.0/build.rs:131`; runtime `PRAGMA compile_options` lists `ENABLE_LOAD_EXTENSION`), so the C entry points exist. SQLite keeps extension loading **disabled per connection unless `sqlite3_enable_load_extension()` is called**, which nothing calls — **inferred** from SQLite's documented default; not separately probed. Net: not enabled, not exposed, not invoked, not explicitly disabled in Litria code.

---

## Pass 4 — Data at rest

### 4.1 Security-sensitive columns

Search: every column in both schemas reviewed; writers located with `rg 'dbSaveEditorState\(|dbSavePreference\(|dbAddHiddenPath\('` over `src/` and all `INSERT`/`UPDATE` in `src-tauri/src/db/`; identifier search `token|secret|api_key|password|credential` over `src-tauri/src` (only unrelated hits: terminal env filtering test at `terminal_policy.rs:113-118`, WebView2 registration token, version-token parsing).

**Credentials, auth/refresh tokens, API keys, provider secrets, session material, connection strings: None found.** Litria 1.0.5 has no account, provider or network-credential feature; the only network surface (ADR-005 managed language-server downloads) stores nothing in SQLite.

Columns that hold **machine- or user-identifying but non-secret** data, reported because they sit in a repo-adjacent file:

| Table.column | Defined | Written | Read | Form | Store | Notes |
|---|---|---|---|---|---|---|
| `editor_state.value` for key `env.python.interpreter` | `schema.rs:67-70` | `src/app/useProjectLaunch.js:189` via `commands.rs:499-509` | `src/app/usePythonFirstOpen.js:57`; `commands.rs:734-747` | plaintext absolute path | **project DB** (`<repo>/.litria/workspace.db`) | Machine-local absolute path (ADR-020 §5 places it here deliberately) |
| `editor_state.value` for `open_tab_piece_ids`, `tab_pane_ids`, `last_session_at`, `ws.*`, `npm.*`, `py.*` flags | same | `useProjectPersistence.js:480-490`, `useProjectLaunch.js:200,219-222`, `useNpmScriptsFirstOpen.js:49-50`, `usePythonFirstOpen.js:82` | `commands.rs:734-747` | plaintext | project DB | session/layout state |
| `pieces.file_path`, `pieces.label`, `groups.folder_path`, `hidden_paths.path` | `schema.rs:22-31,33-46,72-74` | `commands.rs:208-260,356-373,544-554` | `commands.rs:632-762` | plaintext relative paths | project DB | project structure |
| `project.name`, `project.app_version` | `schema.rs:12-20` | `commands.rs:110-118` | `commands.rs:612-629` | plaintext | project DB | — |
| `projects.path` (absolute), `projects.name`, `projects.prefs_file` | `schema.rs:89-96` | `app_db.rs:102-117,190-199` | `app_db.rs:119-151,175-188,201-212` | plaintext | **app DB** (`%LOCALAPPDATA%/com.litria.ide/litria.db`) | absolute paths of every project ever opened |
| `preferences.value` | `schema.rs:98-101` | `useCanvasHud.js:49` (HUD layout JSON); legacy `appearance`/`energyLevel` (`preferences.rs:33`) | `app_db.rs:225-242`; `preferences.rs:351` | plaintext | app DB | UI state |

None of these is encrypted, hashed or obfuscated; none needs to be. No column references an external secret store.

### 4.2 Repository placement and Git exposure

- The project DB lives **inside** the user's repository at `<root>/.litria/workspace.db` (`mod.rs:19-26`), together with `-wal`/`-shm` while a connection is open (observed on the app DB during the real-binary run: `litria.db-wal`, `litria.db-shm` present; both are removed on clean close — after every harness exit only `workspace.db` remained).
- **Ignore protection is repository-local and conditional (confirmed):** `add_litria_to_gitignore` appends `.litria/` **only if a `.gitignore` already exists** (`commands.rs:822-826`); the Blank and Python scaffolds ship one containing `.litria/` (`blank_project.rs:43`, `python_scaffold.rs:165`). Litria's own repo ignores it (`.gitignore:60`). There is no global excludes file on this machine (`git config --global core.excludesfile` empty) and Litria writes no `.git/info/exclude`. A folder opened through open-any-folder that has `.git` but no `.gitignore` gets **no** protection: `workspace.db`, `-wal` and `-shm` are stageable and committable. See finding H1.
- **Filesystem permissions:** Litria sets none (`rg 'set_permissions|Permissions::|OpenOptions' src-tauri/src/db` → no hits; `write_ops.rs` handles text files only). On Windows the DB and `.litria/` inherit the parent ACL (icacls shows `(I)` on every ACE — confirmed). On Unix, SQLite's default is `SQLITE_DEFAULT_FILE_PERMISSIONS 0644` masked by umask (`libsqlite3-sys-0.28.0/sqlite3/sqlite3.c:38134`) — **inferred**, not tested here. Backups and temporary copies: none exist.
- **Logs / exports / diagnostics:** crash records contain OS, version and a breadcrumb tail whose DB entries are command names only (`dbStorage.js:22-31,38,41`; `crash/scan.rs:168-180`); build logs are scaffold output. No path copies DB rows anywhere. No export or backup feature exists. **None found.**
- **Residue:** `secure_delete=0` and `auto_vacuum=0` (Pass 5 table). **Confirmed:** an `editor_state` value inserted, deleted and checkpointed with `wal_checkpoint(TRUNCATE)` was still present as bytes in `workspace.db`. Deleted interpreter paths or old file layouts therefore remain in free pages and in any committed copy of the file. Since no secret is stored, this is reported as a fact, not a finding.

---

## Pass 5 — Connections, constraints, and integrity

### 5.1 Connection paths

| Path | `file:line` | Mode | `foreign_keys` | `journal_mode` | `busy_timeout` | `synchronous` | Other | Configured per connection? | If a PRAGMA fails |
|---|---|---|---|---|---|---|---|---|---|
| Project DB (production) | `mod.rs:27-33` | read/write, create | **ON** — set by Litria (`:32`) and already ON before that because the bundle is built with `-DSQLITE_DEFAULT_FOREIGN_KEYS=1` (`build.rs:123`); measured `1` both before and after the batch (confirmed) | `wal` (persisted in the file header) | **5000 ms** — not set by Litria; rusqlite sets it on every open (`rusqlite-0.31.0/src/inner_connection.rs:121`) (confirmed) | `2` (FULL; library default `DEFAULT_SYNCHRONOUS=2`) | `locking_mode=normal`, `cache_size=-2000`, `secure_delete=0`, `auto_vacuum=0`, `wal_autocheckpoint=1000`, `trusted_schema=1`, `temp_store=0` | Yes: a single connection per open, held in a static `Mutex<Option<Connection>>` (`mod.rs:11`); no pool; a new open replaces it (`:41`) | `open_workspace_db` returns `Err("Failed to set database pragmas: …")` (`:33`) → command error; the file is left as-is |
| App DB (production) | `app_db.rs:67-71` | read/write, create | ON | `wal` | 5000 ms | 2 | as above | Single static connection (`:8`) | `Err("Failed to set app database pragmas")` → `lib.rs:158-160` logs to stderr and **continues**; every later `with_app_db` call fails "App database is not open." (`:94`) |
| Tests (in-memory) | `schema.rs:209,233,251,266,305,334,345,355,372`; `commands.rs:859` | `:memory:` | ON | `memory` | 5000 ms | — | — | per test | panics via `unwrap` |
| Read-only connections | — | **None found** anywhere |
| Imports, recovery tools, background tasks, extension-facing or one-off utility connections | — | **None found** (`rg 'Connection::open' src-tauri/src` → only `mod.rs:27`, `app_db.rs:67` and the test lines above) |

Runtime probe of the effective settings (harness `pragmas` after the production open sequence):

```
PRAGMA foreign_keys = 1   journal_mode = wal   busy_timeout = 5000   synchronous = 2
locking_mode = normal   cache_size = -2000   temp_store = 0   secure_delete = 0   auto_vacuum = 0
wal_autocheckpoint = 1000   query_only = 0   defer_foreign_keys = 0   trusted_schema = 1
compile_options: … DEFAULT_FOREIGN_KEYS … ENABLE_LOAD_EXTENSION … THREADSAFE=1 USE_URI
sqlite_version = 3.45.0
```

FK enforcement was verified by behaviour, not assumption: orphan inserts into `group_pieces`, `connections` and `groups.parent_id` all fail with extended code 787 `FOREIGN KEY constraint failed` (confirmed).

### 5.2 Table inspection

| Table | FKs | Index on FK columns | Indexes for real predicates | NOT NULL | Uniqueness | CHECK | Defaults concealing missing data | Cascade | Type assumptions |
|---|---|---|---|---|---|---|---|---|---|
| `schema_version` | — | — | — | `version` | **none** (multiple rows possible; `LIMIT 1` without `ORDER BY`, `schema.rs:196`) | none | — | — | read as `i32` |
| `project` | — | PK | `LIMIT 1` full scan; no `ORDER BY` (`commands.rs:614-615`) | name, app_version, created/updated | PK `instance_id` | **no single-row guard** (contrast `viewport`) | — | — | — |
| `pieces` | — | PK | `WHERE id = ?` (PK) | file_path, label, x, y, scale, is_hidden | `file_path` UNIQUE | none (`scale`, `is_hidden` unconstrained) | `x/y/scale` defaults are semantic zeros, acceptable | referenced by `group_pieces`, `connections` | `is_hidden` read as `i32` (`:646`) |
| `groups` | `parent_id → groups.id ON DELETE SET NULL` | **none** on `parent_id` | none needed (full load) | name, is_collapsed | PK | none | — | SET NULL on parent delete | `is_collapsed` read as `i32` |
| `group_pieces` | `group_id → groups CASCADE`, `piece_id → pieces CASCADE` | `UNIQUE(group_id, piece_id)` covers `group_id`; **no index on `piece_id`** (piece deletes scan; tables are small) | — | both | composite UNIQUE | — | — | CASCADE both ways | — |
| `connections` | `from_piece_id`, `to_piece_id → pieces CASCADE` | **none** on either FK column | full load | from/to | none (duplicate edges allowed) | none on `source_side`/`target_side`/`type` (free text) | — | CASCADE on piece delete | `type` nullable free text |
| `editor_state` | — | PK | `INSERT OR REPLACE` by key | value | PK key | — | — | — | opaque strings |
| `hidden_paths` | — | PK | — | — | PK | — | — | — | — |
| `viewport` | — | PK | `WHERE id = 1` | x, y, scale | PK | `CHECK (id = 1)` | — | — | — |
| app `projects` | — | PK | `ORDER BY pinned DESC, last_opened_at DESC` full scan (`app_db.rs:123-124`) | name, last_opened_at, pinned | PK `path` (string-exact; `C:\x` and `C:\x\` are different rows) | none | — | — | `pinned` read as `i32` (`:135`) |
| app `preferences` | — | PK | — | value | PK | — | — | — | — |

### 5.3 Multi-statement writes

| Operation | `file:line` | Transaction? | Partial state if execution fails between statements |
|---|---|---|---|
| Project creation (`db_bootstrap_project`) | `commands.rs:92-129` | **No** — six separate steps: `create_dir_all`, `open_workspace_db` (which itself autocommits DDL, then `INSERT INTO schema_version`), `INSERT OR REPLACE INTO project`, `litria.toml` write, `.gitignore` append, app-DB register | **Confirmed (T9):** a `workspace.db` with tables and `schema_version=3` but no `project` row. `db_open_project` then takes the "returning project" branch (`:168`) and fails in `load_full_state` with `Failed to load project metadata: Query returned no rows` on every retry; the marker-rebuild branch is never reached. Finding S2. |
| Batch piece insert / batch move | `commands.rs:231-257`, `:266-280` | **Yes** (`unchecked_transaction` + `commit`) | Atomic |
| Single-row piece/group/connection/state writes | `commands.rs:208-222,342-346,356-374,437-441,447-453,460-466,483-490,501-507,533-539,546-553,559-563` | Autocommit single statements | Atomic per statement; cascades run inside the same statement |
| Delete cascades | DB-side via `ON DELETE CASCADE` / `SET NULL` | inside the deleting statement | Atomic |
| Migrations | `schema.rs:148-171` | **No** — `execute_batch` prepares and steps each statement in a loop with no `BEGIN` (rusqlite `src/lib.rs:552-567`); each `ALTER` autocommits; the version bump is a separate `UPDATE` | **Confirmed (T6, T7):** see Pass 6 |
| Imports / extension / agent mutations / recovery / repair | — | **None found** (no such code) | — |
| Frontend-orchestrated sequences (e.g. file delete: fs op → tabs → connections → `dbDeletePiece`; move: fs op → `dbUpdatePiece`; group ops; `src/app/filesystemWriteManager.js:17-18,463,743`) | many `dbStorage` calls per gesture | Each command autocommits; **no cross-command transaction** | If the app dies mid-sequence the DB can hold a piece whose `file_path` no longer exists on disk, or a file with no piece. **Inferred** from structure; not reproduced. The next open hydrates from DB and the tree reconciler re-syncs folders (`useGroupFolderReconciliation`), so this is a transient inconsistency, not a corruption. |

---

## Pass 6 — Failure and migration behavior

### 6.1 Compatibility with earlier 1.x releases

| Test | Artifact used | Result | Status |
|---|---|---|---|
| DB created by the earliest 1.x release (`v1.0.0`) opens in 1.0.5 | Tagged source only: `git show v1.0.0:src-tauri/src/db/schema.rs` and `mod.rs` are byte-identical to `v1.0.5` (md5 above). No 1.0.0 binary is on disk and none was downloaded. | Any DB a 1.0.0 build creates is DDL-identical to the 1.0.5 fresh DB, which opens (trivially). | **Inferred from source identity; binary-level unverified** |
| DB created by the immediately preceding release (`v1.0.4`) opens in 1.0.5 | The **actual 1.0.4 release binary** on disk created `realapp/project/.litria/workspace.db` (Pass 2.1, `app_version` stamped `1.0.4`). Opened with the 1.0.5 `schema.rs` code path (harness `load`). | `OK project LIMIT 1 -> instance_id=litria-18d557ac03f0b474-1238-91da name=AuditRealBinary`, `schema_version` stays 3, no migration statements run. | **Confirmed** |
| Pre-1.0 (`schema_version` 1 and 2) files | Only the committed fixtures (`schema.rs:267-284`, `:306-318`); real historical DDL is unavailable (repository history starts 2026-08-09). | Both fixtures migrate to 3 (harness T4/T5 and the repo's own tests). | **Confirmed for the fixtures; real historical files unverified** |

Versions tested: 1.0.4 (binary) → 1.0.5 (code); 1.0.0 (source) → 1.0.5 (source identity).

### 6.2 Migration mechanics (all confirmed from `schema.rs:141-175` and runtime)

| Question | Answer |
|---|---|
| Backup before migration | **None.** No copy of `workspace.db`, `-wal` or `-shm` is made anywhere (`rg -i 'backup|copy' src-tauri/src/db` → none; `write_ops.rs:87` backups are for text files). |
| DB/WAL/SHM captured consistently | Not applicable (no backup). |
| Failure **before** any schema change | Open returns `Err` (e.g. pragma failure); file untouched. |
| Failure **during** a batch (crash between `ALTER`s) | The completed `ALTER`s are committed individually; `schema_version` unchanged. **Confirmed (T6):** fixture with `source_side` already added, version 1 → every subsequent open fails `Failed to migrate connections to v2: duplicate column name: source_side`. |
| Failure **after** schema changes but before the version bump | **Confirmed (T7):** all v1→v2 columns present, version still 1 → same permanent failure. |
| Transactional | **No** (`execute_batch` loop, separate `UPDATE`). |
| Idempotent / resumable | **No.** `ADD COLUMN` is not idempotent and nothing inspects `table_info` before altering; the only guard is the version gate, which is exactly what a partial run leaves stale. (The test `migrate_is_idempotent`, `schema.rs:344-351`, only proves that a *completed* migration is skipped.) |
| Version inconsistent with schema after failure | **Yes**, in both directions above. |
| Rollback / recovery | **Absent.** Manual `sqlite3` surgery (drop the columns or bump the version) is the only route; the UI offers no repair, and deleting `.litria/` discards the canvas. |
| Contrast | The app DB's `prefs_file` migration *is* tolerant (`schema.rs:186-190` treats "duplicate column name" as done). |

### 6.3 Failure cases (disposable databases; harness runs the production open sequence)

| Case | How produced | Structured error | Usable to user | Retries | Hangs | Silent | Replacement DB | Data loss | Panic |
|---|---|---|---|---|---|---|---|---|---|
| Corrupt DB (random bytes at 100–600) | T11a | `Failed to set database pragmas: database disk image is malformed` → `CommandError{Internal, internal.unclassified}` (`errors.rs:95-120`) | Launcher shows `Could not open project at that path: …` (`useProjectLaunch.js:320-328`, `LaunchScreen.jsx:133-136`) with raw SQLite text; no recovery hint | no | no | no | no | none by Litria | no |
| Truncated to 512 / 20 000 bytes | T11c/d | same `malformed` | same | no | no | no | no | none | no |
| Header magic overwritten | T11e | `file is not a database` | same | no | no | no | no | none | no |
| **Zero-length** `workspace.db` | T11b | open **succeeds** (SQLite treats an empty file as new) → `initialize` writes a fresh v3 schema into it; then `load_full_state` fails `Failed to load project metadata: Query returned no rows` | misleading message | no | no | partially: the re-initialization is silent | **yes** (empty file replaced by a fresh schema) | nothing recoverable was lost (file was empty), but the symptom is masked | no |
| Read-only DB **file** (attribute) | T12 | open **succeeds**; every write later fails `SQLITE_READONLY attempt to write a readonly database` | **No**: persistence handlers only `console.warn` (`useProjectPersistence.js:373,410,491,527`; `useCanvasHud.js:49`, `useScaffoldActions.js:282-284`, `usePythonFirstOpen.js:82` swallow with `.catch(() => {})`) | no | no | **yes** | no | **session changes silently discarded** | no |
| Read-only DB file (ACL deny W) | T13c | `Failed to open workspace database: unable to open database file: <path>` | as corrupt row | no | no | no | no | none | no |
| Read-only **containing directory**, DB exists | T13a | `Failed to set database pragmas: unable to open database file` (WAL needs `-wal`/`-shm`) | as corrupt row, message does not mention permissions or WAL | no | no | no | no | none | no |
| Read-only parent, no DB yet | T13b | `Failed to create .litria directory: Access is denied. (os error 5)` → `AccessDenied` category via `from_io`/`from_text` | yes (mentions access denied) | no | no | no | no | none | no |
| Missing parent directory chain | T14a | none — `create_dir_all` **silently creates the whole chain** (`mod.rs:20-23`, `commands.rs:92-95`) | n/a | — | — | yes (creation) | creates a new project | none | no |
| Invalid path (`<`, `>`, `?`, `CON`, `NUL`) | T14b/c | os errors 123 / 267 / 3, structured | yes | no | no | no | no | none | no |
| Stale/persistent write lock held by another process | T15 | open **succeeds in ~36 ms** (the open sequence performs no write on an already-WAL, already-versioned file); a subsequent write waits the rusqlite default **5 s** then fails `DatabaseBusy: database is locked` (measured 5497 ms) | write failures are swallowed as in the read-only row | one busy wait per statement | no (bounded) | yes for writes | no | writes during the lock are lost | no |
| Two Litria instances on one project (idle connections) | T15b | both open fine; last writer wins per row; no advisory lock | — | — | — | — | — | possible silent overwrite of layout | no |
| Interrupted multi-step write: bootstrap dies after DB creation, before `project` row | T9 | on retry: `Failed to load project metadata: Query returned no rows` **forever** | misleading | no | no | no | no | project unopenable until `.litria/` is deleted by hand | no |
| Interrupted migration | T6/T7 | permanent `duplicate column name` | misleading | no | no | no | no | canvas inaccessible without manual SQL | no |

`PRAGMA integrity_check` / `quick_check`: **never run** (`rg -i 'integrity_check|quick_check' src-tauri src scripts test` → no hits). Corruption is only discovered when the pragma batch or a query trips over it.

---

## Findings

### Tier 1 — Data loss or credential exposure

**None found.** Basis: Pass 4 column review (no credential-class data exists), Pass 6 runtime matrix (no case destroys previously committed bytes; the two "unopenable" cases leave the file intact and hand-recoverable). The Tier 2 durability findings below were deliberately not promoted.

### Tier 2 — Silent incorrectness / durability

**S1. Non-transactional migration bricks a project on interruption** — **confirmed**
- Evidence: `src-tauri/src/db/schema.rs:148-153`, `:157-163`, `:166-171` (three separate autocommitting steps; no `BEGIN`); rusqlite `execute_batch` loop `src/lib.rs:552-567`.
- Runtime: T6 (`fixture v1-partial` → `open` twice: both `ERR Failed to migrate connections to v2: duplicate column name: source_side`, `schema_version` still 1); T7 (`fixture v1-after-v2` → same).
- Reachable input: a pre-v3 `workspace.db` opened by 1.0.x while the process dies (crash, kill, power loss, WebView2 host death) inside the ~ms window between the first `ALTER` and the version `UPDATE`. Also any future non-additive migration.
- Failure: every later open fails with the same error; the launcher shows a raw SQLite message; no repair path; user's canvas is intact on disk but unreachable.
- Existing mitigation: none (version gate only).
- Remediation: run each version step **and** its version bump inside one `unchecked_transaction`, and make the `ALTER`s tolerant (check `PRAGMA table_info` or match "duplicate column name" as the app DB already does at `schema.rs:186-190`).
- Regression test: build the T6 fixture (v1 + `source_side` already present, version 1) and assert `migrate_workspace_schema` succeeds and ends at `CURRENT_SCHEMA_VERSION`.

**S2. Bootstrap is not atomic; a half-created project is never repaired** — **confirmed**
- Evidence: `src-tauri/src/db/commands.rs:103-119` (DB created, then a separate `INSERT OR REPLACE INTO project`); `commands.rs:168-173` (open branch trusts `workspace_db_exists` and never falls back).
- Runtime: T9 (`create` then `load`: `ERR Failed to load project metadata: Query returned no rows`).
- Reachable input: process death or an I/O error between `open_workspace_db` and the `project` insert (disk full, antivirus lock) during wizard completion or open-any-folder.
- Failure: the folder is permanently reported as `Could not open project at that path: Failed to load project metadata: Query returned no rows`; the marker-rebuild branch (`:175-179`) is unreachable because `workspace.db` exists.
- Existing mitigation: none.
- Remediation: in `db_open_project`, treat "workspace.db exists but `project` has no row" as the rebuild case (or wrap open+insert in one transaction and delete the file on failure).
- Regression test: create `.litria/workspace.db` with schema but no `project` row, call `db_open_project`, assert a `ProjectState` is returned (rebuilt) rather than an error.

**S3. Read-only project database opens successfully and every write is silently discarded** — **confirmed (DB layer), inferred (UI)**
- Evidence: `src-tauri/src/db/mod.rs:27` (`Connection::open` with READWRITE|CREATE falls back to read-only); no `sqlite3_db_readonly`/`PRAGMA query_only` check anywhere; frontend swallow sites `src/project/useProjectPersistence.js:373,410,491,527`, `src/app/useCanvasHud.js:49`, `src/app/useScaffoldActions.js:282-284`, `src/app/usePythonFirstOpen.js:82`, `src/app/useNpmScriptsFirstOpen.js:49-50`.
- Runtime: T12 (`attrib +R` → `open` OK, `load` OK, `write-test` → `SQLITE_READONLY attempt to write a readonly database`, 0 ms).
- Reachable input: a project on read-only media, a checkout whose files a sync/backup tool marked read-only, or a folder whose ACL denies write to the DB while allowing directory writes.
- Failure: the user arranges pieces, opens tabs, changes settings for a whole session; nothing persists; the next open shows the old layout with no explanation.
- Existing mitigation: none (console warnings only).
- Remediation: after open, probe writability (`PRAGMA query_only` / `sqlite3_db_readonly`, or a no-op write in a rolled-back transaction) and surface a persistent "workspace is read-only" pill; route persistence failures to a visible toast instead of `console.warn`.
- Regression test: open a project whose `workspace.db` is read-only and assert `db_open_project` returns a structured `AccessDenied` (or a `readOnly: true` flag) rather than success.

### Tier 3 — Hardening

**H1. `.litria/` is only git-ignored when a `.gitignore` already exists** — **confirmed**
- Evidence: `src-tauri/src/db/commands.rs:822-826` (early return when the file is absent); scaffold templates `blank_project.rs:43`, `python_scaffold.rs:165` cover only Litria-created projects.
- Runtime: the real-binary bootstrap into a folder without `.gitignore` wrote none (Pass 2.1 artifact listing).
- Reachable input: open-any-folder on a git repository that has no `.gitignore` (common for fresh `git init` repos and many small projects).
- Failure: `git add -A` stages `.litria/workspace.db` (and `-wal`/`-shm` if the app is open), publishing the absolute interpreter path from `editor_state`, the machine's layout state, and deleted-row residue (Pass 4.2) to collaborators or a public remote.
- Existing mitigation: none for that case.
- Remediation: when `<root>/.git` exists and `.gitignore` does not, create it with `.litria/` (or append to `.git/info/exclude`).
- Regression test: bootstrap into a temp dir containing `.git/` and no `.gitignore`; assert `.gitignore` (or `.git/info/exclude`) now lists `.litria/`.

**H2. No integrity check and a zero-length database is silently re-initialized; corruption surfaces as raw SQLite text with no recovery guidance** — **confirmed**
- Evidence: no `integrity_check`/`quick_check` anywhere; `schema.rs:112` runs DDL on whatever file is present; `errors.rs:95-120` classifies `malformed`/`not a database` as `Internal internal.unclassified`.
- Runtime: T11b (0-byte file → `OK schema_version=Ok(3)` then `Query returned no rows`); T11a/c/d/e (raw messages).
- Reachable input: interrupted copy/sync producing a 0-byte or truncated `workspace.db`; disk faults.
- Failure: the user sees `Could not open project at that path: database disk image is malformed` (or the misleading "no rows" message) with no indication that deleting `.litria/` restores a rebuild-from-`litria.toml`; in the 0-byte case the truncation evidence is overwritten.
- Existing mitigation: WAL + `synchronous=FULL` make torn writes by Litria itself unlikely.
- Remediation: run `PRAGMA quick_check` on open, refuse to initialize a pre-existing 0-byte file, and map `malformed`/`not a database` to a `db.corrupt` code whose message names the recovery step.
- Regression test: open a project whose `workspace.db` is a truncated copy; assert the command error has code `db.corrupt` and the file is unmodified.

**H3. Project path reaches `Connection::open` with URI parsing enabled and no validation** — **confirmed mechanism; unreachable on Windows (confirmed); Linux/macOS unverified**
- Evidence: `commands.rs:75-103,155-169` (trim + dir check only), `mod.rs:26-27`; rusqlite `OpenFlags::default()` includes `SQLITE_OPEN_URI` (`rusqlite-0.31.0/src/lib.rs:1174-1182`); bundle built with `SQLITE_USE_URI` (`libsqlite3-sys-0.28.0/build.rs:138`).
- Runtime: T19 (`file:<dir>/x?mode=memory&cache=shared` → in-memory DB; `?mode=ro` honoured); T19b (Windows: joined path with `?` → os error 123, unreachable).
- Reachable input: a typed launcher path beginning with `file:` on Linux/macOS, where `?` and `:` are legal directory characters so `create_dir_all` succeeds and SQLite then parses the query string.
- Failure: the "project" bootstraps into a memory database; every session's state vanishes on close. Self-inflicted (local user, own machine); no privilege boundary.
- Existing mitigation: Windows filename rules; the folder picker never produces such a path.
- Remediation: open with `OpenFlags::default() - SQLITE_OPEN_URI` (or canonicalize the root through `path_guard::resolve_project_root`) so the filename is always literal.
- Regression test: `open_workspace_db(Path::new("file:<tmp>?mode=memory"))` on Unix must create a real file (or be rejected), never an in-memory DB.

**H4. App-database failure at startup is logged and then silently degrades every app-level command** — **inferred**
- Evidence: `src-tauri/src/lib.rs:158-160` (`eprintln!` only); `app_db.rs:94` (`"App database is not open."` on every later call); ignored results at `commands.rs:129,171` (`let _ = app_db::register_project(...)`), `preferences.rs:351` (`unwrap_or_default`), `:379` (`let _ =`).
- Runtime: not reproduced (would require an unwritable `%LOCALAPPDATA%`); the T13 permission errors show the shape of the open failure.
- Reachable input: `%LOCALAPPDATA%\com.litria.ide` unwritable or corrupt `litria.db`.
- Failure: recents never populate, pins and HUD layout never persist, per-project preference mapping never caches; the only trace is a stderr line no release user sees.
- Existing mitigation: global preferences fall back to an empty map and still work from toml.
- Remediation: surface the setup failure once in the launcher (banner) and expose it via a `db_app_status` command.
- Regression test: point `LOCALAPPDATA` at a read-only dir, start the app, assert the launcher shows the app-storage warning.

**H5. Second `project` row on re-bootstrap; `LIMIT 1` without `ORDER BY`** — **confirmed mechanism; UI reachability inferred as blocked**
- Evidence: `commands.rs:111-114` (`INSERT OR REPLACE` keyed on a fresh `instance_id`, never replaces), `:614-615` (`LIMIT 1`, no order); `schema.rs:12-20` (no single-row constraint).
- Runtime: T8 (`bootstrap` twice → `project_rows=2`; `load` returns the first row "First").
- Reachable input: `db_bootstrap_project` on a folder that already holds a `workspace.db`. Through the wizard this is blocked for Blank/Python templates (`blank_project.rs:188-215`, `python_scaffold.rs:499-525` refuse non-empty folders) and the scaffold step runs before the bootstrap (`NewProjectWizard.jsx:575-589,708-712`); the npm scaffold path's own CLI is expected to refuse a non-empty target (not verified). Direct IPC reaches it.
- Failure: the project opens under the old name and instance id; the new metadata is invisible.
- Remediation: `CHECK`-style single-row guard (e.g. `id INTEGER PRIMARY KEY CHECK (id = 1)` as `viewport` does) or `DELETE FROM project` before insert.
- Regression test: bootstrap twice on one root; assert one row and that the returned state reflects the latest name.

**H6. Test fixtures for v1/v2 omit the foreign-key clauses** — **confirmed drift (Pass 2 D2/D3)**
- Evidence: `schema.rs:270-283`, `:309-317` vs `WORKSPACE_SCHEMA_V1` `:45,52-53,63-64`; ADR-015 v1 DDL includes the FKs.
- Runtime: `PRAGMA foreign_key_list(groups)` empty on `mig1`/`mig2`, populated on `fresh`.
- Failure scenario: any future migration that must rebuild a table (SQLite cannot alter constraints in place) would be tested against a table without FKs, so a dropped `ON DELETE CASCADE` would pass CI and ship orphan-producing deletes.
- Remediation: generate fixtures from the full historical DDL (including FKs), or assert `foreign_key_list` after migration.
- Regression test: after `migrate_upgrades_a_v1_database`, assert `PRAGMA foreign_key_list(connections)` has two rows.

---

## Conclusion

### 1. Authoritative schema source
`src-tauri/src/db/schema.rs` alone: `WORKSPACE_SCHEMA_V1` (latest DDL, applied idempotently on every open) plus `migrate_workspace_schema` (additive `ALTER`s gated by the `schema_version` table). No migration files, no `PRAGMA user_version`, no competing source.

### 2. Schema drift

| Pair | Result |
|---|---|
| Real 1.0.4 release binary vs 1.0.5 `schema.rs` (harness) | identical (md5 `ee31d23e…`) |
| Fresh vs v1-fixture-migrated | **FKs missing** on `groups.parent_id`, `connections.from/to_piece_id`; cosmetic column-order text |
| Fresh vs v2-fixture-migrated | **FK missing** on `groups.parent_id` |
| Fresh vs `mem_db()` test helper | identical by construction; 20/20 db tests pass |
| App DB real vs harness | identical (md5 `00c02a62…`) |
| `schema_version` | 3 everywhere |

### 3. Connection paths and effective PRAGMAs

| Path | RW | foreign_keys | journal_mode | busy_timeout | synchronous | secure_delete | Set per connection | PRAGMA failure |
|---|---|---|---|---|---|---|---|---|
| `open_workspace_db` (`mod.rs:27-33`) | RW+create | 1 | wal | 5000 ms (rusqlite default) | 2 FULL | 0 | yes (single static connection) | open fails, structured |
| `open_app_db` (`app_db.rs:67-71`) | RW+create | 1 | wal | 5000 ms | 2 | 0 | yes (single static) | logged, app continues degraded |
| tests (`:memory:`) | RW | 1 | memory | 5000 ms | — | — | per test | panic |

### 4. Findings by tier and status

| Tier | Confirmed | Inferred | Unverified | Total |
|---|---|---|---|---|
| 1 Data loss / credential exposure | 0 | 0 | 0 | **0** |
| 2 Silent incorrectness / durability | 3 (S1, S2, S3) | 0 | 0 | **3** |
| 3 Hardening | 4 (H1, H2, H5, H6) | 1 (H4) | 1 (H3: confirmed mechanism, platform reach unverified) | **6** |

### 5. Prioritized remediations
1. **Transactional, tolerant migrations** (S1): one transaction per version step including the bump; treat "duplicate column name" as done.
2. **Repairable bootstrap** (S2): `db_open_project` rebuilds when `workspace.db` exists but `project` is empty; or open+insert in one transaction.
3. **Read-only detection with a visible signal** (S3): probe writability at open; replace `console.warn` swallows with a user-visible persistence-failure pill.
4. **Unconditional `.litria/` ignore for git repos** (H1): create `.gitignore` or use `.git/info/exclude` when `.git` exists.
5. **Corruption handling** (H2): `PRAGMA quick_check` on open, refuse to initialize a pre-existing empty file, `db.corrupt` error code with the recovery step in the message.

### 6. Audit limitations
- **1.0.5 binary not rebuilt.** The on-disk release binary is 1.0.4; rebuilding would run `scripts/extract-sourcemaps.mjs` and overwrite the owner's archived `release-sourcemaps/1.0.5/` maps. The DB module is byte-identical across all 1.0.x tags, and the harness compiled the 1.0.5 `schema.rs` verbatim with identical output, but "created by the 1.0.5 executable" is strictly unverified.
- **Production open path invoked via a verbatim copy.** `open_workspace_db` is `pub(crate)`; the harness reproduces `mod.rs:18-38` line-for-line rather than calling it. The real binary run covers the end-to-end path once.
- **Historical v1/v2 DDL unavailable.** The public repository was seeded 2026-08-09 without history; only the committed test fixtures describe pre-v3 files. Whether real pre-v3 databases carried the FK clauses is unverified (D2/D3, H6).
- **1.0.0 binary not exercised.** Source identity only.
- **Platform coverage.** All runtime checks ran on Windows 10 (NTFS ACLs, `attrib`). Unix permission defaults (0644) are cited from SQLite source, not observed. H3 (URI path) is unreachable on Windows and untested on Linux/macOS.
- **UI presentation of errors** is traced in source (`useProjectLaunch.js`, `LaunchScreen.jsx`, persistence hooks) rather than observed live in the failing states; the CDP session only exercised the happy path.
- **Crash-in-migration** was simulated with on-disk fixtures representing each interruption point rather than by killing a process mid-`ALTER`.
- **Stale-lock realism.** The lock test used a foreign `BEGIN IMMEDIATE`; a stale `-shm` after an OS crash was not modelled.
- **Extension loading** runtime default (disabled per connection) is taken from SQLite documentation; not probed with a `load_extension()` call.
- **Report location.** The repository's security policy (`Agents/docs/security-policy.md` Rule 3) names `docs/security-audits/` as the home for audits; this report was placed at the requested `docs/audits/` path. Cross-linking from the living audit is left to the owner (a second file change was outside the audit's allowed scope).
- **Working-tree side effects.** `.research/2026-09-14-sqlite-schema-audit.md` (git-ignored, per the repo's mandatory research-journal policy) and ignored `src-tauri/target/` test artifacts were written; `git status` shows only this report.
