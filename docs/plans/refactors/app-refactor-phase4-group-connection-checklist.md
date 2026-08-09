# App Refactor Phase 4 Group + Connection Isolation Checklist

## Purpose
Extract grouping and graph connection behavior into `GroupDomain` and `ConnectionDomain`.

## In Scope
- Group metadata and piece membership.
- Connection model, constraints, and derivations.
- History transaction integration for both domains.

## Tasks
- [x] Define `GroupDomain` API and ownership boundaries.
- [x] Define `ConnectionDomain` API and ownership boundaries.
- [x] Move group create/rename/collapse/expand/delete behavior out of `App.jsx`.
- [x] Move connection create/delete/update behavior out of `App.jsx`.
- [x] Ensure both domains mutate state via explicit commands only.
- [x] Wire undo/redo transactions for group and connection operations.
- [x] Add integration tests for group and connection workflows.
- [x] Add dependency checks for forbidden cross-domain imports.

## PR Slices
1. `group-domain`: extraction + tests.
2. `connection-domain`: extraction + tests.
3. `history-integration`: transaction boundaries and integration tests.

## Validation Gates
- [x] Group menu actions still work (`create/collapse/expand/rename/delete`).
- [x] Piece membership updates correctly in groups.
- [x] Connection creation and removal workflows pass.
- [x] Undo/redo works for group and connection changes.
- [x] No forbidden imports between Group, Connection, and other domains.

## Exit Criteria
- [x] Grouping and connection flows validated by tests.
- [x] Domain boundaries for group/connection are enforced.

## Evidence
- PR(s): `_____`
- Test run links/output: `Slice 1 local: npm run test:domains (pass), npm run check:architecture (pass), npm run build (pass)`
- Dependency check output: `_____`

## Progress Notes
- 2026-02-14: Slice 1 completed.
- Added `src/app/groupDomain.js` with `commands.toggleCollapse`, `commands.expand`, `commands.rename`, and `selectors.getGroupById`.
- Migrated `App.jsx` group rename/collapse/expand handlers to `GroupDomain` commands.
- Added `test/domains/groupDomain.test.mjs` for group command/selector coverage.
- Updated `scripts/app-shell-guard.mjs` allowlist for `./app/groupDomain`.
- Remaining in this track: move `create/delete` group behaviors out of `App.jsx`.
- 2026-02-14: Slice 2 completed.
- Added `GroupDomain` commands for `createFolderGroup` and `removePieces`.
- Migrated `App.jsx` group membership cleanup on piece delete to `groupDomain.commands.removePieces`.
- Migrated `App.jsx` folder-group creation state mutation to `groupDomain.commands.createFolderGroup`.
- Migrated group-pill double-click expand behavior to `groupDomain.commands.expand`.
- Expanded `test/domains/groupDomain.test.mjs` with create/remove regression coverage.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 3 completed.
- Added `src/app/connectionDomain.js` with `commands.createConnectionFromDrag` and connection selectors.
- Migrated interaction connection-create path in `useCanvasInteractionController` to `connectionDomain.commands.createConnectionFromDrag`.
- Added `test/domains/connectionDomain.test.mjs` for connection domain command/selector coverage.
- Updated `scripts/app-shell-guard.mjs` allowlist for `./app/connectionDomain`.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- Remaining in this track: move connection delete/update paths to `ConnectionDomain`, and finish any residual group delete path extraction in `App.jsx`.
- 2026-02-14: Slice 4 completed.
- Expanded `ConnectionDomain` command surface with create/insert/remove/removeForPiece/removeForPieces APIs.
- Migrated App-side connection usage to `ConnectionDomain`:
- connection graph derivation source (`getAllConnections`)
- piece delete cleanup (`removeConnectionsForPieces`)
- scaffold application connection create/insert wiring
- piece render tabs/slots selectors
- Expanded `test/domains/connectionDomain.test.mjs` to cover command proxy/delete paths.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- Remaining in this track: explicit connection update operation API (if required by product behavior), and residual group delete workflow ownership.
- 2026-02-14: Slice 5 completed.
- Fixed `ConnectionDomain` transactional delete test mock state to avoid unbound `this` access.
- Added `updateConnectionAction` in `src/history/actions.js` and routed `connectionDomain.commands.updateConnectionByIdWithHistory` through history transaction boundaries.
- Added `ConnectionDomain` regression test for transactional connection update.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 6 completed.
- Added `groupDomain.commands.deleteGroup` and migrated group-delete menu behavior to domain command ownership.
- Updated delete action enablement so group-delete works when a group is targeted and no pieces are selected.
- Added `GroupDomain` regression test for `deleteGroup`.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 7 completed.
- Added `groupDomain.commands.replaceAll` and migrated scaffold apply from raw `setGroups` to domain command wiring.
- Added `connectionDomain.commands.createConnectionAndInsert` and migrated scaffold apply from split `createConnection`/`insertConnection` orchestration to single domain command.
- Updated `applyScaffoldPlan` contract to consume domain-owned commands (`replaceGroups`, `createConnectionAndInsert`).
- Expanded domain regression coverage for `GroupDomain.replaceAll` and `ConnectionDomain.createConnectionAndInsert`.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 8 completed.
- Added integration coverage for scaffold-apply orchestration in `test/domains/scaffoldApply.integration.test.mjs`.
- Integration test validates piece creation, group replacement, connection insertion, manifest updates, next-id counters, and refresh signaling through domain command boundaries.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 9 completed.
- Added connection history undo/redo regression coverage in `test/domains/connectionDomain.test.mjs` for both delete and update transactional actions (`action.do` + `action.undo` roundtrip).
- Confirmed architecture guard + app shell guard continue to enforce import and shell-boundary constraints.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- Remaining in this track: wire equivalent transaction boundaries for group operations so group undo/redo is covered alongside connection operations.
- 2026-02-14: Slice 10 completed.
- Added reusable `replaceGroupsAction` in `src/history/actions.js` and routed group mutation commands through history-aware group replacement actions.
- Updated `GroupDomain` wiring to use `history` + `getGroups` snapshots in `src/app/groupDomain.js`.
- Updated `App.jsx` to provide live group snapshots to `GroupDomain` (`groupsRef`) for deterministic undo/redo action generation.
- Added regression test `GroupDomain history-backed commands support undo/redo roundtrip` in `test/domains/groupDomain.test.mjs`.
- Note: `createFolderGroup` and `removePieces` remain non-transactional by design because they are currently coupled to project/scaffold side effects and piece-delete flow.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Phase 4 validation complete (manual + automated).
- Manual verification passed for group actions, membership updates, connection workflows, and undo/redo behavior with follow-up fixes applied during the phase.
