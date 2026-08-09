# RFC: Group Nest/Merge Disambiguation Popover

## Status
- Proposed (v2 — filesystem-first rewrite)

## Date
- 2026-03-19

## Owner
- Litria (solo)

## Summary
Add a disambiguation step when dragging a group pill onto another group on the canvas.
Instead of immediately nesting, show a popover with three options: **Nest inside**
(move folder into target), **Merge** (move files into target folder, delete source),
or **Cancel**.

Both operations are **filesystem-first** — files move on disk before group state
updates. This fixes an existing bug where canvas group nesting only sets `parentId`
in memory without moving the folder.

## Problem
Three related gaps exist today:

### 1. Canvas nest doesn't touch the filesystem (bug)
`handleGroupNestDrop` calls `groupDomain.commands.setParentGroup`, which sets
`parentId` in memory. The folder is **not** moved on disk. Meanwhile, the scaffold's
drag-and-drop calls `moveProjectPath` (Rust `fs::rename`) and correctly syncs piece
filenames, group membership, and the manifest. The canvas and scaffold diverge
immediately after a canvas nest.

### 2. No merge capability
There is no way to combine two groups' pieces into one group and delete the other.
Users must manually drag each piece, then delete the empty group.

### 3. No confirmation on canvas drop
Accidental nesting during drag requires undo. There is no visual confirmation of what
will happen before the action commits.

## Goals
1. Fix the canvas nest to perform a real filesystem move (parity with scaffold).
2. Add merge as a filesystem operation (move files, delete source folder).
3. Give users a clear choice between nesting and merging at the drop point.
4. Allow cancellation if the drop was accidental.
5. Comply with UI governance (ADR-007, ADR-008, ADR-009, `docs/ui-governance.md` §10).

