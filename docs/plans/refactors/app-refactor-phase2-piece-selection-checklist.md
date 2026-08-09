# App Refactor Phase 2 Piece + Selection Extraction Checklist

## Purpose
Extract `PieceDomain` and `SelectionDomain` from `App.jsx` with feature parity.

## In Scope
- Piece and selection state ownership.
- Piece/selection commands and selectors.
- Workspace provider integration.

## Tasks
- [x] Add `PieceDomain` API contract (`commands`, `selectors`, tests).
- [x] Add `SelectionDomain` API contract (`commands`, `selectors`, tests).
- [x] Move piece mutations out of `App.jsx` into `PieceDomain`.
- [x] Move selection mutations out of `App.jsx` into `SelectionDomain`.
- [x] Wire both domains into `WorkspaceProvider`.
- [x] Replace direct state writes in UI with domain command calls.
- [x] Add characterization tests for existing piece/selection behavior.
- [x] Add unit tests for extracted commands/selectors.

## PR Slices
1. `piece-domain`: API + core commands/selectors + tests.
2. `selection-domain`: API + core commands/selectors + tests.
3. `integration`: provider wiring and `App.jsx` call-site migration.

## Validation Gates
- [x] Create piece flow passes.
- [x] Move piece flow passes.
- [x] Delete piece flow passes.
- [x] Single select and multi-select flows pass.
- [x] No direct piece/selection mutation remains in `App.jsx`.
- [x] Unit tests pass for `PieceDomain` and `SelectionDomain`.

## Exit Criteria
- [x] Feature parity for create/move/select/delete is confirmed.
- [x] `App.jsx` no longer performs piece/selection domain mutations.

## Evidence
- PR(s): `_____`
- Test run links/output: `Slice 1-8 local: npm run test:domains (pass), npm run check:architecture (pass), npm run build (pass)`
- Remaining known gaps: `Phase 2 scope complete; ready for Phase 3 handoff`

## Progress Notes
- 2026-02-14: Slice 1 started.
- Added `src/app/pieceDomain.js` with initial `commands.createPiece` API.
- Migrated `App.jsx` `addPiece` path to call `pieceDomain.commands.createPiece`.
- Updated `scripts/app-shell-guard.mjs` allowlist for `./app/pieceDomain` import.
- 2026-02-14: Slice 2 completed.
- Added `PieceDomain` `commands.deletePieces` and initial `selectors` (`getPieceById`, `listPieces`).
- Migrated `App.jsx` `handleDeleteSelected` mutation path to `pieceDomain.commands.deletePieces`.
- Local validation: `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 3 completed.
- Added `src/app/selectionDomain.js` with initial `commands` and `selectors`.
- Migrated `App.jsx` selection mutation call-sites (`select/toggle/clear`) to `selectionDomain.commands`.
- Migrated selected-state reads in key UI paths to `selectionDomain.selectors`.
- Updated `scripts/app-shell-guard.mjs` allowlist for `./app/selectionDomain` import.
- Local validation: `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 4 completed.
- Added domain unit tests: `test/domains/pieceDomain.test.mjs` and `test/domains/selectionDomain.test.mjs`.
- Added `npm run test:domains` in `package.json`.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 5 completed.
- Added `pieceDomain.commands.updatePieceFilenames` and migrated folder-group filename mutation path from `App.jsx`.
- Added unit test for filename update command in `test/domains/pieceDomain.test.mjs`.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 6 completed.
- Added `pieceDomain.commands.normalizeInvalidCoordinates` and moved coordinate sanitization mutation out of `App.jsx`.
- Moved delayed spawn-flag mutation (`isSpawning`) into `PieceDomain` internal command path.
- Added unit test coverage for coordinate normalization in `test/domains/pieceDomain.test.mjs`.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Manual Phase 2 flow check completed by operator.
- Confirmed pass: create piece, move piece, delete piece, single-select, multi-select.
- 2026-02-14: Slice 7 completed.
- Added `src/app/WorkspaceContext.jsx` with `WorkspaceProvider` and `useWorkspace`.
- Wired `pieceDomain` + `selectionDomain` into `WorkspaceProvider` in `src/App.jsx`.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 8 completed.
- Added characterization flow test `test/domains/pieceSelection.characterization.test.mjs`.
- Characterized create/select/toggle/delete command flow stability across PieceDomain + SelectionDomain.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
