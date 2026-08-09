# ADR-014: Glass Material System and Theme Contract Architecture

## Status
- Accepted — Implemented (PR #35, 2026-04-05)
- Amended 2026-06-13 — Edge Assignment moves to a **left-edge** channel; edge color is a **cascade** (ad-hoc override → inherited → ungrouped default), superseding the "per-node rejected" alternative; LED/glow are **static-only** (no animation). See "Amendment (2026-06-13)" below.

## Date
- 2026-04-05
- 2026-06-13 (amendment)

## Context

Litria's node rendering carries visual debt from its original puzzle-piece metaphor:

**1. Tabs and slots no longer serve a purpose.** Slots stopped rendering some time ago. Tabs are barely visible. Both are carry-overs from the v1 puzzle-piece design where interlocking geometry communicated file relationships. In practice, connections are communicated through lines and spatial grouping — the puzzle geometry is redundant visual noise.

**2. Nodes are opaque black tiles that contradict the Glass theme identity.** The Glass theme promises transparency — the hero image shows glass tiles, the drawers and modals use `backdrop-filter` frosting — but the canvas nodes are solid dark rectangles. There is a visual promise the app does not deliver.

**3. The existing diagnostic visualization model (base/gloss/edgeBloom) was never implemented and is overly complex.** The v1 Glass PRD defined three diagnostic layers — `base` (internal integrity), `gloss` (code structure), `edgeBloom` (connectivity) — each with five severity levels. This model requires three independent diagnostic pipelines per node and maps to visual channels that overlap spatially (all rendered on the same piece surface).

**4. No unified theme contract exists.** The current Glass theme is the only theme. There is no abstraction separating what every theme must implement (semantic channels) from what a specific theme chooses to implement (material-specific rendering). Building additional themes (Obsidian, Terminal, Paper) would require ad-hoc decisions about which visual behaviors to replicate.

**5. The existing corner highlight and edge glow compete for the same visual register.** Both are decorative, low-opacity effects with no semantic meaning. They occupy similar visual weight and neither communicates actionable information.

## Decision

Replace the current node rendering model with a **Glass Material System** built on three principles:

### 1. Nodes become glass tiles

Remove tabs and slots. Nodes are rounded rectangles with near-zero surface alpha and a light backdrop blur. The node's visual identity comes from its rim, corner indicator, edge assignment, and label — not its fill. Transparency is the default state; opacity increases only when the editor is open (frosted state).

Baseline values established through prototype testing:
- Surface alpha: 0
- Blur radius: 6px
- Corner radius: 12px
- Rim width: 1.5px

### 2. Three-channel visual system

Replace the `base/gloss/edgeBloom` model with three spatially separated channels that each serve one purpose:

| Channel | Location | Data Source | Purpose |
|---------|----------|-------------|---------|
| **Corner LED** | Top-right corner | System (LSP diagnostics, write manager) | File health status |
| **Edge Assignment** | Top/bottom edge gradients | User (inherited from parent group) | Categorization |
| **Rim Refraction** | Full perimeter | Theme (material properties) | Depth and materiality |

Channels occupy distinct visual zones and cannot conflict.

### 3. Universal theme contract

Separate theme tokens into two layers:

- **Semantic tokens** — every theme must implement: `nodeHealthColor`, `nodeAssignmentColor`, `nodeSurfaceAlpha`. These define what the three channels communicate.
- **Material tokens** — theme-specific, optional: `glassRefractiveIndex`, `glassBlurRadius`, `glassRimWidth`. These define how a particular theme renders the channels.

This allows future themes (Obsidian, Terminal, Paper) to implement the same semantic contract with entirely different visual treatments. Themes are primarily CSS custom properties, enabling community palette customization without building a theme editor.

### Snell-Descartes inspired rim rendering

The glass rim uses surface curvature to drive highlight intensity — an approximation of Snell's Law (`n₁ sin(θ₁) = n₂ sin(θ₂)`) rather than a physical simulation. Where corner radius is tight, the rim is brighter; where edges are straight, the rim is subtle. A single `glassRefractiveIndex` token scales the effect globally. This applies uniformly to nodes (rounded rectangles) and folder groups (squircles), producing consistent material behavior from different geometries.

### Corner LED replaces diagnostic layers

The corner LED aggregates health into a single indicator per node with clear priority:

1. **Blue** (pulse 2.5s) — unsaved changes (dirty state from write manager)
2. **Red** (pulse 2s) — errors present (from LSP diagnostics)
3. **Amber** (static) — warnings present (from LSP diagnostics)
4. **Green** (static) — clean, diagnostics passed
5. **Dim white/grey** (static) — empty file, no content to evaluate

Two LED styles offered as user preference: **Dot** (radial ball) and **Arc** (L-shaped catchpoint following corner radius).

### Edge assignment inherits from folder groups

Edge color is not per-node. Coloring a folder group propagates to all child nodes as thin linear gradients on top and bottom edges. The sublabel text (e.g., "SERVICE", "API") auto-populates from the group name. One user action — coloring a group — drives edge color, sublabel text, and spatial clustering.

## Consequences

### Positive
- Visual identity aligns with Glass theme promise and hero image
- Three-channel system eliminates visual competition between indicators
- Corner LED provides at-a-glance file health using data already flowing through LSP and write manager
- Edge assignment gives users spatial categorization with zero per-node configuration
- Theme contract enables future themes without ad-hoc visual decisions
- CSS custom property layer enables community palette sharing
- Removing tabs/slots simplifies piece geometry, reduces draw complexity, and makes Snell rim computation uniform
- User-exposed material token sliders allow personal tuning of glass density
- Backdrop-blur implemented via Canvas pixel sampling from layer canvas with `ctx.filter` blur
- LED pulse animations via `Konva.Animation` with `prefers-reduced-motion` support

### Negative
- Backdrop-blur samples from current frame's layer canvas (includes self-pixels on first render — produces subtle self-frosting that reads as glass density)
- Snell rim approximation adds a precomputation step per piece shape (mitigated by caching)
- Breaking change to existing node rendering — existing Glass theme token values will need migration
- Two LED styles (Dot/Arc) means additional settings surface

### Neutral
- Existing connection line rendering is unchanged
- Group nesting behavior is unchanged
- Editor drawer behavior is unchanged — frosted state is an alpha increase on the node, not a drawer change
- The v1 Glass PRD's Phase 1 work (token model, persistence, ThemeDomain API) remains valid infrastructure

## Alternatives Considered

### Adopt `@hashintel/refractive` library
Rejected. Chrome-only (Firefox/Safari fall back to plain blur). Early beta with API instability. Performance concerns from client-side displacement map calculation. Cannot operate on Canvas/Konva layer — DOM/CSS only. Custom Konva implementation provides better cross-browser support and per-pixel control.

### Keep `base/gloss/edgeBloom` diagnostic model
Rejected. Three diagnostic layers per node requires three independent data pipelines with five severity levels each. The visual output (three overlapping effects on the same surface) is harder to parse than a single corner indicator. The model was never implemented and the simpler LED approach provides equivalent information at lower complexity.

### Per-node edge color assignment
Rejected in favor of group inheritance. Per-node coloring requires individual configuration of every node. Group inheritance provides the same visual result with one action per group. Users who need per-node overrides can use a single-file group.

## References
- Prototype: `docs/prototypes/prototype-glass-material.html`
- Supersedes diagnostic model in: `docs/prds/theme-glass-prd.md`
- Related: ADR-013 (Action Token Modifier System — modifier key interactions on canvas)
- Design concept: Glass Material System memory doc (2026-04-04)

## Amendment (2026-06-13): Left-edge color channel + color cascade + static-only

Revises the Edge Assignment channel and the LED animation spec, driven by the minimap-prototype rethink and the New Project Wizard landing (B1). Full design rationale: `docs/plans/canvas/node-visual-language-plan.md`.

### Edge Assignment moves to the LEFT edge only
The Edge Assignment channel (originally "top/bottom edge gradients", §2 table and §"Edge assignment inherits…") now renders as a single **left-edge** vertical accent. Cleaner and more minimal, and it reads as a "color spine" that survives at low zoom (validated in the minimap prototype). The top/bottom gradients are retired.

### Edge color is a cascade, not group-only
The original "Per-node edge color assignment — Rejected" alternative is **superseded**. Edge color resolves through a three-tier cascade, highest priority first:

1. **Ad-hoc per-node override** — `piece.color`, set in the moment via the node actions pill. **Sticky**: survives moving the node to another folder; cleared only via an explicit reset/inherit action.
2. **Inherited organizational** — child borrows its parent group/directory color (`group.color` via `buildGroupColorByPieceId`).
3. **Ungrouped default** — a project setting (`nodeUngroupedEdgeColor`), chosen in the New Project Wizard, for root/loose nodes.

Folder/group color is likewise editable ad hoc after the wizard. **Governing principle:** the wizard sets initial defaults, but node and folder colors stay editable forever — people change their minds.

Resolution is a single shared pure function (`resolveNodeEdgeColor`) consumed by BOTH the live canvas and the wizard's choice-preview, so the preview is guaranteed to match what the project actually renders.

### LED + glow are STATIC — no animation
Supersedes the LED "pulse" spec (§"Corner LED replaces diagnostic layers": "Blue pulse 2.5s" / "Red pulse 2s"; and "LED pulse animations via `Konva.Animation`" under Consequences). LEDs and edge glow are **never animated** — static color only. Settled performance decision: the `Konva.Animation` LED pulse forced a 60fps redraw per dirty LED and stole the canvas frame budget from drag/pan/zoom at scale. State/color alone is a sufficient signal. Do not re-introduce canvas-thread animation for status.

### Live / Calm = static intensity axis
The Live/Calm variants (one theme, two energy levels) are a **static** intensity axis layered on these tokens — Live = vivid (fuller left-edge glow, saturated colors, brighter LED), Calm = low-stimulus (muted/desaturated, softer or flat edge, dimmer LED) for accessibility / sensory comfort / the VR endpoint. No motion in either; implemented as two preset sets of static token values. (Supersedes the "post-beta" framing — with animation off the table, this is cheap token work folded into the beta set.)

### Delivery
Three coordinated steps (see the plan doc): (1) node left-edge language [this amendment], (2) wizard landing rendering through the shared resolution, (3) Live/Calm presets.
