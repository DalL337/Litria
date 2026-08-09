# App Refactor Phase 3 Interaction Extraction Checklist

## Purpose
Isolate pointer and canvas behavior into `InteractionDomain` with no UI-owned mutation logic.

## In Scope
- Drag lifecycle and pointer state machine.
- Snap and lasso behavior.
- Integration with Piece, Selection, Connection, and History domains.

## Tasks
- [x] Define `InteractionDomain` API and lifecycle states.
- [x] Move drag start/move/end handling from `App.jsx`.
- [x] Move snap behavior behind domain commands.
- [x] Move lasso behavior behind domain commands/selectors.
- [x] Ensure interaction commands route mutations through owning domains.
- [x] Integrate `HistoryDomain` transaction boundaries for interaction actions.
- [x] Add regression tests for drag/lasso/snap flows.
- [x] Add latency capture script/checklist for drag p95.

## PR Slices
1. `interaction-core`: state machine and command interfaces.
2. `interaction-migration`: event handler migration from `App.jsx`.
3. `interaction-tests`: regression coverage + latency baseline capture.

## Validation Gates
- [ ] Piece drag works for single selection.
- [ ] Multi-drag works.
- [ ] Snap on drag end still works.
- [ ] Lasso select works.
- [ ] Undo/redo for interaction actions works.
- [ ] p95 drag latency is within agreed threshold.

## Exit Criteria
- [ ] `App.jsx` no longer owns drag/lasso/snap mutation logic.
- [ ] Interaction regression suite passes.

## Evidence
- PR(s): `_____`
- Performance notes: `_____`
- Test run links/output: `Slice 1 local: npm run test:domains (pass), npm run check:architecture (pass), npm run build (pass)`

## Progress Notes
- 2026-02-14: Slice 1 completed.
- Added `src/app/interactionDomain.js` as an interaction API boundary (`commands`, `selectors`, `lifecycle`).
- Migrated `App.jsx` to consume `useInteractionDomain` instead of direct `useCanvasInteractionController` wiring.
- Routed drag-line and hover-target reads through interaction-domain selectors.
- 2026-02-14: Slice 2 completed.
- Routed lasso selection updates through `SelectionDomain` command paths inside interaction controller.
- Exposed explicit snap-finalization boundary command `finalizePieceDragWithSnap` in `InteractionDomain`, and wired `App.jsx` drag-end to it.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 3 completed.
- Replaced direct interaction-time piece mutations in controller with `PieceDomain` commands:
- `previewMoveSelectedPieces`, `previewMovePiece`, `previewMoveSnapshotPieces`, and `replacePieces`.
- Added domain unit coverage for preview/replace piece commands in `test/domains/pieceDomain.test.mjs`.
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
- 2026-02-14: Slice 4 completed.
- Added `src/app/interactionHelpers.js` with tested interaction utilities:
- `getLassoSelectedIds`, `applyDragEndSnap`, `executeInteractionHistoryAction`.
- Integrated transaction boundaries for connection create, piece move, group move, and scale operations in interaction controller.
- Added regression tests in `test/domains/interactionHelpers.regression.test.mjs`.
- Added latency capture artifacts:
- `scripts/measure-drag-latency.mjs`
- `docs/plans/interaction-latency-samples.json`
- `npm run measure:drag-latency`
- Local validation: `npm run test:domains` (pass), `npm run check:architecture` (pass), `npm run build` (pass).
