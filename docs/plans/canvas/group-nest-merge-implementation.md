# Group Nesting & Merging — Implementation Brief

> **Status**: Implemented, not shipped — blocked on known limitations (see bottom)
> **Date**: 2026-03-19
> **Governance**: ADR-007, ADR-008, ADR-009, `docs/ui-governance.md` §10
> **RFC**: `docs/rfcs/group-nest-merge-popover.md`

---

## Overview

When a user drags a group pill onto another group on the canvas, a popover appears
offering **Nest inside**, **Merge**, or **Cancel**.

**Critical design principle**: The filesystem is the source of truth. Both nest and
merge are filesystem operations first, with group state updated to reflect the result.
This matches how the scaffold already works — `useScaffoldOperations.js` calls
`moveProjectPath` and then syncs group membership and piece filenames.

The current canvas group pill drag (`handleGroupNestDrop` → `setParentGroup`) is
**broken** — it sets `parentId` in memory without moving the folder on disk. This
brief fixes that gap and adds merge on the same foundation.

Five tasks, executed in order:

---

## Task 0 — Prerequisite: understand the existing filesystem pattern

### How scaffold moves work today

`useScaffoldOperations.js` lines 94-130 (`handleScaffoldDrop`):

```
1. moveProjectPath(rootPath, sourcePath, destPath)    — Rust fs::rename
2. collectAffectedPieces(...)                         — find pieces whose filenames fall under sourcePath
3. syncGroupMembership(...)                           — remove from old group, add to new group if destPath matches a group's folderPath
4. buildFilenameUpdates(...) → updatePieceFilenames   — update piece.filename to reflect new path
5. bumpScaffoldRefresh()                              — force scaffold tree to re-read filesystem
```

`useGroupMenuActions.js` lines 135-169 (group creation):

```
1. Create the group in state (groupDomain.commands.createFolderGroup)
2. For each piece: moveProjectPath(rootPath, currentPath, newFolderPath/basename)
3. If move fails: writeProjectFile as fallback
4. updatePieceFilenames(moved)
5. updateTabFilename for each moved piece
6. queueManifestCommand → projectDomain.commands.updatePieceFileMap
7. bumpScaffoldRefresh()
```

Both patterns share: filesystem move → piece filename update → group state update → scaffold refresh.

### What the canvas nest does today (BROKEN)

`App.jsx` line 760-762:

```js
const handleGroupNestDrop = useCallback(({ groupId, targetGroupId }) => {
  groupDomain.commands.setParentGroup(groupId, targetGroupId);
}, [groupDomain]);
```

This sets `parentId` in memory but:
- Does NOT move the folder on disk
- Does NOT update piece filenames
- Does NOT update the manifest
- Does NOT refresh the scaffold

The filesystem and canvas drift apart immediately.

---

## Task 1 — `groupDomain.js`: add `mergeIntoGroup` command

### What

Add `mergeIntoGroup(fromGroupId, intoGroupId)` to `groupDomain.commands`.

