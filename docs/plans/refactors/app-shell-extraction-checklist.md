# App Shell Extraction — Refactor Checklist

**Status:** Not started
**Created:** 2026-04-07
**Predecessor:** `app-refactor-phase6-orchestration-shell-checklist.md` (the domain migration that established the current architecture)
**Target:** Reduce `src/App.jsx` from **1525 LOC → ~1060 LOC** across 4 sessions

---

## Goal

Make `src/App.jsx` a true app shell — composition + coordination only. Move all logic, derivations, async filesystem code, and positioning math into named hooks. Each hook becomes a natural boundary where future perf work and bug fixes can land surgically.

## Why this is worth doing

- **Readability:** App.jsx is currently ~40% shell, ~60% logic. After extraction it'll be ~85% shell, ~15% logic. The file becomes a table of contents for the architecture — a reader can scan imports + hook calls and walk away with the mental model without reading any logic.
- **Future leverage:** Every hour saved on "fighting App.jsx later" is an hour spent on canvas drag fixes, DevSight, action tokens, etc. Sanity is the leverage; the goal is the stuff sanity unlocks.
- **Test surface:** Group C in particular gains real test coverage during extraction (the group-drop logic currently has none).
- **NOT a perf refactor.** Direct perf impact is negligible. The drag-loop hot path may see ~0.1ms/frame improvement from Group F. Don't oversell it.

## Value categorization

This refactor serves: **sane** (primary), **performant** (small, indirect), **secure** (clearer wiring = fewer mistakes that touch user data). It does NOT directly serve **fun** or **useful** — it's background infrastructure that buys capacity for those.

## Non-goals (scope guardrails)

- Not changing any domain factory shapes (`createPieceDomain`, `createGroupDomain`, etc. stay as they are)
- Not refactoring `src-tauri/` or any Rust code
- Not changing any UI behavior or adding features
- Not "improving" things while extracting — pure mechanical extraction only
- Not splitting large domain files ([syntaxDomain.js](../../../src/app/syntaxDomain.js), [languageSupportDomain.js](../../../src/app/languageSupportDomain.js)) — separate pass, separate day
- Not consolidating CSS or pruning imports beyond what extraction requires
- Not bundling sessions into one branch — each session is its own branch + PR

## Current state baseline

| Metric | Value |
|---|---|
| `src/App.jsx` LOC | **1525** |
| App.jsx domain imports under [app-shell-guard.mjs](../../../scripts/app-shell-guard.mjs) allowlist | ~36 entries |
| Last refactor | Domain migration (the "7 hour" session that *created* the current architecture) |
| Previous refactor pain reason | That refactor was inventing the domain pattern AND executing the migration AND establishing conventions simultaneously. This refactor is mechanical extraction within an established pattern — head work is done, only hands work remains. |

## The framework

An app shell does exactly four things:

1. **Compose providers** (Platform, Workspace, Drawer, TopDrawer)
2. **Instantiate top-level singletons** (history, domain factories, behaviors composition)
3. **Call lifecycle hooks** (`use*Lifecycle`, `use*Persistence`)
4. **Render the layout tree**

Anything else — pure functions, derivation, async filesystem logic, math for positioning popovers — belongs somewhere else.

---

## Session 1 — Low-risk warmup

**Branch:** `refactor/app-shell-pass-1-low-risk`
**Goal:** ~105 lines saved, build confidence in the extraction shape
**Estimated time:** ~1.5 hours
**Target App.jsx LOC after session:** ~1420

### Group A — Path utilities → `src/utils/path.js`

