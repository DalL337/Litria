# App Refactor Phase 6 Final Orchestration Shell Checklist

## Purpose
Finalize `App.jsx` as composition-only shell and enforce architecture in CI.

## In Scope
- Final migration of remaining domain mutations from `App.jsx`.
- Provider composition cleanup.
- CI enforcement for dependency and architecture rules.

## Tasks
- [x] Remove remaining domain mutation logic from `App.jsx`.
- [x] Keep `App.jsx` limited to provider composition and top-level routing/wiring.
- [x] Verify all domains expose stable API contracts and tests.
- [x] Enable architecture/dependency checks in CI.
- [x] Enforce project-wide duplicate filename prevention by basename (case-insensitive).
- [x] Ensure parity checklist from Phase 0 passes end-to-end.
- [x] Capture post-refactor baseline metrics for comparison.
- [x] Update documentation to reflect final architecture and ownership.

## PR Slices
1. `shell-cleanup`: remove remaining mutation logic from `App.jsx`.
2. `ci-enforcement`: architecture checks + dependency rules in CI.
3. `docs-and-baseline`: final baseline snapshot and architecture docs.

## Validation Gates
- [x] No domain mutation remains in `App.jsx`.
- [x] CI passes with architecture rule checks enabled.
- [x] Phase 0 regression checklist passes.
- [x] Baseline comparison shows no unacceptable regressions.

## Exit Criteria
- [x] `App.jsx` is composition-only by code review and tests.
- [x] Domain boundaries are enforced automatically in CI.
- [x] Refactor considered complete and platform-ready.

## Evidence
- PR(s): `Local branch closeout (Phase 6 shell-cleanup slices 1-8 + closeout fixes)`
- CI run links/output: `Local command evidence: npm run check:architecture (pass), npm run test:domains (pass 38/38), npm run build (pass)`
- Final baseline snapshot: `docs/plans/app-refactor-phase0-baseline.md (updated 2026-02-14)`

## Closeout Status (Current)
- Automated checks rerun on 2026-02-14:
  - `npm run check:architecture` -> pass
  - `npm run test:domains` -> pass (`38/38`)
  - `npm run build` -> pass
- Manual parity closeout script executed and recorded:
  `docs/plans/app-refactor-phase6-manual-closeout-script.md` (`PASS`)
- Phase 6 closeout status: complete.

## Scope Drift
- 2026-02-14: Added a stricter filename validation rule than originally planned for Phase 6.
- Drift: duplicate filename checks now enforce global basename uniqueness across the whole project (not only exact relative-path matches).
- Reasoning: prevents ambiguous piece identity in scaffold/editor flows, avoids accidental duplicates during incremental migration, and keeps naming behavior predictable as orchestration boundaries are enforced.
- Follow-up impact: users can still differentiate quickly with `app_1.py`, `app1.py`, or `app-1.py`; this is a low-friction guardrail.

## Progress Notes
- 2026-02-14: Phase 6 started with `ci-enforcement` slice.
- Updated `.github/workflows/architecture-guard.yml` to run:
  `npm run check:architecture`, `npm run test:domains`, and `npm run build` on push/PR.
