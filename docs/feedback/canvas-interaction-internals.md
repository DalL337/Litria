# Canvas Interaction — Internal / Architectural Notes

Companion file to [`macos-feedback.md`](./macos-feedback.md). That file
tracks user-visible symptoms (what happened, what the user saw). This
file tracks the **root causes** and **architectural patterns** behind
them — things a developer would note while planning a fix, but that
wouldn't be filed as a bug report by a tester.

Several symptoms in the feedback file share root causes. Fixing the
root causes here is usually cheaper than fixing each symptom independently.

Context: these were identified during the first dev-build test session
after the SQLite persistence cutover (2026-04-06). None are
SQLite-related — the cutover just made them more visible by clearing
the persistence noise.

---

## 1. `buildGroupBounds` ignores collapsed state

**Status**: RESOLVED — `buildGroupBounds` now respects `group.isCollapsed`
(returns the stub bounds when collapsed, expanded footprint otherwise; covered
by tests in `test/domains/workspaceSelectors.test.mjs`). Verified during PR #72.

**Affects**: Feedback items 19 (right-click drags group from empty canvas),
partially 25 (collapsed stub outline).

**Location**: Bounds computation for groups. Called in
[`src/App.jsx`](../../src/App.jsx) via `buildGroupBounds(group, piecesById, PIECE_WIDTH, PIECE_HEIGHT)`.

**Current behavior**: The function iterates `group.pieceIds` and computes
the min/max of each piece's `x, y, x+width, y+height`. This gives the
bounding rectangle of the pieces in their **world-space positions**.

**Problem**: When a group is collapsed, the pieces are not moved — they
retain their original world positions so that expanding restores the
layout. The collapsed stub renders at a different (smaller) location,
but `buildGroupBounds` still returns the bounds of the expanded piece
positions. The net effect is that the collapsed group has a **visible
small stub** but an **invisible large hit region** extending across
where the pieces *would* be if expanded.

Visible symptom: when the group actions menu is open, the selection
outline renders as a large dashed rectangle that looks disconnected
from the small collapsed stub — because it *is* the expanded bounds.

**Fix direction**:
1. `buildGroupBounds` takes a `group` object and should check
   `group.isCollapsed`
