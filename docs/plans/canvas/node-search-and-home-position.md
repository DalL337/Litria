# Node Search & Home Position — Implementation Plan

> **Status**: Delivered — merged to main 2026-03-29 (`fc3ab6f`: node search,
> home position, and canvas-scaffold sync landed together). The search pill
> and viewport behavior described below are live. *(Status corrected
> 2026-07-28 — this banner had read Planned since 03-27.)*
> **Date**: 2026-03-27
> **Governance**: ADR-008 (shadcn/Radix for popovers), `docs/ui-governance.md`
> **Dependencies**: `cmdk` (already installed), Radix Popover (already installed)

---

## Overview

Two related features that establish spatial navigation in the canvas:

1. **Home Position (0,0)** — every project opens with the viewport looking at canvas
   origin. A project-level toggle (`restoreViewportOnOpen`) lets users opt into
   restoring their last viewport instead.

2. **Node Search** — fuzzy search over piece filenames/labels with two entry points
   (compass long-press for power users, persistent search pill for new users). Clicking
   a result smooth-pans to center that piece at 85% zoom. "Home" is always pinned at
   the top of results.

---

## Phase 1 — Home Position & Viewport Toggle

### 1a. Manifest schema addition

**File: `src/project/manifest.js`**

Add `settings` top-level field to the manifest schema with a `restoreViewportOnOpen`
flag. This field lives alongside existing top-level keys (`viewport`, `appearance`,
`pieces`, etc.).

```js
// In normalizeManifest or equivalent:
settings: {
  restoreViewportOnOpen: false  // default: Home position
}
```

The `normalizeManifest` function should ensure `settings` exists and
`restoreViewportOnOpen` defaults to `false` for existing manifests that lack it.

### 1b. Viewport restoration gate

**File: `src/project/useProjectPersistence.js`** (lines 212-219)

Currently `loadWorkspaceState` unconditionally restores saved viewport:

```js
if (loaded.viewport) {
  setViewportScale(loaded.viewport.scale);
  setViewportOffsetX(loaded.viewport.offsetX);
  setViewportOffsetY(loaded.viewport.offsetY);
}
```

Change: read `loaded.settings?.restoreViewportOnOpen`. If `true`, restore as today.
If `false` or absent, skip — viewport stays at the `useViewport` defaults of
`{scale: 1, offsetX: 0, offsetY: 0}`.

Viewport **save** logic (line 247) is unchanged — always persist the current
viewport for potential future restoration.

### 1c. No UI for the toggle yet

The `restoreViewportOnOpen` flag is data-layer only for now. It can be manually set
in `litria.project.json` for testing. UI exposure comes with the future project settings
panel.

### Files touched

| File | Change |
|---|---|
| `src/project/manifest.js` | Add `settings.restoreViewportOnOpen` to schema + normalize |
| `src/project/useProjectPersistence.js` | Gate viewport restore on the flag |

---

## Phase 2 — Search Infrastructure

### 2a. Long-press detection hook

**New file: `src/behaviors/useLongPress.js`**

```
useLongPress({ onLongPress, onClick, delay = 400, moveThreshold = 5 })
  → { onPointerDown, onPointerUp, onPointerLeave, onPointerMove }
```

