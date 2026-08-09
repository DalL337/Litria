# Single File Open — Fix Plan

**Status: COMPLETE** -- Fixed. Closed 2026-03-07.

## Problem

Opening a single file via Launch Screen > Open > File loads the previous project's
canvas state when the file's parent directory contains a `litria.project.json`.

### Root Cause

`handleOpenFileInstance` sets `projectInstance.rootPath` to the parent directory of
the selected file. The persistence effect in `useProjectPersistence.js` (line 122)
fires on any `projectInstance` change, calls `loadWorkspaceState({ rootPath })`,
finds the old manifest, and overwrites the single-piece state with the full
project's pieces/groups/viewport.

### Affected Files

| File | Role |
|------|------|
| `src/app/useProjectLaunch.js` | Creates the file-mode instance (lines 150-211) |
| `src/project/useProjectPersistence.js` | Restore effect (line 122), persist effects (lines 189, 261) |
| `src/project/projectDomain.js` | `loadWorkspaceState` / `loadEditorState` read manifest by rootPath |
| `src/drawers/DrawerContentScaffold.jsx` | Lists full parent dir tree via `listTree(rootPath)` |

## Fix Strategy

### 1. Guard persistence restore in file mode

**Where**: `useProjectPersistence.js`, effect at line 122

**What**: Skip `loadWorkspaceState` when `projectInstance.manifestPath === null`.
The single piece created by `handleOpenFileInstance` is the intended state —
there is nothing to restore.

Same guard on the editor restore effect (line 166): skip `loadEditorState`.

### 2. Guard persistence writes in file mode

**Where**: `useProjectPersistence.js`, effects at lines 189 and 261

**What**: Skip `persistWorkspaceState` and `persistEditorState` when
`manifestPath === null`. Prevents writing a `litria.project.json` into an
arbitrary directory that happens to be the file's parent.

### 3. Scope the scaffold drawer for file mode

**Where**: `DrawerContentScaffold.jsx`

**What**: When in file mode (`manifestPath === null`), show a minimal tree:
- Parent directory name as a label/root
- Only files that are currently on the canvas (from `pieces`)
- As user adds nodes, they appear in the tree

Fall back to current `listTree(rootPath)` behavior for project mode.

### 4. Center the piece in the viewport

**Where**: `useProjectLaunch.js`, `handleOpenFileInstance`

**What**: Instead of hardcoded `(220, 180)`, compute center from current
viewport transform so the piece lands in the visible center. Requires
access to viewport state (scale, offsetX, offsetY) and container dimensions.

Low priority — cosmetic, not blocking.

## Sequence

| Step | Scope | Risk | Notes |
|------|-------|------|-------|
| 1 | Restore guard | Low | Pure guard, no behavior change for project mode |
| 2 | Write guard | Low | Prevents unintended side effect |
| 3 | Scaffold drawer | Medium | Needs a conditional rendering path |
| 4 | Viewport centering | Low | Cosmetic improvement |

## Validation

- Open a file whose parent dir has a `litria.project.json` — should see only the single file piece
- Open a file from a dir with no manifest — same single file piece
- Confirm no `litria.project.json` gets written to the parent dir after edits
- Scaffold drawer shows only the opened file, not the full directory listing
- Open an existing Litria project after a file-mode session — project restores normally
- Dirty status, save, and teardown all work in file mode

## Future Considerations

- Explicit `mode: 'file' | 'project'` field on projectInstance (cleaner than inferring from manifestPath)
- Organic node addition in file mode — allow adding files from anywhere on disk
- Whether file-mode sessions should persist across app restarts
