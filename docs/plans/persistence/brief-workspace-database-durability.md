# Brief — Workspace database durability fixes (SQLite audit remediation)

**Status:** Slices 1, 2, 3 and 5 implemented 2026-09-14 on branch
`fix/adr-026-workspace-db-durability`, PR #36 (see *Delivery notes* below), plus
the backend half of slice 4 (`readOnly` on `ProjectState`). Slice 4's
frontend waits on the two owner rulings in §4. Drafted 2026-09-14 from the
audit `docs/audits/sqlite-schema-2026-09-14.md`; owner directed "deal with
the fixes first, then stop." Companion ADR:
`docs/adrs/026-workspace-database-durability.md` (decisions only; this brief
is the canonical detailed design).

## Origin

The 2026-09-14 SQLite audit (owner-supplied six-pass prompt, audit-only) found
zero Tier-1 issues, three confirmed Tier-2 durability defects and six
hardening items. The owner's reaction: "not as bad as I thought." The owner's
longer-term direction is SQLite as the opinionated default with a
backend-neutral contract possibly following later; that contract is
explicitly **out of scope** here, but Slice placement respects it (ADR-026
decision 8).

## Findings being fixed (all verified 2026-09-14; evidence in the audit)

| Id | Defect | Evidence | Audit case |
|---|---|---|---|
| S1 | Migration steps and the version bump autocommit separately; a crash between them makes every later open fail `duplicate column name` | `src-tauri/src/db/schema.rs:148-171`; rusqlite `execute_batch` has no implicit transaction | T6, T7 |
| S2 | Bootstrap creates `workspace.db` before inserting the `project` row; a half-created file is treated as a returning project and fails `Query returned no rows` forever | `src-tauri/src/db/commands.rs:103-119`, `:168-173` | T9 |
| S3 | Read-only file opens fine; every write fails `SQLITE_READONLY`; frontend swallows with `console.warn` | `src-tauri/src/db/mod.rs:27`; `src/project/useProjectPersistence.js:373,410,491,527`; `src/app/useCanvasHud.js:49`; `src/app/useScaffoldActions.js:282-284`; `src/app/usePythonFirstOpen.js:82`; `src/app/useNpmScriptsFirstOpen.js:49-50` | T12 |
| H2 | No `quick_check`; zero-length file silently re-initialized; corruption surfaces as raw SQLite text | `schema.rs:112`; `src-tauri/src/errors.rs:95-120` | T11a–e |
| H3 | `SQLITE_OPEN_URI` on by default; `file:` paths parsed as URIs | `mod.rs:27`; rusqlite `OpenFlags::default()` | T19 |
| H1 | `.litria/` ignore only appended when `.gitignore` exists | `commands.rs:822-826` | Pass 2.1 artifact listing |
| H5 | Re-bootstrap on an existing file yields two `project` rows; `LIMIT 1` unordered | `commands.rs:111-114`, `:614-615` | T8 |
| H6 | v1/v2 test fixtures omit FK clauses the production schema has | `schema.rs:270-283`, `:309-317` vs `:45,52-53,63-64` | Pass 2 D2/D3 |

Corrected assumptions from the audit, so nobody re-fixes them: rusqlite
already sets `busy_timeout` to 5000 ms on every connection; foreign keys are
ON by compile default (`SQLITE_DEFAULT_FOREIGN_KEYS=1`) and by pragma.

## Design

### 1. Transactional, tolerant migrations (S1, H6)

`migrate_workspace_schema` (`schema.rs:141-175`) becomes:

- Read `version`. For each step `v → v+1` with `version < v+1`:
  `let tx = conn.unchecked_transaction()?;` → run the step's statements →
  `UPDATE schema_version SET version = v+1` → `tx.commit()?`. One
  transaction per step, bump included. A crash anywhere inside a step rolls
  back to the previous whole version.
