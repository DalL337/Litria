# ADR-013: Interaction Modes and Action Token System

## Status
- Extended (2026-07-25 — group pill drops joined the mode system; see
  "Addendum (2026-07-25)" below)
- Accepted + Implemented, Phases 1–3 (2026-06-13 — PRs #54, #55, #56; shipped
  as designed: E-toggle mode state in `interactionDomain`, Ctrl/Alt tap
  sub-modes, status-bar pill, +/- cursor, `useActionToken` API. Status flip
  recorded 2026-07-25 — doc lagged the code.)
- Proposed (revised 2026-04-15, supersedes original 2026-04-04 proposal)

## Date
- 2026-04-04 (original)
- 2026-04-15 (revised)

## Revision Summary

The original ADR proposed held-modifier action tokens (hold Ctrl during drag = additive, hold Alt = subtractive) operating in a single interaction context. Gap analysis revealed three blocking conflicts:

1. **Ctrl is overloaded** — Ctrl+click already means "start connection drag" (PuzzlePiece.jsx, useCanvasInteractionController.js) and "toggle multi-select" (usePieceUiActions.js). Adding "additive group action" to the same modifier in the same mode creates disambiguation problems with no clean resolution.
2. **Alt conflicts on Windows** — Alt triggers menu bar focus in many apps. Tauri may suppress this, but the original proposal treated it as a footnote ("likely fine") rather than a tested constraint. The fallback (Shift) conflicts with lasso selection and multi-select.
3. **No discoverability path** — Removing auto-merge-on-drop and replacing it with invisible held-modifier gestures leaves new users with no way to discover the feature.

The revised design introduces an **interaction mode system** that eliminates all three conflicts by separating structural editing from default canvas interaction. Action tokens survive as the semantic layer within edit mode, but their activation model changes from held-modifier to toggled sub-mode.

## Context

Canvas interactions have two related problems:

**1. No way to remove a node from a folder group via direct manipulation.** A user can drag a node onto a folder group to merge it in, but extracting a node requires switching to the scaffold tree. This breaks flow — the mental model says "I should be able to drag it out," but the canvas has no mechanism to distinguish "move" from "remove from group."

**2. Implicit merge on drop creates accidental group membership.** The current behavior auto-merges a node into a folder group whenever a drag ends over one. On a dense canvas with many folder groups nearby, this punishes the user for letting go at the wrong moment — a tired hand, a momentary grip slip, an overshoot. The user didn't intend to add the node to that group; they just needed to set it down. This creates friction and frustration that scales with canvas complexity.

Both problems share a root cause: the canvas cannot distinguish between "I am moving a piece" and "I intend to change this piece's group membership." A plain drag should be safe — it should never alter group structure. Group changes should require explicit intent from the user.

**3. Modifier key contention in the current codebase.** The original proposal (hold Ctrl = additive, hold Alt = subtractive) assumed modifier keys were available. They are not:

| Modifier | Current meaning | File |
|----------|----------------|------|
| Ctrl+click on piece | Start connection drag | PuzzlePiece.jsx:102 |
| Ctrl+click on piece | Toggle multi-select | usePieceUiActions.js:78 |
| Ctrl+drag on piece | Suppress piece drag (connection mode) | PuzzlePiece.jsx:220 |
| Ctrl+mousewheel | Zoom at pointer | WorkspaceStage.jsx:86 |
| Shift+click | Multi-select / range select | usePieceUiActions.js:79 |
| Shift+LMB on canvas | Lasso selection | useCanvasInteractionController.js:78 |
| Shift+RMB on connection | Delete connection | ConnectionLine.jsx:101 |
| Alt | Windows menu bar activation risk | OS-level |

Every modifier is claimed. Overloading them requires disambiguation heuristics that erode user trust. The solution is not a smarter modifier parser — it is a mode boundary.

## Decision

Introduce an **interaction mode system** with two modes — Default and Edit — where each mode owns its modifier key meanings without conflict. Action tokens provide the semantic abstraction layer within Edit mode.

### Interaction modes

```
Default Mode                          Edit Mode
(canvas manipulation)                 (structural editing)
─────────────────────                 ─────────────────────
drag         = move piece             drag onto target = merge/nest (additive)
                                      drag off group   = extract (subtractive)
Ctrl+click   = connection draw        Ctrl tap   = switch to additive sub-mode
Shift+click  = multi-select           Alt tap    = switch to subtractive sub-mode
Shift+LMB    = lasso selection        Shift+click = multi-select (unchanged)
mousewheel   = zoom (see §Prereq)     mousewheel  = zoom (unchanged)
pan          = middle-mouse / space   pan         = middle-mouse / space

Toggle: tap E                         Toggle: tap E
```

