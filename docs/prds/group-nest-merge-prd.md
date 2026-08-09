# Product Requirements Document: Group Nest & Merge

**PRD-GNM-001 | Version 1.0 | March 20, 2026**

| Field | Value |
|---|---|
| Document ID | PRD-GNM-001 |
| Version | 1.0 |
| Date | March 20, 2026 |
| Status | Proposed — implementation complete, not shipped (blocked on known limitations) |
| Project | Litria |
| Component | Canvas group pill drag disambiguation (nest/merge popover) |
| Tech Stack | React (shadcn Popover), Tauri (Rust filesystem ops) |
| Prerequisites | ADR-007, ADR-008, ADR-009, ADR-010 |

---

## 1. Purpose and Scope

### 1.1 Purpose

When a user drags a group pill onto another group on the canvas, provide a disambiguation popover with three options: **Nest inside** (move folder into target as subdirectory), **Merge** (move files into target folder, delete source), or **Cancel**. Both operations are filesystem-first — files move on disk before group state updates.

### 1.2 Problems Solved

1. **Canvas nest is broken**: `handleGroupNestDrop` sets `parentId` in memory but does not move the folder on disk. The filesystem and canvas diverge immediately.
2. **No merge capability**: Users cannot combine two groups' contents without manually dragging each piece.
3. **No drop confirmation**: Accidental nesting during drag requires undo, with no visual confirmation of what will happen.

### 1.3 Scope

- Canvas group-to-group drag disambiguation (nest, merge, cancel)
- Filesystem-first operations matching the existing scaffold pattern
- New `mergeIntoGroup` and `setFolderPath` commands in `groupDomain.js`
- New `remove_empty_directory` Tauri command for post-merge cleanup
- GroupDropPopover component (shadcn Popover per ADR-009)

### 1.4 Out of Scope

- Scaffold drag-and-drop changes (already correct)
- Filesystem undo (Ctrl+Z restores group state only, not files — matches existing behavior)
- Single-piece drag-and-drop between groups
- Batch operations on multiple groups simultaneously
- Nested group visual representation on canvas (separate design task)
- Centralized filesystem write manager (separate PRD, future extraction)

---

## 2. User Stories

### US-1: Nest a group inside another
**As a** Litria user, **I want to** drag a group pill onto another group and choose "Nest inside," **so that** the source folder moves inside the target folder on disk, and the canvas reflects the parent-child relationship.

### US-2: Merge two groups
**As a** Litria user, **I want to** drag a group pill onto another group and choose "Merge," **so that** all source files move into the target folder, the source group is deleted, and I have one combined group.

### US-3: Cancel an accidental drop
**As a** Litria user, **I want to** cancel a group-to-group drop, **so that** nothing changes if I dropped accidentally.