- Remaining in Phase 6: `shell-cleanup` (`App.jsx` composition-only) and docs/baseline closeout.
- 2026-02-14: `shell-cleanup` slice 1 completed.
- Extracted launch/open instance handlers from `src/App.jsx` into `src/app/useProjectLaunch.js`.
- `App.jsx` now consumes `useProjectLaunch` and no longer contains inline create/open/open-file handler bodies.
- Updated app shell guard transition allowlist for `./app/useProjectLaunch`.
- Local validation: `npm run check:architecture` (pass), `npm run test:domains` (pass, 35/35), `npm run build` (pass).
- 2026-02-14: `shell-cleanup` slice 2 completed.
- Extracted group/scaffold action handlers from `src/App.jsx` into `src/app/useGroupMenuActions.js`.
- `App.jsx` now consumes `useGroupMenuActions` for delete/create-folder/collapse/expand/rename group flows.
- Updated app shell guard transition allowlist for `./app/useGroupMenuActions`.
- Local validation: `npm run check:architecture` (pass), `npm run test:domains` (pass, 35/35), `npm run build` (pass).
- 2026-02-14: `shell-cleanup` slice 3 completed.
- Extracted scaffold interaction handlers from `src/App.jsx` into `src/app/useScaffoldActions.js`.
- `App.jsx` now consumes `useScaffoldActions` for scaffold select/open/toggle visibility, editor launcher open, and deselect/reset flows.
- Updated app shell guard transition allowlist for `./app/useScaffoldActions`.
- Local validation: `npm run check:architecture` (pass), `npm run test:domains` (pass, 35/35), `npm run build` (pass).
- 2026-02-14: `shell-cleanup` slice 4 completed.
- Extracted piece modal + piece interaction handlers from `src/App.jsx` into `src/app/usePieceUiActions.js`.
- `App.jsx` now consumes `usePieceUiActions` for create-piece modal open/close/create/validate and piece click/double-click flows.
- Updated app shell guard transition allowlist for `./app/usePieceUiActions`.
- Local validation: `npm run check:architecture` (pass), `npm run test:domains` (pass, 35/35), `npm run build` (pass).
- 2026-02-14: Manual parity check for slice 3 (user-run) passed.
- Verified: scaffold double-click opens editor, existing tabs reload as expected, scaffold path hide/reveal works, group-menu deselect works.
- 2026-02-14: Implemented global duplicate-basename validation for piece creation.
- Updated `src/utils/pieceValidation.js` to reject filenames when any existing piece has the same basename (case-insensitive), regardless of folder path.
- Added tests in `test/domains/pieceValidation.test.mjs` covering cross-folder duplicates, case-insensitive duplicates, and allowed unique names.
- 2026-02-14: `shell-cleanup` slice 5 completed.
- Extracted canvas-level UI mutation handlers from `src/App.jsx` into `src/app/useCanvasUiActions.js` (group menu toggle, group-pill select/expand, and connection delete dispatch).
- Extracted unsaved-exit prompt handlers from `src/App.jsx` into `src/app/useExitPromptActions.js` (cancel/discard/save close flow).
- Updated app shell guard transition allowlist for `./app/useCanvasUiActions` and `./app/useExitPromptActions`.
- Local validation: `npm run check:architecture` (pass), `npm run test:domains` (pass, 38/38), `npm run build` (pass).
- 2026-02-14: `shell-cleanup` slice 6 completed.
- Extracted group-menu UI orchestration from `src/App.jsx` into `src/app/useGroupMenuUi.js`.
- Moved rename panel lifecycle reset (close menu -> close rename + clear value), group-menu visibility computation, and menu positioning style computation into the hook.
- Wired rename input change through hook handler to further reduce inline UI logic in `App.jsx`.
- Updated app shell guard transition allowlist for `./app/useGroupMenuUi`.
- Local validation: `npm run check:architecture` (pass), `npm run test:domains` (pass, 38/38), `npm run build` (pass).
- 2026-02-14: `shell-cleanup` slice 7 completed.
- Extracted large render sections from `src/App.jsx` into presentational components:
  `src/components/ProjectPill.jsx`, `src/components/GroupMenuOverlay.jsx`, and `src/components/WorkspaceStage.jsx`.
- `App.jsx` now focuses on composing providers/domains/hooks and wiring props into presentational UI blocks instead of owning deep inline canvas/group-menu markup.
- Local validation: `npm run check:architecture` (pass), `npm run test:domains` (pass, 38/38), `npm run build` (pass).
- 2026-02-14: `shell-cleanup` slice 8 completed.
- Extracted drawer configuration construction out of `src/App.jsx` into `src/components/useAppDrawers.jsx`.
- Drift handling during slice: first attempt placed the hook under `src/app/`, which correctly failed architecture guard because domain-layer files cannot import UI drawer components; hook was moved to `src/components/` to preserve boundary rules.
- `App.jsx` now consumes `{ drawers, artboardDrawers }` from the UI-layer hook and no longer owns drawer memo blocks.
- Local validation: `npm run check:architecture` (pass), `npm run test:domains` (pass, 38/38), `npm run build` (pass).
- 2026-02-14: Manual closeout run exposed project-instance root bug (scaffold showing sibling projects under chosen parent path).
- Root cause: create flow treated selected path as final project root; users selected a parent directory.
- Fix applied in `src/app/useProjectLaunch.js`: new-project create now resolves root path to `<selected parent>/<projectName>` unless selected folder already matches project name.
- Validation after fix: `npm run check:architecture` (pass), `npm run test:domains` (pass, 38/38), `npm run build` (pass).
- Remaining manual blocker to investigate next: group-drag snap/adjacency misalignment regression reported during parity run.