## Non-Goals
1. Changing how scaffold drag-and-drop works (it's already correct).
2. Building a centralized filesystem write manager (see separate RFC).
3. Making filesystem moves reversible via Ctrl+Z.
4. Changing how single-piece drag-and-drop between groups works.
5. Batch operations on multiple groups.

## Design principle: filesystem is truth

The scaffold already follows this principle — `useScaffoldOperations.js` calls
`moveProjectPath` first, then updates piece filenames, group membership, and
refreshes the scaffold. Canvas operations must follow the same pattern:

```
Filesystem operation (Rust fs::rename)
  → Piece filename updates (updatePieceFilenames)
    → Group state updates (setParentGroup / mergeIntoGroup)
      → Manifest update (updatePieceFileMap)
        → Scaffold refresh (bumpScaffoldRefresh)
```

State is never updated before the filesystem confirms success.

## Proposed Design

### Existing pattern (scaffold — correct)

`useScaffoldOperations.js` `handleScaffoldDrop`:
1. `moveProjectPath(rootPath, sourcePath, destPath)` — Rust `fs::rename`
2. `collectAffectedPieces(...)` — find pieces under sourcePath
3. `syncGroupMembership(...)` — update group membership
4. `buildFilenameUpdates(...)` → `updatePieceFilenames` — update piece paths
5. `bumpScaffoldRefresh()` — re-read filesystem

### New: canvas nest (mirrors scaffold pattern)

When user clicks "Nest inside" in the popover:

1. Compute `destPath = targetGroup.folderPath + "/" + basename(sourceGroup.folderPath)`
2. `await moveProjectPath(rootPath, sourceGroup.folderPath, destPath)` — move folder
3. If fails → error notification, abort, clear pending state
4. Update piece filenames for all pieces in source group
5. `setParentGroup(sourceGroupId, targetGroupId)` + update `folderPath`
6. Update manifest, refresh scaffold

### New: canvas merge (filesystem-first)

When user clicks "Merge" in the popover:

1. For each piece in source group: compute dest as `targetGroup.folderPath + "/" + basename`
2. Move each file individually via `moveProjectPath`
3. Track successes/failures independently
4. Attempt to remove empty source directory
5. Update piece filenames for successfully moved pieces
6. `mergeIntoGroup(sourceGroupId, targetGroupId)` — state merge
7. Update manifest, refresh scaffold

### Error handling

- **Nest**: Single `fs::rename` — atomic on same filesystem. Fails or succeeds entirely.
- **Merge**: Individual file moves. Partial success is possible. State updated only
  for files that actually moved. Notification shows "Merged 3/5 files" on partial failure.
- **Both**: Never update group state before filesystem confirms.

### Undo limitations

Group state changes are reversible via history (Ctrl+Z). Filesystem moves are NOT
reversible. This matches existing behavior — scaffold moves are also not undoable
via Ctrl+Z. A future filesystem write manager could add rollback support.

### Interaction layer: pending state

`handleGroupNestDrop` stores `{ groupId, targetGroupId, screenX, screenY }` in
`pendingGroupDrop` state instead of calling domain commands directly.

`handleResolveGroupDrop(action)` is async — performs filesystem operations, then
updates state on success.

### Presentation layer: GroupDropPopover

shadcn Popover (ADR-009). `PopoverAnchor` with invisible div at drop coordinates.
Contextual label, two pill-styled buttons, cancel link. Disabled during filesystem
operation with "Moving files..." indicator.

### Data flow

```
Konva dragend
  → handleGroupPillDragEnd (useCanvasInteractionController.js)
    → onGroupNestDrop({ groupId, targetGroupId, screenX, screenY })
      → setPendingGroupDrop(...)  (App.jsx)
        → <GroupDropPopover> renders at drop point
          → user clicks "Nest inside" or "Merge"
            → handleResolveGroupDrop('nest' | 'merge')
              → moveProjectPath (filesystem)           ← DISK FIRST
                → updatePieceFilenames (state)
                  → setParentGroup / mergeIntoGroup (state)
                    → updatePieceFileMap (manifest)
                      → bumpScaffoldRefresh()
                        → setPendingGroupDrop(null)
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| File locked by editor during move | Medium | Medium | Monaco doesn't hold OS file locks. Rust `fs::rename` works on open files on Windows if no exclusive lock. |
| Merge partial failure leaves inconsistent state | Low | Medium | Track successes individually. State updated only for moved files. Notification explains what happened. |
| Empty source folder left after merge | Low | Low | New Tauri command `remove_empty_directory` — safe (fails if not empty). |
| Undo restores group state but not filesystem | Medium | Medium | Matches existing scaffold behavior. Document limitation. Future filesystem manager RFC addresses this. |
| `folderPath` not updated alongside `parentId` | Fixed | High | Brief adds `setFolderPath` command to groupDomain. Both called in sequence. |
| Popover dismissed during async operation | Low | Medium | Disable dismiss while `isResolving` is true. |

## Open Questions

### 1. Folder deletion after merge
After moving all files from source group's folder, should we delete the empty folder?
- **Recommended**: Yes, via a new `remove_empty_directory` Tauri command (safe — Rust
  `fs::remove_dir` fails if not empty).

### 2. Non-piece files in source folder
If the source folder contains files that aren't pieces (e.g. `__init__.py`, `.gitkeep`),
merge moves only piece files. The folder won't be empty and won't auto-delete.
- **Recommended**: Show notification "Folder not empty — some files were not moved."
  User can clean up manually via scaffold.

### 3. Groups without `folderPath`
If a group has no `folderPath` (ad-hoc group created without a folder), filesystem
operations can't apply.
- **Recommended**: If either group lacks `folderPath`, fall back to state-only
  operation (current behavior). Show a subtle indicator that no files were moved.

## Alternatives Considered

1. **Build filesystem write manager first**: Correct architecturally but delays the
   feature. The manager RFC exists for future extraction. Current approach uses the
   same primitives the scaffold already uses — no new patterns introduced.

2. **Always nest, add merge to context menu**: Buries merge. Users wouldn't discover it.

3. **Modifier key (Shift+drop)**: Less discoverable. Conflicts with multi-select.

4. **Auto-detect based on hierarchy**: Removes user agency.

5. **Full modal dialog**: Overkill for a two-option choice.

## Implementation Sequence
Detailed in `docs/plans/group-nest-merge-implementation.md`.

## References
- ADR-007: Adopt shadcn/ui for Interactive Primitives
- ADR-008: Protected Zones — shadcn Exclusions
- ADR-009: GroupDropPopover Uses shadcn Popover
- RFC: Filesystem Write Manager (future extraction)
- `docs/ui-governance.md` — Sections 4.3 (pills), 10.2 (shadcn styling contract)
- `src/app/useScaffoldOperations.js` — Existing filesystem move pattern (reference implementation)