Modes are mutually exclusive. Only one mode is active. The `E` key toggles between them — tap to enter edit mode, tap again to return to default. This matches design tool conventions (Photoshop, Illustrator, Figma) where tool selection changes what mouse gestures mean.

### Why modes, not held modifiers

Design tools solved this problem decades ago. Photoshop does not make you hold a modifier to switch between the Move tool and the Pen tool — you press a key to switch tools, then your mouse gestures have different meanings in each tool context. The held-modifier approach (original ADR-013) works for simple cases but breaks down when:

- The modifier is already claimed by another gesture in the same context
- The modifier has OS-level side effects (Alt on Windows)
- The user needs to perform multiple structural edits in sequence (holding a modifier for 30 seconds of reorganization is physically uncomfortable)
- Discoverability depends on the user guessing to hold a key

A sticky mode toggle solves all four. The user enters edit mode deliberately, performs structural edits with natural drag gestures (no modifier holding), and exits when done.

### Edit mode sub-modes (action tokens)

Edit mode has two sub-modes controlled by action tokens:

**Additive** (default on entering edit mode):
- Cursor displays persistent `+` indicator
- Drag a piece onto a folder group = merge into group
- Drag a piece onto another piece = nest / create group (future)
- Target highlights on hover to show valid drop zones

**Subtractive** (tap Alt to switch):
- Cursor displays persistent `-` indicator
- Drag a piece out of its group = extract from group
- Source group de-emphasizes to show the piece is leaving

Sub-mode switching:
- Tap `Ctrl` = switch to additive (if not already)
- Tap `Alt` = switch to subtractive
- These are **toggle taps**, not held modifiers. The sub-mode persists until changed or edit mode is exited.
- On entering edit mode, sub-mode always resets to additive.

### Action token system (three-layer architecture)

The action token abstraction from the original ADR survives with a changed activation model.

```
Layer 1: Token (intent)     Layer 2: Mode binding        Layer 3: Consumer
  'additive'                  editMode.subMode             "is additive active?"
  'subtractive'               toggle key: Ctrl/Alt          --> reads from mode state
```

**Layer 1 — Token definition (intent):**
Unchanged from original. Each token declares semantic intent, cursor treatment, and label.

```js
{
  id,            // 'additive' | 'subtractive' | future tokens
  label,         // 'Add' | 'Remove'
  cursor,        // 'plus' | 'minus' | custom cursor identifier
  description,   // 'Add item to target' | 'Remove item from target'
}
```

**Layer 2 — Mode binding (activation):**
Changed from original. Tokens are not activated by held modifier keys. They are activated by the current sub-mode within edit mode. The binding map now maps token IDs to toggle keys:

```json
{
  "actionBindings": {
    "additive": "ctrl",
    "subtractive": "alt"
  }
}
```

These bindings control which key *taps* switch to which sub-mode, not which held keys activate which token. User remapping still works — a user remaps the toggle key, not the semantic action.

**Layer 3 — Consumer (context opt-in):**
Simplified from original. The hook reads mode state instead of polling keyboard state:

```js
const { isActive, activeToken } = useActionToken('additive');
// isActive: true when edit mode is on AND current sub-mode is 'additive'
// No keyboard polling, no event.ctrlKey checks, no continuous modifier detection
```

### Cursor feedback

Cursor rendering changes based on mode and sub-mode:

| Mode | Sub-mode | Cursor | Persistent? |
|------|----------|--------|-------------|
| Default | — | Normal (platform default) | — |
| Edit | Additive | `+` indicator | Yes — always shown while in additive sub-mode |
| Edit | Subtractive | `-` indicator | Yes — always shown while in subtractive sub-mode |

Cursors are persistent within the sub-mode, not gesture-dependent. The user always knows which sub-mode they are in by looking at their cursor. This replaces the original design's "cursor only appears while modifier held during drag" with a always-visible mode indicator.

Cursor rendering is centralized — handled by the mode system, not by individual consumers. Implementation options:
- CSS `cursor: url()` on the Konva stage container div (simplest, no animation support)
- DOM overlay element tracking mouse position (matches existing scaffold drag ghost pattern, supports animation and zoom-independence)

Decision deferred to implementation. Both are viable; the architecture does not depend on the choice.

### Canvas behavior by mode

**Default mode (no changes from current behavior except zoom fix):**

