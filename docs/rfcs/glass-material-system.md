# RFC: Glass Material System — Transparent Nodes, Health LEDs, and Theme Contract

**Status:** Proposed
**Date:** 2026-04-05
**Owner:** Litria
**Relates to:** ADR-014, `docs/prds/theme-glass-prd.md`, `docs/prds/glass-material-system-prd.md`

---

## 1. Problem

Canvas nodes are opaque black tiles with vestigial puzzle-piece geometry. The Glass theme applies transparency to drawers, modals, and overlays but not to the primary visual element — the node. File health information is not surfaced on nodes. Edge glow and corner highlights are decorative with no semantic meaning. There is no theme contract that would allow additional themes to implement consistent visual channels.

---

## 2. Design Overview

The Glass Material System replaces node rendering with transparent glass tiles and introduces a three-channel visual system:

```
┌─────────────────────────────────────────────┐
│  ═══════ edge assignment (top) ═══════  ◗   │  ← Corner LED (Dot or Arc)
│                                             │
│          [ glass surface ]                  │  ← Near-zero alpha + 6px blur
│          backdrop-blur of canvas            │  ← 180×110 px (was 140×60)
│                                             │
│                                             │
│  SUBLABEL                                   │  ← Bottom-left, auto from parent group
│  filename.ts                                │  ← Bottom-left, text shadow for contrast
│  ═══════ edge assignment (bottom) ═════     │
└─────────────────────────────────────────────┘
         ↑ rim refraction (Snell-inspired)
```

Three channels, three spatial zones, three data sources:
- **Corner LED** — system health (top-right)
- **Edge assignment** — user categorization (top/bottom edges)
- **Rim refraction** — material depth (full perimeter)

---

## 3. Rendering Pipeline

### 3.1 Glass Surface (Konva Backdrop-Blur)

CSS `backdrop-filter` does not work in Canvas. The glass effect is implemented manually in Konva's `sceneFunc`:

```
┌──────────────────────────────────────┐
│  1. Sample    Read pixel region      │
│               behind piece bounds    │
│                                      │
│  2. Blur      Offscreen canvas with  │
│               ctx.filter='blur(6px)' │
│                                      │
│  3. Clip      Mask to piece shape    │
│               via clipFunc           │
│                                      │
│  4. Tint      Apply surface alpha    │
│               rgba(20,24,36, alpha)  │
│                                      │
│  5. Composite Draw rim, LED, label,  │
│               edge assignments       │
└──────────────────────────────────────┘
```

**Performance strategy:**
- Static pieces: render glass once, cache via `node.cache()`
- During drag: recompute only the dragged piece (one piece per frame)
- During pan/zoom: debounce backdrop recalculation (stale blur is imperceptible during motion)
- Cache invalidation: on piece move, viewport change, or theme token change

### 3.2 Snell-Descartes Rim Approximation

Not a physical simulation — uses surface curvature as a proxy for refraction intensity.

```
displacement(point) = scale_factor * (curvature_at(point) / max_curvature) * refractive_index
```

- **Straight edges:** curvature ≈ 0, minimal rim highlight
- **Rounded corners:** curvature = 1/radius, brighter highlight
- **Squircle groups:** continuously varying curvature, undulating highlight

The displacement map is precomputed per piece shape and cached. It only recomputes when:
- Corner radius token changes
- Refractive index token changes
- Piece dimensions change

**Token:** `glassRefractiveIndex` (default 1.5, range 1.0–2.0)

### 3.3 Frosted State (Editor Open)

When the editor drawer opens for a file, the corresponding node transitions to frosted:
- Surface alpha increases from baseline (0) to `--glass-frosted-alpha` (0.75)
- Blur radius may optionally increase
- Rim brightens slightly (border-color alpha increases)
- Transition: 400ms ease

When the editor closes, the node returns to clear glass state.

---

## 4. Corner LED System

### 4.1 Health State Resolution

```
useNodeHealth(filePath) → 'blue' | 'red' | 'amber' | 'green' | 'empty'

Priority waterfall:
  1. Is file dirty (write manager)?      → blue
  2. Are there errors (LSP diagnostics)? → red
  3. Are there warnings (LSP)?           → amber
  4. Has file been analyzed?             → green
  5. Is file empty / no content?         → empty (dim white/grey)
```

Data sources already exist:
- Write manager tracks dirty state per file
- LSP diagnostics are collected per file by LanguageSupportDomain
- No new data pipeline required

### 4.2 LED Styles

User preference stored in settings, two options:

**Dot** — Radial ball indicator
- Circular radial gradient, positioned top-right corner inset 6px
- Size controlled by `--glass-specular-radius` token (default 28px)
- Familiar indicator pattern

