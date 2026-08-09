# Planned Features & Intentional Scaffolding

**Purpose.** A single source of truth for code that exists *ahead of its UI wiring* — backend commands, JS bindings, or helpers built before the feature that consumes them. When a dead-code tool (e.g. `npx fallow dead-code`) flags an unused export, **check here first**:

- **Listed here →** intentional scaffolding for a planned feature. Keep it. Do not delete.
- **Not listed here →** treat as a deletion candidate and triage (verify call sites, then remove).

This lets us *measure* dead-code findings against declared intent instead of guessing from the code.

## How to maintain this doc

- **Adding scaffolding ahead of wiring** (e.g. a Rust command + JS wrapper before the UI calls it): add an entry below with the feature name, the exact code surfaces (files + exported symbols), and the wiring TODO.
- **Wiring a feature up** (the exports gain real consumers): delete its entry — it's no longer "planned," it's shipped.
- **Deciding a planned feature is dead** (won't build it): delete both the entry *and* the scaffolding code in the same change.
- Keep entries surface-accurate: list the symbols so a reviewer can diff this doc against a dead-code report mechanically.

---

## Registry

### Connection Persistence — create wired; delete removed
- **Status:** resolved. `dbCreateConnection` is wired (`useProjectPersistence.js`
  `persistConnectionSides`, on manual draw). `dbDeleteConnection` / `db_delete_connection`
  were **removed** — they had no caller and no correctness role.
- **Why delete was unnecessary:** connections are discovery/imports-authoritative.
  On load, hydration clears connections and discovery re-creates them from import
  relationships; the persisted rows are per-pair **anchor-side overrides** (not
  connection existence). Deleting a wire is transient by design — if the import
  still exists, discovery redraws it on reopen. `db_delete_connection` would only
  reset an anchor override, so it was never the mechanism for a durable delete.
- **If durable connection-delete is ever wanted:** it needs a purpose-built
  "suppressed pairs" concept (persist which discovered edges the user has hidden),
  not a generic delete-by-id — so re-adding the old command wouldn't be the path.

### Editor State Restore — feature shipped; `load_editor_state` retained for split-panes
- **Status:** the restore feature is **shipped** — but via the inline `_dbState.editorState`
  payload that `db_open_project` already returns, *not* via `dbLoadEditorState`.
  `useProjectPersistence.js` (editor session restoration effect) reads
  `open_tab_piece_ids` / `active_tab_piece_id` from `projectInstance._dbState.editorState`
  and restores tabs through `openFromSnapshot`; `useProjectLaunch.js` restores the
  `ws.*` workspace-style keys the same way. So open tabs, active editor, and
  workspace color modes all restore on open.
- **Retained scaffolding:** `src-tauri/src/db/commands.rs` — `db_load_editor_state`
  and `src/project/dbStorage.js` — `dbLoadEditorState`. These have **no code caller**
  (restore uses the inline payload instead), so a dead-code tool will flag
  `dbLoadEditorState`. Kept intentionally for the planned editor split-panes feature
  (`docs/plans/ideas/editor-split-panes.md`), which needs an on-demand editor-state
  read independent of project open.
- **Resolution TODO:** when split-panes lands (wiring `dbLoadEditorState`) *or* is
  dropped, close this out — delete both the binding and the Rust command per the
  deletion rule above if unused. Do **not** "wire" `dbLoadEditorState` into launch:
  that would duplicate data already present in `_dbState.editorState`.

### Group Membership — FIXED via folder-derivation; `group_pieces` is the plan-only-mode seam
- **Status:** the stale-membership bug is **fixed**. Hydration
  (`useProjectPersistence`) derives each folder-backed group's members from where
  its pieces' files actually live — the same source of truth the runtime
  folder=group reconciliation uses, via the shared `src/utils/groupFolders.js`
  (`buildPiecesByFolder` / `deriveGroupPieceIds`). A stale/incomplete
  `group_pieces` row can no longer resurrect an old membership on reopen.
- **Grouping always = a folder disk write** (confirmed permanent core model,
  2026-07-01). So `group_pieces` is not read on load today — it's consulted only
  as a fallback for a group with no `folderPath` ("manual" group), of which there
  are currently none.
- **Keep — do NOT delete.** `group_pieces` + `db_add_piece_to_group` /
  `db_remove_piece_from_group` are the persistence **seam for a future "plan-only
  mode"**: grouping to externalize a user's mental model *without* disk writes
  (i.e. manual, non-folder groups). `deriveGroupPieceIds` already returns `null`
  for a `folderPath`-less group so the hybrid load path is in place.
- **When plan-only mode is built:** wire membership persistence **properly** — a
  centralized reconciliation that diffs in-memory `group.pieceIds` against
  `group_pieces` — rather than trusting the current scattered call-site writes
  (the inconsistency this fix routed around). Do not rely on today's writes.

### LSP backend scaffolding — ahead of language-server management & richer LSP
Unused Rust in `src-tauri/src/lsp/` that is **intentional scaffolding** for planned
LSP work, not dead code — rustc flags each as dead-code; keep them. (Triaged
2026-07-01; the non-scaffolding warnings alongside these — the version constants,
`LspPosition`/`LspRange`, `LspSession` metadata fields, the `spawn_pty` param — are
*not* scaffolding and are out of scope here.) Grouped by the feature that gives each a home:

- **Managed language-server installs** — see `docs/plans/lsp/language-server-management-build-plan.md`.
  - `ResolutionTier::Managed` — `src-tauri/src/lsp/packs/mod.rs`. The middle tier of the
    resolver's global → managed → bundled chain. `resolver.rs::probe_managed` is a stub
    that always returns `None`; the variant isn't constructed until managed installs
    (`~/.litria/servers/`) exist.
  - `install_hint()` — `src-tauri/src/lsp/packs/python.rs`, `.../typescript.rs`. The
    `npm install -g …@<pinned>` command to recover a missing server. A home already
    exists: `src/app/languageSupportDomain.js` detects a missing `server` prerequisite
    and shows guidance — but `LspPrerequisitesPayload` (`src-tauri/src/lsp/types.rs`)
    carries no hint yet. Wiring = add an `installHint` field, populate it in
    `session.rs::detect_prerequisites`, surface it in the JS message. Low priority:
    servers are bundled (`satisfied_by_bundle: true`), so it only triggers on a
    broken / dev-without-bundle install.

- **Incremental document sync** — richer LSP; only `Full` sync exists today.
  - `SyncKind::as_u8` + `LanguagePack.document_sync_kind` — `src-tauri/src/lsp/packs/mod.rs`.
    Declares per-pack sync granularity for the LSP handshake. Nothing reads the field and
    only `Full` exists, so wiring it now is a no-op — it becomes meaningful when
    Incremental sync (per-change diffs) is added.

- **Graceful LSP shutdown** — teardown currently `kill()`s the process.
  - `LspTransport::wait()` — `src-tauri/src/lsp/transport.rs`. Waits for the server to
    exit; intended to follow an LSP `shutdown` + `exit` sequence. Immediate kill is fine
    for a desktop app, so this only gets a home if a graceful-shutdown sequence is adopted.

---

## Investigate (not confirmed scaffolding — resolve, don't assume)

_None currently — previous entries (`lspTeardownAll`, `getBackends`) were confirmed
dead and removed._