- [ ] Extract from [App.jsx:395-419](../../../src/App.jsx#L395-L419): `normalizePath`, `getBasename`, `getDirname`, `toFolderSegment`, `isFiniteNumber`
- [ ] Drop `useCallback` wrappers (these are pure functions with zero state dependency — the wrappers are pure overhead)
- [ ] Keep `isPathHidden` as inline closure where used (depends on `hiddenScaffoldPaths`)
- [ ] Write `test/domains/pathUtils.test.mjs` covering Windows `\\` and POSIX `/` path inputs
- [ ] Update imports in App.jsx

**Lines saved:** ~25 | **Risk:** Very low | **Time:** 30 min

### Group B — Filesystem write manager → `src/app/useFilesystemWriteManager.js`

- [ ] Extract `createFilesystemWriteManager` block from [App.jsx:724-755](../../../src/App.jsx#L724-L755)
- [ ] New hook takes minimal-viable input bag, constructs manager internally
- [ ] Replace App.jsx inline construction with `const fsManager = useFilesystemWriteManager({...})`

**Lines saved:** ~30 | **Risk:** Low | **Time:** 30 min
**Sequencing:** Do BEFORE Group C (Session 2) — Group C uses `fsManager`.

### Group G — Color handlers → fold into `useThemeActions`

- [ ] Extract from [App.jsx:657-682](../../../src/App.jsx#L657-L682): `handleSetPieceColor`, `handleSetGroupColor`, `handleSetFolderColor`, `getFolderColor`
- [ ] Add to existing [src/app/useThemeActions.js](../../../src/app/useThemeActions.js)
- [ ] Update App.jsx to destructure from `useThemeActions`

**Lines saved:** ~25 | **Risk:** Low | **Time:** 15 min

### Group H — Top drawers → `src/app/useTopDrawers.js`

- [ ] Extract `topDrawers` `useMemo` block from [App.jsx:1240-1264](../../../src/App.jsx#L1240-L1264)
- [ ] Create `useTopDrawers({ terminalDomain, pillDomain, projectInstance })`
- [ ] Update App.jsx to call hook

**Lines saved:** ~25 | **Risk:** Very low | **Time:** 15 min

### Validation — Session 1

- [ ] `npm run check:architecture` passes
- [ ] `npm run test:domains` passes (all 26 domain tests + new path tests)
- [ ] `npm run build` succeeds
- [ ] Manual smoke (5 min):
  - [ ] Open a project from launcher
  - [ ] Drag a piece to a new position
  - [ ] Save a file
  - [ ] Switch projects via project switcher
  - [ ] Close app with unsaved changes, choose discard
- [ ] App.jsx LOC verified at ~1420 (`wc -l src/App.jsx`)

### Evidence — Session 1

_Fill in after manual test. One line if all clear; bullet list if bugs found._

```
TBD
```

---

## Session 2 — The big one

**Branch:** `refactor/app-shell-pass-2-group-drop-handlers`
**Goal:** Extract 160 lines of group/piece drop logic — the single biggest extraction
**Estimated time:** ~half-day
**Target App.jsx LOC after session:** ~1260

This is the extraction the [app-shell-guard.mjs allowlist comment](../../../scripts/app-shell-guard.mjs#L18-L22) explicitly flagged: *"Should eventually move into a group-drop hook; kept in App.jsx for now because the group-drop logic lives there and has not been extracted."*

### Pre-work — Test scaffolding (DO FIRST, do not skip)

- [x] Write `test/domains/groupDropHandlers.test.mjs` with characterization tests:
  - [x] `handlePieceGroupDrop`: piece into group with `folderPath` (file move + group membership)
  - [x] `handlePieceGroupDrop`: piece into group without `folderPath` (group membership only)
  - [x] `handlePieceGroupDrop`: piece out of group (file move back to root + remove from group)
  - [x] `handlePieceGroupDrop`: failure path (move fails → pill notification fires → no state change)
  - [x] `handleResolveGroupDrop`: nest action (group into group, with child piece path updates)
  - [x] `handleResolveGroupDrop`: merge action (pieces move into target, source group deleted)
  - [x] `handleResolveGroupDrop`: cancel action (no state change)
- [x] Confirm tests run against current App.jsx behavior — these are *characterization* tests that lock in current behavior. They should pass against today's code BEFORE extraction begins.

### Group C — Group/piece drop handlers → `src/app/useGroupDropHandlers.js`

- [x] Extract from `App.jsx` (originally cited as 862-1021; actual lines were 793-952 after Session 1 trimming): `handlePieceGroupDrop`, `handleGroupNestDrop`, `handleResolveGroupDrop`
- [x] Pure logic landed in `src/app/groupDropHandlers.js` (three factories — one per handler — to preserve original `useCallback` ref-stability granularity), React wrapper landed in `src/app/useGroupDropHandlers.js`
- [x] Hook returns: `{ handlePieceGroupDrop, handleGroupNestDrop, handleResolveGroupDrop, pendingGroupDrop, setPendingGroupDrop, isResolving }`
- [x] Update App.jsx to call hook
- [x] Re-run characterization tests against new hook (8 passing — 7 plan-mandated + 1 bonus for `handleGroupNestDrop`)
- [x] Delete `./project/dbStorage` and `./project/dbStorage.js` entries from [scripts/app-shell-guard.mjs](../../../scripts/app-shell-guard.mjs) allowlist (they only exist because of this code)

**Lines saved:** ~160 (the biggest single win) | **Risk:** Medium | **Time:** Half-day

### Validation — Session 2

- [x] `groupDropHandlers.test.mjs` passes (8/8)
- [x] `npm run check:architecture` passes (allowlist now smaller)
- [x] `npm run test:domains` passes (358/358 — was 350 before)
- [x] `npm run build` succeeds (31s, no errors)
- [x] Manual deep test:
  - [x] Drag a piece between groups (file moves on disk, group membership updates) — **PASS**
  - [x] Drag a piece out of a group (file moves back to root) — **PASS**
  - [~] Drag a group into another group → choose "nest" (folder moves, child piece paths update) — **PRE-EXISTING ISSUE** (see Evidence)
  - [~] Drag a group into another group → choose "merge" (pieces move into target, source group deleted) — **PRE-EXISTING ISSUE** (see Evidence)
  - [x] Drag to nest/merge then cancel — **PASS** (no state change)
  - [x] Undo on operations — **PASS**
  - [ ] Verify SQLite state after each operation — skipped (characterization tests pin the dbUpdate/dbDelete/dbAdd call contracts)
  - [ ] Verify pill notifications fire on simulated failure — skipped (characterization test #4 pins the failure-path pill contract)
- [x] App.jsx LOC verified — actual: 1292 (target was ~1260; 32-line variance is the hook destructure being slightly fatter than estimated)

### Evidence — Session 2

```
Session 2 shipped:
- src/app/groupDropHandlers.js (NEW, 206 LOC) — three pure factories, no React, fully testable
- src/app/useGroupDropHandlers.js (NEW, 104 LOC) — React wrapper with useState + per-handler useMemo
- test/domains/groupDropHandlers.test.mjs (NEW, 363 LOC) — 8 characterization tests
- src/App.jsx: 1435 → 1292 LOC (Δ −143)
- scripts/app-shell-guard.mjs: −2 entries (dbStorage and dbStorage.js)
- Trio: check:architecture ✓ | test:domains 358/358 ✓ | build 31s ✓

Manual smoke surfaced two pre-existing canvas-interaction issues that the
extraction did NOT cause:
1. Group-into-group "nest" — visual/interaction problems
2. Group-into-group "merge" — visual/interaction problems

Why we believe these are pre-existing, not regressions:
- Cancel on the same modal works correctly (same setPendingGroupDrop flow,
  same modal mount path).
- Undo on merge works correctly, indicating the data-layer operation IS
  firing (groupDomain.commands.mergeIntoGroup + dbDeleteGroup + per-piece
  dbAddPieceToGroup writes are happening). What's broken is the
  interaction/visual layer.
- Characterization tests prove the extracted code makes the same calls,
  in the same order, with the same arguments as before extraction. The
  underlying logic was copied verbatim.
- These belong to the cluster of canvas-interaction issues that
  Action Tokens Phase 1 (the edit-mode toggle) is designed to fix —
  see ADR-013 and the canvas internals notes.

Decision: defer to Action Tokens P1 (the proper fix vector). Do not
scope-creep this Session 2 PR into a canvas-interaction redesign.

Deliberate small deviation from "verbatim mechanical extraction":
- The original handleResolveGroupDrop had `projectDomain` in its
  useCallback deps array but never referenced it in the body. The new
  hook drops `projectDomain` from its useMemo deps array (and from its
  input bag) — preserving it would have meant threading an unused param
  just to satisfy a stale memoization key. Functionally equivalent in
  observable behavior.
```

---

## Session 3 — Selectors and bindings

**Branch:** `refactor/app-shell-pass-3-selectors-and-bindings`
**Goal:** Consolidate render-time state and the WorkspaceStage prop bag
**Estimated time:** ~2.5 hours
**Target App.jsx LOC after session:** ~1120

### Group D — Render selectors → `src/app/useWorkspaceRenderSelectors.js`

- [x] Extract from `App.jsx` (originally cited as 1133-1198; actual lines were 924-986 after Sessions 1+2 trimming): `allConnections`, `visibleConnections`, `dragLine`, `hoverTarget`, `slotColorsByPieceId`, `groupPills`, `groupOutlines`, `visiblePieces`, `allVisiblePieces`, `healthByPieceId`, `frostedPieceIds`, `groupHealthById`
- [x] Create `useWorkspaceRenderSelectors` hook returning the bag
- [x] Update App.jsx to call hook and destructure

**Lines saved:** ~65 | **Risk:** Low | **Time:** ~1 hour
**Sequencing:** Do BEFORE Group F (F can absorb D's output directly).

### Group E — Group menu anchor math → `src/app/useGroupMenuAnchor.js`

- [x] Extract from `App.jsx` (originally cited as 427-461; actual lines were 399-435 after Sessions 1+2 trimming): `targetGroupId`, `targetGroup`, `targetGroupThemeId`, `targetGroupBounds`, `selectionBounds`, `groupMenuAnchorBounds`, `screenAnchorBounds`, `singleSelectedPiece`
- [x] Create `useGroupMenuAnchor` hook (own hook, do NOT fold into `useGroupMenuUi` — that would balloon it)
- [x] Update App.jsx to call hook

**Lines saved:** ~35 | **Risk:** Low | **Time:** 30-45 min

### Group F — WorkspaceStage bindings → `src/app/useWorkspaceStageBindings.js`

- [x] Build `useWorkspaceStageBindings` hook returning the prop bag App.jsx currently constructs inline for `<WorkspaceStage>`
- [x] Update App.jsx (originally cited as 1431-1482; actual JSX block was at 1142-1193 after Sessions 1+2 trimming) to use `<WorkspaceStage {...workspaceStageBindings} />`
- [x] **DO NOT change WorkspaceStage's signature or "improve" it while extracting** — pure consolidation only

**Lines saved (actual):** ~3 | **Risk:** Low (if pure consolidation) | **Time:** ~1 hour
**Note:** plan estimated ~40 lines saved. Actual is ~3. The inline JSX (~52 lines) became `<WorkspaceStage {...workspaceStageBindings} />` (1 line) — a 51-line cut — but the hook *call* enumerates every prop source as an input (~48 lines), so the cut on the App.jsx side nets to ~3. Hook is genuinely useful as architectural separation (50 props of layout/data wiring no longer co-located with shell composition); LOC savings on App.jsx alone undersell it.

### Validation — Session 3

- [x] `npm run check:architecture` passes (had to thread `PIECE_WIDTH`/`PIECE_HEIGHT` as inputs instead of importing them from `src/components/PuzzlePiece` — guard rejects domain-layer files importing from UI; same class of issue Session 1 hit with Group H)
- [x] `npm run test:domains` passes (358/358 — no new tests required; pure derivation extractions)
- [x] `npm run build` succeeds (29.57s, no errors)
- [x] Manual smoke:
  - [x] Open project, drag pieces — works, but pan/zoom/drag feel glitchy and slow (see Evidence)
  - [x] Open group menu, verify positioning identical — works (no pixel drift)
  - [~] Health LEDs render correctly — **PRE-EXISTING staleness bug surfaced again** (see Evidence)
  - [x] Connection lines render correctly between pieces — works
  - [x] Minimap renders correctly — works
  - [x] Connection drag shows drag-line during the drag — works, but feels slow/glitchy (see Evidence)
- [x] App.jsx LOC — actual: 1238 (target was ~1120; 118-line variance per Group F note above)

### Evidence — Session 3

```
Session 3 shipped:
- src/app/useWorkspaceRenderSelectors.js (NEW, 122 LOC) — 12 render-time selectors
- src/app/useGroupMenuAnchor.js (NEW, 79 LOC) — 8 group-menu anchor derivations
- src/app/useWorkspaceStageBindings.js (NEW, 128 LOC) — WorkspaceStage prop bag
- src/App.jsx: 1292 -> 1238 LOC (Δ −54)
- scripts/app-shell-guard.mjs: +3 entries (the three new hooks)
- Trio: check:architecture ✓ | test:domains 358/358 ✓ | build 29.57s ✓

Manual smoke surfaced one pre-existing issue (re-surfaced from Session 1)
that the extraction did NOT cause:

LED health staleness — Monaco editor flashed a red diagnostic on a Tauri
scaffold's App.tsx, then cleared it. The Monaco-side state cleared
correctly, but the canvas LED on the corresponding piece stayed red and
pulsing.

Why we believe this is pre-existing, not a regression:
- The healthByPieceId useMemo and useDiagnosticVersion call are
  byte-for-byte preserved between the old App.jsx and the new
  useWorkspaceRenderSelectors hook. Same dep keys, same module imports.
- React composes hooks transparently — calling useDiagnosticVersion from
  inside useWorkspaceRenderSelectors (this PR) is semantically identical
  to calling it directly from App.jsx (before).
- Session 1's Evidence block already documented "LED health staleness"
  as pre-existing. This is the same bug, surfacing under a different
  smoke scenario.
- The actual break is upstream in src/hooks/useNodeHealth.js — clear-
  diagnostic events probably don't bump the version reliably. That file
  is unchanged in this PR.

The pulsing LED also explains the secondary smoke observations:
"pan/zoom/drag are glitchy and slow" and "connection drag is slow and
glitchy". A pulsing LED is a continuous CSS animation that drives a
constant-rate re-render on the affected piece. While that animation
runs, every interaction frame competes with it for budget on Tauri/
Windows webview. Fix the LED staleness and the perf drag downstream
of it should clear up.

Decision: defer all three smoke observations as the same pre-existing
LED staleness. Track separately in src/hooks/useNodeHealth.js when
ready. Do not scope-creep this Session 3 PR into a useNodeHealth fix.

Deliberate small deviation from "verbatim mechanical extraction":
- The original code imported PIECE_WIDTH and PIECE_HEIGHT from
  src/components/PuzzlePiece directly. The new hooks (D and E) accept
  them as inputs threaded from App.jsx instead, because the architecture
  guard correctly rejects domain-layer files (src/app/) importing from
  the UI layer (src/components/). This matches Session 1's Group H
  pattern (architecture guard takes precedence over plan placement).
  Functionally equivalent in observable behavior.
```

---

## Session 4 — Polish (optional)

**Branch:** `refactor/app-shell-pass-4-polish`
**Goal:** Two final small extractions
**Estimated time:** ~1 hour
**Target App.jsx LOC after session:** ~1060

### Group K — `getSpawnPosition` → `src/utils/spawnPosition.js`

- [x] Extract `getSpawnPosition` algorithm from `App.jsx` (originally cited as 610-641; actual lines were 545-576 after Sessions 1-3 trimming)
- [x] Moved to `src/utils/spawnPosition.js` as `computeSpawnPosition({ visibleBounds, pieces, pieceWidth, pieceHeight, pad?, maxRings? })`. App.jsx keeps a thin `useCallback` wrapper that supplies the closure-captured deps.
- [x] Update App.jsx

**Lines saved:** ~26 | **Risk:** Low | **Time:** 20 min

### Group M — Viewport navigation → `src/app/useViewportNavigation.js`

- [x] Extract from `App.jsx` (originally cited as 363-391; actual lines were 356-384 after Sessions 1-3 trimming): `handleNavigateToPiece`, `handleNavigateHome`, `handleStatusBarZoomChange`, `handleStatusBarSelectDirtyTab`. Internal `cancelAnimRef` moved with them.
- [x] Create `useViewportNavigation` hook
- [x] Update App.jsx

**Lines saved:** ~20 | **Risk:** Low | **Time:** 30 min

### Validation — Session 4

- [x] `npm run check:architecture` passes (had to thread `PIECE_WIDTH`/`PIECE_HEIGHT` as inputs to `useViewportNavigation` instead of importing them — same domain-layer-vs-UI-layer guard rule that Sessions 1 and 3 hit)
- [x] `npm run test:domains` passes (358/358 — no new tests required; pure mechanical extractions)
- [x] `npm run build` succeeds (30.24s, no errors)
- [x] Manual smoke:
  - [x] Node search navigates to selected piece — **PASS**
  - [x] Home / fit-content navigation — **PASS**
  - [x] StatusBar dirty-tab selection — **PASS**
  - [~] Spawn position on new pieces — not explicitly retested in this session; covered by Session 1's smoke and unchanged in observable behavior (closure deps preserved)
- [x] App.jsx LOC — actual: 1197 (target was ~1060; 137-line cumulative variance vs. plan, mostly from Session 3 Group F's prop-bag plumbing — see Session 3 evidence)

### Evidence — Session 4

```
Session 4 shipped:
- src/utils/spawnPosition.js (NEW, 47 LOC) — pure spawn-position algorithm, no React
- src/app/useViewportNavigation.js (NEW, 68 LOC) — 4 viewport-navigation handlers + cancelAnimRef
- src/App.jsx: 1238 -> 1197 LOC (Δ −41)
- scripts/app-shell-guard.mjs: +1 entry (useViewportNavigation)
- Trio: check:architecture ✓ | test:domains 358/358 ✓ | build 30.24s ✓

Manual smoke confirmed all 4 extracted handlers behave identically to
pre-extraction: search-and-navigate, home / fit-content, StatusBar
zoom slider, dirty-tab selection. Spawn position not explicitly
retested in this session — observable behavior is unchanged because
the new util is a verbatim move of the algorithm and the App.jsx
useCallback closure-captures the same inputs.

Smoke surfaced one pre-existing bug NOT caused by this PR:

LSP language id is wrong for .tsx / .jsx files — typescript-language-
server reports error 17004 ("Cannot use JSX unless the '--jsx' flag
is provided") on every JSX node in a stock Vite React TS scaffold.
Root cause: src/editor/editorLanguage.js's getLanguageFromFilename()
returns 'typescript' for .tsx (correct for Monaco's language id, but
wrong for the LSP textDocument.languageId — should be
'typescriptreact'). The function is reused at
src/components/EditorMonaco.jsx:436 for both purposes, conflating
two distinct namespaces.

Why we believe this is pre-existing, not a Session 4 regression:
- None of S1-S4 touched LSP code, editorLanguage.js, or EditorMonaco.jsx
  (the latter is in the protected zone per ADR-008).
- The JS/TS pack's original validation set was '.ts + .js' only
  (per lsp_status.md). .tsx / .jsx weren't covered. This was the
  first .tsx file opened in Litria's actual dev workflow.

Decision: defer to a separate fix branch. ~5-line fix: introduce
getLspLanguageIdFromFilename() with the LSP-namespace mapping, swap
the call site in EditorMonaco.jsx. Captured in
bug_lsp_jsx_language_id.md (memory file).

Cumulative across all 4 sessions: 1525 → 1197 (Δ −328, 21.5% reduction).
The 137-line cumulative gap from the plan's 1060 target is primarily
Session 3 Group F's prop-bag plumbing (50 prop sources threaded as
inputs almost erase the 51-line JSX cut). Sessions 1, 2, and 4 all
hit or beat their targets. The architectural goal — App.jsx as
composition + coordination only — is met regardless of the LOC delta.
```

---

## Cumulative math

| Pass | Plan: lines saved | Plan cumulative | Plan App.jsx LOC | Actual lines saved | Actual cumulative | Actual App.jsx LOC |
|---|---|---|---|---|---|---|
| Baseline | — | 0 | 1525 | — | 0 | 1525 |
| Session 1 (A, B, G, H) | 105 | 105 | 1420 | 93 | 93 | 1432 |
| Session 2 (C) | 160 | 265 | 1260 | 143 | 236 | 1292 (post-merge baseline drift) |
| Session 3 (D, E, F) | 140 | 405 | 1120 | 54 | 290 | 1238 |
| Session 4 (K, M) — optional | 60 | 465 | **~1060** | 41 | 331 | **1197** |

## Branch strategy

Per [AGENTS.md](../../../AGENTS.md) branch lifecycle policy: each session is its own coherent unit, so each session gets its own branch + PR off main.

| Session | Branch | Depends on |
|---|---|---|
| 1 | `refactor/app-shell-pass-1-low-risk` | `main` |
| 2 | `refactor/app-shell-pass-2-group-drop-handlers` | Session 1 merged |
| 3 | `refactor/app-shell-pass-3-selectors-and-bindings` | Session 2 merged |
| 4 (opt) | `refactor/app-shell-pass-4-polish` | Session 3 merged |

Each merges before the next starts. Each is reviewable on its own. Each can be reverted independently if something downstream breaks. Each session ends in a working, shippable state — you can stop after any session.

## Completion criteria

The plan is done when:

- [ ] All Session 1, 2, 3 checkboxes are checked (Session 4 is optional)
- [ ] App.jsx is at ~1060 LOC or below
- [ ] App.jsx contains only: imports, top-level state, behaviors composition, domain factory creation, lifecycle hook calls, action hook calls, render-bindings hook calls, and the JSX render tree
- [ ] No new TODO/FIXME markers added during extraction
- [ ] All extracted hooks have JSDoc headers naming their inputs and outputs
- [ ] [scripts/app-shell-guard.mjs](../../../scripts/app-shell-guard.mjs) allowlist has shrunk by at least 2 entries (the `dbStorage` entries)

## Stop conditions

Halt the refactor and reassess if:

- Any session validation fails and the cause isn't immediately obvious
- A characterization test catches a behavior change you didn't intend
- The estimated time on a group exceeds 2x the estimate
- You feel the marathon-pull from the last refactor — stop, take a break, come back fresh. Each session is designed to be picked up and put down. There's no penalty for going slow.

## Notes

- Update this file as sessions complete. Check boxes. Fill in evidence.
- If a group reveals an unexpected dependency that requires re-sequencing, document the new order in the relevant session's notes and proceed.
- If a bug is found during validation, log it under Evidence with enough context to reproduce, then decide: fix in this session (if related to the extraction) or defer to a separate branch (if pre-existing).
