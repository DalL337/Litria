# Product Requirements Document
## Folder-to-Canvas — Scaffold Folder Groups with Grid Layout

**Project:** Litria
**Component:** Canvas / Scaffold / Groups
**Version:** 1.0
**Status:** Planning
**Relates to:** ADR-014 (Glass Material System), RFC: Glass Material System

---

## 1. Overview

Users can currently drag individual files from the scaffold tree onto the canvas as nodes. Folders cannot be placed on the canvas. This feature enables dragging (or double-clicking) a folder from the scaffold to spawn it as a collapsed folder group on the canvas. When expanded, the group reveals its children in a bounded grid layout with progressive expansion.

---

## 2. Goals

- Folders in the scaffold can be dragged to the canvas or double-clicked to spawn
- Folder spawns as a collapsed squircle pill (existing group behavior)
- Expanding a group reveals children in a 3×3 grid layout (files), with subfolders and ">More" below
- Grid grows incrementally on ">More" (3×3 → 4×3 → 4×4 → 5×4 → ...) keeping roughly square
- Recursive structure — subfolders spawn as nested collapsed groups within the parent
- Files already on the canvas are skipped (no duplicates)

---

## 3. Non-Goals

- No drag-reordering within the grid (files are alphabetical)
- No custom grid size configuration
- No lazy-loading of deep folder trees (full recursive load on spawn)
- No file preview or content display within the grid

---

## 4. Interaction Model

### 4.1 Spawn Trigger

| Action | Behavior |
|--------|----------|
| **Drag folder** from scaffold to canvas | Folder group spawns at drop position, collapsed |
| **Double-click folder** in scaffold | Folder group spawns at default canvas position (center of viewport), collapsed |

### 4.2 Expand / Collapse

| Action | Behavior |
|--------|----------|
| **Double-click** collapsed group pill | Expands to 3×3 grid view |
| **Double-click** expanded group pill header | Collapses back to pill |
| **Click `>`** | Grid grows to next tier. Tooltip: "Show more files" |
| **Click `<`** | Grid shrinks to previous tier (minimum 3×3). Tooltip: "Show fewer files" |

---

## 5. Grid Layout Specification

### 5.1 File Grid (Top Section)

Files are laid out left-to-right, top-to-bottom in a grid. The initial (default) tier is 3×3 = 9 file slots.

```
Tier 0 (default):  3×3  =  9 files visible
Tier 1:            4×3  = 12
Tier 2:            4×4  = 16
Tier 3:            5×4  = 20
Tier 4:            5×5  = 25
Tier 5:            6×5  = 30
Tier 6:            6×6  = 36
...continues as needed
```

**Growth pattern:** Alternate adding a column then a row, keeping the grid roughly square.

**Sorting:** Alphabetical by filename within the grid.

### 5.2 Subfolder Row (Bottom Section)

Below the file grid, a separate row for:
- **Subfolder pills** — each renders as a collapsed squircle (the existing group pill)
- **`>` (expand) button** — shown when file count exceeds current grid tier capacity. Tooltip: "Show more files"
- **`<` (shrink) button** — shown when grid is expanded beyond tier 0. Tooltip: "Show fewer files"

```
┌──────────────────────────────────────────┐
│                                          │
│     [ file grid — 3×3 or larger ]        │
│                                          │
│  [📁 sub1]  [📁 sub2]       [<]  [>]    │
└──────────────────────────────────────────┘
```

Chevron buttons are compact glass-styled controls (50×80px) — smaller than file nodes, same height as subfolder pills. Universal arrow language, no text. Hover tooltip for accessibility.

Subfolder pills are sorted alphabetically. If there are no subfolders, the bottom row only shows chevron buttons as needed. If there are no extra files and no subfolders, no bottom row is rendered.

### 5.3 Spacing

| Property | Value |
|----------|-------|
| Node width | 180px (PIECE_WIDTH) |
| Node height | 110px (PIECE_HEIGHT) |
| Grid gap (horizontal) | 20px |
| Grid gap (vertical) | 16px |
| Subfolder row gap from grid | 20px |
| Subfolder pill width | 180px (SQUIRCLE_W) |
| Subfolder pill height | 80px (SQUIRCLE_H) |
| Bounding box padding | 24px |

### 5.4 Bounding Box

The group's bounding box auto-sizes to fit the current grid tier + subfolder row. When the grid grows, the bounding box expands. When it shrinks, the bounding box contracts. The group outline (existing glass squircle outline) wraps this bounding box.

---

## 6. Duplicate Handling

When spawning a folder, files that already exist as nodes on the canvas are **skipped**. Matching is by normalized file path (relative to project root).

If ALL files in a folder are already on canvas, the folder still spawns as a group containing references to those existing nodes (they become members of the group).