**Arc** — L-shaped catchpoint
- Border-top + border-right forming an L that follows corner radius
- Inset 6px from edges, no splash/bleed onto node surface
- Follows `--glass-corner-radius` token — adjusts when corner radius changes
- Reads as a specular catchpoint but functions as a discrete indicator

### 4.3 Animation

| State | Animation | Timing |
|-------|-----------|--------|
| Empty | Static | — |
| Blue (unsaved) | Pulse (opacity 1 → 0.5) | 2.5s ease-in-out infinite |
| Green (clean) | Static | — |
| Amber (warnings) | Static | — |
| Red (errors) | Pulse (opacity 1 → 0.55) | 2.0s ease-in-out infinite |

Pulse uses ease-in-out for a breathing feel rather than a blinking alarm. Only actionable states (unsaved, errors) pulse. Informational states (clean, warnings) are static.

Respects `prefers-reduced-motion` — pulses become static when reduced motion is enabled.

### 4.4 Blue → Save → Health Transition

```
User edits file → LED turns blue (unsaved)
User saves       → blue clears, LSP re-analyzes
LSP reports      → LED transitions to green/amber/red
```

The blue → health color transition is the moment the node goes from "pending work" to "evaluated." It should feel like a small reward — the glass cleared up.

---

## 5. Edge Assignment System

### 5.1 Group Inheritance Model

```
Folder Group ("services", color: orange)
  ├── auth.service.ts    → orange edges, sublabel "SERVICE"
  ├── api.handler.ts     → orange edges, sublabel "SERVICE"
  └── user.service.ts    → orange edges, sublabel "SERVICE"
```

One action — assigning a color to a folder group — produces three effects:
1. **Edge color** propagates to all child nodes
2. **Sublabel text** auto-populates from group name
3. **Spatial clustering** is already handled by group membership

### 5.2 Rendering

Linear gradient on top and bottom edges:
- Starts transparent at left edge
- Fades to assignment color at ~15% from left
- Full intensity at center
- Fades back to transparent at ~85%
- Ends transparent at right edge
- Stops short of rounded corners to preserve LED and rim refraction zones

Gradient is 2px tall, subtle enough to not compete with the corner LED.

### 5.3 Inheritance Rules

- Node with a parent group: inherits group color and name as sublabel
- Node with no parent group: no edge assignment, no sublabel
- Nested groups: innermost group wins
- Custom override: user can set a per-node tag that overrides the group-derived sublabel (edge color still inherited)

---

## 6. Theme Contract Architecture

### 6.1 Token Layers

```
Semantic Tokens (required)          Material Tokens (optional)
─────────────────────────          ──────────────────────────
nodeHealthColor                    glassRefractiveIndex
nodeAssignmentColor                glassBlurRadius
nodeSurfaceAlpha                   glassRimWidth
nodeLedStyle ('dot' | 'arc')       glassSpecularIntensity
nodeCornerRadius                   glassFrostedAlpha
                                   glassSpecularRadius
```

Every theme implements semantic tokens. Material tokens are theme-specific — the Glass theme defines glass-* tokens, a future Terminal theme would define terminal-* tokens (e.g., `terminalScanlineIntensity`).

### 6.2 Theme Examples

| Theme | Surface | Rim | Corner LED | Edge Assignment |
|-------|---------|-----|------------|-----------------|
| **Glass** | Transparent + blur | Snell refraction | Specular catchpoint or dot | Linear gradient |
| **Obsidian** | Dense dark matte | Subtle dark border | Faint ember | Muted side stripe |
| **Terminal** | Black with scanlines | Phosphor glow | Cursor-colored pip | Monochrome bar |
| **Paper** | Warm parchment | Embossed edge | Ink blot tint | Watercolor wash |

### 6.3 CSS Customizability

Themes are primarily CSS custom properties. Users customize by overriding variables:

```css
/* User's "Terminal Violet" variant */
--cm-terminal-accent: #9b59b6;
--cm-terminal-bg: #1a0a2e;
--cm-terminal-scanline: rgba(155, 89, 182, 0.03);
```

Community palettes are shareable as small token files. No theme editor required for palette customization.

### 6.4 User-Exposed Material Settings

The settings drawer exposes material token sliders for the active theme:

| Setting | Token | Range | Default (Glass) |
|---------|-------|-------|-----------------|
| Surface Alpha | `nodeSurfaceAlpha` | 0 – 0.4 | 0 |
| Blur Radius | `glassBlurRadius` | 0 – 30px | 6px |
| Rim Width | `glassRimWidth` | 0.5 – 3px | 1.5px |
| LED Size | `glassSpecularRadius` | 12 – 50px | 28px |
| Corner Radius | `nodeCornerRadius` | 2 – 24px | 12px |
| LED Style | `nodeLedStyle` | dot / arc | dot |

