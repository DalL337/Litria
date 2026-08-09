# Product Requirements Document
## Glass Material System — Transparent Nodes, Health LEDs, and Theme Contract

**Project:** Litria
**Component:** Canvas / Theme / Node Rendering
**Version:** 1.0
**Status:** Planning
**Relates to:** ADR-014, RFC: Glass Material System, `docs/prds/theme-glass-prd.md` (supersedes diagnostic model)

---

## 1. Overview

The Glass Material System transforms canvas nodes from opaque black puzzle pieces into transparent glass tiles with functional health indicators, user-driven categorization, and a physics-inspired rim treatment. It establishes a universal theme contract that separates semantic channels (what every theme communicates) from material tokens (how a specific theme renders).

This PRD supersedes the diagnostic visualization model (`base/gloss/edgeBloom`) from the v1 Glass PRD. The v1 PRD's infrastructure work (ThemeDomain API, persistence, token resolution) remains valid and is extended here.

---

## 2. Goals

- Deliver transparent glass nodes that match the Glass theme's visual promise and hero image
- Surface file health (errors, warnings, unsaved state) directly on nodes via corner LED
- Enable user-driven file categorization through group-inherited edge colors
- Remove vestigial tab/slot puzzle geometry
- Establish a theme contract architecture supporting future themes (Obsidian, Terminal, Paper)
- Expose material tuning controls to users (alpha, blur, rim, LED size, corner radius)
- Provide two LED styles (Dot and Arc) as user preference

---

## 3. Non-Goals

- No physically accurate raytracing or real Snell-Descartes simulation (curvature-driven approximation only)
- No adoption of `@hashintel/refractive` or other external refraction libraries
- No inline code preview within nodes (code only appears when editor drawer opens)
- No new diagnostic data pipelines — uses existing LSP diagnostics and write manager state
- No theme editor/creator UI in this scope (CSS custom properties serve as the customization layer)
- No changes to connection line rendering, editor drawer, or Monaco integration

---

## 4. Tech Stack Constraints

| Layer | Technology | Notes |
|-------|-----------|-------|
| Canvas rendering | Konva (React-Konva) | Custom `sceneFunc` for glass pipeline |
| Backdrop blur | Canvas 2D API | `ctx.filter = 'blur(Xpx)'` on offscreen canvas |
| Theme tokens | JS object + CSS custom properties | Reactive through existing ThemeDomain |
| Health data | Zustand store selectors | Write manager + LSP diagnostic slices |
| Settings UI | shadcn components | Sliders, toggle, within existing settings drawer |

---

## 5. User Workflows

### 5.1 Passive Health Monitoring

```
User is working on the canvas
  → Glances at nodes
  → Sees corner LEDs at a glance:
     Green tiles = clean files
     Amber tile  = "that file has warnings, I'll check later"
     Red pulse   = "something broke, I should look"
     Blue pulse  = "I forgot to save that one"
  → No clicks required, no panels to open
```

### 5.2 Unsaved Work Recovery

```
User edits a file, closes editor, moves on
  → Node LED turns blue (pulsing gently)
  → User pans across canvas later
  → Spots the blue glow in peripheral vision
  → Opens the file, saves it
  → LED transitions blue → green (or amber/red if diagnostics find issues)
```

### 5.3 File Categorization

```
User has a folder group "services" on canvas
  → Right-clicks group, assigns color: orange
  → All child nodes immediately show orange edge gradients
  → All child nodes show "SERVICE" sublabel
  → User drags a new file into the group
  → New file inherits orange edges and sublabel
  → User zooms out: orange cluster is identifiable at a distance
```

### 5.4 Material Tuning

```
User opens Settings → Appearance → Glass Material
  → Adjusts Surface Alpha slider (0 → 0.15)
  → Nodes gain slight dark tint in real time
  → Adjusts Blur Radius (6 → 10)
  → Backdrop frost intensifies
  → Switches LED Style from Dot to Arc
  → Corner indicators reshape to L-catchpoints
  → All changes are live, no apply button
  → Settings persist per project
```

---

## 6. Node Visual Specification

### 6.1 Default State (Clear Glass)