- Each additive step is expressed as a list of `(table, column, decl)` and a
  helper `add_column_if_missing(conn, table, column, decl)` that consults
  `PRAGMA table_info(<table>)` (table names are compile-time literals; keep
  them so) and skips existing columns. This heals files left by pre-fix
  builds between statements (T6/T7 shapes).
- The final `if version < CURRENT_SCHEMA_VERSION { UPDATE … }` disappears;
  each step owns its bump.
- Fixtures: `migrate_upgrades_a_v1_database` / `_v2_database…` fixtures gain
  the FOREIGN KEY clauses the production DDL carries (ADR-015 shows them
  present in v1), and the tests assert `PRAGMA foreign_key_list` on
  `groups` and `connections` after migration (H6).

New tests (schema.rs): `migrate_heals_partial_v1_to_v2_step` (fixture = v1 +
`source_side` already present, version 1) and
`migrate_heals_completed_step_without_bump` (all v2 columns present, version
1); both must end at `CURRENT_SCHEMA_VERSION` with all columns present.
`migrate_is_idempotent` stays.

### 2. Repairable bootstrap, single project row (S2, H5)

- `db_open_project` (`commands.rs:154-185`): after `open_workspace_db`, check
  `SELECT COUNT(*) FROM project`. Zero rows → close the connection and fall
  through to the existing marker/fresh branches (which call
  `db_bootstrap_project`). Rows in other tables are preserved because
  bootstrap opens the same file and only touches `project`.
- `db_bootstrap_project` (`commands.rs:103-119`): wrap `DELETE FROM project`
  + `INSERT INTO project …` in one `unchecked_transaction`. `INSERT OR
  REPLACE` becomes a plain `INSERT` (the delete makes it single-row by
  construction). No schema change; `CURRENT_SCHEMA_VERSION` stays 3.
- `load_full_state` keeps `LIMIT 1`; with one row it is deterministic.

New tests (commands.rs; `pub(crate)` functions are callable in-crate):
`open_rebuilds_when_project_row_missing` (temp dir: run `open_workspace_db`,
no insert, then `db_open_project` → `Ok(ProjectState)` with name = folder
name, and pre-existing `editor_state` rows still present);
`bootstrap_twice_keeps_one_project_row`.

### 3. Open-time health in the adapter file (H2, H3, error classification)

All in `src-tauri/src/db/mod.rs`, per ADR-026 decision 8:

- **Flags:** `Connection::open_with_flags(path, OpenFlags::default() -
  OpenFlags::SQLITE_OPEN_URI)` for both databases (`mod.rs:27`,
  `app_db.rs:67`). Test: on Unix, `open_workspace_db(Path::new("file:<tmp>?mode=memory"))`
  must produce a real file under that literal name or fail; never an
  in-memory DB. On Windows the test asserts the existing os-error-123 path.
- **Zero-length guard:** before `Connection::open`, if `workspace.db` exists
  with length 0 → return `db.corrupt` ("workspace.db is empty"). A file that
  exists is never initialized as new.
- **`quick_check`:** after the pragma batch, `PRAGMA quick_check` must
  return exactly `ok`; anything else → `db.corrupt` with the first line of
  the check output in the message.
- **Result-code mapping:** a `fn classify(e: &rusqlite::Error) -> CommandError`
  keyed on `ErrorCode`: `DatabaseCorrupt | NotADatabase` → `Internal`,
  code `db.corrupt`; `ReadOnly` → `AccessDenied`, code `db.read_only`;
  `DatabaseBusy | DatabaseLocked` → `Conflict`, code `db.busy`;
  `CannotOpen` → `from_io`-style access-denied/not-found by message; else
  `Internal`, `db.sqlite`. `open_workspace_db`/`open_app_db` return
  `CommandError` (or a small `DbError` the commands map) instead of
  `String`, so `from_text` substring matching is off the database path.
  Messages for `db.corrupt` end with the recovery sentence: *"Move or
  delete the project's `.litria` folder to rebuild the workspace from
  litria.toml; your files are untouched, the canvas layout will be reset."*
