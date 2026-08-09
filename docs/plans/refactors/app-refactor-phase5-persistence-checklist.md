# App Refactor Phase 5 Persistence Separation Checklist

**Status: COMPLETE** -- Core persistence slices done, scaffold follow-up completed. Closed 2026-03-07.

## Purpose
Isolate project persistence concerns into `ProjectDomain` and infrastructure adapters.

## In Scope
- Manifest reads/writes.
- Scaffold apply and sync workflows.
- File-system adapter boundary.

## Tasks
- [x] Define `ProjectDomain` API (`load`, `save`, `sync`, `applyScaffold`).
- [x] Extract manifest logic from `App.jsx` and workspace-facing UI code.
- [x] Extract file-system operations behind adapter interfaces.
- [x] Ensure persistence side effects are isolated to adapters/services.
- [x] Update editor/workspace interactions to call `ProjectDomain` APIs only.
- [x] Add unit tests for `ProjectDomain` behavior with adapter mocks.
- [x] Add integration tests for save/load/reopen project flows.
- [x] Implement and wire `Open Existing Litria Project` launch flow (manifest-read bootstrap, non-destructive open path).
- [x] Implement launch `Open File` picker flow (native file explorer selection and single-file workspace bootstrap).

## PR Slices
1. `project-api`: domain contract and adapter interfaces.
2. `persistence-migration`: move fs/manifest logic out of UI layers.
3. `persistence-tests`: unit + integration coverage.

## Validation Gates
- [x] Save workflow works.
- [x] Reload/reopen project restores expected state.
- [ ] Scaffold apply workflow works.
- [ ] Disk sync behavior is correct.
- [x] No fs/manifest side effects exist outside adapter layer.

## Exit Criteria
- [x] IO side effects are isolated in adapter boundary.
- [ ] Save/load/scaffold/sync flows pass tests and manual verification.

## Evidence
- PR(s): `local workspace (uncommitted)`
- Test run links/output: `npm run test:domains` (pass, 35/35), `npm run check:architecture` (pass), `npm run build` (pass)
- Adapter boundary notes: `DrawerContentScaffold` now consumes `listTree` via `ProjectDomain`; no direct `project/storage` imports in UI/application layer (`rg -n "project/storage" src` -> no matches).
- Manual validation notes (2026-02-14): open-existing browse + launch works; edit/save/close/reopen roundtrip works; negative-path check works; scaffold-create flow currently has partial piece spawn and inconsistent filename-header injection in some pieces (tracked as deferred/non-blocking for persistence).

## Plan Drift
- Drift recorded (2026-02-14): Added explicit launch-path work for `Open Existing Litria Project`.
- Reason: persistence validation surfaced a product gap; reopen/load verification required a real, non-disabled open-existing entrypoint.
- Impact: small scope increase inside Phase 5; implementation remained within persistence boundary goals (manifest read + project instance bootstrap, no new backend command required).
- Drift recorded (2026-02-14): Added explicit launch `Open File` flow with native picker support.
- Reason: launch UX now needs best-practice file/folder selection paths instead of manual path typing.
- Impact: small scope increase; added dialog plugin wiring and a file-read command for non-project single-file bootstrap.

## Progress Notes
- 2026-02-14: Slice 1 (`project-api`) completed.
- Added `src/project/projectDomain.js` with command surface:
  `load`, `save`, `sync`, `readFile`, `writeFile`, `readManifest`, `writeManifest`,
  `movePath`, `deletePath`, `listTree`, `applyScaffold`.
- Routed `App.jsx` persistence/scaffold call sites through `ProjectDomain` command APIs.
- Updated app shell guard allowlist for `./project/projectDomain`.
- Added `test/domains/projectDomain.test.mjs` for adapter proxy behavior and scaffold orchestration behavior with adapter mocks.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- Remaining in this phase: move manifest orchestration from `useProjectPersistence` into `ProjectDomain`, then add save/load/reopen integration coverage.
- 2026-02-14: Slice 2 (`persistence-migration` - partial) completed.
- Added high-level persistence commands to `ProjectDomain`:
  `updateManifest`, `saveTabState`, `loadWorkspaceState`, `loadEditorState`, `persistWorkspaceState`, `persistEditorState`.
- Refactored `src/project/useProjectPersistence.js` to delegate manifest/session orchestration to `ProjectDomain` commands.
- Updated `App.jsx` persistence hook wiring to pass `projectDomain` instead of raw storage functions.
- Expanded `test/domains/projectDomain.test.mjs` with workspace/editor persistence command coverage.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- Remaining in this phase: add save/load/reopen integration tests.
- 2026-02-14: Slice 2 follow-up completed.
- Added explicit `ProjectDomain` command `updatePieceFileMap` for piece-file-map manifest mutations.
- Replaced remaining `App.jsx` manifest updater closures with queued domain command calls via `useProjectPersistence` (`queueManifestCommand`).
- Removed direct manifest updater usage from app-level group/piece delete and group rename/create flows.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- Remaining in this phase: integration coverage for save/load/reopen project flows (Slice 3).
- 2026-02-14: Slice 3 (`persistence-tests`) completed.
- Added `test/domains/projectPersistence.integration.test.mjs` covering save -> reopen -> load roundtrip for workspace + editor state via `ProjectDomain` APIs.
- Local validation: `npm run test:domains` (pass, 35/35), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Phase 5 adapter-boundary closeout completed.
- Updated `src/drawers/DrawerContentScaffold.jsx` to remove direct storage import and consume `listTree` through `App.jsx` `ProjectDomain` command wiring.
- Adapter boundary verification: `rg -n "project/storage" src` returned no matches.
- Remaining for full phase exit: run manual save/load/scaffold/sync verification script and mark validation gates.
- 2026-02-14: Open-existing launch flow added (plan drift tracked).
- Enabled `Open > Existing Litria Project` in `LaunchScreen` and added open-existing modal path input.
- Added `App.jsx` open-existing bootstrap (`handleOpenProjectInstance`) to load existing manifest safely without invoking `create_project_instance`.
- 2026-02-14: Open-file launch flow added (plan drift tracked).
- Enabled `Open > File` in `LaunchScreen` with native file explorer picker.
- Added single-file bootstrap handler in `App.jsx` and `read_external_file` adapter command path (`src/project/storage.js` + `src/project/projectDomain.js` + `src-tauri/src/lib.rs`).
- 2026-02-14: Manual persistence validation checkpoint (user-run).
- Passed: open-existing browse + load, save/reopen editor roundtrip, negative-path check.
- Deferred: scaffold-create expected-piece spawn completeness and filename comment-header consistency in this flow.
- Phase 5 status: persistence core validated; keep scaffold-apply gate open pending follow-up.
- Follow-up checklist created: `docs/plans/app-refactor-phase5-scaffold-followup-checklist.md`.