| Gesture | Behavior |
|---------|----------|
| Drag piece | Spatial move — piece follows cursor |
| Ctrl+click piece | Start connection drag (existing) |
| Shift+click piece | Toggle multi-select (existing) |
| Shift+LMB on canvas | Lasso selection (existing) |
| Mousewheel | Zoom at pointer (changed — see prerequisite) |
| Drop piece on group | **No auto-merge** — spatial move only, group membership unchanged |

The only default mode change is removing auto-merge-on-drop. This is the same breaking change from the original ADR, but it is less disruptive now because edit mode provides a clear, discoverable alternative.

**Edit mode:**

| Gesture | Sub-mode | Target | Behavior |
|---------|----------|--------|----------|
| Drag piece | Additive | Over folder group | `+` cursor, group highlights, drop = merge into group |
| Drag piece | Additive | Over another piece | Future: nest / create group |
| Drag piece | Additive | Empty canvas | Spatial move (no structural change) |
| Drag piece | Subtractive | Piece is in a group | `-` cursor, group de-emphasizes, drop = extract from group |
| Drag piece | Subtractive | Piece is ungrouped | Spatial move (no structural change) |
| Click piece | Either | — | Select piece (same as default mode) |
| Tap Ctrl | — | — | Switch to additive sub-mode |
| Tap Alt | — | — | Switch to subtractive sub-mode |
| Pan/zoom | Either | — | Unchanged from default mode |

### Mode indicator (UI)

The user must always know which mode is active. Two indicators:

1. **Cursor** — persistent `+` or `-` in edit mode (described above). Absent in default mode.
2. **Status bar** — a text or pill indicator showing the current mode and sub-mode. Minimal: `Edit: Add` or `Edit: Remove`. Returns to empty or `Default` when edit mode is off.

Toolbar button is not required for v1 but the mode system should expose state that a future toolbar can read.

### Mode state architecture

Mode state lives in `interactionDomain` as an extension of the existing interaction controller:

```js
// interactionDomain extension
{
  lifecycle: {
    interactionMode: 'default' | 'edit',
    activeSubMode: 'additive' | 'subtractive',  // only meaningful when mode is 'edit'
  },
  commands: {
    toggleMode(),          // E key handler — flip between default and edit
    setSubMode(tokenId),   // Ctrl/Alt tap handler — switch sub-mode
  },
  selectors: {
    isEditMode(),
    activeActionToken(),   // returns token id or null (null in default mode)
  }
}
```

This extends `interactionDomain` rather than creating a new domain. The interaction controller already orchestrates all canvas gestures — mode is a natural addition to that orchestration layer.

### Extension API surface

Extensions read action token state with one hook. They never touch mode management, cursor rendering, or key detection:

```js
const { isActive } = useActionToken('additive');
// true when edit mode is on AND sub-mode is additive
// Extensions don't know about modes — they ask "is this intent active?"
```

If the user remaps the sub-mode toggle key, or if the mode system changes internals, extensions are unaffected. The token is the API boundary.

### User remapping

Two levels of remapping exposed in settings:

1. **Mode toggle key**: Default `E`, remappable to any single key.
2. **Sub-mode toggle keys**: Default `Ctrl` (additive) and `Alt` (subtractive), remappable.

Remapping keys does not change semantics. A user who cannot comfortably tap Alt remaps "subtractive" to another key. Extensions and internal consumers are unaffected.

## Prerequisite: Zoom input fix

The current zoom implementation (`WorkspaceStage.jsx:84-93`) gates zoom on `e.evt.ctrlKey`:

```js
if (e.evt.ctrlKey) {
  onZoomAtPoint(pointer.x, pointer.y, e.evt.deltaY);
} else if (onTrackpadPan) {
  onTrackpadPan({ deltaX: e.evt.deltaX, deltaY: e.evt.deltaY });
}
```

This is incorrect — zoom should be plain mousewheel, not Ctrl+mousewheel. The Ctrl gate was likely inherited from browser pinch-zoom conventions (browsers fire `wheel` events with `ctrlKey: true` for trackpad pinch gestures), but a desktop app with a canvas should zoom on any mousewheel input at the pointer position.

**Required change before implementing edit mode:** Mousewheel = zoom at pointer. Remove the `ctrlKey` gate. Trackpad pan detection (two-finger scroll without pinch) may need a separate heuristic — likely based on `deltaX !== 0` (trackpad scroll has horizontal component) vs `deltaX === 0` (mouse wheel is vertical-only). This is a small, isolated change in `WorkspaceStage.jsx` that should ship independently.