- **Writability probe:** after `quick_check`, `sqlite3_db_readonly` via
  `conn.is_readonly(DatabaseName::Main)` (rusqlite exposes it). Result is
  returned to the caller as part of the open result.

New tests (mod.rs, temp dirs): `open_refuses_zero_length_file`,
`open_reports_corrupt_on_truncated_file`, `open_reports_read_only`
(set the read-only attribute / `chmod 0444`), `open_does_not_parse_uri`.

### 4. Read-only mode and visible persistence failures (S3)

Backend:

- `ProjectState` (`src-tauri/src/db/types.rs:83-92`) gains
  `read_only: bool` (serde camelCase → `readOnly`). Both `db_open_project`
  and `db_bootstrap_project` set it from the probe (bootstrap of a fresh
  file is always `false`).

Frontend:

- `useProjectLaunch.js` carries `readOnly` onto the project instance;
  `useProjectPersistence.js` skips debounced writes when the instance is
  read-only (no point in generating failures) and the canvas shows a
  persistent pill: *"Read-only workspace — layout changes won't be saved."*
  Pill styling from theme tokens only (Litria-themed deliverables rule); no
  modal (no-questionnaire-modal rule).
- A small `persistenceNotice` piece of domain state (owning domain:
  project persistence, per Orchestration.md) receives every write failure
  from the sites listed in the Findings table; the pill renders the latest
  message and rate-limits to one notice per 10 s. `console.warn` calls stay
  as the secondary trace.
- `db.read_only` and `db.busy` errors from any command route to the same
  notice with their message.

Tests: JS domain test for the notice reducer (rate limit, latest-wins,
clear on project switch); existing persistence tests updated for the
read-only skip; guard run (`npm run check:architecture`) because a domain
gains state.

**Owner rulings (2026-09-14, both RULED):**

1. **Pill placement: canvas top edge next to the HUD**, with the draft copy
   *"Read-only workspace — layout changes won't be saved."* The rate-limited
   persistence notices share that surface. (Status strip rejected: too easy
   to never look at for a first-hour basic.)
2. **Read-only skips persistence only.** Every gesture stays (drag, group,
   wire, collapse); nothing is written and the pill says why. Owner's
   addition: **zoom and pan must remain in all cases**, so a node someone
   parked far off the viewport is still reachable. Viewport writes are
   skipped like every other write; navigation itself is never gated.

Slice 4 branches from `main` after PR #36 merges (it depends on the
`readOnly` field and the `db.*` error codes that PR carries).

### 5. `.litria/` ignore for git repositories (H1)

`add_litria_to_gitignore` (`commands.rs:822-846`): if `.gitignore` is
absent **and** `<root>/.git` exists (file or directory — worktrees use a
file), write a new `.gitignore` containing exactly:

```
# Litria workspace (local state)
.litria/
```

Absent `.git` → unchanged (nothing written). Test:
`bootstrap_creates_gitignore_in_git_repo_without_one` and
`bootstrap_writes_nothing_outside_git_repo`.

## Slices

Each slice is one PR-sized unit; 1–3 and 5 are backend-only and can ship in
one PR if preferred. Verification per `Agents/docs/verification-policy.md`
Rule 1 on every slice (`cargo build` zero warnings, `cargo test`, and for
slice 4 also `npm run check` + `npm run test:domains`).

| # | Slice | Goal | Files | Tests | Acceptance |
|---|---|---|---|---|---|
| 1 | Transactional migrations | S1 + H6 | `schema.rs` | 2 new partial-migration tests; FK assertions in fixture tests; existing 9 schema tests green | T6/T7 shapes open and land at version 3 |
| 2 | Repairable bootstrap | S2 + H5 | `commands.rs` | 2 new temp-dir tests | T9 shape opens as a rebuilt project; bootstrap twice = one row |
| 3 | Open-time health | H2 + H3 + code mapping | `mod.rs`, `app_db.rs`, `errors.rs` (new codes only) | 4 new temp-dir tests | T11b refuses; T11a/c/d/e → `db.corrupt` with recovery sentence; T12 → `readOnly` reported; T19 literal filename |
| 4 | Read-only mode + notices | S3 | `types.rs`, `commands.rs`, `useProjectLaunch.js`, `useProjectPersistence.js`, persistence domain, pill component + CSS | JS domain tests; guard pass | Read-only file shows the pill on open; a forced write failure shows a notice within one flush |
| 5 | Gitignore creation | H1 | `commands.rs` | 2 new temp-dir tests | Fresh `git init` folder gets `.gitignore` with `.litria/` on first open |