- `onPointerDown`: record position, start `setTimeout(delay)` → fires `onLongPress`
- `onPointerMove`: if distance > moveThreshold, cancel timer (it's a drag)
- `onPointerUp`: if timer hasn't fired, cancel it and call `onClick`
- `onPointerLeave`: cancel timer, no action
- Uses refs for timer ID and start position to avoid stale closures

**File: `src/behaviors/index.js`** — add `useLongPress` export.

### 2b. Viewport animation + center-on-piece math

**File: `src/utils/math.js`** — add easing function:

```js
export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}
```

**New file: `src/utils/viewportNavigation.js`**

Two pure computation functions + one animation driver:

```js
/**
 * Compute viewport state to center a piece on screen at target zoom.
 * Transform: screenX = canvasX * scale + offsetX
 * To center: offsetX = containerW/2 - pieceCenterX * scale
 */
export function computeCenterOnPiece(piece, containerW, containerH, pieceW, pieceH, targetScale = 0.85) {
  const ps = piece.scale ?? 1;
  const cx = piece.x + (pieceW * ps) / 2;
  const cy = piece.y + (pieceH * ps) / 2;
  return {
    scale: targetScale,
    offsetX: containerW / 2 - cx * targetScale,
    offsetY: containerH / 2 - cy * targetScale
  };
}

/**
 * Compute viewport state for Home: canvas (0,0) centered on screen at 100% zoom.
 */
export function computeHomeViewport(containerW, containerH) {
  return {
    scale: 1,
    offsetX: containerW / 2,
    offsetY: containerH / 2
  };
}

/**
 * Animate viewport from current state to target over duration ms.
 * Returns a cancel function.
 *
 * Uses requestAnimationFrame + easeOutCubic for smooth deceleration.
 * 300ms default — fast enough to feel responsive, slow enough to track visually.
 */
export function animateViewport({ from, to, duration = 300, setScale, setOffsetX, setOffsetY }) {
  const start = performance.now();
  let rafId = null;

  function tick(now) {
    const elapsed = now - start;
    const t = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(t);

    setScale(from.scale + (to.scale - from.scale) * eased);
    setOffsetX(from.offsetX + (to.offsetX - from.offsetX) * eased);
    setOffsetY(from.offsetY + (to.offsetY - from.offsetY) * eased);

    if (t < 1) {
      rafId = requestAnimationFrame(tick);
    }
  }

  rafId = requestAnimationFrame(tick);
  return () => { if (rafId) cancelAnimationFrame(rafId); };
}
```

### 2c. Shared search component

**New file: `src/components/NodeSearchPanel.jsx`**

Uses existing `cmdk` primitives from `src/components/ui/command.jsx`:

```jsx
<Command>
  <CommandInput placeholder="Search pieces..." />
  <CommandList>
    {/* Home — always visible, never filtered out */}
    <CommandItem onSelect={onNavigateHome}>
      <HomeIcon /> Home
    </CommandItem>
    <CommandSeparator />

    {/* Piece results — fuzzy matched by cmdk/command-score */}
    <CommandEmpty>No pieces found.</CommandEmpty>
    <CommandGroup>
      {pieces.map(piece => (
        <CommandItem
          key={piece.id}
          value={`${piece.label ?? ''} ${piece.filename ?? ''}`}
          keywords={[piece.filename, piece.label].filter(Boolean)}
          onSelect={() => onNavigateToPiece(piece)}
        >
          <span>{piece.label || getBasename(piece.filename)}</span>
          <span className="node-search-filename">
            ({getBasename(piece.filename)})
          </span>
        </CommandItem>
      ))}
    </CommandGroup>
  </CommandList>
</Command>
```

Props:
- `pieces` — array of pieces to search
- `onNavigateToPiece(piece)` — pan to piece
- `onNavigateHome()` — pan to Home
- `onClose()` — close the popover after selection

The Home item is rendered outside the `<CommandGroup>` so `cmdk`'s built-in
filtering does not hide it.

### 2d. Navigation callbacks in App.jsx

**File: `src/App.jsx`**

```js
const cancelAnimRef = useRef(null);

const handleNavigateToPiece = useCallback((piece) => {
  if (cancelAnimRef.current) cancelAnimRef.current();
  const from = { scale: viewport.scale, offsetX: viewport.offsetX, offsetY: viewport.offsetY };
  const to = computeCenterOnPiece(piece, deskWidth, deskHeight, PIECE_WIDTH, PIECE_HEIGHT, 0.85);
  cancelAnimRef.current = animateViewport({
    from, to, duration: 300,
    setScale: viewport.setScale,
    setOffsetX: viewport.setOffsetX,
    setOffsetY: viewport.setOffsetY
  });
}, [deskWidth, deskHeight, viewport]);

const handleNavigateHome = useCallback(() => {
  if (cancelAnimRef.current) cancelAnimRef.current();
  const from = { scale: viewport.scale, offsetX: viewport.offsetX, offsetY: viewport.offsetY };
  const to = computeHomeViewport(deskWidth, deskHeight);
  cancelAnimRef.current = animateViewport({
    from, to, duration: 300,
    setScale: viewport.setScale,
    setOffsetX: viewport.setOffsetX,
    setOffsetY: viewport.setOffsetY
  });
}, [deskWidth, deskHeight, viewport]);
```

The `cancelAnimRef` ensures that triggering a new navigation cancels any in-flight
animation — no fighting animations.

### Files touched

| File | Change |
|---|---|
| `src/behaviors/useLongPress.js` | New file |
| `src/behaviors/index.js` | Add export |
| `src/utils/math.js` | Add `easeOutCubic` |
| `src/utils/viewportNavigation.js` | New file — compute + animate |
| `src/components/NodeSearchPanel.jsx` | New file — shared search UI |
| `src/App.jsx` | Add `handleNavigateToPiece`, `handleNavigateHome`, `cancelAnimRef` |

---

## Phase 3 — Compass Long-Press Popover (Power Users)

**File: `src/components/StatusBar.jsx`**

The crosshair button (line 186-192) currently wires `onClick={onResetView}`.

Changes:
1. Import `useLongPress` from behaviors
2. Import `NodeSearchPanel` and Radix `Popover` components
3. Add `[isSearchOpen, setIsSearchOpen]` local state
4. Wire `useLongPress` to the crosshair button:
   - `onClick` → `onResetView` (existing tap behavior preserved)
   - `onLongPress` → `setIsSearchOpen(true)`
5. Wrap button with `<Popover>` / `<PopoverAnchor>` / `<PopoverContent side="top">`
6. Render `<NodeSearchPanel>` inside the popover content
7. On result selection: call navigate callback, close popover

New props on StatusBar:
- `pieces` — for search
- `onNavigateToPiece(piece)` — pan to piece
- `onNavigateHome()` — pan to Home

**File: `src/App.jsx`** — pass new props to `<StatusBar>`:

```jsx
<StatusBar
  ...existing...
  pieces={allVisiblePieces}
  onNavigateToPiece={handleNavigateToPiece}
  onNavigateHome={handleNavigateHome}
/>
```

### Files touched

| File | Change |
|---|---|
| `src/components/StatusBar.jsx` | Long-press + search popover on compass |
| `src/App.jsx` | Pass new props to StatusBar |

---

## Phase 4 — Search Pill (New Users)

**New file: `src/components/SearchPill.jsx`**

Persistent search affordance centered horizontally at the top of the canvas area.
Positioned absolute, `top: 36px; left: 50%; transform: translateX(-50%)` — same
vertical zone as PillNotification but horizontally centered.

```jsx
<Popover open={isOpen} onOpenChange={setIsOpen}>
  <PopoverTrigger asChild>
    <button className="search-pill-trigger">
      <SearchIcon size={14} />
      <span>Search pieces...</span>
    </button>
  </PopoverTrigger>
  <PopoverContent side="bottom" align="center" sideOffset={4}
    className="search-pill-popover">
    <NodeSearchPanel
      pieces={pieces}
      onNavigateToPiece={(piece) => { onNavigateToPiece(piece); setIsOpen(false); }}
      onNavigateHome={() => { onNavigateHome(); setIsOpen(false); }}
    />
  </PopoverContent>
</Popover>
```

**New file: `src/styles/search.css`**

Styles for:
- `.search-pill-trigger` — pill shape, glass-morphic background matching Litria tokens
  (`rgba(24, 24, 24, 0.96)`, backdrop blur, rounded), subtle border, pointer cursor
- `.search-pill-popover` — width ~320px, max-height for ~8 results with scroll
- `.node-search-filename` — muted secondary text (`--cm-text-muted`)
- `.node-search-home` — distinct styling for pinned Home item (home icon)

**File: `src/App.jsx`** — import style, render `<SearchPill>` inside `<CanvasArea>`
after the `<TopDrawerProvider>` block:

```jsx
<SearchPill
  pieces={allVisiblePieces}
  onNavigateToPiece={handleNavigateToPiece}
  onNavigateHome={handleNavigateHome}
/>
```

### Files touched

| File | Change |
|---|---|
| `src/components/SearchPill.jsx` | New file |
| `src/styles/search.css` | New file |
| `src/App.jsx` | Import style + render SearchPill |

---

## Phase 5 — Keyboard Shortcut (Ctrl+P / Cmd+P)

**File: `src/App.jsx`**

Add shared `isNodeSearchOpen` state:

```js
const [isNodeSearchOpen, setIsNodeSearchOpen] = useState(false);
```

In the keyboard handler (around line 156), add:

```js
if (ctrlOrCmd && e.key === 'p') {
  if (document.activeElement?.closest('.monaco-editor')) return;
  e.preventDefault();
  setIsNodeSearchOpen(true);
}
```

Pass `isNodeSearchOpen` and `setIsNodeSearchOpen` to both `<SearchPill>` and
`<StatusBar>`. Both components sync their local popover open state: if the shared
state goes `true`, they open; when they close, they set it back to `false`.

The SearchPill is the primary keyboard target since it's more discoverable.

### Files touched

| File | Change |
|---|---|
| `src/App.jsx` | Add state + keyboard handler + pass props |
| `src/components/SearchPill.jsx` | Sync with shared open state |
| `src/components/StatusBar.jsx` | Sync with shared open state |

---

## Implementation Order

```
Phase 1   manifest.js + useProjectPersistence.js     (home position + toggle)
  |
Phase 2a  useLongPress.js + behaviors/index.js       (interaction hook)
  |
Phase 2b  math.js + viewportNavigation.js            (animation + compute)
  |
Phase 2c  NodeSearchPanel.jsx                        (shared search UI)
  |
Phase 2d  App.jsx navigation callbacks               (wire navigate handlers)
  |
Phase 3   StatusBar.jsx + App.jsx                    (compass long-press)
  |
Phase 4   SearchPill.jsx + search.css + App.jsx      (discoverable pill)
  |
Phase 5   App.jsx + sync props                       (Ctrl+P shortcut)
```

Each phase is independently testable. Phase 1 can ship alone. Phases 2-5 build
on each other but the search is usable after Phase 4 (keyboard shortcut is polish).

---

## Decisions & Tradeoffs

| Decision | Rationale |
|---|---|
| `cmdk` for fuzzy search | Already installed, provides command-score matching free. `<Command filter>` prop available if custom scoring needed later. |
| 300ms ease-out animation | VS Code-like feel. Fast enough to not waste time, slow enough to track. Ease-out decelerates into destination = "arriving" feel. |
| `restoreViewportOnOpen` default `false` | Home position is the safer default for new users. Power users can opt in. No migration needed — viewport data always saved. |
| `allVisiblePieces` as search set | Hidden/collapsed pieces excluded. Avoids confusion of navigating to invisible content. Revisit if users request. |
| Home pinned outside CommandGroup | `cmdk` filtering only applies within `<CommandGroup>`. Items outside are always rendered. |
| Cancel in-flight animation on new nav | `cancelAnimRef` prevents fighting animations when user clicks results rapidly. |
| No project settings UI yet | Toggle is data-layer only. Exposed when project settings panel is built. |

## Known Limitations

1. **No animated Home on project open** — viewport starts at Home instantly, no
   animation. Animation is only for in-session navigation.

2. **Search excludes hidden pieces** — pieces in collapsed groups or hidden scaffold
   paths won't appear in results. Could add a "Search all" toggle later.

3. **Long-press not discoverable** — power-user feature by design. The search pill
   is the discoverable surface. A tooltip on hover ("Hold for search") could help.

## Files Summary

| File | Action | Phase |
|---|---|---|
| `src/project/manifest.js` | Modify — add settings schema | 1 |
| `src/project/useProjectPersistence.js` | Modify — gate viewport restore | 1 |
| `src/behaviors/useLongPress.js` | **New** | 2a |
| `src/behaviors/index.js` | Modify — add export | 2a |
| `src/utils/math.js` | Modify — add easeOutCubic | 2b |
| `src/utils/viewportNavigation.js` | **New** | 2b |
| `src/components/NodeSearchPanel.jsx` | **New** | 2c |
| `src/App.jsx` | Modify — callbacks, props, state, keyboard | 2d, 3, 4, 5 |
| `src/components/StatusBar.jsx` | Modify — long-press + popover | 3 |
| `src/components/SearchPill.jsx` | **New** | 4 |
| `src/styles/search.css` | **New** | 4 |