### US-4: Understand partial failure
**As a** Litria user, **when** a merge partially fails (some files can't move), **I want to** see which files succeeded and which failed, **so that** I can resolve the issue manually.

---

## 3. Design Principle: Filesystem Is Truth

The scaffold already follows this principle. Canvas operations must match:

```
Filesystem operation (Rust fs::rename)
  -> Piece filename updates (updatePieceFilenames)
    -> Group state updates (setParentGroup / mergeIntoGroup)
      -> Manifest update (updatePieceFileMap)
        -> Scaffold refresh (bumpScaffoldRefresh)
```

State is never updated before the filesystem confirms success.

---

## 4. Product Requirements

### 4.1 Interaction Flow

#### 4.1.1 Trigger

User drags a group pill and releases it over another group pill on the canvas. The interaction controller detects the drop target and fires `onGroupNestDrop` with `{ groupId, targetGroupId, screenX, screenY }`.

#### 4.1.2 Pending State

Instead of immediately modifying state, the drop handler stores the pending operation:

```js
setPendingGroupDrop({ groupId, targetGroupId, screenX, screenY });
```

The target group's drag highlight persists while the popover is open.

#### 4.1.3 Popover

A shadcn Popover (ADR-009) appears at the drop coordinates with:

```
+------------------------------+
|  Move "random" into "src"    |  <- contextual label (source -> target names)
|                              |
|  +------------+ +----------+ |
|  | Nest inside| |  Merge   | |  <- pill-styled action buttons
|  +------------+ +----------+ |
|           Cancel              |  <- text button, muted
+------------------------------+
```

#### 4.1.4 Resolution

User clicks an action. The resolver performs the filesystem operation, then updates state on success. During the operation, buttons are disabled and the label shows "Moving files..."

#### 4.1.5 Dismiss

- Escape or click outside -> cancel (via Radix `onOpenChange`)
- Dismiss is blocked while a filesystem operation is in progress (`isResolving`)

### 4.2 Nest Operation

When user clicks "Nest inside" (group A into group B):

1. Compute `destPath = groupB.folderPath + "/" + basename(groupA.folderPath)`
2. `await moveProjectPath(rootPath, groupA.folderPath, destPath)`
3. If fails -> error notification, abort, clear pending state
4. Update piece filenames for all pieces in group A (prefix replacement)
5. Update tab filenames for any open tabs showing moved files
6. `setParentGroup(groupA.id, groupB.id)` — set parent-child relationship
7. `setFolderPath(groupA.id, destPath)` — update stored folder path
8. Queue manifest update (`updatePieceFileMap`)
9. Refresh scaffold (`bumpScaffoldRefresh`)
10. Clear pending state

**Atomicity**: `fs::rename` is atomic on the same filesystem. The entire folder moves or nothing moves.

### 4.3 Merge Operation

When user clicks "Merge" (group A into group B):

1. For each piece in group A:
   - Compute `destPath = groupB.folderPath + "/" + basename(piece.filename)`
   - `await moveProjectPath(rootPath, piece.filename, destPath)`
   - Track success/failure per file
2. Attempt `remove_empty_directory(rootPath, groupA.folderPath)`
   - If folder not empty (non-piece files remain): show notification "Folder not empty — some files were not moved"
   - If folder already absent: no-op (idempotent)
3. Update piece filenames for successfully moved pieces
4. Update tab filenames for moved pieces
5. `mergeIntoGroup(groupA.id, groupB.id)` — move pieces to target group, reparent children, delete source group
6. Queue manifest update
7. Refresh scaffold
8. Clear pending state

**Partial failure**: Individual file moves can fail independently. State is updated only for files that actually moved. Notification shows "Merged 3/5 files — 2 failed (permission denied)".

### 4.4 Guards

| Guard | Behavior |
|---|---|
| `groupId === targetGroupId` | No-op, return early |
| Either group has no `folderPath` | Fall back to state-only operation (current behavior). Show subtle indicator that no files were moved |
| `pendingGroupDrop` is null when resolver fires | Clear state, return early |
| `rootPath` is unavailable | Clear state, return early |

### 4.5 New Domain Commands

#### `mergeIntoGroup(fromGroupId, intoGroupId)`

State-only merge in `groupDomain.js`:
1. Compute merged `pieceIds` (target + source, deduplicated via `Set`)
2. Reparent any groups whose `parentId === fromGroupId` to `intoGroupId`
3. Update target group's `pieceIds`
4. Remove source group from array
5. Single `applyGroupsUpdate` call with history label `'Merge folder groups'`

Guards: `if (!fromGroupId || !intoGroupId || fromGroupId === intoGroupId) return;`

#### `setFolderPath(groupId, newPath)`

Update a group's `folderPath` in `groupDomain.js`:
- Single `applyGroupsUpdate` call
- History label: `'Update folder path'`

### 4.6 New Rust Backend Command

#### `remove_empty_directory`

```rust
pub(crate) fn remove_empty_directory(
    root_path: &str,
    relative_path: &str,
) -> CommandResult<()>
```

- Uses `std::fs::remove_dir` (not `remove_dir_all`) — **safe by default**, fails if directory contains any files
- Path validation via `path_guard` (traversal protection)
- Write lock via `write_ops::with_write_lock`
- Returns `Ok(())` if directory already absent (idempotent)
- Registered as Tauri command in `lib.rs`

### 4.7 Screen Coordinate Threading

`useCanvasInteractionController.js` must pass the pointer's screen position to `onGroupNestDrop`:

- Capture `clientX`/`clientY` from the Konva event's native PointerEvent during `handleGroupPillDragMove` into a `lastPointerScreenRef`
- Read the ref in `handleGroupPillDragEnd` when firing `onGroupNestDrop`

---

## 5. Presentation Requirements

### 5.1 GroupDropPopover Component

**Location**: `src/components/GroupDropPopover.jsx`

**Props**:

| Prop | Type | Description |
|---|---|---|
| `pendingGroupDrop` | `{ groupId, targetGroupId, screenX, screenY } \| null` | Pending drop data; null = closed |
| `onResolve` | `(action: 'nest' \| 'merge' \| 'cancel') => void` | Resolution callback |
| `groups` | `Array` | Groups array for displaying names |
| `isResolving` | `boolean` | True while filesystem operation is in progress |

**Anchor**: `PopoverAnchor` with invisible `position: fixed` div at `{screenX, screenY}`. Radix handles viewport clamping.

### 5.2 Styling Contract

Per `docs/ui-governance.md` Section 10.2:

| Property | Value | Source |
|---|---|---|
| Surface | `rgba(24, 24, 24, 0.96)` | Litria glass-morphic |
| Backdrop | `backdrop-filter: blur(10px)` | Section 10.2 |
| Border | `1px solid rgba(212, 212, 212, 0.28)` | Section 10.2 |
| Border radius | `14px` | Section 10.2 card panels |
| Z-index | `60` | PopoverContent default |
| Transitions | `--cm-transition-fast` (150ms ease) | Section 10.2 |

**Buttons**:

| Button | Variant | Tokens |
|---|---|---|
| Nest inside | Primary pill | `--cm-pill-primary-bg/border/color` |
| Merge | Default pill | `--cm-pill-border/bg/color` |
| Cancel | Text-only | `--cm-text-muted` |

### 5.3 Loading State

While `isResolving` is true:
- Contextual label replaced with "Moving files..."
- All buttons disabled (reduced opacity)
- Radix `onOpenChange` suppressed (prevent dismiss during operation)

### 5.4 Accessibility

Provided by Radix Popover:
- Focus trap within popover
- `role="dialog"` with `aria-label`
- Escape key dismisses (when not resolving)
- Focus restoration to canvas after dismiss
- Tab navigation between Nest, Merge, and Cancel buttons

---

## 6. Cross-Platform Considerations

### 6.1 Platform-Specific Behaviors

| Behavior | Windows | macOS | Linux |
|---|---|---|---|
| `fs::rename` (nest) | Atomic on NTFS | Atomic on APFS | Atomic on same filesystem. Fails with `EXDEV` across mount points |
| File locked during merge | May fail if file held by another process (no OS-level file lock from Monaco) | No file locking issue | No file locking issue |
| Case-only folder rename | Case-insensitive FS: `Random` -> `random` appears as no-op | Case-insensitive by default (APFS) | Case-sensitive: real rename |
| Empty folder deletion | `remove_dir` works if empty | `remove_dir` works if empty. `.DS_Store` may prevent deletion | `remove_dir` works if empty |
| Path separator in `folderPath` | Backend normalizes via `std::path::Path`. Frontend uses forward slashes only | Forward slashes native | Forward slashes native |

### 6.2 macOS `.DS_Store` Issue

macOS Finder creates `.DS_Store` files in directories. After a merge moves all piece files, the source folder may contain only `.DS_Store` and `remove_empty_directory` will fail (directory not empty).

**Mitigation**: Show the "Folder not empty — some files were not moved" notification. User can delete `.DS_Store` manually via scaffold or Finder. A future enhancement could add a `remove_directory_if_only_hidden` variant, but this is not in v1 scope.

### 6.3 Cross-Device Move (Linux)

Per ADR-010, `fs::rename` fails across mount points. For nest operations (single `fs::rename` call), the error is immediate and clear. For merge operations (per-file moves), some files may succeed before one fails if the project spans mount points.

**v1 behavior**: Surface a user-friendly error: "Cannot move files across filesystems. Ensure your project is on a single drive."

**Future**: The Filesystem Write Manager PRD defines a copy-then-delete fallback that handles this transparently.

---

## 7. Error Handling

### 7.1 Error Scenarios

| Scenario | Type | User Message | State Change |
|---|---|---|---|
| Nest folder move fails (permission) | Nest | "Cannot nest '{source}' — permission denied" | None |
| Nest folder move fails (cross-device) | Nest | "Cannot nest '{source}' — folders must be on the same drive" | None |
| Merge file move fails (1 of N) | Merge | "Merged {n}/{total} files. {failures} failed: {reason}" | Only successful moves reflected |
| Source folder not empty after merge | Merge | "Folder '{source}' not empty — some files were not moved" | Group deleted, folder remains on disk |
| Either group has no folderPath | Both | Subtle indicator: "No folder associated — group state updated only" | State-only (parentId/merge), no filesystem |
| Destination already exists | Both | "A file named '{name}' already exists in '{dest}'" | Operation aborted for that file |

### 7.2 Undo Limitations

**Group state** is fully reversible via Ctrl+Z (history captures before/after groups array).

**Filesystem moves are NOT reversible via Ctrl+Z.** This matches existing behavior — scaffold drag-and-drop moves are also not undoable. A future filesystem write manager could add journaled rollback support.

**User expectation**: Document this clearly. After undoing a merge, the group structure is restored but files remain in their new location.

---

## 8. Files Touched

### New Files

| File | Purpose |
|---|---|
| `src/components/GroupDropPopover.jsx` | Popover UI component |
| `src/app/useGroupFilesystemOps.js` | Extracted `performNest`/`performMerge` helpers (if App.jsx is too large) |

### Modified Files

| File | Change |
|---|---|
| `src/app/groupDomain.js` | Add `mergeIntoGroup` + `setFolderPath` commands |
| `src/App.jsx` | `pendingGroupDrop` state, `handleGroupNestDrop` → pending, `handleResolveGroupDrop` (async) |
| `src/behaviors/useCanvasInteractionController.js` | Thread `screenX`/`screenY` into `onGroupNestDrop` callback |
| `src-tauri/src/project_ops.rs` | Add `remove_empty_directory` function |
| `src-tauri/src/lib.rs` | Register `remove_empty_directory` as Tauri command |

### Unchanged Files

| File | Reason |
|---|---|
| `src/app/useScaffoldOperations.js` | Scaffold path already correct |
| `src/components/ui/popover.jsx` | Used as-is (shadcn generated) |
| `src/styles/tokens.css` | All needed tokens already defined |

---

## 9. Acceptance Criteria

### 9.1 Functional

| # | Criterion | Validation |
|---|---|---|
| F1 | Nest: folder moves on disk, piece filenames updated, scaffold reflects hierarchy | Nest group A into B via canvas. Verify `A/` now at `B/A/` on disk. Verify scaffold shows nested structure. |
| F2 | Nest: `parentId` and `folderPath` both updated | After nest, verify `groupA.parentId === groupB.id` and `groupA.folderPath === "B/A"` |
| F3 | Merge: all files move to target folder | Merge group A (3 files) into B. Verify all 3 files now in `B/` on disk. |
| F4 | Merge: source group deleted from state | After merge, verify group A no longer exists in `groups` array |
| F5 | Merge: child groups reparented | Group C has `parentId === A.id`. After merging A into B, verify `C.parentId === B.id` |
| F6 | Merge: source folder deleted if empty | After merge, verify `A/` folder no longer exists on disk |
| F7 | Merge: source folder preserved if non-piece files remain | Add `__init__.py` to A. Merge A into B. Verify `__init__.py` still in `A/` and notification shown |
| F8 | Cancel: no changes | Click Cancel. Verify no filesystem or state changes |
| F9 | Escape dismisses popover as cancel | Press Escape while popover open. Verify no changes |
| F10 | Popover disabled during operation | Click Nest. Verify buttons disabled and "Moving files..." shown until operation completes |
| F11 | Undo restores group state | Nest A into B, then Ctrl+Z. Verify groups restored. Verify files remain at `B/A/` (filesystem not rolled back) |
| F12 | Self-drop is no-op | Drag group A onto itself. Verify no popover, no state change |
| F13 | Groups without folderPath fall back to state-only | Create an ad-hoc group (no folder). Nest it via canvas. Verify `parentId` set, no filesystem error |
| F14 | Manifest updated after both operations | Verify `litria.project.json` reflects updated piece filenames after nest and merge |
| F15 | Open editor tabs reflect new filenames | Have a file from group A open in editor. Nest A into B. Verify tab title shows new path |
| F16 | Scaffold drag-and-drop still works | After shipping this feature, verify scaffold drag works identically to before |

### 9.2 Cross-Platform

| # | Criterion | Platform | Validation |
|---|---|---|---|
| P1 | Nest works on same filesystem | All | Standard nest operation succeeds |
| P2 | Nest fails gracefully across mount points | Linux | Project on tmpfs, attempt nest to ext4 destination. Verify error notification |
| P3 | Merge with `.DS_Store` in source | macOS | Merge all pieces. Verify notification about non-empty folder |
| P4 | Merge with locked file | Windows | Open file in external editor, attempt merge. Verify that file is skipped, others succeed |
| P5 | Path with unicode characters | All | Group folder named `datos-espa~nol`. Nest/merge. Verify correct handling |

### 9.3 Accessibility

| # | Criterion | Validation |
|---|---|---|
| A1 | Popover receives focus on open | Verify focus moves to popover when it appears |
| A2 | Tab navigates between buttons | Tab through Nest, Merge, Cancel buttons |
| A3 | Enter activates focused button | Focus Nest button, press Enter. Verify nest operation starts |
| A4 | Escape dismisses | Press Escape. Verify popover closes and drop is canceled |
| A5 | Screen reader announces popover | Verify `role="dialog"` and `aria-label` present |
| A6 | Focus returns to canvas after dismiss | Dismiss popover. Verify focus returns to previous element |

### 9.4 Performance

| # | Criterion | Target |
|---|---|---|
| R1 | Popover appears after drop | < 50ms (no filesystem call before popover) |
| R2 | Nest operation (including all sync) | < 200ms for typical group (< 20 files) |
| R3 | Merge operation (per file) | < 50ms per file move |
| R4 | No UI freeze during filesystem operations | Async Tauri invokes, popover shows loading state |

---

## 10. Known Limitations (Blocking Ship)

### 10.1 Group reconciliation gap

After merge deletes a group, recreating the folder via scaffold or OS does not recreate the group in state. Pieces appear orphaned.

**Resolution**: Either implement reconciliation in `syncGroupMembership` (lighter fix) or wait for the Filesystem Write Manager (heavier fix). See PRD-FSM-001 Section 3.3.

### 10.2 No nested group rendering on canvas

Nest operation works correctly at filesystem and state level, but the canvas renders nested groups as flat peers. No visual indicator of parent-child relationship.

**Resolution**: Separate design task — nested group rendering on canvas. Not blocking nest functionality (scaffold correctly reflects the hierarchy).

### 10.3 Lasso tool drag state leak (pre-existing)

After lasso tool selection, mouse movement drags the screen. Unrelated to nest/merge — pre-existing interaction controller bug.

**Resolution**: Investigate drag state cleanup in `useCanvasInteractionController` after lasso selection completes.

> **Resolved (2026-07-22, PR #172).** Root cause found in `useLassoSelection`,
> not the controller: `cancelLasso` was never wired to any caller and the
> lasso had no window-level failsafe (unlike the controller's `isDragActive`),
> so a marquee released over a DOM overlay or off-window stranded
> `isSelecting` — the box then stretched on every mousemove with no button
> held. Fixed with a window `mouseup`/`pointercancel`/`blur` cancel while a
> lasso is active.

---

## 11. Implementation Sequence

Detailed task breakdown in `docs/plans/group-nest-merge-implementation.md`.

```
Task 1: groupDomain.js — mergeIntoGroup + setFolderPath commands
  |
Task 2: App.jsx — pendingGroupDrop state + coordinate threading
  |
Task 3: App.jsx / useGroupFilesystemOps.js — filesystem-first resolve handlers
  |
Task 4: GroupDropPopover.jsx — popover UI
  |
Task 5: project_ops.rs — remove_empty_directory command
  |
Manual QA across all scenarios
```

---

## References
- ADR-007: Adopt shadcn/ui for Interactive Primitives
- ADR-008: Protected Zones — shadcn Exclusions
- ADR-009: GroupDropPopover Uses shadcn Popover
- ADR-010: Cross-Platform Build, Distribution & Platform Abstraction
- RFC: `docs/rfcs/group-nest-merge-popover.md`
- RFC: `docs/rfcs/filesystem-write-manager.md`
- PRD-FSM-001: Filesystem Write Manager
- Implementation brief: `docs/plans/group-nest-merge-implementation.md`
- `docs/ui-governance.md` — Sections 4.3 (pills), 10.2 (shadcn styling contract)
- `src/app/useScaffoldOperations.js` — reference filesystem move pattern