Changes are reactive — no apply button. Values persist per project in `litria.project.json` under the existing `appearance` object.

---

## 7. Integration with Existing Code

### 7.1 Affected Components

| Component | Change |
|-----------|--------|
| `PuzzlePiece.jsx` | Replace `sceneFunc` with glass rendering pipeline, remove tab/slot geometry |
| `EdgeGlow.jsx` | Replace blur glow with edge assignment gradient renderer |
| `themeDomain.js` | Add material tokens, LED style preference, semantic token layer |
| `themeDefaults.js` | Update `GLASS_THEME_TOKEN_DEFAULTS` with new baseline values |
| Settings drawer | Add Glass Material section with token sliders |
| New: `useNodeHealth.js` | Hook aggregating write manager + LSP diagnostics → LED color |
| New: `GlassRenderer.js` | Konva backdrop-blur pipeline (sample → blur → clip → composite) |

### 7.2 Unaffected Systems

- Connection line rendering (unchanged)
- Group nesting/merging behavior (unchanged)
- Editor drawer open/close (unchanged — frosted state is node-side)
- Monaco editor (unchanged)
- Canvas pan/zoom mechanics (unchanged)
- Node drag behavior (unchanged)
- Minimap (unchanged)

### 7.3 Token Migration

Existing Glass theme tokens that change meaning:

| Old Token | Old Value | New Token | New Value |
|-----------|-----------|-----------|-----------|
| `pieceBaseAlpha` | 0.9 | `nodeSurfaceAlpha` | 0 |
| `edgeGlow` | blur-based | `nodeAssignmentColor` | gradient-based |
| `pieceStroke` | decorative | `glassRimWidth` + Snell | material-driven |
| (corner highlight) | muted decorative | `nodeHealthColor` | functional LED |

Migration path: `themeDefaults.js` version bump from 2 → 3 with automatic token remapping.

---

## 8. Folder Group Squircle Consistency

The Glass material applies to folder groups as well as nodes. Squircle geometry produces continuously varying curvature (unlike the node's binary flat/corner), which means:

- Snell rim approximation undulates smoothly around the perimeter
- Surface alpha and blur match nodes (or slightly more transparent for containers)
- Corner LED on groups aggregates children: red if any child has errors, amber if any has warnings, green if all clean
- Group color (edge assignment source) renders as the group's own border tint

Same `glassRefractiveIndex` token drives both — the material is consistent, only the geometry differs.

---

## 9. Phase Plan

| Phase | Scope | Dependencies | Effort | Status |
|-------|-------|-------------|--------|--------|
| **0: Token contract** | Define semantic + material tokens, update `themeDefaults.js` | None | Small | |
| **1: Glass surface** | Konva backdrop-blur pipeline, remove tabs/slots, transparent nodes | Phase 0 | Medium | |
| **2: Corner LED** | `useNodeHealth` hook, Dot + Arc styles, pulse animations | Phase 1 | Small | |
| **3: Edge assignments** | Group color inheritance, gradient renderer, sublabel auto-population | Phase 1 | Small | |
| **4: Rim refraction** | Snell approximation, curvature-driven displacement, cache layer | Phase 1 | Medium | **Implemented** |
| **5: Settings UI** | Material token sliders in settings drawer, LED style toggle | Phases 0-3 | Small | |
| **6: Theme contract** | Semantic/material token separation, theme creation API, CSS variable export | Phase 0 | Medium | |
| **7: Squircle parity** | Apply glass rendering to folder group squircles, aggregate LED | Phase 4 | Small | **Implemented** |
| **7.1: Group aggregate LED** | Rollup health indicator (worst-case of children) | Phase 7 | Small | **Implemented** |

---

## 10. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Backdrop-blur performance during drag | Implemented: samples layer canvas per frame with ctx.filter blur; self-frosting on first render is visually acceptable |
| Snell approximation too subtle to notice | Prototype tuning confirmed visible effect; `glassRefractiveIndex` slider allows user amplification |
| Transparent nodes lose visual presence | Rim, LED, edge assignments, and label shadow provide structural definition independent of fill |
| Theme token migration breaks existing projects | Version-gated migration in `themeDefaults.js` with automatic remapping and fallback |
| Reduced-motion users miss pulse information | Pulse states (blue, red) use distinct colors from static states — color alone communicates status |

---

## References
- ADR-014: `docs/adrs/014-glass-material-system.md`
- PRD: `docs/prds/glass-material-system-prd.md`
- Prototype: `docs/prototypes/prototype-glass-material.html`
- Existing Glass PRD (v1): `docs/prds/theme-glass-prd.md`
- Snell's Law: `n₁ sin(θ₁) = n₂ sin(θ₂)` — approximated, not physically simulated