```
┌─────────────────────────────────────────────┐
│  ── ── ── edge gradient (2px) ── ── ──  ◗   │
│                                             │
│            [ transparent surface ]          │  180×110 px
│           6px backdrop blur                 │
│           0 surface alpha                   │
│                                             │
│                                             │
│  SUBLABEL (9px, uppercase, 0.6 opacity)     │  ← bottom-left (14px from left, 32px from bottom)
│  filename.ts (12px, mono, text-shadow)      │  ← bottom-left (14px from left, 18px from bottom)
│  ── ── ── edge gradient (2px) ── ── ──      │
└─────────────────────────────────────────────┘
  ↑ 1.5px rim, Snell-driven brightness
  ↑ 12px corner radius
```

### 6.2 Frosted State (Editor Open)

```
┌─────────────────────────────────────────────┐
│  ── ── ── edge gradient ── ── ── ── ──  ◗   │
│                                             │
│            [ frosted surface ]              │
│           surface alpha: 0.75              │
│           rim brightens                     │
│                                             │
│  filename.ts (label repositions)            │
│  ── ── ── edge gradient ── ── ── ── ──      │
└─────────────────────────────────────────────┘
  Transition: 400ms ease
```

### 6.3 Corner LED — Dot Style

```
  ┌─────────────────┐
  │             (●)  │  ← 28px radial gradient
  │                  │     6px inset from edges
  │                  │     radial-gradient with glow
```

### 6.4 Corner LED — Arc Style

```
  ┌─────────────────┐
  │            ┐     │  ← L-shaped border-top + border-right
  │            │     │     follows corner radius
  │                  │     6px inset, no splash
```

### 6.5 Edge Assignment

```
  transparent ─── fade in ─── full color ─── fade out ─── transparent
  |   0%    |    15%    |       50%       |    85%    |    100%   |
                     stops short of corners
```

2px height, linear gradient, inherited from parent folder group color.

---

## 7. Corner LED Specification

### 7.1 Health States

| State | Color | Animation | Trigger |
|-------|-------|-----------|---------|
| Empty | `rgba(180, 180, 190, 0.5)` | Static | File has no content |
| Blue | `rgba(60, 140, 255, 0.95)` | Pulse 2.5s ease-in-out | Write manager reports dirty |
| Green | `rgba(50, 205, 100, 0.9)` | Static | LSP: 0 errors, 0 warnings |
| Amber | `rgba(240, 180, 40, 0.9)` | Static | LSP: 0 errors, 1+ warnings |
| Red | `rgba(240, 60, 60, 0.95)` | Pulse 2.0s ease-in-out | LSP: 1+ errors |

### 7.2 Priority Resolution

```
if (isDirty)                    → blue
else if (diagnostics.errors > 0) → red
else if (diagnostics.warnings > 0) → amber
else if (fileIsEmpty)           → empty
else                            → green
```

### 7.3 Accessibility

- Color alone communicates status — sufficient contrast between all five states
- Pulse respects `prefers-reduced-motion` (becomes static)
- LED size adjustable via settings (12–50px range)

---

## 8. Material Token Defaults

| Token | Default | Range | Exposed in Settings |
|-------|---------|-------|---------------------|
| `nodeSurfaceAlpha` | 0 | 0 – 0.4 | Yes |
| `glassBlurRadius` | 6px | 0 – 30px | Yes |
| `glassRimWidth` | 1.5px | 0.5 – 3px | Yes |
| `glassSpecularRadius` | 28px | 12 – 50px | Yes |
| `nodeCornerRadius` | 12px | 2 – 24px | Yes |
| `glassRefractiveIndex` | 1.5 | 1.0 – 2.0 | No (advanced) |
| `glassFrostedAlpha` | 0.75 | — | No |
| `nodeLedStyle` | `dot` | `dot` / `arc` | Yes |

---

## 9. Phasing

### Phase 0: Token Contract — **Status: Implemented**
- Define semantic + material token schemas
- Update `GLASS_THEME_TOKEN_DEFAULTS` to version 3
- Add migration path from version 2 tokens
- **Exit:** Token contract reviewed, migration tested

### Phase 1: Glass Surface + Tab/Slot Removal — **Status: Implemented**
- Remove tab/slot geometry from `PuzzlePiece.jsx`
- Nodes render as rounded rectangles
- Implement Konva backdrop-blur pipeline (`GlassRenderer.js`)
- Apply baseline values (alpha 0, blur 6px, corner radius 12px)
- Implement frosted state transition on editor open/close
- **Exit:** Nodes render as transparent glass tiles, no tabs/slots, no regressions to drag/drop/connections

