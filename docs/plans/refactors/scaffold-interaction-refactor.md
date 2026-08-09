# Scaffold Interaction Refactor

**Project:** Litria
**Status:** Ready for Development
**Date:** 2026-03-07

---

## 1. Overview

Add drag-and-drop file/folder organization to the scaffold drawer and expose matching operations on the canvas. Changes in either surface (scaffold tree or canvas) mirror to the other and persist across open/close cycles, restarts, and project reloads.

---

## 2. Current State

| Area | Current behavior |
|---|---|
| Scaffold tree | Read-only: select, open, toggle visibility, collapse/expand. No drag. |
| Canvas pieces | Drag to reposition. No drag-into-group or drag-out-of-group. |
| Canvas groups | Collapsed groups drag as a unit. No nesting, no merge-on-collision. |
| Hide icon | Click area spans the full `.scaffold-tree-entry` button (`width: 100%`), not isolated to the eye icon. |
| Persistence | Pieces/groups save to `litria.project.json` via 400ms debounced autosave. Scaffold collapse state is session-only. |
| File system | Grouping physically moves files on disk (e.g. `file.py` -> `Group-1/file.py` via `moveProjectPath()`). |

**Key files:**

| File | Role |
|---|---|
| [DrawerContentScaffold.jsx](src/drawers/DrawerContentScaffold.jsx) | Scaffold tree UI |
| [useScaffoldActions.js](src/app/useScaffoldActions.js) | Scaffold interaction handlers |
| [useGroupMenuActions.js](src/app/useGroupMenuActions.js) | Group creation, file moves |
| [pieceDomain.js](src/app/pieceDomain.js) | Piece state and commands |
| [groupDomain.js](src/app/groupDomain.js) | Group state and commands |
| [useCanvasInteractionController.js](src/behaviors/useCanvasInteractionController.js) | Canvas drag, snap, adjacency |
| [useProjectPersistence.js](src/project/useProjectPersistence.js) | 400ms debounced manifest write |
| [scaffold.css](src/styles/scaffold.css) | Scaffold tree styles |

---

## 3. Goals

- Drag files and folders within the scaffold tree to reorganize
- Move files into/out of folders via drag
- Nest folders inside other folders via drag
- Mirror all scaffold changes onto the canvas (piece/group membership)
- Mirror all canvas piece/group moves back to the scaffold tree
- Visual drop indicator showing where the dragged item will land
- Right-click context menus for file/folder creation, opening, renaming, and deletion
- Persist all changes across scaffold open/close, app restart
- Fix the hide icon isolation issue

---

## 4. Non-Goals

- Scaffold search/filter
- Multi-select drag in the scaffold
- Undo/redo for scaffold operations (canvas undo history is sufficient)

---

## 5. Scaffold Drawer: Drag-and-Drop

### 5.1 Drag Initiation

| Property | Detail |
|---|---|
| Trigger | Left-click + hold on a file or folder row (`.scaffold-tree-entry`) |
| Threshold | 4px movement before drag activates (matches canvas drag threshold) |
| Visual | Dragged item becomes semi-transparent at origin; a floating ghost row follows the cursor |
| Multi-select | Not supported in v1 -- single item drag only |

### 5.2 Drop Targets

| Target | Behavior |
|---|---|
| **Folder row** | Drop into that folder (item becomes child) |
| **Between rows** | Drop indicator line appears between items; item reorders at that position |
| **Root level** (above first item or below last) | Item moves to project root (out of any folder) |
| **Self or own descendant** | Invalid drop -- visual rejection (red indicator or no-drop cursor) |

### 5.3 Drop Indicator

| Property | Detail |
|---|---|
| Between-rows | Horizontal line (2px, accent color) spanning the tree width at the insertion point |
| Into-folder | Folder row highlights with a subtle background tint |
| Invalid | No indicator shown; cursor changes to no-drop |
| Timing | Indicator updates on `dragOver` as cursor moves between zones |

### 5.4 Drop Zone Detection

Each tree row has three hit zones (top 25%, middle 50%, bottom 25%):

| Zone | Meaning |
|---|---|
| Top 25% | Insert before this item |
| Middle 50% | Drop into this item (only valid if target is a folder) |
| Bottom 25% | Insert after this item |

For files (non-folders), the middle zone collapses -- top 50% = before, bottom 50% = after.

### 5.5 What Happens on Drop

1. **File into folder:**
   - Move file on disk via `moveProjectPath(oldPath, newPath)`
   - Update piece's `filename` to new relative path
   - Add piece to target group's `pieceIds`; remove from source group (if any)
   - Rebuild scaffold tree from file system state

