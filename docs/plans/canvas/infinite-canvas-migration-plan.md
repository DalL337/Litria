# Infinite Canvas Migration Plan

**Status: COMPLETE** -- Artboard removed, infinite pan/zoom implemented. Closed 2026-03-07.

> Remove the artboard system, restructure the window layout, and implement full pan/zoom on an infinite canvas.

## Decisions Locked

| Decision | Resolution |
|----------|------------|
| Artboard | Remove completely — files, state, bounds, all references |
| Layout model | Flex column: `ProjectBar → CanvasArea`. Chrome is a DOM sibling, not an overlay |
| ProjectPill | Deleted. Replaced by `ProjectBar` component in window chrome |
| Pan trigger | Left-click-hold on empty canvas, 4px movement threshold to distinguish from click-to-deselect |
| Zoom trigger | Mouse wheel toward cursor position |
| Lasso | Unchanged — shift+drag on empty canvas |
| Piece/group drag | No conflict with pan — Konva hit detection disambiguates by click target (piece vs empty stage) |
| Per-piece scale | Moves to the existing ellipsis action menu on selected pieces/groups |
| `piece.location` | Field removed. Ignored on load, stopped writing on save |
| Trackpad | Deferred. Ship wheel=zoom, revisit later |
| Spawn position | Viewport center with collision avoidance (spiral scan for clear slot) |

---

## Phase 1A — Layout Restructure

**Goal**: Establish the `ProjectBar → CanvasArea` DOM hierarchy before touching artboard logic. Chrome lives in the window, not on the canvas.

### New Files

**`src/components/ProjectBar.jsx`**
- Thin bar (~30px), fixed height, flex row
- Left-aligned: project name (plain text, no positioning math)
- Right-aligned: placeholder slot for future zoom indicator
- CSS: normal document flow, not absolute/fixed. Background color from theme
- Future: project switcher dropdown, menu bar above it

**`src/components/CanvasArea.jsx`**
- Wrapper div with `position: relative; flex: 1; overflow: hidden`
- Containment boundary for drawers, tooltips, overlays, Konva stage — everything canvas-related
- `deskRef` attaches here (replaces current measurement point)
- Drawers render inside this container, scoped to its bounds

### Modifications

**`src/App.jsx`**
- Root layout becomes flex column:
  ```
  <div className="App" (flex column, height: 100vh)>
    <ProjectBar projectName={...} />
    <CanvasArea ref={deskRef}>
      <DrawerProvider> ... </DrawerProvider>
      <WorkspaceStage ... />
      <EditorDrawer ... />
      <GroupMenuOverlay ... />
      ... all canvas-scoped UI
    </CanvasArea>
  </div>
  ```
- `deskWidth`/`deskHeight` now measures `CanvasArea` — happens naturally since `deskRef` moves to the new wrapper
- All z-index layering stays internal to `CanvasArea`

**`src/components/useAppDrawers.jsx`**
- Remove `artboardDrawers` array entirely
- Remove `DrawerContentArtboard` import
- Return only `{ drawers }` (the left drawer set)

### Deletions

**`src/components/ProjectPill.jsx`**
- All artboard-relative positioning logic goes with it
- `.project-pill` CSS block in `styles/` goes too

### Commit Checkpoint

- [ ] App has correct DOM hierarchy
- [ ] ProjectBar renders in window chrome above canvas
- [ ] Drawers scoped to CanvasArea
- [ ] Canvas still renders artboard (no functional canvas changes yet)
- [ ] Build passes

---

## Phase 1B — Artboard Removal

**Goal**: Gut every artboard reference. After this, the canvas is a flat infinite plane with no bounded region.

### File Deletions

| File | What it was |
|------|-------------|
| `src/components/Artboard.jsx` | Artboard component |
| `src/config/artboardPresets.js` | Preset dimensions, DPI options, orientation logic |
| `src/drawers/DrawerContentArtboard.jsx` | Scale slider drawer panel |

### File Modifications

**`src/App.jsx`**
- Remove state: `artboardPreset`, `artboardOrientation`, `artboardDpi` and their setters
- Remove computed: `artboardSize`, `artboardX`, `artboardY`, `artboardBounds`, `artboardDrawerWidth`
- Remove imports: `getDimensions`, `defaults`, `dpiOptions` from artboardPresets
- Remove JSX: the entire `artboard-drawer-host` div and its `DrawerProvider`
- Remove props: stop passing `artboardBounds` to `WorkspaceStage`, `useGroupMenuUi`, `usePiecePlacement`

**`src/components/WorkspaceStage.jsx`**
- Remove `artboardBounds` prop
- Remove the artboard `<Rect>` element
- Remove `artboardFill`/`artboardStroke` theme token reads