This prerequisite frees Ctrl from the viewport layer, which eliminates one row from the modifier contention table and simplifies the mental model: Ctrl is never a viewport modifier, only an interaction modifier.

## Prerequisite: Modifier detection consolidation

The codebase currently detects Ctrl/Cmd in three separate locations with identical logic:

1. `useKeyboardModifiers.js:18` — `ctrlKey || metaKey`
2. `App.jsx:167` — `isMac ? e.metaKey : e.ctrlKey`
3. `usePieceUiActions.js:78` — `isMac ? e?.evt?.metaKey : e?.evt?.ctrlKey`

Before building the mode system, consolidate platform-aware modifier detection into a single utility that reads from `platformDefaults.js` (ADR-011). The mode system, keyboard shortcut handler, and all existing interaction handlers should consume this utility. This prevents adding a fourth copy of the same logic and ensures the mode toggle key respects platform conventions (Cmd on macOS, Ctrl on Windows/Linux).

## Implementation Scope

### Phase 0 — Prerequisites (ship independently)
- **Zoom fix**: Remove `ctrlKey` gate from `WorkspaceStage.jsx` wheel handler. Implement mousewheel = zoom, trackpad two-finger = pan.
- **Modifier consolidation**: Extract platform-aware modifier detection utility from existing duplicated logic. Refactor existing consumers.
- **Alt key test**: Verify that `Alt` keydown events reach the Tauri webview on Windows without triggering menu bar focus. If Alt is intercepted, change the default subtractive binding to a safe alternative. This is a 5-minute manual test that prevents a late discovery.

### Phase 1 — Mode system (new)
- Mode state in `interactionDomain` (lifecycle, commands, selectors)
- `E` key toggle handler (registered in global keyboard handler, `App.jsx`)
- Mode indicator in status bar
- Mode-aware cursor rendering (centralized)
- Gate: mode toggle works, indicator displays, cursor changes on mode switch

### Phase 2 — Action tokens within edit mode (new)
- Token definitions (additive, subtractive)
- Sub-mode toggle handlers (Ctrl tap, Alt tap — only active in edit mode)
- `useActionToken` hook reading from `interactionDomain` selectors
- Binding map with user-facing settings for remapping
- Gate: sub-mode toggles work, cursor switches between + and -, hook returns correct state

### Phase 3 — Canvas interaction gating (modify existing)
- Remove auto-merge-on-drop from default mode: `handlePieceDragEnd` in `useCanvasInteractionController.js` no longer triggers `onPieceGroupDrop` on group overlap in default mode
- Gate group overlap detection (`updateDragOverGroup`) on edit mode + additive sub-mode
- Implement subtractive drag: dragging a grouped piece in subtractive sub-mode triggers `onPieceGroupDrop({ toGroupId: null })`
- Gate group highlight rendering on edit mode + additive sub-mode
- Gate: structural edits only happen in edit mode, default mode drag is always safe

**What does NOT change:**
- `handlePieceGroupDrop` in `App.jsx` — callback contract unchanged
- `filesystemWriteManager.js` — move pipeline unchanged
- `groupDomain.js` — group state mutations unchanged
- `reconcileGroupsWithFolders.js` — scaffold reconciliation unchanged
- Scaffold tree drag behavior — unaffected, scaffold uses its own interaction model
- Connection drag — unchanged, operates only in default mode
- Selection (click, multi-select, lasso) — unchanged in both modes

## Alternatives Considered

### Held-modifier action tokens (original ADR-013)
Hold Ctrl during drag = additive, hold Alt = subtractive. Rejected after gap analysis: Ctrl is overloaded with connection drag and multi-select in the same interaction context. Alt has Windows menu bar risk. Holding a modifier for extended reorganization sessions is physically uncomfortable. No discoverability path for new users.

### Context-sensitive Ctrl disambiguation
Ctrl+drag looks for group collision first; if no group detected, falls back to connection draw. Rejected: piece drag (piece follows cursor) and connection drag (piece stays, line extends) are physically different gestures that fork at mousedown. Cannot smoothly transition between them mid-drag. Prediction-based disambiguation feels fragile and erodes user trust.

### Hardcoded modifier checks per feature
Inline `event.ctrlKey` / `event.altKey` in each handler. Rejected: same reasons as original ADR — meanings drift, extensions reimplement everything, users cannot remap.

### No abstraction — just document conventions
Style guide saying "Ctrl means additive." Rejected: conventions without enforcement diverge.

### Command pattern with keybinding registry
Full command system for every interaction. Overkill for mode-scoped gesture semantics.

## Consequences