This is the **state-only** half of merge. It updates the groups array after the
filesystem move has already succeeded. The filesystem move happens in the caller
(Task 3's `handleResolveGroupDrop`).

### Behavior

1. Find both groups in the array. If either is missing, return early.
2. Compute the merged `pieceIds`: target's pieces + source's pieces, deduplicated
   via `Set`.
3. Reparent any groups whose `parentId === fromGroupId` to `intoGroupId`.
4. Update target group's `pieceIds` to the merged set.
5. Remove the source group from the array.
6. All in a single `applyGroupsUpdate` call.

### History

- Label: `'Merge folder groups'`
- `withHistory: true` (default) — undo restores the source group and its pieces.

### Guards

- `if (!fromGroupId || !intoGroupId || fromGroupId === intoGroupId) return;`

### Implementation sketch

```js
mergeIntoGroup(fromGroupId, intoGroupId) {
  if (!fromGroupId || !intoGroupId || fromGroupId === intoGroupId) return;
  applyGroupsUpdate({
    label: 'Merge folder groups',
    update: (prev) => {
      const source = prev.find((g) => g.id === fromGroupId);
      const target = prev.find((g) => g.id === intoGroupId);
      if (!source || !target) return prev;
      const mergedIds = [...new Set([...target.pieceIds, ...source.pieceIds])];
      return prev
        .filter((g) => g.id !== fromGroupId)
        .map((g) => {
          if (g.id === intoGroupId) return { ...g, pieceIds: mergedIds };
          if (g.parentId === fromGroupId) return { ...g, parentId: intoGroupId };
          return g;
        });
    }
  });
}
```

### Tests to validate

- Merge two groups with overlapping pieceIds → no duplicates.
- Merge a group that has children → children reparented to target.
- Self-merge → no-op.
- Missing group ID → no-op.
- Undo restores source group, pieces, and children's parentId values.

---

## Task 2 — `App.jsx`: intercept `handleGroupNestDrop` with pending state

### What

Replace the immediate `setParentGroup` call with a pending state that defers the
action until the user resolves via the popover.

### State

```js
const [pendingGroupDrop, setPendingGroupDrop] = useState(null);
// shape: { groupId, targetGroupId, screenX, screenY } | null
```

### Changes to `handleGroupNestDrop`

```js
const handleGroupNestDrop = useCallback(({ groupId, targetGroupId, screenX, screenY }) => {
  if (groupId === targetGroupId) return;
  setPendingGroupDrop({ groupId, targetGroupId, screenX, screenY });
}, []);
```

### Threading screen coordinates

`useCanvasInteractionController.js` line 488 currently calls:

```js
onGroupNestDrop({ groupId, targetGroupId: nestTargetId });
```

Extend to include pointer screen position. Capture `clientX`/`clientY` from the
Konva event's native PointerEvent during `handleGroupPillDragMove` into a
`lastPointerScreenRef`, then read it in `handleGroupPillDragEnd`:

```js
const nestTargetId = dragOverGroupRef.current;
if (nestTargetId && onGroupNestDrop) {
  onGroupNestDrop({
    groupId,
    targetGroupId: nestTargetId,
    screenX: lastPointerScreenRef.current?.x ?? 0,
    screenY: lastPointerScreenRef.current?.y ?? 0
  });
}
```

### Drag highlight persistence

While `pendingGroupDrop` is set, the target group highlight should persist.
Derive from `pendingGroupDrop.targetGroupId` in render logic, decoupled from
`dragOverGroupId`.

---

## Task 3 — `App.jsx`: filesystem-first `handleResolveGroupDrop`

### What

This is the core logic. When the user clicks Nest or Merge in the popover,
**move files on disk first**, then update state to match.

### Dependencies needed in scope

The resolver needs access to the same utilities the scaffold uses:
- `moveProjectPath` — Rust `fs::rename` via Tauri invoke
- `piecesById` — to look up `piece.filename` for each piece in the group
- `normalizePath`, `getBasename` — path utilities
- `pieceDomain.commands.updatePieceFilenames` — update piece filename state
- `updateTabFilename` — update open editor tabs
- `queueManifestCommand` / `projectDomain.commands.updatePieceFileMap` — persist filename changes
- `bumpScaffoldRefresh` — force scaffold re-read
- `projectInstance.rootPath` — project root

These are all already available in App.jsx or passed to existing hooks.

### Nest resolution: filesystem-first

```
User clicks "Nest inside" (group A into group B):

1. Compute paths:
   - sourcePath = groupA.folderPath           (e.g. "random")
   - destPath   = groupB.folderPath + "/" + basename(groupA.folderPath)
                                              (e.g. "src/random")

2. Move folder on disk:
   - await moveProjectPath(rootPath, sourcePath, destPath)
   - If fails → show error pill notification, abort, clear pending state

3. Update piece filenames:
   - For each piece in groupA: compute new filename under destPath
   - pieceDomain.commands.updatePieceFilenames(updates)
   - updateTabFilename for each affected piece

4. Update group state:
   - groupDomain.commands.setParentGroup(groupA.id, groupB.id)
   - Update groupA's folderPath to destPath
   - (Need a new groupDomain command or extend rename to handle folderPath update)

5. Update manifest:
   - queueManifestCommand → projectDomain.commands.updatePieceFileMap

6. Refresh scaffold:
   - bumpScaffoldRefresh()

7. Clear pending state:
   - setPendingGroupDrop(null)
```

### Merge resolution: filesystem-first

```
User clicks "Merge" (group A into group B):

1. Compute paths:
   - For each piece in groupA:
     - sourcePath = piece.filename             (e.g. "random/daddy.py")
     - destPath   = groupB.folderPath + "/" + basename(piece.filename)
                                               (e.g. "src/daddy.py")

2. Move files on disk (one by one):
   - For each piece: await moveProjectPath(rootPath, sourcePath, destPath)
   - If any fails: log error, skip that piece, continue with others
   - Track which pieces moved successfully

3. Delete source folder if empty:
   - After all pieces moved, attempt to remove the now-empty source folder
   - Need a Tauri command for rmdir (or check if moveProjectPath handles this)
   - If folder not empty (had non-piece files), leave it — don't force delete

4. Update piece filenames:
   - For successfully moved pieces: updatePieceFilenames + updateTabFilename

5. Update group state:
   - groupDomain.commands.mergeIntoGroup(groupA.id, groupB.id)
   - (This handles pieceId merge, child reparenting, and source group deletion)

6. Update manifest:
   - queueManifestCommand → projectDomain.commands.updatePieceFileMap

7. Refresh scaffold:
   - bumpScaffoldRefresh()

8. Clear pending state:
   - setPendingGroupDrop(null)
```

### Error handling strategy

**Atomic intent, graceful partial failure:**

- **Nest** moves a single folder → atomic by nature (`fs::rename` is atomic on
  the same filesystem). If it fails, nothing changes. Show error notification.
- **Merge** moves individual files → can partially succeed. Track successes,
  update state only for files that actually moved. If some fail, show a
  notification like "Merged 3/5 files — 2 failed (permission denied)".
- **Never update group state before filesystem confirms success.**
- **Undo caveat**: History undo restores group state but does NOT undo filesystem
  moves. This matches existing behavior — scaffold moves are also not reversible
  via Ctrl+Z. Document this clearly.

### Implementation sketch

```js
const handleResolveGroupDrop = useCallback(async (action) => {
  if (!pendingGroupDrop) { setPendingGroupDrop(null); return; }
  const { groupId, targetGroupId } = pendingGroupDrop;
  const rootPath = projectInstance?.rootPath;

  if (action === 'cancel' || !rootPath) {
    setPendingGroupDrop(null);
    return;
  }

  const sourceGroup = groups.find(g => g.id === groupId);
  const targetGroup = groups.find(g => g.id === targetGroupId);
  if (!sourceGroup?.folderPath || !targetGroup?.folderPath) {
    setPendingGroupDrop(null);
    return;
  }

  if (action === 'nest') {
    await performNest(sourceGroup, targetGroup, rootPath);
  } else if (action === 'merge') {
    await performMerge(sourceGroup, targetGroup, rootPath);
  }

  setPendingGroupDrop(null);
}, [pendingGroupDrop, groups, projectInstance, /* ...other deps */]);
```

The `performNest` and `performMerge` helpers contain the filesystem logic
outlined above. They can be extracted to a separate file (e.g.
`src/app/useGroupFilesystemOps.js`) to keep App.jsx clean.

### Open question: folder deletion after merge

After merge moves all files from group A's folder into group B's folder, the
source folder may be empty. Options:

- **A**: Add a Tauri command `remove_empty_directory(rootPath, relativePath)` that
  deletes the directory only if empty. Safe and explicit.
- **B**: Leave the empty folder. The scaffold shows it, user can delete manually.
- **C**: Use existing `deleteProjectPath` if it exists.

**Recommendation**: Option A. An empty folder after merge is confusing. The Rust
side is trivial (`fs::remove_dir` fails if not empty — safe by default).

### Open question: `folderPath` update on nest

`setParentGroup` sets `parentId` but does not update `folderPath`. After nesting
group A into group B and moving `random/` to `src/random/`, the group's
`folderPath` must change from `"random"` to `"src/random"`. Options:

- **A**: Add a `setFolderPath(groupId, newPath)` command to groupDomain.
- **B**: Extend `setParentGroup` to accept an optional `folderPath` parameter.
- **C**: Combine into a single `nestGroup(groupId, parentId, folderPath)` command.

**Recommendation**: Option A. Keep commands single-responsibility. Call
`setParentGroup` then `setFolderPath` in sequence within the same resolver.

---

## Task 4 — `GroupDropPopover.jsx`: shadcn Popover disambiguation UI

### Technology decision

Per ADR-008 decision rubric → shadcn Popover. See ADR-009 for full rationale.

### Component location

`src/components/GroupDropPopover.jsx`

### Props

```js
{
  pendingGroupDrop,      // { groupId, targetGroupId, screenX, screenY } | null
  onResolve,             // (action: 'nest' | 'merge' | 'cancel') => void
  groups,                // groups array — for displaying group names
  isResolving            // boolean — true while filesystem operation is in progress
}
```

### Anchor strategy

`PopoverAnchor` with invisible `position: fixed` div at `{screenX, screenY}`.
Already exported from `src/components/ui/popover.jsx` (line 39). Radix handles
viewport clamping.

```jsx
<Popover open={!!pendingGroupDrop} onOpenChange={(open) => !open && onResolve('cancel')}>
  <PopoverAnchor asChild>
    <div
      style={{
        position: 'fixed',
        left: pendingGroupDrop?.screenX ?? 0,
        top: pendingGroupDrop?.screenY ?? 0,
        width: 1,
        height: 1,
        pointerEvents: 'none'
      }}
    />
  </PopoverAnchor>
  <PopoverContent side="bottom" align="start" sideOffset={8}>
    {/* content */}
  </PopoverContent>
</Popover>
```

### Content layout

```
┌──────────────────────────────┐
│  Move "random" into "src"    │  ← contextual label (source → target names)
│                              │
│  ┌────────────┐ ┌──────────┐│
│  │ Nest inside│ │  Merge   ││  ← pill-styled action buttons
│  └────────────┘ └──────────┘│
│           Cancel             │  ← text button, muted
└──────────────────────────────┘
```

When `isResolving` is true, disable buttons and show a subtle loading indicator
(e.g. muted "Moving files..." text replacing the contextual label).

### Styling contract (per `docs/ui-governance.md` §10.2)

| Property | Value | Source |
|---|---|---|
| Surface | `rgba(24, 24, 24, 0.96)` | Litria glass-morphic |
| Backdrop | `backdrop-filter: blur(10px)` | §10.2 |
| Border | `1px solid rgba(212, 212, 212, 0.28)` | §10.2 |
| Border radius | `14px` | §10.2 card panels |
| Z-index | `60` | PopoverContent default |
| Transitions | `--cm-transition-fast` (150ms ease) | §10.2 |

### Button styling

`--cm-pill-*` token system (governance §4.3):

| Button | Variant | Tokens |
|---|---|---|
| **Nest inside** | Primary pill | `--cm-pill-primary-bg/border/color` |
| **Merge** | Default pill | `--cm-pill-border/bg/color` |
| **Cancel** | Text-only | `--cm-text-muted` |

### Dismiss behavior

- **Escape / click outside** → `onResolve('cancel')` via Radix `onOpenChange`
- **Disabled while resolving** — prevent dismiss during filesystem operation

### Accessibility

Radix Popover provides: focus trap, `role="dialog"`, Escape handling, focus restoration.

---

## Execution order

```
Task 1  — groupDomain.js: mergeIntoGroup command (state-only)
  ↓
Task 2  — App.jsx: pending state + screen coordinate threading
  ↓
Task 3  — App.jsx (or extracted hook): filesystem-first resolve handlers
  ↓
Task 4  — GroupDropPopover.jsx: popover UI
  ↓
Manual QA:
  - Nest via canvas → folder moves on disk → scaffold reflects → undo restores state
  - Merge via canvas → files move on disk → source folder deleted → scaffold reflects
  - Cancel → nothing happens
  - Nest via scaffold drag → still works as before (unchanged path)
  - Error: lock a file, attempt merge → partial failure notification
```

## Files touched

| File | Change |
|---|---|
| `src/app/groupDomain.js` | Add `mergeIntoGroup` + `setFolderPath` commands |
| `src/App.jsx` | `pendingGroupDrop` state, `handleResolveGroupDrop` (async, filesystem-first) |
| `src/behaviors/useCanvasInteractionController.js` | Thread `screenX`/`screenY` into `onGroupNestDrop` |
| `src/components/GroupDropPopover.jsx` | New file |

### Possibly touched

| File | Change | Condition |
|---|---|---|
| `src/app/useGroupFilesystemOps.js` | New file — extracted `performNest`/`performMerge` helpers | If App.jsx gets too long |
| `src-tauri/src/project_ops.rs` | Add `remove_empty_directory` command | If we choose folder cleanup (Task 3, Open Question) |

## Files NOT touched

| File | Reason |
|---|---|
| `src/app/useScaffoldOperations.js` | Scaffold path unchanged — it already works |
| `src/components/ui/popover.jsx` | Used as-is |
| `src/styles/tokens.css` | All tokens already defined |

## Undo limitations

**Group state** is fully reversible via Ctrl+Z (history captures before/after).
**Filesystem moves** are NOT reversible via Ctrl+Z. This matches existing behavior —
scaffold drag-and-drop moves are also not undoable. A future filesystem write
manager (see `docs/rfcs/filesystem-write-manager.md`) could add rollback support,
but that is out of scope for this feature.

---

## Known limitations — blocking ship (2026-03-19)

### 1. Merge deletes group state but scaffold/OS can recreate the folder

**Scenario**: User merges group A into group B. Files move, folder A deleted, group A
removed from state. User then recreates folder A in scaffold or File Explorer and
drags files back into it. Canvas does not recognize the folder as a group — pieces
appear orphaned with no group outline.

**Root cause**: Groups are only created through the "Create Folder Group" UI flow.
The scaffold's `syncGroupMembership` can move pieces between **existing** groups but
cannot create new groups from folders. There is no reconciliation between filesystem
folders and group state.

**Impact**: After a merge, the inverse operation (recreating the source group) requires
the user to manually create a new folder group — dragging files back into a recreated
folder is not sufficient.

**Resolution path**: The filesystem write manager RFC (`docs/rfcs/filesystem-write-manager.md`)
would provide a centralized reconciliation layer. Alternatively, a lighter fix would
be adding group-from-folder detection in `syncGroupMembership` — when a piece's
new parent directory matches no existing group's `folderPath`, auto-create a group.

### 2. Nested groups have no visual representation on canvas

**Scenario**: User nests group A into group B via the popover. The folder moves on
disk, `parentId` is set correctly, scaffold reflects the hierarchy. But the canvas
renders both groups as flat peers — there is no visual indicator of the parent-child
relationship.

**Root cause**: The canvas has no rendering vocabulary for nested groups (indentation,
containment, visual hierarchy). `parentId` is stored and persisted but not consumed
by any canvas rendering logic.

**Impact**: Nest operation works correctly at the filesystem and state level, but the
user gets no visual feedback on the canvas that nesting occurred.

**Resolution path**: Separate design task — nested group rendering on canvas. Not
part of this implementation scope.

### 3. Pre-existing: lasso tool drag state leaks to screen pan

**Scenario**: After using the lasso tool to create a selection and folder group,
mouse movement drags the screen. Unrelated to this implementation — pre-existing
interaction controller bug.

**Resolution path**: Investigate drag state cleanup in `useCanvasInteractionController`
after lasso selection completes.
