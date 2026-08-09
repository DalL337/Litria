# Collapsed Folder Group — Squircle Design

**Status: COMPLETE** -- Implemented. Closed 2026-03-07.

## Problem

Collapsed folder groups currently render as a plain pill (`Rect` with
`cornerRadius: 6`, `PIECE_WIDTH x PIECE_HEIGHT * 0.33`). It's visually flat,
doesn't communicate what's inside, and doesn't match the glass-indigo design
language used by drawer tabs and other interactive surfaces.

## Current Implementation

| File | What it does |
|------|-------------|
| `src/app/selectors/workspaceSelectors.js` | `buildGroupPills()` — computes pill position from group bounds center |
| `src/components/WorkspaceStage.jsx` | Renders collapsed groups as Konva `Rect` + `Text` (lines 125-164) |
| `src/theme/themeDefaults.js` | `groupPillFill/Stroke/SelectedStroke/Text` tokens |
| `src/app/groupDomain.js` | `toggleCollapse()`, `expand()` — state management |

Current pill shape: `PIECE_WIDTH` wide, `PIECE_HEIGHT * 0.33` tall, solid dark
fill (`#2f2f2f`), single name label, no file count, no visual hierarchy.

## Design: Squircle Replacement

### Shape

Fixed-size squircle (rounded rect with higher corner radius to approximate a
superellipse). Same width as a piece node (`PIECE_WIDTH`). Height roughly
`PIECE_HEIGHT * 0.4` — slightly taller than the current pill to accommodate
the divider and file count.

Corner radius: ~14-16px (noticeably rounder than the 6px pill, gives the
squircle feel without needing a custom path).

### Layout (top to bottom)

```
  ┌──────────────────────────┐
  │                          │
  │       src/utils          │  <- folder group name, centered
  │                          │
  │          ───             │  <- short centered divider line (~40% width)
  │                          │
  │        7 files           │  <- piece count, centered, smaller text
  │                          │
  └──────────────────────────┘
```

- **Name**: current `group.name`, centered horizontally and vertically in the
  top ~60% of the squircle. Same font size as current pill (11px) or bump to 12px.
- **Divider**: short horizontal line, centered, ~40% of squircle width. Subtle
  color — `--cm-indigo` at reduced opacity or the border color.
- **File count**: `group.pieceIds.length` + " files" (or "1 file" singular).
  Smaller font (~10px), secondary text color.

### Theme — Glass Indigo

Inherits the drawer tab design language from `src/styles/drawers.css` and
`src/styles/tokens.css`. Since this is a Konva canvas element (not DOM), the
theme is applied via Konva fill/stroke props mapped from the same color values.

**Static state:**
- Fill: `rgba(30, 30, 30, 0.75)` (matches `--drawer-tab-bg`)
- Stroke: `--cm-indigo` (`#5c6bc0`)
- Stroke width: 1px
- Shadow: `shadowBlur: 6, shadowColor: black, shadowOpacity: 0.4` (existing)
- Name text: `--cm-text-primary` / `#e6e6e6`
- Count text: `--cm-indigo-light` (`#7986cb`) or a muted secondary color
- Divider line: `--cm-indigo` at ~40% opacity

**Hover state:**
- Stroke: `--cm-indigo-light` (`#7986cb`)
- Shadow: add glow — `shadowColor: rgba(121, 134, 203, 0.30)` (matches `--cm-glow-hover`)
- Optional: slight fill brighten to `rgba(35, 35, 40, 0.80)`

**Selected/active state:**
- Stroke: `--cm-electric-blue` (`#2979ff`)
- Fill: `rgba(41, 121, 255, 0.08)` (matches `.drawer-tab.is-active`)
- Shadow: `shadowColor: rgba(41, 121, 255, 0.35)` (matches `--cm-glow-active`)

### Connections

Incoming and outgoing connections route to the **closest available edge** of the
squircle, same as piece nodes. Since the squircle replaces all pieces in the
group visually, connection endpoints collapse to whichever edge of the squircle
is nearest to the other end of the connection.

This means `buildGroupPills` (or its replacement) needs to expose the squircle
bounds so the connection routing logic can calculate edge intersection points
instead of routing to hidden piece positions.

### Position

Anchored to the **top-left piece position** of the group at collapse time. This
means `buildGroupPills` changes from using `bounds.centerX/centerY` to using
`bounds.minX/minY` (the top-left corner of the group's bounding box).

### Interaction

No interaction changes — same as current pill:
- Click to select
- Double-click to expand (calls `groupDomain.expand()`)
- Drag to reposition

## Affected Files

| File | Change |
|------|--------|
| `src/app/selectors/workspaceSelectors.js` | Update `buildGroupPills` — add `pieceCount` to output, change position anchor to top-left |
| `src/components/WorkspaceStage.jsx` | Replace pill `Rect + Text` with squircle shape: higher corner radius, divider `Line`, count `Text`, hover/active states |
| `src/theme/themeDefaults.js` | Replace `groupPill*` tokens with `groupSquircle*` tokens mapped to glass-indigo values |
| `src/styles/tokens.css` | No change needed (Konva uses JS values, not CSS vars) — but token values are sourced from here |
| Connection routing | Needs to resolve connection endpoints to squircle edges when group is collapsed |

## Token Mapping

| Squircle prop | Source token | Value |
|---------------|-------------|-------|
| fill (static) | `--drawer-tab-bg` | `rgba(30, 30, 30, 0.75)` |
| stroke (static) | `--cm-indigo` | `#5c6bc0` |
| stroke (hover) | `--cm-indigo-light` | `#7986cb` |
| stroke (selected) | `--cm-electric-blue` | `#2979ff` |
| fill (selected) | `.is-active` bg | `rgba(41, 121, 255, 0.08)` |
| glow (hover) | `--cm-glow-hover` | `rgba(121, 134, 203, 0.30)` |
| glow (selected) | `--cm-glow-active` | `rgba(41, 121, 255, 0.35)` |
| name text | `--cm-text-primary` | `#e6e6e6` |
| count text | `--cm-indigo-light` | `#7986cb` |
| divider | `--cm-indigo` @ 40% | `rgba(92, 107, 192, 0.4)` |

## Implementation Sequence

| Step | Scope | Notes |
|------|-------|-------|
| 1 | Theme tokens | Add `groupSquircle*` tokens to `themeDefaults.js` |
| 2 | Selector | Update `buildGroupPills` — add `pieceCount`, anchor to top-left |
| 3 | Render | Replace Konva pill with squircle shape + divider + count in WorkspaceStage |
| 4 | Hover state | Add `onMouseEnter`/`onMouseLeave` for hover glow on the Konva Group |
| 5 | Connections | Update connection routing to use squircle bounds for collapsed groups |
| 6 | Cleanup | Remove old `groupPill*` tokens once squircle is validated |