---

## 7. Recursive Structure

A folder like `src/` with subfolders `src/components/`, `src/utils/`:

```
[src] (collapsed pill)
  └─ expand →
     ├── App.tsx, index.ts, main.ts ... (3×3 grid)
     ├── [📁 components] (collapsed pill in subfolder row)
     │     └─ expand →
     │          ├── Button.tsx, Modal.tsx ... (3×3 grid)
     │          └── no subfolders
     └── [📁 utils] (collapsed pill in subfolder row)
           └─ expand →
                ├── math.ts, format.ts ... (3×3 grid)
                └── no subfolders
```

Each level follows the same layout rules. Nested groups are independent — expanding a subfolder doesn't affect the parent's grid state.

---

## 8. Scaffold Integration

### 8.1 Scaffold Tree Changes

| Element | Current Behavior | New Behavior |
|---------|-----------------|--------------|
| Folder row | Click toggles expand/collapse in tree | Same, plus draggable to canvas |
| Folder double-click | Toggles expand/collapse | Spawns to canvas (collapsed group) |
| Folder drag | Not supported | Drag to canvas drop zone |

### 8.2 Visual Feedback During Drag

- Folder row gets a drag ghost (existing scaffold drag system)
- Canvas shows a drop indicator (outline of where the group will land)
- Drop target validation: anywhere on the canvas is valid

---

## 9. Phasing

### Phase 1: Folder Spawn (Collapsed)
- Enable folder drag from scaffold to canvas
- Enable folder double-click to spawn at viewport center
- Spawn creates a folder group with all recursive children as pieces
- Group starts collapsed (squircle pill)
- Skip files already on canvas
- **Exit:** Folder can be dragged/double-clicked to canvas, appears as collapsed pill

### Phase 2: Grid Layout Engine
- Implement 3×3 grid positioning for expanded folder groups
- Auto-layout children within group bounding box
- Subfolder row below file grid
- Subfolder pills render as collapsed groups
- **Exit:** Expanding a folder group shows children in 3×3 grid with subfolder pills

### Phase 3: Progressive Grid Expansion
- ">More" / ">Less" indicators in subfolder row
- Grid tier stepping (3×3 → 4×3 → 4×4 → ...)
- Bounding box resize on tier change
- **Exit:** User can grow/shrink the grid, bounding box adjusts

### Phase 4: Scaffold Context Menu Color
- Add color swatch picker to scaffold folder context menu
- Color propagates to the folder group on canvas (if spawned)
- **Exit:** Right-click folder in scaffold → set color → nodes on canvas show edge color

---

## 10. Acceptance Criteria

- [ ] Folders can be dragged from scaffold to canvas
- [ ] Folders can be double-clicked in scaffold to spawn on canvas
- [ ] Spawned folder starts as collapsed squircle pill
- [ ] Expanding shows children in 3×3 grid layout
- [ ] Files sorted alphabetically in grid
- [ ] Subfolders appear as collapsed pills in a row below the file grid
- [ ] `>` chevron expands grid to next tier (with "Show more files" tooltip)
- [ ] `<` chevron contracts grid to previous tier, minimum 3×3 (with "Show fewer files" tooltip)
- [ ] Chevron buttons are compact glass-styled (50×80px), smaller than file nodes
- [ ] Grid growth keeps roughly square (alternate column/row addition)
- [ ] Files already on canvas are skipped (no duplicates)
- [ ] Recursive — subfolders contain their own nested children
- [ ] Each nested group follows the same 3×3 layout rules
- [ ] Group bounding box auto-sizes to current grid tier
- [ ] Glass material applies to all spawned nodes and subfolder pills
- [ ] Corner LED health indicators work on grid-spawned nodes

---

## 11. Resolved Design Questions

- **Grid controls:** Compact `<` / `>` chevron buttons (50×80px) in the subfolder row. Universal arrow language, no text labels. Hover tooltip for accessibility ("Show fewer files" / "Show more files").
- **Large folder warning:** Prompt when folder contains >50 files. "This folder has 147 files. Spawn all?" Prevents accidental canvas floods from `src/` with hundreds of files.
- **Subfolder expansion:** In-place. Expanding a subfolder pushes siblings and redraws the parent bounding box. Keeps the spatial hierarchy clear — nested content is always physically inside its parent.
- **Grid tier memory:** Persisted per group. Expanding to tier 3 (5×4) and collapsing/reopening remembers tier 3. Stored in group metadata alongside color and name.

---

## References
- ADR-014: `docs/adrs/014-glass-material-system.md`
- RFC: `docs/rfcs/glass-material-system.md`
- Glass Material PRD: `docs/prds/glass-material-system-prd.md`