### Positive
- Eliminates accidental group membership from unintentional drops on dense canvases
- Plain drag in default mode is always safe — no breaking change anxiety
- Zero modifier key conflicts — each mode owns its key meanings exclusively
- Matches established UX conventions from design tools (mode-based tool switching)
- Discoverable — mode indicator in status bar + persistent cursor change make the mode visible
- Sub-mode toggles (tap, not hold) are physically comfortable for extended editing sessions
- Action token abstraction gives extensions a one-line API
- User remapping works for both mode toggle and sub-mode keys
- Integrates with existing platform config system (ADR-011) for OS-specific defaults
- New tokens (e.g., 'duplicate', 'link') can be added as sub-modes without changing existing consumers
- Prerequisite zoom fix improves default mode independently

### Negative
- Adds an interaction mode concept — users must learn that edit mode exists before they can organize groups via direct manipulation. Mitigated by status bar indicator, cursor change, and potential onboarding hint.
- Mode state is invisible if the user is not looking at the cursor or status bar. Mitigated: edit mode cursor is visually distinct (+ or - sign, not just an arrow variant).
- Over-engineering risk if the system never grows beyond additive/subtractive. Mitigated: the mode system is thin (one state variable + one toggle handler) and the action token layer is optional.

### Neutral
- Does not replace the existing keybinding system for discrete shortcuts (Ctrl+S, Ctrl+Z). The mode system governs gesture semantics (what does drag mean), not discrete commands.
- Does not affect scaffold tree interactions. Scaffold drag uses its own interaction model within the drawer panel.
- The mode toggle key (`E`) does not conflict with any existing shortcut (verified: current shortcuts are Ctrl+Z, Ctrl+Shift+Z, Ctrl+Y, Ctrl+0, Ctrl+Shift+0, Ctrl+P — all Ctrl-modified, `E` alone is unbound).

## Future Extensions

### Metadata inspection (edit mode click)
In edit mode, clicking a piece could display its backing data (SQLite record, file metadata). This is a natural extension — the mode system supports a "click handler per mode" pattern where default mode click = select and edit mode click = inspect. Not in scope for v1, but the architecture accommodates it without rework.

### Additional sub-modes
New action tokens (e.g., 'duplicate', 'link', 'reorder') can be added as sub-modes with their own toggle keys and cursor indicators. The token registry and `useActionToken` hook support arbitrary tokens — only the binding map and cursor assets need updating.

### Toolbar integration
A visual toolbar showing the current mode and available sub-modes. The mode system exposes all necessary state via `interactionDomain.selectors` — a toolbar component reads the same state as the status bar indicator.

## Addendum (2026-07-25) — Group-Structure Operations Join the Mode System

Owner decision (2026-07-25): group-level structural operations must be a
100% mirror of the node-level edit-mode actions ("add and remove just like
single nodes"). Until this addendum, the collapsed-pill nest/merge drop
(ADR-009's popover) remained reachable in **default** mode — contradicting
this ADR's "default mode drag is always safe" principle, and contradicting a
2026-06-17 code comment that already claimed nesting lived in edit mode (the
gating was believed present but never implemented; found 2026-07-25, journal
`.research/2026-07-25-fsm-breakdown.md`).

Delivered (PR #188):

- **Edit + additive** — dropping a collapsed group pill onto another group
  silently **nests** it (folder moves into the target, parent link set),
  mirroring node-add. No confirmation popover: the mode is the consent,
  exactly as with piece merges.
- **Edit + subtractive** — dragging a nested group **un-nests** it: its
  folder moves to the project root, mirroring node-extract-to-root.
- **Default mode** — pill drags are pure spatial moves. Group-overlap
  detection and the drag-over highlight are gated live on edit+additive,
  the same check piece drags use.
- **Merge** has no node-action mirror and is irreversible (dissolves the
  source group, deletes its folder), so it left the drag flow entirely: it
  is now an explicit "Merge Into" target list in the group context menu.
  ADR-009's GroupDropPopover is removed (ADR-009 superseded).

Disk work routes through `groupStructureOps` → FilesystemWriteManager
(PR #187); this addendum governs only the interaction grammar.

## References
- ADR-011: Runtime platform configuration (OS-specific modifier key defaults)
- ADR-009: Group drop popover — superseded 2026-07-25 by the addendum above
- Canvas domain: `src/domains/canvas/`
- Interaction controller: `src/behaviors/useCanvasInteractionController.js`
- Modifier state hook: `src/behaviors/useKeyboardModifiers.js`
- Platform defaults: `src/platform/platformDefaults.js`
