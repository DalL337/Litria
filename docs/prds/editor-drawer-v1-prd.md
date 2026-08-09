# Editor Drawer v1 PRD

## Overview
Litria adds a dedicated editor drawer for piece-based file editing.  
The editor is file-first (`filename`), lazy-mounts Monaco, supports multi-tab workflows, and preserves unsaved work across crashes/restarts.

## Goals
- Provide IDE-like code editing for selected puzzle pieces.
- Keep editing state per file (`code`, `workingCode`, dirty tracking).
- Support multi-select editing with sorted tabs.
- Persist saves to both Litria piece state and project files.
- Recover unsaved work after crash/restart.

## Non-Goals (v1)
- Full multi-language LSP implementation (Python-first path planned separately).
- Advanced project explorer integration.
- Prompting on drawer close (drawer close is hide-only).

## Interaction Model
- Editor rail/tab appears only when one or more pieces are selected.
- Double-click on a piece opens editor drawer immediately.
- Opening editor rebuilds tabs from current selection.
- Tabs are sorted alphabetically by `filename`.
- Tab titles always show `filename` (never `label`).
- Max open tabs: 8.

## Drawer Behavior
- Drawer width: 75-80% of Desk space.
- Drawer overlays artboard and uses drawer system patterns for future transparency settings.
- Closing drawer does not prompt save.
- Closing drawer preserves open tabs and in-memory session state.

## Editor Behavior
- Monaco lazy-mounts on first open.
- Monaco remains mounted after first initialization.
- Brand-new empty files receive first-line filename header comment.
- Unknown language uses fallback comment syntax.

## Data Model and Save Semantics
- `code`: last saved file content.
- `workingCode`: active unsaved editor content.
- Dirty state rule: `workingCode !== code`.
- Dirty tab style: italic filename + dot indicator.
- Save writes to:
  1) piece state (`code`) and
  2) project file on disk.

## Tab Close and Exit Prompts
- Closing clean tab via `X`: close immediately.
- Closing dirty tab via `X`: prompt `Save / Discard / Cancel` for that tab only.
- App exit with dirty files: prompt `Save / Discard / Cancel`.

## Selection and Tab Session Rules
- Deselection does not auto-close open tabs.
- Reopening/rebuilding editor tabs uses current selection.
- Open-tab set should not bleed between project instances.

## Recovery
- Crash/restart restores unsaved `workingCode`.
- Restore tab order and active tab where possible.
- Recovery state is project-instance scoped.