**`src/drawers/DrawerContentSettings.jsx`**
- Remove the entire "Artboard" section (preset dropdown, orientation toggle, DPI selector)
- Remove artboard-related props from the component signature
- Theme section stays untouched

**`src/behaviors/usePiecePlacement.js`**
- Remove `artboardBounds` parameter
- Remove `isInsideArtboard`, `getLocationForPosition`, `getArtboardPieces`, `getDeskPieces`
- Keep only spawn position logic (will be upgraded in Phase 2B with viewport awareness)
- If the hook becomes trivial, inline the spawn logic and delete the file

**`src/app/useGroupMenuUi.js`**
- Remove `artboardBounds` parameter
- Replace artboard edge constraints with `CanvasArea` measured dimensions (`deskWidth`/`deskHeight`)

**`src/drawers/DrawerContentScaffold.jsx`**
- Change tooltip text from "Show/Hide on artboard" to "Show/Hide"

**`src/theme/themeDefaults.js`**
- Remove `artboardFill` and `artboardStroke` tokens

**`src/styles/drawers.css`**
- Remove `.artboard`, `.artboard-label`, `.artboard-drawer-host`, `.drawer-artboard` class blocks

### Per-Piece Scale — Move to Ellipsis Action Menu

- The `scaleSelectedPieces()` command in `useCanvasInteractionController.js` stays untouched
- Add a scale action (compact slider or +/- stepper) to the existing ellipsis bubble menu that appears on piece/group selection
- The ellipsis menu is already selection-aware and positioned per-piece — scale becomes another action item alongside existing actions
- Menu sizing stays modular — grows to fit its actions, no fixed dimensions

### Data Cleanup

| File | Change |
|------|--------|
| `src/app/pieceDomain.js` | Stop initializing `location: 'desk'` on new pieces |
| `src/project/projectDomain.js` | On load: ignore `piece.location` if present (backward compat) |
| `src/project/useProjectPersistence.js` | On save: stop writing `piece.location` |

### Commit Checkpoint

- [ ] All 3 artboard files deleted
- [ ] No artboard references remain in codebase
- [ ] Canvas is a flat infinite plane — pieces render at x/y coords
- [ ] Scale control lives in ellipsis action menu
- [ ] `piece.location` no longer written on save, ignored on load
- [ ] Build passes

---

## Phase 2A — Coordinate Transform Foundation

**Goal**: Establish transform utilities before wiring inputs. This is the load-bearing infrastructure for pan/zoom.

### New File

**`src/behaviors/useViewport.js`**

State:
- `scale` (number, default 1.0)
- `offsetX` (number, default 0)
- `offsetY` (number, default 0)

Core utilities:
- `screenToCanvas(screenX, screenY)` — `(screenPos - stageOffset) / stageScale`
- `canvasToScreen(canvasX, canvasY)` — `canvasPos * stageScale + stageOffset`
- `getVisibleBounds()` — `{ x, y, width, height }` in canvas space (computed from offset, scale, and CanvasArea dimensions)

### Thread Through Existing Code

Piece `x, y` coordinates are already in canvas space and stay that way. The transform layer only applies to pointer input (screen → canvas) and overlay positioning (canvas → screen).

| File | Current pattern | Change to |
|------|----------------|-----------|
| `useCanvasInteractionController.js` | `stage.getPointerPosition()` for lasso, drag, connection | `screenToCanvas(pointer.x, pointer.y)` |
| `useConnectionDrag.js` | Raw pointer coords for edge detection | Canvas-space coords via `screenToCanvas` |
| `useLassoSelection.js` | Raw pointer coords for selection rect | Canvas-space coords via `screenToCanvas` |
| `useSnap.js` | Piece coords directly | No change needed — already in canvas space |
| `App.jsx` | Tooltip positioning reads `stage.scaleX()` / `stage.position()` | Use `canvasToScreen` from viewport |
| `useGroupMenuUi.js` | Was artboard-constrained (removed in 1B) | Constrain to `getVisibleBounds()` |

### Commit Checkpoint

- [ ] `useViewport.js` created with transform utilities
- [ ] All interaction code routes through `screenToCanvas`/`canvasToScreen`
- [ ] App behaves identically at scale=1, offset=0
- [ ] Build passes

---

## Phase 2B — Pan/Zoom Input Handlers

**Goal**: Wire user inputs to the viewport state.

### Zoom — Wheel Handler

In `useViewport.js`:
- Attached to Konva Stage `onWheel`
- Zoom toward cursor position: compute cursor in canvas space before zoom, apply new scale, adjust offset so cursor stays fixed
- Clamp scale: `0.1` to `3.0`
- Apply `stage.scale({ x, y })` and `stage.position({ x, y })`

### Pan — Left-Drag on Empty Canvas