### Phase 2: Corner LED — **Status: Implemented**
- Implement `useNodeHealth(filePath)` hook
- Render Dot LED style with all five health states
- Render Arc LED style with all five health states
- Add LED style toggle to settings
- Implement pulse animations with reduced-motion support
- **Exit:** LEDs display correct health state for all nodes, toggle works, pulses animate

### Phase 3: Edge Assignments — **Status: Implemented**
- Add color property to folder group data model
- Implement gradient renderer for top/bottom edge assignments
- Implement sublabel auto-population from group name
- Propagate group color to child nodes on group membership change
- **Exit:** Coloring a group colors all children, sublabel populates, drag-in/drag-out updates correctly

### Phase 4: Rim Refraction — **Status: Implemented**
- Implement curvature-driven Snell approximation
- Precompute displacement map per piece shape
- Apply to node rounded rectangles
- Apply to folder group squircles
- Cache displacement maps with invalidation on radius/index change
- **Exit:** Rim highlight varies with curvature, consistent across nodes and groups

### Phase 5: Settings UI + Polish — **Status: Implemented**
- Add Glass Material section to settings drawer
- Implement sliders for all user-exposed tokens
- Reactive updates (no apply button)
- Persist tuned values per project
- Add group LED aggregation (rollup of children's health)
- **Exit:** All sliders functional, values persist across restart

### Phase 6: Theme Contract — **Status: Partial**
- Separate semantic tokens from material tokens in ThemeDomain
- Define theme creation API (extend existing v1 PRD API)
- Export theme tokens as CSS custom properties
- Document theme authoring guide
- **Exit:** A second theme (e.g., Obsidian stub) can implement the contract and render nodes with different material treatment

---

## 10. Acceptance Criteria

- [x] Nodes render as transparent rounded rectangles (no tabs, no slots)
- [x] Glass surface shows backdrop blur at 6px baseline
- [x] Corner LED displays correct health state per file (blue/green/amber/red/empty)
- [x] Blue LED activates on unsaved changes, clears on save
- [x] Red/blue LEDs pulse with ease-in-out timing
- [x] Pulse respects `prefers-reduced-motion`
- [x] Dot and Arc LED styles both function, toggleable in settings
- [x] Edge assignment color inherits from parent folder group
- [x] Sublabel auto-populates from parent group name
- [x] Rim refraction varies with corner curvature
- [x] Frosted state activates when editor opens, clears when editor closes
- [x] Material token sliders in settings are reactive (no apply button)
- [x] Settings persist per project in `litria.project.json`
- [ ] No regressions to: drag/drop, connections, grouping, editor drawer, minimap
- [ ] Theme contract separates semantic tokens from material tokens
- [x] Canvas grid renders as subtle reference pattern (theme-controllable opacity)

---

## 11. Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Konva backdrop-blur performance | Frame drops during drag | Cache static pieces, recompute only active piece, debounce on pan/zoom |
| Transparent nodes hard to see on dark canvas | Nodes feel invisible | Rim, LED, edge assignments, text shadow provide structure; subtle canvas grid gives transparency something to refract |
| Tab/slot removal breaks existing projects | Layout shifts on load | Piece dimensions unchanged — tabs/slots were visual only, not structural |
| Token migration from v2 to v3 | Existing Glass theme settings lost | Automatic migration with sensible defaults, no user action required |
| LED colors insufficient for colorblind users | Health states ambiguous | Distinct brightness levels per state; Dot/Arc shape provides secondary channel; future: icon overlay option |

---

## 12. Open Questions

- Should the canvas grid pattern be opt-in or default-on for the Glass theme?
- Should folder group squircle surface be slightly more transparent than nodes (since groups are containers, not files)?
- Should the group aggregate LED show the worst-case child, or a proportional indicator (e.g., "3 red, 2 green")?
- Should there be a minimum blur floor (e.g., 2px) to prevent nodes from becoming invisible outlines?
- Should edge assignment gradients animate when a node is dragged into or out of a group?

---

## References
- ADR-014: `docs/adrs/014-glass-material-system.md`
- RFC: `docs/rfcs/glass-material-system.md`
- Prototype: `docs/prototypes/prototype-glass-material.html`
- Existing Glass PRD (v1): `docs/prds/theme-glass-prd.md`
- Existing ThemeDomain API: `docs/prds/theme-glass-prd.md` (Orchestration section)
