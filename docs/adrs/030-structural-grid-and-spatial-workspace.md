# ADR-030: Structural Grid and Spatial Workspace Boundary

## Status

- Accepted direction — 2026-09-17 (owner discussion: top-left corner anchoring,
  Strict/Flex placement, routing accommodation after snapping, and a future
  inhabitable VR/AR workspace). Implementation has not begun.
- Proposed implementation detail — 2026-09-17 (the accompanying brief proposes
  ownership, storage, candidate arbitration, and delivery slices; numerical
  defaults and remaining interaction choices are not ratified by this record).

## Date

2026-09-17

## Context

The canvas already has world coordinates, Home navigation to `(0,0)`, and a grid
rendered in world space. The visible grid does not currently supply placement
targets: snapping is a separate neighbor-alignment operation. Theme editing
controls limited grid paint, and the grid ends at a fixed extent.

Litria's wire-routing behavior includes opening corridors through adjacent
nodes, with cascading movement of neighboring chains. The owner requires this
behavior to remain available with a structural grid, permitting limited tuning
while preserving the existing routing method as far as possible.

The owner also intends a future VR/AR experience in which the user inhabits a
customizable space with nodes, wires, and grid around them. The long-term target
is broader than a flat board in a room. Current implementation scope remains 2D.

The [structural-grid brief](../plans/canvas/brief-structural-grid.md) is the
**canonical detailed design**, including verified source findings, proposed
contracts, file-level edits/removals, unresolved choices, implementation order,
and validation. Observations were checked against `ef4c2a3` on 2026-09-17.

## Decision

### 1. Grid geometry is shared world structure

The grid has one applied world-space definition used by placement and rendering
and available to routing. Its major, minor, and sub levels form a coherent
subdivision hierarchy. Home and the grid reference the same origin.

Camera zoom and pan change presentation, not grid coordinates or saved node
positions. Level visibility and line thickness may adapt to zoom without changing
the available placement lattice. Exact intervals and defaults belong to the
detailed design and tuning process, not this ADR.

### 2. Placement anchors at the node body's top-left corner

Use the body's top-left corner, excluding decorative extent. Existing stored
node coordinates already have this meaning; there is no center-origin migration.
Centers and connection locations remain derived from actual bounds.

Group/selection movement must preserve internal arrangement rather than
independently quantizing each member. The precise moving-set anchor is specified
in the brief before implementation.

### 3. Strict and Flex govern intended placement

Strict targets major grid intersections. Flex permits major, minor, and sub
intersections, with a short animated slide into the resolved arrangement.
This choice is separate from existing default/edit and additive/subtractive
interaction modes.

Changing snap mode, zoom, theme appearance, or grid visibility never rearranges
existing nodes. Neighbor docking's precedence relative to grid candidates is an
explicit interaction decision in the brief; it must not emerge accidentally from
helper execution order.

### 4. Routing accommodation follows placement and may override grid alignment

Preserve ADR-025's wire corridor and adjacency accommodation behavior. Once an
intended placement is resolved, routing may part adjacent nodes and move their
neighboring chains to preserve a usable connection. These movements may leave
corners off major, minor, or sub lines, including in Strict mode.

Do not follow accommodation with a resnap that closes the corridor. Preserve
exact clearance and multi-wire separation rather than rounding them to a major
step or forcing every route onto grid lines. Retain chosen-side authority,
dynamic terminal placement, obstacle avoidance, route stability, and the existing
fallback/protection rules.

This decision extends the placement context of
[ADR-025](025-edge-routing-wire-visual-language.md); it does not remove formal
group-interior protections, authorize unlimited cascades, or require replacement
of the sparse orthogonal router. Any extension of those behaviors needs its own
explicit scope.

### 5. Resolved positions are real project state

The triggering move/connection action and its routing accommodation form one
undoable operation. Save the resolved positions of every affected node, including
neighbors outside the original selection. Undo and redo restore the recorded
arrangements without solving a new layout.

Animated settlement is a finite presentation of that operation. It must not
create alternate permanent coordinates, per-frame persistence writes, or another
round of automatic layout. Reduced motion and interruption must leave the same
authoritative result. Hydration, discovery, hover, and camera motion are not new
triggers for node displacement.