Order: 1 → 2 → 3 → 5 (no rulings needed) → 4 (after the two owner rulings
above). Slice 3's error classification lands before slice 4 so the frontend
can key on codes.

## Delivery notes (2026-09-14, branch `fix/adr-026-workspace-db-durability`)

- Slices 1, 2, 3, 5 landed together in one PR (as the table allows), plus
  the backend half of slice 4: `ProjectState.readOnly` is set from the
  writability probe by both `db_open_project` and `db_bootstrap_project`.
  No frontend file changed.
- **H3 remedy changed.** Dropping `SQLITE_OPEN_URI` is inert: the bundled
  SQLite is compiled with `SQLITE_USE_URI` (ADR-026 decision 6 erratum).
  `db::open_connection` refuses paths that start with `file:`; the test
  `open_does_not_parse_uri` keeps a positive control proving the T19 string
  does produce an in-memory database when parsed.
- **The repair path returns the preserved rows.** When `workspace.db` exists
  without a `project` row, `db_open_project` bootstraps the row and then
  returns `load_full_state()`, not the empty bootstrap state. An empty state
  would hydrate an empty canvas over surviving `pieces` rows, and the next
  create would collide on `UNIQUE(file_path)`.
- **Classification covers every command, not only open.** Every
  `with_workspace_db` closure now returns `db::DbError` (a `rusqlite::Error`
  plus context) and `From<DbError> for CommandError` maps by result code.
  A write to a read-only file already surfaces as `db.read_only` (proved
  in `open_reports_read_only`), so slice 4's frontend can key on it.
  App-DB operations keep their text errors (out of scope); `open_app_db`
  shares the flags, pragmas and the `file:` refusal.
- `initialize_app_schema` reuses the new `add_column_if_missing` helper
  instead of matching `duplicate column name` text.
- Tests beyond the table: `migrate_failed_step_leaves_previous_whole_version`
  (per-step atomicity: the v3 step fails, the file stays at a whole v2),
  `open_reports_corrupt_from_quick_check` (page-2 garbage the pragma batch
  does not notice), `classify_maps_result_codes_to_codes`,
  `gitignore_created_when_git_is_a_worktree_file`,
  `gitignore_appended_once_when_present`, `open_returning_project_reports_writable`.
  On-disk tests serialize on `db::serial_guard()` because they share the
  process-wide `PROJECT_DB` slot.

## Verification against the audit

The audit's runtime cases were produced with a scratch harness (not in the
repo). The regression tests above reproduce each case in-crate with temp
directories so the evidence lives in `cargo test`. After slices 1–3, the
audit's Pass 6 table rows for corrupt / zero-length / read-only / interrupted
migration / interrupted bootstrap should each flip to "structured error with
recovery guidance" or "self-heals"; re-running the audit's commands from the
report is the acceptance check for the arc.

## Deferred / not in scope

- Audit H4 (app-database startup failure only logged) — follow-up after this
  arc; needs a launcher banner.
- Backup-before-migrate — reconsider only when a non-additive migration is
  first needed.
- The persistence contract / pluggable backends ("Pass 7") — separate brief.
  Two rulings it will need, noted so they are not lost: which `editor_state`
  keys are machine-local versus shared, and where a remote-backend credential
  would live (never `litria.toml`).
- Reconciling the audit report's location (`docs/audits/`) with the security
  policy's home rule (`docs/security-audits/`).
