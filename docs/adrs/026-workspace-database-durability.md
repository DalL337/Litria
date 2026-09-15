# ADR-026: Workspace database durability — transactional migrations, repairable bootstrap, honest read-only and corruption handling

## Status

Implemented (2026-09-15 — decision 3's frontend half (read-only pill,
rate-limited write-failure notices, persistence skip) delivered on
`feat/read-only-workspace-pill` (PR #37) under the two owner rulings recorded in the
brief §4; the decisions themselves still await formal owner acceptance)

Implemented on branch (2026-09-14 — decisions 1, 2, 4–8 and the backend
half of 3 (`readOnly` probe and field) delivered on
`fix/adr-026-workspace-db-durability`, merged as PR #36; decision 6
carries an erratum found during implementation)

Proposed (2026-09-14 — drafted at owner direction from the SQLite audit of
the same day; owner accepted the audit's ordering "fix first, then the
persistence contract"; formal acceptance on owner review of this document)

## Date

2026-09-14

## Context

The 2026-09-14 audit of the project SQLite layer
(`docs/audits/sqlite-schema-2026-09-14.md`) found no data-loss or
credential-exposure defect and no SQL-injection surface, but three confirmed
durability defects and a cluster of hardening gaps, all in
`src-tauri/src/db/`. The `db/` module is byte-identical from `v1.0.0` to
`v1.0.5`, so every shipped release carries them:

- **S1** — `migrate_workspace_schema` runs its `ALTER`s and the version bump
  as separate autocommitting statements. A process death between them leaves
  a file that fails `duplicate column name` on every later open, permanently.
- **S2** — `db_bootstrap_project` creates `workspace.db` and inserts the
  `project` row as separate steps. A death in between leaves a file that
  `db_open_project` treats as a returning project and fails
  `Query returned no rows` forever; the rebuild-from-marker branch is never
  reached.
- **S3** — a read-only `workspace.db` opens successfully; every later write
  fails `SQLITE_READONLY` and the frontend swallows it with `console.warn`.
  A whole session's layout changes vanish silently.
- **H2** — nothing runs `quick_check`; corruption surfaces as raw SQLite
  text with no recovery hint, and a zero-length file is silently
  re-initialized as an empty schema.
- **H3** — `Connection::open` uses rusqlite's default flags, which include
  `SQLITE_OPEN_URI`; a `file:` project path would be parsed as a URI
  (unreachable on Windows, unverified on Unix).
- **H1** — `.litria/` is appended to `.gitignore` only when one already
  exists, so open-any-folder on a repo without one leaves `workspace.db`
  stageable.
- **H5 / H6** — a second `INSERT OR REPLACE INTO project` on an existing file
  produces two rows read by an unordered `LIMIT 1`; the v1/v2 migration test
  fixtures omit the foreign-key clauses the production schema has.

The owner's stated direction is that SQLite is Litria's opinionated default
persistence and that a backend-neutral contract may follow later. These fixes
are deliberately placed so that the SQLite-specific parts land in the file
that would become that adapter.

Canonical detailed design:
`docs/plans/persistence/brief-workspace-database-durability.md` (the brief).
This ADR records the decisions only.

## Decision

1. **Migrations are transactional and tolerant.** Each version step of
   `migrate_workspace_schema` runs inside one transaction together with its
   `schema_version` bump, so a file is always at a whole version. Additive
   `ALTER TABLE … ADD COLUMN` steps first consult `PRAGMA table_info` and
   skip columns that already exist, so a file left between statements by an
   older build migrates cleanly instead of failing forever. `CURRENT_SCHEMA_VERSION`
   stays 3; no new version is introduced by this decision.

2. **A workspace without a project row is a bootstrap target, never an
   error.** `db_open_project` treats "`workspace.db` exists but `project`
   is empty" exactly like "no `workspace.db`": it rebuilds from `litria.toml`
   or bootstraps fresh, preserving whatever rows the file already holds.
   Bootstrap writes the `project` row inside a transaction and clears any
   prior row first, so the table is single-row by construction.

3. **Read-only workspaces open in a visible read-only mode.** Opening does
   not refuse a read-only file (viewing the canvas is still useful); it
   probes writability at open and reports `readOnly: true` in the returned
   `ProjectState`. The canvas shows a persistent read-only pill while that
   flag is set, and persistence write failures of any kind surface through a
   visible, rate-limited notice. `console.warn` alone is no longer an
   acceptable terminal state for a failed write.

4. **Corruption is detected at open and named.** `open_workspace_db` runs
   `PRAGMA quick_check` after the pragma batch and refuses to initialize a
   pre-existing zero-length file. SQLite corruption results map to a
   structured `db.corrupt` command error whose message states the recovery
   step (remove `.litria/` to rebuild from `litria.toml`; the canvas layout
   is lost, files are not). Litria never deletes or rewrites a corrupt file
   itself.

5. **Persistence errors are classified by SQLite result code, not message
   text.** `src-tauri/src/db/mod.rs` maps `rusqlite::ErrorCode`
   (`DatabaseCorrupt`/`NotADatabase` → `db.corrupt`, `ReadOnly` →
   `db.read_only`, `DatabaseBusy` → `db.busy`, `CannotOpen` → existing
   access/not-found categories) before anything reaches
   `CommandError::from_text`. The substring classifier remains for
   non-database text but is no longer on the database path.

6. **Database filenames are literal.** `open_connection` in
   `src-tauri/src/db/mod.rs` refuses any database path that begins with
   `file:` (the only prefix SQLite parses as a URI) and opens with
   `OpenFlags::default()` minus `SQLITE_OPEN_URI`. Applies to both databases.

   > **Erratum (2026-09-14, found while implementing):** the flag alone is
   > inert. rusqlite's `bundled` feature compiles SQLite with
   > `SQLITE_USE_URI` (libsqlite3-sys 0.28.0 `build.rs`), which enables URI
   > parsing for every connection regardless of open flags. The regression
   > test `open_does_not_parse_uri` showed the audit's T19 string still
   > producing an in-memory database with the flag removed; the refusal is
   > the effective control and the flag is kept only as defence in depth.

7. **`.litria/` is ignored whenever the folder is a git repository.** If
   `<root>/.git` exists and `.gitignore` does not, bootstrap creates a
   `.gitignore` containing `.litria/`. Existing behaviour (dedup-append when
   the file exists; nothing when the folder is not a repository) is kept.

8. **SQLite-specific mechanisms live in `src-tauri/src/db/mod.rs`.** The
   writability probe, `quick_check`, the open-flag change and the result-code
   mapping are placed there, not in `commands.rs`, so a future
   backend-neutral store contract can treat that file as the SQLite adapter
   without moving them again. The decision to author such a contract is
   **not** made here.

## Consequences

Positive:

- The two "permanently unopenable" states can no longer be produced by a
  crash, and files already in those states (if any exist in the wild)
  self-heal on the next open thanks to the tolerant `ALTER`s and the
  bootstrap-target rule.
- Users on read-only media or a mis-ACL'd checkout see why their layout is
  not persisting instead of discovering it on the next launch.
- Corruption produces one recognisable error with the recovery step in it;
  support conversations get shorter.
- Every fix ships with a regression test derived from the audit's runtime
  cases (T6, T7, T9, T11b, T12, T19), so the audit's evidence becomes the
  test suite's evidence.

Costs / trade-offs:

- `quick_check` on every open costs milliseconds at Litria's file sizes
  (tens of KB). Accepted; the brief leaves "run only on suspicious signals"
  as a later optimisation if a large project ever measures otherwise.
- `ProjectState` gains a `readOnly` field, which touches the JS hydration
  path and one domain test; the pill is a small UI addition that must use
  theme tokens like every Litria surface.
- The tolerant migration adds a `table_info` read per additive step. Three
  steps today; negligible.
- The `.gitignore` creation writes a new file into a user's repository
  without asking. Accepted because the alternative (committing
  `workspace.db`) is worse and the existing append behaviour already writes
  to that file; the brief specifies the exact content so nothing else is
  added.

## Alternatives Considered

- **Back up `workspace.db` before migrating** — rejected as the primary fix:
  it leaves the root cause (non-atomic migration) in place, adds a second
  database file to a repository directory that then also needs ignoring,
  and still needs a repair path. May be added later for non-additive
  migrations; recorded in the brief.
- **Refuse to open a read-only workspace** — rejected: a read-only view of
  the canvas is legitimate (read-only media, review checkouts) and refusing
  gives the user nothing.
- **Auto-delete and rebuild on corruption** — rejected: destroys the user's
  only evidence and their chance to recover the layout by hand; the
  rebuild is one deliberate step away and the message says which.
- **A migration crate or ORM** — rejected: three additive versions and a
  single version table do not justify a dependency; the transaction wrapper
  is a dozen lines.
- **A new schema version with a single-row CHECK on `project`** — rejected
  for now: it would be the first non-additive change (SQLite cannot add a
  constraint in place) and would force the table-rebuild migration the
  fixture drift (H6) makes risky. Single-row-by-construction achieves the
  same invariant without a migration.

## Scope Notes

- **Not decided here:** a backend-neutral persistence contract, pluggable
  backends, or any PostgreSQL/CRDT direction. Those get their own brief
  (the audit's "Pass 7" question) after this arc ships. Decision 8 only
  keeps that door open.
- **Not in scope:** the app-level database's silent startup failure (audit
  H4) and typed errors beyond the database boundary. Listed as follow-ups.
- The split between shared workspace state and machine-local session state
  inside `workspace.db` (interpreter path, open tabs, viewport next to
  pieces and groups) is unchanged; it is the first question the contract
  brief must answer, not this one.

## Implementation Follow-ups

> **Implemented follow-up (2026-09-15, ADR-027 slice 1):** File-save
> failures now use the same adapter-neutral persistence-failure observer as
> workspace-database writes. A failed or refused disk write leaves the editor
> and piece baselines dirty, surfaces the affected relative path and reason,
> and vetoes save-gated project transitions. The database `readOnly` flag
> continues to govern layout persistence only; it does not disable file-save
> attempts.

- Cross-link this ADR and the audit from `docs/security-audits/security-audit.md`
  (the living audit) on the next dated entry; the audit report itself sits
  at `docs/audits/` by owner instruction and the security policy's home rule
  is not yet reconciled.
- Audit H4: surface app-database initialisation failure in the launcher.
- Consider a Rust integration test that exercises `open_workspace_db` on a
  temp directory (today no test does; every db test is in-memory).
