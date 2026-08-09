# Idea: Central Shortcut Registry

**Status**: Captured (2026-07-01, during the feedback #7 menubar buildout). Not scheduled.

## Problem

Keyboard shortcuts live in three disconnected places:

1. **Bindings** — ad-hoc `window.addEventListener('keydown')` effects:
   - `src/App.jsx` (undo/redo, fit content/selection, find node Ctrl+P, select all Ctrl+A)
   - `src/components/EditorDrawer.jsx` (capture-phase Ctrl+S / Ctrl+Shift+S)
   - `src/app/interactionDomain.js` (`E` edit-mode toggle, Ctrl/Alt sub-mode taps)
2. **Labels** — `shortcutLabels` per-OS strings in `src/platform/platformDefaults.js`.
3. **Display** — menu items in `src/components/menuBarItems.js` referencing labels.

Nothing forces (1) and (2) to agree. The `palette: Ctrl+K` label shipped for months
with no binding behind it (removed 2026-07-01). The current guard is indirect: a
domain test asserts every builder-emitted shortcut exists in `shortcutLabels`, but
nothing verifies a label matches its actual keydown handler.

## Sketch

A single registry mapping `actionId → { keys (per-OS), label (per-OS), handler-ref }`:

- One module registers bindings (single keydown listener, editable-target guard,
  Monaco/xterm exclusions in one place).
- `shortcutLabels` becomes derived output, not hand-maintained.
- Menu builders reference `actionId`, not label strings.
- Guard test: every registered action either has a menu item or is explicitly
  marked chord-only.

## Constraints

- ADR-013: no `Alt+` accelerators (Windows menu-focus risk); `E`/Ctrl/Alt taps in
  interactionDomain are modal gestures, not accelerators — they may stay outside
  the registry.
- EditorDrawer's save listener is capture-phase on purpose (beats Monaco). The
  registry needs a capture opt-in per action.

## Trigger to revisit

Next time a shortcut is added/changed and the label drifts, or when split-view
(feedback #10) lands with its own bindings.