### 6. Themes edit presentation and author structural choices explicitly

The grid is editable through themes. Theme appearance and applied workspace
geometry have separate authority: changing paint must not silently change snap
spacing, node placement, or routing geometry. Structural edits and any subsequent
realignment are explicit operations.

The brief proposes theme-owned structural presets, an applied workspace grid
record, and a separate personal snap preference. Exact storage and editor
contracts remain implementation proposals. Maintain ADR-019's distinction
between theme definitions, preference choices, and workspace state.

### 7. Build 2D with a boundary for a future inhabitable workspace

Project identities, connections, world state, and actions remain independent of
Konva, mouse events, and screen coordinates. Rendering and input adapters consume
the shared model. Geometry and routing implementations have explicit dimensional
contracts so later 3D behavior has a defined integration point.

The future target permits nodes, wires, and grid throughout a customizable
space. Project origin is separate from viewer pose and physical-room anchoring.
Environment appearance is separate from project arrangement; selecting different
surroundings does not implicitly move nodes or create routing obstacles.

This is architectural preparation, not a claim that 2D routing already handles
3D. Depth, orientation, volumetric obstacles, 3D placement guides, and desktop
representation of spatial arrangements require future design and implementation.

## Consequences

Positive:

- Visible grid and placement share one coordinate definition.
- Existing node-parting behavior survives strict placement without a snap/seam
  feedback loop.
- Saved and undone arrangements remain consistent across rendering surfaces.
- Theme editing gains structural capability without hidden layout changes.
- A future spatial interface has a clear boundary for input, rendering, geometry,
  and routing extensions.

Costs and limitations:

- Strict describes placement intent; a final routed arrangement may be off-grid.
  Target/settlement feedback must make that understandable.
- Existing separate group/seed/scale paths require deliberate integration.
- Scaled geometry, persistence, and transaction behavior need coverage beyond
  simply drawing three levels of lines.
- Numerical defaults, docking precedence, and structural editing details require
  the review points identified in the brief.
- A future room-scale layout remains substantial product/geometry work even
  when shared entities and operations are reusable.

## Alternatives Considered

- **A richer background alone:** does not connect drawing to placement, routing,
  or saved grid structure.
- **Require all final positions to remain on major lines:** prevents minimal
  routing accommodation or forces unnecessarily large moves.
- **Run grid snapping again after seam resolution:** can close the corridor and
  repeatedly fight the router.
- **Replace the router with a dense grid search:** discards working obstacle,
  terminal, and stability behavior and introduces unnecessary search cost.
- **Live geometry derived from the active visual theme:** permits global theme
  changes to alter existing projects' placement/routing rules unexpectedly.
- **Renderer-only permanent node offsets:** violates ADR-025's authoritative
  world-position requirement and creates disagreement across saves and surfaces.
- **Make a planar board the maximum future scope:** does not represent the
  owner's intended inhabitable spatial workspace.
- **Implement general 3D or add an XR dependency now:** expands current scope
  without validating the future interaction or geometry requirements.

## Scope Notes

This record documents the accepted direction; it delivers no runtime behavior.
It does not alter node dimensions, move saved nodes, add a free snap mode, change
project-open camera policy, or select a headset/runtime/library.

ADR-025 continues to own routing doctrine; ADR-019 owns preferences/library
boundaries; ADR-026/027 govern durable persistence and teardown. Detailed
implementation proposals must preserve those contracts or explicitly amend them.

## Implementation Follow-ups

Begin with the brief's geometry/ownership slice. It proposes a GridDomain in
`src/app/gridDomain.js`; review and register that owner in `docs/Orchestration.md`
when implementation starts and verify guard coverage. Then deliver persistence,
placement/route settlement, and rendering/animation in the brief's order.

Resolve the brief's open spacing and docking choices before activating grid
snapping. Preserve the current source/test baseline and add behavior-level
coverage for all placement paths. No existing ADR needs to be rewritten to make
these two planning artifacts reviewable.
