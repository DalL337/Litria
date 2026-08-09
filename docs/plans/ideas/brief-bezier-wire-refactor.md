# Brief: Bezier Wire Refactor (Connection Layer)

> **For:** Claude Code
> **Scope:** Connection rendering + existing-wire interactions in the canvas layer. Replaces straight dashed connection lines with bezier wires, adds a directional chevron revealed on hover/select, and exposes modeless select / delete / add-symbol actions on existing wires.
> **Stack:** Rust, React 19 + react-konva, Tauri v2, Lucide icons.
> **Status:** Three-phase handoff. Land and verify each phase before starting the next.

> **Supersession note (2026-07-29, owner ruling — edge-routing session):**
> Phase 1's **rest-state** decisions — the 5px status-colored resting gauge
> and the wire as an always-on status-color channel — are superseded by the
> Wire Visual Language in `brief-edge-routing.md`: wires rest thin, solid,
> and neutral; *unhealthy* wires rest popped (exception-based status); hover
> pops with health color + glow; click holds the pop. The compute-points /
> draw-curve seam, normal-launch geometry, chevron (Phase 2), and modeless
> interactions (Phase 3) all stand unchanged.

---

## Context

Litria renders connections between glass-tile nodes as straight dashed `Line` elements in `ConnectionLine.jsx`, drawn in the single canvas `<Layer>` in `WorkspaceStage.jsx` (after group outlines, before pieces). We are refactoring these to bezier wires for a cleaner look that **mimics conventional node editors** — the familiar visual language lowers the adoption barrier for users coming from those tools, and it's the foundation the later routing work builds on.

Ground truth before you start (verified against the code — earlier drafts of this brief got several of these wrong):

- **Anchoring:** wires connect at **edge midpoints**, and the user *deliberately picks the edge*. Source side comes from drag direction; target side from where the user drops on the target's edge (`useConnectionDrag.js`). A wire can be `right→left`, `bottom→top`, `right→bottom`, anything. Honor the chosen edges.
- **Color:** wire color is **status-driven**, not folder-group-driven. It comes from `syntaxStatus` first (`broken`/`orphaned`/`drifted`/`unused`/`pending`/`resolved`), falling back to piece-health status, resolved against theme tokens (`ConnectionLine.jsx`). Preserve this exactly.
- **Type:** the connection `type` field is **always `'reference'`** — there is no `reference` vs `syntax` distinction to read. The meaningful per-connection signal is `syntaxStatus`, and it already drives color.
- **Edge = bundle:** a single edge between two nodes carries a *set* of symbols. "Adding to a connection" means growing that symbol set, not drawing a second edge.
- **Direction:** the model is directional, and **both directions can coexist** (`A→B` and `B→A`), `useConnections.js`. Direction is not conveyed visually today.
- **Interaction modes (ADR-013):** Edit mode is narrowly the **group-membership** mode — `additive` joins a dragged node to a group, `subtractive` extracts it (`useCanvasInteractionController.js`). It is *not* a general mutation gate. **Node deletion is modeless** (select → context-menu Delete, `GroupMenuOverlay.jsx`).

This is a **render + interaction-layer change**. Do not touch:
- The connection domain (CRUD, edge midpoint queries, cascade delete) beyond wiring the existing delete/add-symbol entry points to the new UI affordances.
- Connection data structures or the `type` field.
- Any persistence (SQLite editor/connection state) or the syntax domain's symbol storage.

The wire's geometry and the wire's drawing must be kept as **two separate functions** (see Architectural Seam below). This is the single most important instruction in this brief.

---

## Architectural Seam (load-bearing — do not blur)

Split wire rendering into two distinct responsibilities:

1. **Compute the point list** — a function that takes the source and target node anchor points (and their chosen edges) and returns an ordered array of points the wire passes through. **Today this returns exactly `[start, end]`.** No awareness of other nodes. No collision logic.

2. **Render a smooth curve through the point list** — a function that takes an ordered array of points and draws a bezier through them. It does not know or care how the list was produced. It can also answer "point + tangent at parameter `t`" from the same control points (needed by the chevron in Phase 2).

These must be separate functions with a clean boundary. Do not inline the curve math into the component, and do not let the point-computation reach into rendering.

**Why:** the eventual destination is routing — wires that **respect other node positions, curve around them, and loop around corners**, matching the node-editor visual language. That feature inserts waypoints into the point list (job 1) without touching the drawing code (job 2). Keep that seam clean now so routing is a drop-in later. **Do not build routing or collision detection in this brief** — just preserve the seam.

---

## Phase 1 — Bezier Wires

**Goal:** every connection renders as a smooth bezier instead of a straight dashed line.

### Requirements

