# App Refactor Sequenced Execution Plan (One Phase At A Time)

## Purpose
Provide a practical, day-by-day execution plan to run the orchestration refactor safely with active architecture guards.

## Source of Truth
- Architecture target: `docs/Orchestration.md`
- Enforcement model: `docs/plans/app-refactor-enforcement.md`
- Baseline and regression gate: `docs/plans/app-refactor-phase0-baseline.md`
- Phase checklists: `docs/plans/app-refactor-phase1-domain-mapping-checklist.md` through `docs/plans/app-refactor-phase6-orchestration-shell-checklist.md`

## Execution Rule
Only one phase can be `in progress` at a time. Do not start the next phase until the current phase exit criteria is complete.

## Standard Daily Loop (Use Every Day)
1. Choose exactly one phase task from the active checklist.
2. Make one focused implementation slice.
3. Run required checks:
```bash
npm run check:architecture
npm run build
```
4. Run relevant parity checks from `docs/plans/app-refactor-phase0-baseline.md`.
5. Update the active phase checklist evidence fields.
6. If checks fail, fix immediately before moving to the next slice.

## Guard-Aware Branching Strategy
Use one branch per phase and one PR-sized slice per responsibility.

Suggested naming:
- `refactor/phase2-piece-domain-api`
- `refactor/phase2-selection-domain-api`
- `refactor/phase3-interaction-state-machine`

## Tomorrow Start Plan

### Step 1 (First Working Block)
- Open and execute `docs/plans/app-refactor-phase2-piece-selection-checklist.md`.
- Implement first slice only: `PieceDomain` API contract and minimal command extraction.
- Keep `SelectionDomain` unchanged until slice 1 is stable.

Required pass before ending step:
- [ ] `npm run check:architecture`
- [ ] `npm run build`
- [ ] Piece create/move/select/delete sanity pass from baseline checklist.

### Step 2 (Second Working Block)
- Implement second slice: `SelectionDomain` API contract and mutation extraction.
- Migrate only direct selection writes in `App.jsx` to domain commands.

Required pass before ending step:
- [ ] `npm run check:architecture`
- [ ] `npm run build`
- [ ] Single-select and multi-select checks pass.

### Step 3 (Third Working Block)
- Integration cleanup for Phase 2.
- Wire domains via provider.
- Remove remaining piece/selection mutation paths from `App.jsx`.
- Update phase evidence fields and unresolved gap list.

Required pass before ending step:
- [ ] `npm run check:architecture`
- [ ] `npm run build`
- [ ] Phase 2 exit criteria complete.

## Phase-by-Phase Build Order

1. Phase 2: Piece + Selection extraction
- Keep changes limited to ownership and API surfaces.
- Do not start interaction extraction yet.

2. Phase 3: Interaction extraction
- Move drag/lasso/snap behind `InteractionDomain`.
- Re-check performance baseline after each major handler migration.

3. Phase 4: Group + Connection isolation
- Move group and graph behavior into domains.
- Verify undo/redo semantics on every merged slice.

4. Phase 5: Persistence separation
- Extract fs/manifest logic to `ProjectDomain` adapters.
- Ensure no UI-side direct persistence mutations remain.

5. Phase 6: Final orchestration shell
- Shrink `App.jsx` to composition/wiring only.
- Tighten guards by reducing temporary allowlists.

## Definition of Done Per Slice
- Owning domain is explicit.
- No forbidden dependency edges.
- No new domain-coupled imports in `src/App.jsx`.
- Phase checklist updated.
- `npm run check:architecture` and `npm run build` both pass.

## Failure Protocol
If a slice introduces architecture violations:
1. Stop adding new behavior.
2. Fix boundary issue first.
3. Re-run checks.
4. Record the violation and fix note in the active phase checklist evidence section.

## Tightening Protocol (Important)
At the end of each completed phase:
1. Remove at least one transition allowlist entry from `scripts/app-shell-guard.mjs` or `scripts/architecture-guard.mjs`.
2. Re-run `npm run check:architecture`.
3. Document what was tightened in the phase evidence section.

## Progress Tracking Format
Use this status line in commit/PR notes:

`Phase X | Slice Y | checks: arch/build | baseline gates: N passed | allowlist delta: +/-N`