2. **File out of folder (to root):**
   - Move file on disk to project root
   - Update piece's `filename`
   - Remove piece from group's `pieceIds`
   - If group is now empty, prompt or auto-delete the group

3. **Folder into folder (nesting):**
   - Move folder on disk
   - Update group's `folderPath` and all child pieces' `filename` paths
   - Set group's `parentId` to target group's ID
   - Rebuild scaffold tree

4. **Reorder within same level:**
   - No file system move needed (sibling order is display-only)
   - Store sort order in manifest if custom ordering is desired, otherwise alphabetical

---

## 6. Scaffold: Right-Click Context Menu

### 6.1 Context Menu Targets

The context menu appears on right-click. Menu items vary by what was clicked:

**Right-click on file:**

| Action | Behavior |
|---|---|
| Open | Opens the file in the editor drawer. If a piece exists, activates its tab. If no piece exists, creates one and opens its tab. Editor drawer opens if closed. |
| Rename | Inline rename: entry name becomes an editable text input. Enter confirms, Escape cancels. |
| Delete | Deletes file from disk. Removes associated piece from canvas and any group membership. Confirmation prompt before delete. |

**Right-click on folder:**

| Action | Behavior |
|---|---|
| New File | Creates an empty file inside the folder. Inline name input appears as a new child row. Enter confirms and creates on disk + spawns piece on canvas. Escape cancels. |
| New Folder | Creates an empty subfolder. Inline name input appears as a new child row. Enter confirms and creates on disk + spawns group on canvas. Escape cancels. |
| Rename | Inline rename. Updates folder on disk, group's `folderPath`, and all descendant piece `filename` paths. |
| Delete | Deletes folder and all contents from disk. Removes all associated pieces and the group from canvas. Confirmation prompt before delete. |

**Right-click on empty space (below all items):**

| Action | Behavior |
|---|---|
| New File | Creates file at project root. Inline name input at bottom of tree. |
| New Folder | Creates folder at project root. Inline name input at bottom of tree. |

### 6.2 Inline Name Input