- Wires use a **normal-launch** control-point strategy: each endpoint's control point is offset **perpendicular to the chosen edge** (`right`→+x, `left`→−x, `top`→−y, `bottom`→+y). This is the faithful node-editor rule — wires leave a port along its face normal — and it honors the user's deliberate edge choice across vertical/mixed anchors, not just the left↔right case. (A horizontal-only launch would bulge sideways on a wire someone anchored top/bottom and look broken — do not use it.)
- The offset magnitude **scales with the distance between the two anchors** so short wires don't kink and long wires don't balloon. A clamped fraction of the relevant delta (sane min and max) is fine. Expose min / max / fraction as **named constants** — not magic numbers buried in the function.
- Bezier is **always on**. No straight-line mode, no toggle. The straight dashed path is fully removed from the connection render.
- Wires still connect at **edge midpoints**, exactly as today.
- Wire color still derives from the existing **status logic** (`syntaxStatus` → piece-health → theme tokens), exactly as today. Whatever `stroke` the wire gets today, the bezier gets.
- **Thickness ("gauge"):** the wire is also the **status-color channel**, so it needs enough body to carry color legibly — not just topology like a typical node editor. Target a 16–18 gauge / lamp-cord presence: substantial, readable, not domineering. Against the 180×110 tile, that's **5px at zoom 1.0** (up from today's 3px). State ladder: rest 5px, hover 6px, selected 6px **plus a soft outer glow** (distinguish selection with a halo, not extra width — matches the glass aesthetic).
- **Thickness under zoom:** wires are canvas-space and **scale with zoom** (proportional shrink is the familiar node-editor feel and keeps zoom-out useful for overview), **but clamp the on-screen result** so the color channel never vanishes when zoomed out or balloons when zoomed in — floor ~2px, cap ~9px on screen. (Contrast: the Phase 2 chevron is pure screen-space; a continuous line reads better scaling-with-a-floor than held constant.)
- Expose all thickness values as **named constants**, not magic numbers:
  ```
  WIRE_STROKE_REST     = 5
  WIRE_STROKE_HOVER    = 6
  WIRE_STROKE_SELECTED = 6   // + glow, not extra width
  WIRE_STROKE_MIN_PX   = 2   // on-screen floor (applied after zoom)
  WIRE_STROKE_MAX_PX   = 9   // on-screen cap (applied after zoom)
  ```
  These are starting points — expect to retune by eye once it's on screen.
- Preserve all existing connection behavior: one connection per direction, cascade delete, selection highlight.
- The natural "bow-out when the target sits behind the source" falls out of normal-launch for free — that's expected and desirable (it's the familiar loop), and it is *not* routing.

### Konva implementation notes

- Use a Konva `Path` with a cubic-bezier `data` string, or a `Line` with `bezier={true}` and computed control points — whichever keeps the point-list → render seam cleanest.
- Keep the wire in the **existing single canvas layer** at its current position in render order (group outlines → connections → pieces). Do not add a new layer.
- Respect existing pan/zoom — wires are in canvas space and transform with everything else.

### Acceptance (Phase 1)

- All existing connections render as bezier curves with normal-launch control points.
- Short, vertically-stacked, and mixed-edge connections all look clean — the curve leaves each node perpendicular to the chosen edge, no sideways bulge that contradicts the anchor.
- Status colors are unchanged from today.
- Rest wires read at ~5px (zoom 1.0); hover/selected thicken per the ladder, with selection carrying a glow rather than only extra width.
- Wire thickness scales with zoom but stays within the ~2px floor / ~9px cap on screen — status color stays readable at 0.25x and doesn't dominate at 1.5x.
- Selection highlight still works on the new wire.
- No straight-line / dashed code path remains.
- `npm run check:architecture` and `npm run test:domains` pass unchanged (render change; domain tests should be unaffected — if any break, **stop and report** rather than editing tests to fit).

**Stop here. Hand back for visual verification before Phase 2.**

---

## Phase 2 — Directional Chevron (hover / select only)

**Goal:** a single direction-indicating chevron appears on a wire only when hovered or selected. Resting canvas stays clean curves with no arrows.

### Requirements