In `useCanvasInteractionController.js`:
- `handleStageMouseDown`: if target is empty stage and no shift key → start pan candidate
- `handleStageMouseMove`: if pan candidate and movement > 4px → commit to pan mode, update offsets by delta
- `handleStageMouseUp`: if was panning → end pan. If movement < 4px → click-to-deselect (existing behavior)
- Pan mode flag prevents lasso/selection from triggering during the same gesture
- No conflict with piece/group drag — Konva hit detection disambiguates by click target

### Stage Integration

In `WorkspaceStage.jsx`:
- Add `onWheel` handler to `<Stage>`
- Stage gets `scaleX={scale}` `scaleY={scale}` `x={offsetX}` `y={offsetY}` props
- `draggable={false}` on Stage (pan handled manually to avoid gesture conflicts)

### Zoom-During-Drag

- Wheel while mid-piece-drag zooms the canvas
- Piece stays under cursor because coordinate transforms are correct from Phase 2A
- No special handling needed

### Spawn Position — Viewport-Aware with Collision Avoidance

In `usePiecePlacement.js` (or equivalent):
- Uses `getVisibleBounds()` to get viewport center as starting point
- Grid-snapped spiral scan from viewport center:
  1. Start at viewport center
  2. Check if a piece-sized rect (140x60 + padding) overlaps any existing piece bounding box
  3. If occupied, spiral outward (right → down → left → up, expanding)
  4. First clear slot wins
- Fast — just rect overlap checks against piece array, piece counts are low
- Spawned piece is always visible and never stacked on top of existing pieces

### Commit Checkpoint

- [ ] Wheel zoom works, zooms toward cursor
- [ ] Left-drag pan works, threshold-gated, no conflict with lasso or piece drag
- [ ] All interactions (lasso, connection drag, piece drag, snap) work correctly through transform layer
- [ ] Pieces spawn in viewport center, avoiding collision with existing pieces
- [ ] Build passes

---

## Phase 3 — Polish (Incremental, Independent)

Each item is a standalone commit. No dependencies between them.

- [ ] **Zoom indicator** — `85%` label in `ProjectBar` right slot
- [ ] **Fit-to-content** — Ctrl+0 → compute bounding box of all pieces → set scale/offset to fit
- [ ] **Zoom-to-selection** — Shortcut → fit selected pieces in viewport
- [ ] **Auto-pan-on-drag** — Pan canvas when dragging a piece near viewport edge
- [ ] **Viewport persistence** — Save `{ scale, offsetX, offsetY }` per project in manifest
- [ ] **Viewport culling** — Skip rendering pieces fully outside `getVisibleBounds()`
- [ ] **Minimap** — Thumbnail overlay showing all pieces + viewport rectangle
- [ ] **Trackpad gestures** — Differentiate pinch-to-zoom vs two-finger-scroll-to-pan
- [ ] **Project switcher** — Dropdown in `ProjectBar` with recent projects, wired to existing teardown/open flows
- [ ] **Menu bar** — File/Edit/View bar above `ProjectBar` in the flex column

---

## Files Touched Summary

| Phase | New Files | Deleted Files | Modified Files |
|-------|-----------|---------------|----------------|
| 1A | `ProjectBar.jsx`, `CanvasArea.jsx` | `ProjectPill.jsx` | `App.jsx`, `styles/`, `useAppDrawers.jsx` |
| 1B | — | `Artboard.jsx`, `artboardPresets.js`, `DrawerContentArtboard.jsx` | `App.jsx`, `WorkspaceStage.jsx`, `DrawerContentSettings.jsx`, `usePiecePlacement.js`, `useGroupMenuUi.js`, `DrawerContentScaffold.jsx`, `themeDefaults.js`, `styles/`, `pieceDomain.js`, `projectDomain.js`, `useProjectPersistence.js`, ellipsis menu component |
| 2A | `useViewport.js` | — | `useCanvasInteractionController.js`, `useConnectionDrag.js`, `useLassoSelection.js`, `App.jsx`, `useGroupMenuUi.js`, `WorkspaceStage.jsx` |
| 2B | — | — | `useViewport.js`, `useCanvasInteractionController.js`, `WorkspaceStage.jsx`, `usePiecePlacement.js` |

---

## Execution Sequence

```
Phase 1A  Layout restructure (ProjectBar + CanvasArea wrapper)
  ↓ commit
Phase 1B  Artboard gut + scale action to ellipsis menu
  ↓ commit
Phase 2A  Coordinate transform foundation (useViewport, screenToCanvas/canvasToScreen)
  ↓ commit
Phase 2B  Pan/zoom handlers + viewport-aware collision-avoiding spawn
  ↓ commit
Phase 3   Polish items (independent commits)
```