2. If collapsed, return the bounds of the collapsed stub at the stub's
   actual render position (which is... currently derived how? Needs
   investigation — likely from the first piece's position or the
   group's centroid). This needs a reliable "collapsed stub position"
   field, either stored on the group row or computed consistently
3. If expanded, return the current piece-based bounds (unchanged behavior)

**Related consideration**: The collapsed stub's position itself should
be persisted so that expand/collapse round-trips are stable. Currently
it may be recomputed each time, which could drift.

---

## 2. DOM overlays layered over Konva stage intercept pointer events

**Affects**: Feedback items 20 (stuck pan after drop), 22 (minimap
auto-fit during drag). Indirectly affects several others.

**Architecture**: The Konva stage renders the canvas (pieces, groups,
connections, viewport transforms). On top of that, several React/HTML
DOM overlays are positioned absolutely:

- Minimap widget (top-left area)
- Status bar (bottom of app)
- Editor launcher tab
- Group action popovers
- Drawer shells (scaffold, editor, terminal)
- Project bar, menubar

All of these are DOM elements with `pointer-events: auto` (the default)
and they sit above the Konva canvas in stacking order.

**Problem**: When a drag is in progress and the cursor crosses into one
of these overlays, the pointer events get captured by the DOM element
on top — the Konva stage stops receiving `pointermove` updates. Depending
on how the drag handler is written:

- **If the handler listens on the Konva node directly**: the drag
  "stops" at the overlay boundary visually, because Konva's internal
  drag state stops updating when the pointer isn't over the stage.
  On mouse release, the drop happens wherever the last-visible position
  was — possibly way off from where the user's mouse actually is.
- **If the handler listens on window**: the drag continues tracking
  the real mouse position (via `clientX/clientY` + inverse viewport
  transform), but the rendered piece can't update visually because
  the overlay is opaque. User loses visual tracking. On release, the
  piece is wherever the mouse ended up — which may be "3/4 outside
  the POV" because the mouse went past the visible area.

Both failure modes produce bug reports in the feedback file.

**Fix direction**: Two options, probably want both:

1. **`pointer-events: none` on overlays during active drags.** Add a
   CSS class on a top-level container during any drag (`app-dragging`
   or similar), and have all overlay selectors include
   `.app-dragging .overlay { pointer-events: none; }`. The cursor
   passes through overlays to the Konva stage underneath. This kills
   the pointer-capture side of the problem.

2. **Stage-level drag uses window listeners, not element listeners.**
   On `dragstart`, attach `pointermove` + `pointerup` to `window`.
   On `dragend`, detach them. This ensures the drag handler keeps
   receiving events regardless of what DOM element the cursor is over.
   Konva's internal node drag may already do this; any *app-level*
   drag logic layered on top may not. Audit `useGroupDrag`,
   `useInteractionDomain`, and any place that calls `addEventListener`
   during drag.

3. **Edge-scrolling** (see internals note #3) reduces the *frequency*
   of this problem by auto-panning the camera before the cursor
   reaches an overlay edge, but doesn't fix the underlying pointer-event
   leak.

**Why this became visible after the cutover**: It didn't. It was always
there. The test session just happened to produce more drag interactions
in rapid succession than normal project use, so the bugs surfaced faster.

---

## 3. No edge-scrolling / camera-follow during drag

**Status**: RESOLVED — Option A (edge-scrolling) shipped as
`src/behaviors/useAutoPan.js`. A RAF loop, gated on `isDragActive`, pans the
viewport when the cursor is within `AUTO_PAN_EDGE` (80px) of a viewport edge, at
a rate proportional to edge proximity. Gating on `isDragActive` (not the
piece-only `isDraggingPiece`) both covers group-pill drags and prevents the loop
from stranding after an interrupted drop — see feedback #20.

**Affects**: Feedback item 18 (camera POV doesn't follow piece during drag).

**Current behavior**: The drag handler updates the dragged piece's
world-space position based on cursor movement. The viewport offset
(`viewportOffsetX`, `viewportOffsetY`) and scale are never touched
during a drag — only through explicit pan (right-click drag) or zoom
(Ctrl+wheel) gestures.

**Problem**: Users dragging a piece to any position outside the current
viewport have to multi-step: drop → pan → pick up → drop → pan back.
This is frustrating for moves as small as 20 world-units outside the
visible area.

**Design options** (not a fix, a design decision):

### Option A: Edge-scrolling (recommended)

When a drag is active and the cursor is within N pixels of the viewport
edge (say, 40px), pan the camera at a rate proportional to the distance
from the edge (linear or ease-in curve). Cursor at the exact edge =
max pan rate (e.g., 8 world-units per frame). Cursor at 40px inside =
zero pan.

**Pros**:
- Standard UX, used by Figma, Excalidraw, Miro, Photoshop, every
  node-based editor
- User stays in control — they decide direction by cursor position
- Works identically for all drag types (piece, group, scaffold drop,
  selection box)

**Cons**:
- Requires a `requestAnimationFrame` loop during drag to keep panning
  even when the cursor isn't moving
- Needs tuning for scale: pan rate should be inversely proportional to
  zoom level so it feels consistent
- Can be jarring if too aggressive near edges

### Option B: Literal camera-follow

The viewport offset is continuously updated to keep the dragged piece
centered (or at a fixed offset) in the viewport. The piece stays
"pinned" under the cursor; the world scrolls around it.

**Pros**:
- No pan rate tuning needed
- Cursor can be anywhere; drag always works

**Cons**:
- Disorienting — the user can't see where they're coming from or
  going to, everything is moving
- No standard UX that uses this pattern
- The user report suggests they *think* this is what used to work,
  but it's more likely they were seeing stuck-pan (item 20) which
  produced a similar visual effect by accident

### Option C: Do nothing, rely on zoom out + drag + zoom in

Users zoom out to see their target, drag, zoom back in. Current de-facto
workflow.

**Pros**: No code change.

**Cons**: Already frustrating users.

**Recommendation**: Option A. Edge-scrolling is the right pattern, it's
well-understood, and it composes with every existing drag type without
special cases.

**Implementation sketch**:

```js
// Inside the drag hook, during active drag:
function onDragFrame(cursorX, cursorY) {
  const EDGE_PX = 40;
  const MAX_PAN_RATE = 8; // world units per frame at scale 1
  const rateX = computeEdgeRate(cursorX, viewportBounds.minX, viewportBounds.maxX, EDGE_PX);
  const rateY = computeEdgeRate(cursorY, viewportBounds.minY, viewportBounds.maxY, EDGE_PX);
  if (rateX !== 0 || rateY !== 0) {
    setViewportOffsetX(prev => prev + rateX * MAX_PAN_RATE / viewportScale);
    setViewportOffsetY(prev => prev + rateY * MAX_PAN_RATE / viewportScale);
  }
}

// Attach onDragFrame to a requestAnimationFrame loop started on dragstart
// and canceled on dragend
```

**Open question**: Do we also want the **dragged piece's world-space
position** to update as the viewport pans during edge-scroll? (Yes —
otherwise the piece stays where the user's cursor started, not where
they're dragging toward.) Detail: the piece position should be
recomputed from cursor position + viewport transform on every frame,
not just when the cursor moves.

---

## 4. `setState` updater purity violation in scaffold visibility toggle

**Status**: RESOLVED — decision + DB side effects moved outside the updater
(2026-07-07, commit `841aa2b`; see the dated resolution note below).

**Affects**: Feedback item 23 (hide button broken) as a secondary concern,
not the primary cause.

**Update (2026-07-01)**: The PRIMARY #23 cause was found and fixed — a
raw-vs-normalized path mismatch (suspected cause #3 in the feedback item, not the
purity violation here). `handleToggleScaffoldVisibility` stored `normalizePath(path)`
but `DrawerContentScaffold` compared `hiddenPaths.includes(child.path)` against the
raw path, so on Windows the toggle's visual state never updated. Fixed by
normalizing at the comparison site. This purity smell (below) is still OPEN as
hygiene — harmless because the DB writes are idempotent.

**RESOLVED (2026-07-07, commit `841aa2b`)**: the updater is now pure — the
hidden-check decision and the `dbAddHiddenPath`/`dbRemoveHiddenPath` side
effects moved OUTSIDE the state updater, exactly the fix sketched below
(the code comments at the site cite this note). Doc closed 2026-07-22 after
a code audit found the fix shipped but this note was never updated. All six
root-cause notes in this file are now resolved.

**Location**: [`src/app/useScaffoldActions.js`](../../src/app/useScaffoldActions.js)
— `handleToggleScaffoldVisibility`.

**Current code**:
```js
setHiddenScaffoldPaths((prev) => {
  const isHidden = prev.includes(target);
  if (isHidden) dbRemoveHiddenPath(target).catch(() => {});
  else dbAddHiddenPath(target).catch(() => {});
  return isHidden ? prev.filter(...) : [...prev, target];
});
```

**Problem**: The SQLite side effects (`dbAddHiddenPath` /
`dbRemoveHiddenPath`) are inside the state updater callback. React state
updaters are required to be pure — React will (and in StrictMode always
does) call them multiple times with the same input to verify purity.
Side effects inside the updater fire multiple times.

**Why this isn't the hide button bug (but is still a smell)**: The
SQLite operations are idempotent (`INSERT OR IGNORE`, `DELETE WHERE ...`),
so duplicate calls are harmless. The React state commit is still
correct (both invocations see the same `prev` and return the same
`next`, so React commits once). The toggle logic still works at the
React level.

**The actual hide button bug is probably elsewhere** — either in the
prop chain from click handler to `handleToggleScaffoldVisibility`, or
in the scaffold drawer's render-time filter that reads
`hiddenScaffoldPaths`.

**Fix for the purity violation** (separate from the hide button bug):

```js
const handleToggleScaffoldVisibility = useCallback((entry) => {
  if (!entry) return;
  const target = normalizePath(entry.path);
  if (!target) return;
  const currentlyHidden = hiddenScaffoldPaths.includes(target);
  // State update — pure
  setHiddenScaffoldPaths((prev) => (
    currentlyHidden
      ? prev.filter((path) => path !== target)
      : [...prev, target]
  ));
  // Side effect — outside updater, fires once
  if (currentlyHidden) {
    dbRemoveHiddenPath(target).catch(() => {});
  } else {
    dbAddHiddenPath(target).catch(() => {});
  }
}, [hiddenScaffoldPaths, normalizePath, setHiddenScaffoldPaths]);
```

Note the added `hiddenScaffoldPaths` dependency — reading state outside
the updater means the closure needs the current value. Alternatively,
use a ref to keep the dependency list stable.

---

## 5. Piece domain client-side `nextId` vs SQLite AUTOINCREMENT reconciliation

**Affects**: No current bug, but a latent risk introduced by the SQLite
cutover that should be documented.

**Background**: Before the cutover, the client piece domain generated
IDs from a monotonic counter (`nextId`), stored them in the JSON
manifest, and that was the authoritative source. After the cutover,
SQLite's `pieces.id INTEGER PRIMARY KEY AUTOINCREMENT` is authoritative,
and the client counter advances to stay ahead of SQLite-assigned IDs
(see `pieceDomain.createPiece` / `createPiecesBatch`).

**Current flow for new pieces**:

1. Caller writes file to disk (`writeProjectFile`)
2. Caller calls `dbCreatePiece(...)` → returns SQLite's assigned ID
3. Caller passes that ID to `pieceDomain.createPiece({ id: dbId, ... })`
4. `pieceDomain` inserts with the pre-assigned ID and advances `nextId`
   to `max(nextId, dbId + 1)`

This keeps client and DB in sync as long as **every piece creation
goes through the SQLite-first path**.

**Risk scenarios**:

- **Client-side-only piece creation**: If any code path calls
  `pieceDomain.createPiece({ ...without id... })`, the client assigns
  an ID from its counter. That ID may or may not match what SQLite
  would have picked. If that piece is then persisted via a later
  `dbCreatePiece`, SQLite would assign a *different* ID than the client
  has. State and DB diverge. Fix: all creation paths must flow through
  SQLite first.

- **Import / paste / undo-redo**: If undo restores a deleted piece, does
  it restore the original ID? SQLite's AUTOINCREMENT won't reuse IDs by
  default, so a restore attempts to `INSERT` with an ID that doesn't
  match any row — would need explicit ID insertion, which rusqlite
  supports but we're not currently exercising.

- **Multi-user / future sync**: Not in scope but AUTOINCREMENT becomes
  a problem if multiple clients ever need to create pieces independently.
  UUIDs would be a safer long-term choice.

**Action**: Audit all callers of `pieceDomain.createPiece` /
`createPiecesBatch` to verify they all pass pre-assigned SQLite IDs.
Known-compliant call sites:
- `useScaffoldActions.handleScaffoldOpenFolder` — compliant
- `usePieceUiActions.handleCreatePiece` — compliant
- `useProjectLaunch.handleOpenFileInstance` — **not compliant**, creates
  a piece with hardcoded `id: 1` for single-file-open mode. No workspace
  DB exists in that mode so this is fine as a special case, but the
  flag should be explicit.

---

## 6. Right-click drag button semantics

**Status**: RESOLVED — `Konva.dragButtons = [0]` (set in `PuzzlePiece.jsx`)
restricts node/group dragging to the left mouse button globally, so right-drag
no longer moves selected pieces/groups. Verified during PR #72 (right-drag
inside an expanded group box neither pans nor moves the group).

**Affects**: Feedback items 19 (right-click moves selected group).

**Current state**: Right-mouse-button drag is the intended **pan gesture**
for the canvas. Left-mouse-button drag picks up pieces/groups and
moves them.

**Problem**: Somewhere in the drag handler chain, right-mouse-button
drag is being interpreted as "drag the selected items" when a selection
exists. Either:

- The drag-start code path doesn't check `e.button` / `e.buttons` and
  treats any mousedown-then-move as a drag
- Selection-aware drag logic bypasses the pan path when selection is
  non-empty
- Konva's `draggable` prop on group nodes doesn't filter by mouse button

**Fix direction**:

1. Identify the drag-start handler that's firing for right-mouse
2. Gate it on `e.button === 0` (left button) for piece/group drag
3. Gate pan-start on `e.button === 2` (right button) — already correct
4. Ensure `onContextMenu` doesn't prevent the pan start when no context
   menu should appear

**Audit targets**:
- Konva Stage event handlers
- `useGroupDrag`
- Any `useInteractionDomain` entry points
- Piece-level drag handlers in the canvas node components

---

## Cross-references

| Internal note | Feedback items it addresses |
|---|---|
| 1. `buildGroupBounds` collapsed state | 19, partially 25 |
| 2. DOM overlay pointer events | 20, 22, contributes to 18 |
| 3. Edge-scrolling / camera-follow | 18 |
| 4. `setState` purity violation | 23 (secondary concern only) |
| 5. Piece ID reconciliation | None current; preventive |
| 6. Right-click drag button semantics | 19 |

---

## 7. App.jsx drift and the app-shell-guard's broken feedback loop

**Affects**: Architectural integrity. No user-visible bug, but a quietly
accumulating debt that will become one.

**Current state**: `src/App.jsx` was reduced from ~2100 lines to ~854
lines during the Phases 1-6 refactor (commits leading up to `3426d0f`).
The post-refactor goal was "App.jsx is a composition-only shell." As of
2026-04-06 it has grown back to ~1525 lines — 78% larger than the
post-refactor baseline, and trending upward.

**The principle App.jsx is supposed to follow**:

> App.jsx is a shell. An orchestrator. If something lives there, it's
> because: (1) it can't live anywhere else, (2) it's an import, (3)
> it's a hook invocation, or (4) there isn't a domain it slots into
> neatly. Anything else should live in a domain, hook, or selector.

**Why the guard hasn't prevented the drift**:
`scripts/app-shell-guard.mjs` enforces a transition allowlist of which
**modules** App.jsx may import from. It does not enforce anything about
**what App.jsx does with those imports**. Two failure modes that get
through the guard:

1. **Allowlist-as-rubber-stamp**: when the guard rejects a new import,
   the path of least resistance is to add the import to the allowlist
   with a "should extract this later" comment. The enforcement doc
   (`docs/plans/refactors/app-refactor-enforcement.md`) explicitly says
   the allowlist should *shrink* over time as responsibilities leave
   App.jsx, but commit history shows every recent allowlist change has
   been an *addition*, never a removal. The discipline is the opposite
   of what was specified.
2. **Inline logic accumulation**: behavior can grow inside App.jsx
   without adding new imports — a `useCallback` becomes 80 lines, an
   async drag handler becomes a state machine, a `useMemo` does
   non-trivial computation. None of this trips the import-based guard
   because no new module is being imported. The allowlist could even
   *shrink* while App.jsx grows, if the new growth is all inline logic
   over existing imports.

**Recent allowlist additions (as concrete drift evidence)**:
- `./app/useScaffoldOperations` (commit `e7eb589`)
- `./app/useSyntaxDomainLifecycle` (commit `4b97732`)
- `./app/useTsLspLifecycle` (commit `36a3b26`)
- `./project/dbStorage` and `./project/dbStorage.js` (commits `4d837a1`,
  `ba85539`) — added during the SQLite cutover for a group-drop handler
  that should arguably live in a `useGroupDropResolution` hook

Each of these is a deferred extraction that nobody has circled back to.

**Fix direction** (when there's appetite for an App.jsx cleanup pass):

1. **Extract the easy wins from the allowlist first.** The dbStorage
   imports power one self-contained block (the group-drop handler in
   the `pendingGroupDrop` resolution callback). Lifting that into a
   `useGroupDropResolution` hook is ~30 minutes of work and removes
   two allowlist entries.
2. **Audit App.jsx's growth since `3426d0f`.** What's the 671 lines of
   new code? Are they composition (correct) or business logic
   (incorrect)? Anything in the second category should be extracted to
   a hook or domain.
3. **Add a complementary check that catches inline complexity.** The
   import-based guard misses the actual failure mode. The real
   invariant being violated isn't "App.jsx is too long" — it's
   "App.jsx contains business logic instead of just orchestrating it."
   Line count is a *symptom* of that, not the principle itself. Used
   historically as a litmus test (back when the file was ~2100 lines
   and assistants were losing the plot trying to reason about it),
   but it's a coarse proxy and shouldn't be treated as the rule.

   Better signals to look for:
   - Inline async functions over a threshold (drag handlers, drop
     resolvers, batch operations) — these almost always belong in a
     hook
   - `useCallback` / `useMemo` bodies that contain branching logic,
     not just composition
   - Imports from multiple unrelated domains in service of a single
     callback (the dbStorage group-drop case is the prototype:
     piece domain + group domain + SQLite + filesystem all touched
     by one inline handler)
   - Anything that could be unit tested in isolation but currently
     can't be because it's defined inline in App.jsx

   Any one of these is more meaningful than line count. The principle
   the guard should enforce is "App.jsx is composition" — line count
   is just one way to notice the principle being violated, not the
   principle itself.
4. **Stop using the allowlist as an escape hatch.** When the guard
   rejects a new import, default to extraction unless there's a
   genuine reason it can't be extracted. The "should extract later"
   comment pattern has a 0% follow-through rate per commit history.

**Scope**: This is not a single bug fix, it's an architectural hygiene
pass. Best done as a focused session with a clear scope ("get App.jsx
back under 1000 lines" or "remove N entries from the allowlist") rather
than incrementally during feature work, where it always loses to
whatever ship-pressure feature is in flight.

**Status**: Open. The principle is captured here. The guard is doing
what it's literally programmed to do; the discipline of responding to
its failures is the thing that's broken. Next App.jsx-touching session
should extract `useGroupDropResolution` as a starting point.

## Status

- **#1 `buildGroupBounds` collapsed state** — RESOLVED (PR #72).
- **#3 Edge-scrolling / camera-follow** — RESOLVED (`useAutoPan.js`; closes feedback #18, #20's second strand).
- **#6 Right-click drag button semantics** — RESOLVED (`Konva.dragButtons=[0]`, verified PR #72).
- **#2, #4, #5, #7** — still **open**.

This file is a planning document, not a changelog. Update it as fixes land by
marking items as **RESOLVED** with a commit reference, same convention as
`macos-feedback.md`.