- Exactly **one chevron per active wire**, positioned at **~60% along the curve** (toward the target — reads better than the midpoint on an S-curve).
- The chevron is **oriented to the curve's tangent** at that point, so it points along the wire source → target. This disambiguates the case where both `A→B` and `B→A` exist as overlapping wires.
- Rendered **only when the wire is hovered or selected.** Resting state: no chevron. (Selection is introduced modelessly in Phase 3; until then, drive off hover.)
- The chevron **inherits the wire's status color** — it does *not* encode connection type. There is no `reference`/`syntax` axis to encode; status is already the color channel, and the chevron's only job is direction. Keep one source of truth.
- Size the chevron in **screen space** (constant on-screen size regardless of zoom) so it stays legible. Only one or a few render at a time, so this is cheap.
- Use a **chevron** (open `>` shape), not a filled triangle — lighter, matches the glass aesthetic. Prefer `ChevronRight`-style geometry; otherwise draw it directly in Konva.
- The chevron is a **separate, conditional decoration** — keep it out of the wire-geometry and wire-drawing functions. It reads "is this wire active?" and draws itself. Killing or restyling it later must not touch wire code.

### Curve-point math note

To place and orient the chevron, ask the renderer's geometry for **point + tangent at `t≈0.6`** on the bezier, computed from the *same* control points the renderer uses. Do not re-derive a separate curve. Renderer asks for "full path"; chevron asks for "point + tangent at `t`." Same source of truth.

### Acceptance (Phase 2)

- Resting canvas shows clean curves, zero chevrons.
- Hovering or selecting a wire shows exactly one chevron, correctly oriented toward the target.
- Chevron color matches the wire's status color.
- Chevron stays the same on-screen size across the zoom range (0.25x–1.5x).
- Removing the chevron render block leaves wires fully intact (proves decoupling).

**Stop here. Hand back for verification before Phase 3.**

---

## Phase 3 — Modeless Wire Interactions (select / delete / add-symbol)

**Goal:** make existing wires selectable, deletable, and augmentable — **modeless**, mirroring how nodes already behave (select → context action). These must *not* be gated behind Edit mode.

### Why modeless

Node deletion today is modeless: select a node, pick **Delete** from the context menu (`GroupMenuOverlay.jsx`). Edit mode is only the group-membership drag mode. Gating wire actions behind Edit mode would create the exact asymmetry to avoid ("delete a node by selecting it, but enter a mode to delete a wire?"). Wires mirror nodes.

### Requirements

- **Select:** clicking a wire selects it (highlight), the same way a node selects. Hovering reveals the chevron (Phase 2); selecting holds it. Introduce only the connection-selection state needed — there is none today.
- **Delete edge:** a context action on the selected/hovered wire removes the whole edge, reusing the existing connection-delete entry point (`handleDeleteConnection`). Use the same context-menu affordance pattern nodes use, or inline buttons on the wire. Retire the legacy Shift+right-click delete chord once this lands. Undo is already covered by the FSM delete journal — no extra guardrail needed.
- **Add-symbol:** a context action that **reopens the symbol picker** to grow the edge's existing symbol bundle. This is *not* a new edge and creates no second wire — it appends to the set of symbols the edge already carries. Wire it to the existing symbol-picker entry point; do not build new symbol storage.
- All three are **modeless** — available in default mode off selection/hover, no Edit-mode toggle.

### Acceptance (Phase 3)

- A wire can be selected, and the selection reads visually like a selected node.
- Deleting a selected wire removes the edge and is undoable, with no remaining Shift+right-click delete path.
- "Add-symbol" reopens the picker against the existing edge and grows its bundle without drawing a second wire.
- None of select / delete / add-symbol require Edit mode.

---

## Out of Scope (do not build — note only)

- **Wire routing / collision avoidance** ("curve around other nodes, loop around corners"). The destination, but a future layer. The point-list seam is the only accommodation for it here.
- **New-edge creation gesture.** Stays on the existing drag/shortcut for now. The *only* candidate for moving into Edit mode later is new-edge creation as an `additive` drag (node→node, paralleling drag-node-into-group) — separate from the three existing-wire actions in Phase 3.
- Any change to connection `type`, CRUD internals, or persistence.
- Multi-pin / multi-anchor nodes.

---

## Summary for the agent

1. Split wire rendering into **compute-points** (returns `[start, end]` today, honoring chosen edges) and **draw-curve** (bezier through the points, also answers "point + tangent at `t`"). Keep the seam clean.
2. **Phase 1:** normal-launch bezier wires (perpendicular to each chosen edge), offset scaled by anchor distance, always on, no toggle, status color preserved. Verify, hand back.
3. **Phase 2:** one screen-space chevron at ~60% along the curve, tangent-oriented, **status-colored** (no type axis), hover/select only, fully decoupled from wire code. Verify, hand back.
4. **Phase 3:** modeless select / delete-edge / add-symbol on existing wires, mirroring node behavior — not gated behind Edit mode. Delete reuses `handleDeleteConnection`; add-symbol reopens the symbol picker against the existing bundle.
5. Touch only render + the wire-interaction wiring. Domain, types, and persistence stay untouched. If domain tests break, **stop and report**.