| Property | Detail |
|---|---|
| Appearance | Replaces the entry name text with a text input, same size and position |
| Default value | Empty for new items; current name for rename |
| Confirm | Enter key |
| Cancel | Escape key or click outside |
| Validation | No empty names, no path separator characters (`/`, `\`), no duplicate names at same level |
| On confirm | Execute disk operation, update domains, rebuild tree |

### 6.3 File Creation -> Canvas

When a new file is created via context menu:

1. File created on disk (empty content)
2. Piece spawned on canvas at a default position (near the group if inside a folder, or at viewport center if at root)
3. If inside a folder, piece added to the corresponding group's `pieceIds`
4. Scaffold tree rebuilds
5. Persistence triggers on 400ms debounce

### 6.4 Folder Creation -> Canvas

When a new folder is created via context menu:

1. Folder created on disk
2. Group created on canvas with empty `pieceIds`
3. If inside another folder, `parentId` set to parent group
4. Scaffold tree rebuilds
5. Persistence triggers on 400ms debounce

### 6.5 Delete Behavior

| Scenario | Canvas effect |
|---|---|
| Delete file (has piece on canvas) | Piece removed, removed from group pieceIds, tab closed if open |
| Delete file (no piece on canvas) | No canvas change |
| Delete folder (has group on canvas) | Group removed, all member pieces removed, all open tabs closed |
| Delete folder (nested, has children) | All descendant groups and pieces removed recursively |

Confirmation dialog: "Delete [name]? This cannot be undone." with Cancel / Delete buttons.

---

## 7. Canvas: Piece-to-Group Interactions

### 6.1 Drag Piece Into Group

| Property | Detail |
|---|---|
| Trigger | Drag a piece and hover over a group's bounding box |
| Detection | During `handlePieceDragMove`, check if piece center overlaps any group's bounds |
| Visual | Target group shows a highlight border (accent color, 2px) |
| Drop threshold | Piece center must be inside group bounds for 200ms (debounce accidental pass-through) |
| On drop | Piece joins group: update `groupDomain.pieceIds`, move file on disk, update `filename` |

### 6.2 Drag Piece Out of Group

| Property | Detail |
|---|---|
| Trigger | Drag a grouped piece outside its parent group's bounding box |
| Detection | During `handlePieceDragMove`, check if piece center exits current group bounds |
| Visual | Source group dims or shows a "releasing" indicator |
| On drop | Piece leaves group: remove from `groupDomain.pieceIds`, move file to project root on disk, update `filename` |

### 6.3 Group-to-Group Merge / Nesting

| Property | Detail |
|---|---|
| Trigger | Drag a collapsed group pill onto another group's bounding box |
| Detection | Collision between pill drag bounds and target group bounds |
| Visual | Target group shows merge highlight; tooltip or label shows "Nest into [GroupName]" |
| Confirmation | Drop completes the nest (no modal) |
| On drop | Dragged group becomes child of target: set `parentId`, move folder on disk, update all descendant paths |

### 6.4 Collision Detection Implementation

Add to `useCanvasInteractionController.js`:

```
During piece/group drag move:
  1. Get bounding boxes of all groups (from groupDomain state + piece positions)
  2. Find which group (if any) the drag target overlaps
  3. Exclude the piece's current group (no self-drop)
  4. Exclude descendant groups (no circular nesting)
  5. Set `dropTargetGroupId` in interaction state
  6. On drag end, if dropTargetGroupId is set, execute the move
```

Group bounds calculation: min/max of all piece positions in the group + padding.

---

## 8. Bidirectional Sync

### 7.1 Scaffold -> Canvas

When a scaffold drag completes:

1. File system move executes first (source of truth)
2. `pieceDomain.commands.updatePieceFilenames()` updates affected pieces
3. `groupDomain.commands` adds/removes pieces from groups
4. Canvas re-renders with updated positions and group membership
5. Persistence triggers on the 400ms debounce

### 7.2 Canvas -> Scaffold

When a canvas piece/group move completes:

1. `groupDomain` updates piece membership
2. File system move executes via `moveProjectPath()`
3. Scaffold tree rebuilds from the updated file system state
4. Scaffold collapse/expand state is preserved (keyed by folder path)

### 7.3 Conflict Prevention

Only one drag operation can be active at a time. If the scaffold drawer is open while the canvas is visible, dragging on one surface disables interaction on the other until drop completes. This prevents concurrent moves on the same file.

---

## 9. Persistence

| What | Where | When |
|---|---|---|
| Piece `filename` changes | `litria.project.json` pieces array | 400ms debounce after move |
| Group `pieceIds` changes | `litria.project.json` groups array | 400ms debounce after move |
| Group `parentId` (nesting) | `litria.project.json` groups array | 400ms debounce after move |
| File system moves | Disk | Immediate on drop |
| Scaffold collapse state | `litria.project.json` scaffold section | 400ms debounce after toggle |

**Open/close guarantee:** All state lives in domains (React state) and persists to manifest. Opening/closing the scaffold drawer does not touch domain state. Nothing drops.

**Restart guarantee:** Manifest contains full group hierarchy (`parentId` chains) and piece filenames. On load, the scaffold tree rebuilds from disk and groups rebuild from manifest. No orphaned state.

---

## 10. Hide Icon Isolation Fix

**Problem:** `.scaffold-tree-entry` is `width: 100%` causing the clickable area to span the entire row, overlapping the visibility button.

**Fix:**

In [scaffold.css](src/styles/scaffold.css), change `.scaffold-tree-entry` from `width: 100%` to `flex: 1; min-width: 0;`. This lets it grow to fill available space without overlapping the visibility button. The visibility button remains `flex: 0 0 auto` at its fixed 26x26px size.

```css
/* Before */
.scaffold-tree-entry {
  width: 100%;
  display: flex;
  ...
}

/* After */
.scaffold-tree-entry {
  flex: 1;
  min-width: 0;
  display: flex;
  ...
}
```

This is a one-line CSS fix, independent of the drag work. Ship first.

---

## 11. Implementation Sequence

### Phase 0: Hide icon fix (standalone, ship immediately)
- [ ] Fix `.scaffold-tree-entry` width in scaffold.css
- [ ] Verify hide icon click doesn't trigger entry selection
- [ ] Verify entry click doesn't trigger hide

### Phase 1: Scaffold drag infrastructure
- [ ] Add drag state to DrawerContentScaffold (dragging item, drop target, drop position)
- [ ] Implement drag initiation with 4px threshold on `.scaffold-tree-entry`
- [ ] Render ghost row following cursor during drag
- [ ] Implement drop zone detection (top 25% / middle 50% / bottom 25% per row)
- [ ] Render drop indicator (between-line or folder-highlight)
- [ ] Handle invalid drops (self, descendant)

### Phase 2: Scaffold right-click context menu
- [ ] Context menu component (positioned at cursor, dismisses on click outside or Escape)
- [ ] File menu: Open, Rename, Delete
- [ ] Folder menu: New File, New Folder, Rename, Delete
- [ ] Empty space menu: New File, New Folder
- [ ] Open action: create piece if needed, activate tab, open editor drawer
- [ ] Inline name input for New File / New Folder / Rename (Enter confirms, Escape cancels)
- [ ] Name validation (no empty, no path separators, no duplicates at same level)
- [ ] New File: create on disk + spawn piece on canvas (+ add to group if inside folder)
- [ ] New Folder: create on disk + spawn group on canvas (+ set parentId if nested)
- [ ] Rename: update on disk + update piece filename / group folderPath + descendant paths
- [ ] Delete file: confirmation prompt + remove from disk + remove piece + close tab
- [ ] Delete folder: confirmation prompt + recursive remove from disk + remove group + all descendant pieces/groups

### Phase 3: Scaffold drop execution
- [ ] File into folder: disk move + piece filename update + group membership
- [ ] File out of folder: disk move + filename update + remove from group
- [ ] Folder into folder: disk move + group parentId + descendant path updates
- [ ] Reorder within same level (display order)
- [ ] Scaffold tree rebuilds after each drop

### Phase 4: Canvas piece-to-group drag
- [ ] Add group bounding box calculation to groupDomain or interaction controller
- [ ] During piece drag, detect overlap with non-current groups
- [ ] Show highlight on target group during hover
- [ ] 200ms debounce to prevent accidental drops
- [ ] On drop into group: update pieceIds, move file on disk, update filename
- [ ] On drop out of group: remove from pieceIds, move file to root, update filename

### Phase 5: Canvas group nesting
- [ ] During collapsed group pill drag, detect overlap with other groups
- [ ] Show merge/nest indicator on target group
- [ ] On drop: set parentId, move folder on disk, update all descendant paths
- [ ] Prevent circular nesting (group into own descendant)

### Phase 6: Bidirectional sync + persistence
- [ ] Scaffold drop triggers canvas domain updates (piece filenames, group membership)
- [ ] Canvas drop triggers scaffold tree rebuild
- [ ] Verify 400ms debounced manifest save captures all state
- [ ] Add scaffold collapse state to manifest persistence
- [ ] Test: open/close scaffold preserves all changes
- [ ] Test: app restart restores full hierarchy
- [ ] Test: concurrent scaffold and canvas state stays consistent

---

## 12. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| File system move fails mid-drag | Low | High -- orphaned state | Execute disk move first; rollback domain state on failure |
| Circular group nesting | Medium | Medium -- infinite loops | Validate ancestry chain before allowing nest |
| Performance on large trees | Low | Medium -- janky drag | Virtualize scaffold rows if >200 items; memoize group bounds |
| Race condition: scaffold + canvas simultaneous edits | Low | High -- inconsistent state | Lock: one drag active at a time |
| Path separator issues (Windows backslash) | Medium | Medium -- broken moves | Normalize all paths through existing path utilities |

---

## 13. Integration Points

| Need | Source | API |
|---|---|---|
| File creation | Tauri invoke for writing empty file | Need: `createFile(path)` |
| Folder creation | Tauri invoke for creating directory | Need: `createDirectory(path)` |
| File/folder deletion | Tauri invoke for recursive delete | Need: `deletePath(path)` |
| File moves | Tauri invoke `moveProjectPath()` | Already exists in useGroupMenuActions |
| Piece filename updates | pieceDomain.commands | `updatePieceFilenames()` already exists |
| Open file in editor | EditorSessionContext | `handleScaffoldOpenEntry()` already exists in useScaffoldActions |
| Editor drawer open | DrawerContext | `openDrawer('scaffold')` pattern exists -- need to open editor drawer on Open action |
| Group membership | groupDomain.commands | Need: `addPieceToGroup()`, `removePieceFromGroup()`, `setParentGroup()` |
| Group bounds | groupDomain + pieceDomain | Need: `getGroupBounds(groupId)` utility |
| Scaffold tree data | useScaffoldActions | `buildTree()` already exists, rebuilds from file system |
| Persistence | useProjectPersistence | Already saves pieces, groups on 400ms debounce |
| Collapse state | DrawerContentScaffold | Currently React state only -- need to persist to manifest |

### New groupDomain commands needed

| Command | Purpose |
|---|---|
| `addPieceToGroup(groupId, pieceId)` | Add piece to group's pieceIds array |
| `removePieceFromGroup(groupId, pieceId)` | Remove piece from group's pieceIds array |
| `setParentGroup(groupId, parentGroupId)` | Set group nesting relationship |
| `getGroupBounds(groupId, piecesMap)` | Calculate bounding box from member piece positions |
