# ADR-025: Wire Edge Routing & Wire Visual Language

## Status

- Amended — 2026-07-31 late session (owner rulings during live verify:
  **wires-override-adjacency doctrine** made explicit and standing;
  **snap-with-seam** at the snap gesture; **D1b's one-shot/veto
  superseded** — seams are maintained at every arrangement settle, a wire
  is never left under-passing because adjacency sealed its path. See the
  §4 addendum.)
- Accepted — 2026-07-31 (final rulings landed: D2 discovery half, D3, D4, D6 —
  all decision points D1–D6 now ruled; ADR authored the same session. G5
  verified in code before the D2 ruling was requested.)
- Proposed — 2026-07-28/29 (owner requirements R1–R7 dictated and brief
  written 2026-07-28; D1a–D1d, the wire visual language rework, and the D5
  part-ruling decided 2026-07-28/29, the latter over the live mock
  `docs/plans/ideas/mock-edge-routing-d1c.html`).

## Date

- 2026-07-31

## Context

Wires are computed per-wire, in isolation, inside `ConnectionLine.jsx` — no
wire can see another, so inter-wire spacing and obstacle-aware paths are
unimplementable in the current shape. The owner's routing requirements
(R1–R7: obstacle avoidance, shortest route, legible separation, adjacency
accommodation, ≤20px corridor spacing, purposeful border crossings,
orthogonal-with-fillets sweep) therefore force an architectural move, and the
2026-07-28/29 ruling sessions grew a second, separable decision out of the
same discussion: a rework of the wire visual language itself.

The canonical detailed design is `docs/plans/ideas/brief-edge-routing.md`
(context verified against code 2026-07-28: the `computeWirePoints` waypoint
seam is reserved; anchors are chosen-side edge midpoints; wires render
beneath pieces; `ADJACENCY_THRESHOLD = 20` suppresses wires at contact; grid
interiors already carry 20px gutters). This ADR records the normative
decisions only.

G5 (how discovery assigns wire sides) was verified 2026-07-31 before the
final D2 ruling: discovery sides come from `chooseFacingSides()` — pure
nearest-facing geometry, recomputed every run, never persisted — while only
manually-drawn pairs get durable side rows (`persistConnectionSides`, called
solely from the two manual-draw paths), which discovery already honors as a
per-pair override. User-chosen and code-chosen sides are already distinct
tiers in the data flow.

## Decision

### 1. Routing is a global selector-layer pass

The router is a pure, memoized, deterministic function
`(obstacles, terminals, previousRoutes) → routeMap`, living at the selector
layer beside `buildRenderableWires` (`useWorkspaceRenderSelectors.js`) —
the one place that already sees connections, pieces, groups, bounds, and
hidden ids. `ConnectionLine` receives its point list as a prop and keeps
drawing. The shipped compute/draw seam survives; computation moves up one
level. `buildWireCurve` grows from a single cubic to a multi-segment path
with arc-length-parameterized `pointAt(t)` so the chevron and count chip
work unchanged.

### 2. Route geometry

Orthogonal segments with constant-radius fillets; terminal stubs launch
along the chosen face normal; long drops/rises may relax into gentle curves
(R7). Shortest available path subject to avoidance and spacing (R1/R2).
Wires sharing a corridor offset in steps with a 20px canvas-space ceiling,
compressing when tight (R5); the corridor constant unifies with the
existing `GAP_X = 20` family rather than coining a third coincidence.
Stability bias: a wire keeps its previous route when its cost is within
tolerance of the new optimum, and only wires whose corridor intersects a
changed obstacle rect reroute (no flap on unrelated drags).

### 3. Doctrine (governs every rule below)

- **Positions are world state.** Persisted x/y is the one source of truth
  for every renderer — fresh launches, teammates' machines, the future VR
  surface. Render-only displacement is a per-surface lie and is rejected
  outright (D1a). Collapse/fold remains per-surface view state.
- **Geometry responds to structure; appearance responds to attention.**
  Wire birth and piece moves may change geometry; hover, selection, and
  health only change paint (D1c addendum — hover is paint-only, never a
  nudge or reroute).
- **Explicit user gesture ≥ relationship > organization.** The wire is the
  relationship affordance and ranks one tier above adjacency, which is
  proto-organization — "the starting point of organizing… not a rule, an
  affordance" (owner). The router disturbs organization in proportion to
  its commitment: flush adjacency parts readily, group interiors yield only
  through their own layout engine's gutters, disk structure is never
  touched.

### 4. Adjacency accommodation (D1 — nudge, ruled 2026-07-28/29)

- **Nudge, persistent, one-shot.** When a route needs to pass between flush
  neighbors, the router may part them by writing real positions through the
  standard write path — animated, journaled *with* the wire-creation action
  so one undo reverts both (D1a). Pieces move only at wire birth or an
  explicit reroute action; afterwards obstacle changes move wires, never
  pieces — a user re-flushing a parted pair is the veto, with no stored
  veto state and no fight loop (D1b).
- **Escalation ladder (D1d).** Contact is the display (no wire, existing
  `ADJACENCY_THRESHOLD` behavior) → route around the cluster perimeter →
  open the minimal approach seam nearest the target for buried endpoints
  (including user-anchored buried faces — adjacency yields, the anchor is
  never re-sided) → D4 fallback.
- **Seam rendering (D1c).** Wire visibility fades over a band rather than a
  binary 20px cliff (whisper tuning — fade begins ~12px). A seam wire
  crossed by transit wires renders whispered + hopped, derived statelessly
  from geometry at render time. The corridor cap is dead as a rule,
  replaced by a router cost: seam-widening displacement vs detour.

> **Amendment (2026-07-31, owner rulings during live verify — supersedes
> D1b's one-shot trigger and its re-flush veto):** The
> wires-override-adjacency doctrine is explicit and unqualified: adjacency
> is bottom-tier organization; a wire is NEVER left under-passing because
> adjacency sealed its path. Consequences now in force:
>
> - **Seams are maintained at every arrangement settle** — wire birth AND
>   piece drag-end — not only at birth. Each user gesture receives exactly
>   one seam response (event-driven, no fight loop); the wire wins every
>   round, so the old re-flush veto is retired.
> - **Two seam mechanisms**: buried anchored faces part along the face
>   normal (minimal approach seam); a flush pair whose shared seam lies on
>   a wire's terminal-to-terminal path parts LATERALLY, half each way, so
>   the wire routes between them (the rung-3 seam "nearest the target").
> - **Snap-with-seam** (same doctrine at the snap gesture): a snap that
>   would seal a face wired to a third piece settles at corridor width
>   instead of flush; overlap-drop still forces flush for the snapping
>   pair itself.
> - Proportionality (D1d) unchanged: group members never freeform-part —
>   grouped blockage degrades to the D4 dim under-pass until the
>   gutter-widening mechanism exists. Discovery runs still never move
>   pieces; the drag-end trigger covers discovery wires the moment the
>   user arranges anything.

### 5. Wire visual language (ruled 2026-07-29 — ships first as S0)

- **Rest = topology.** Wires rest thin, solid, neutral; healthy wires have
  nothing to say (green retires at rest).
- **Exception-based status.** Broken/orphaned (red), drifted/pending
  (amber), unused (yellow) rest popped — body, status color, presence —
  without waiting for hover. Preserves the PR #166 property (dead imports
  read red from first load). Aggregation keeps worst-status-wins;
  "worst = healthy" renders neutral.
- **Hover = inspect; click = hold.** Hover pops the wire to its gauge,
  color, glow, and chevron; while popped, every other wire drops a
  half-step (**global focus swap** — owner-verified on the live mock;
  protected). Selection holds the pop plus the existing wire menu. Hover is
  paint-only: the popped wire draws over other wires, beneath tiles.
- **Hit path unchanged**: 14px screen-space minimum, independent of drawn
  gauge. Topmost-wins plus the focus swap resolves tight-corridor
  ambiguity (G4).
- This supersedes the rest-state gauge/color decisions of
  `brief-bezier-wire-refactor.md` Phase 1 only (dated note in that brief);
  the seam, chevron, and Phase-3 items stand.

### 6. Side authority (D2 — completed 2026-07-31)

A **user-chosen side is a hard constraint** — the router never re-sides it,
even when the anchored face is buried (it opens a seam instead; ruled
2026-07-28 via D1d). **Discovery-created sides are router-owned** (ruled
2026-07-31): the router replaces `chooseFacingSides` as the geometry
authority for pairs without a persisted override, free to pick faces that
minimize seams, detours, and congestion. The persisted per-pair side rows —
written only by manual draws — remain the registry of hard sides. No new
state.

### 7. Terminals (D3 — distributed stubs, ruled 2026-07-31)

Stub endpoints distribute along the chosen face: side preserved, midpoint
relaxed. Stubs are **dynamic pseudo-ports** — they exist only where wires
exist, placed by the router, never a static grid — and may reveal their
symbol label on hover (paint-only). Design lineage note: static ports were
rejected at project origin (fixed points make connecting a nightmare) and
labels-as-pseudo-ports died on design language; this ruling resolves both
with the attention doctrine.

### 8. Crossings (D5 — ruled 2026-07-29 via D1c)

Plain right-angle crossings by default. Electrical-diagram **hops** exactly
at asymmetric-visibility crossings — the quiet wire hops the loud one. Hop
ownership is assigned at route time and never flips on hover: opacity
swaps, shape doesn't.

### 9. Unroutable fallback (D4 — ruled 2026-07-31)

When no acceptable route exists (walled-in target, absurd detour cost), the
wire **de-emphasizes and passes beneath** obstacles. Wires already render
under pieces, so the existing z-order displays the failure gracefully; no
new visual state enters the language.

### 10. Drag-time behavior (D6 — ruled 2026-07-31)

While a piece is dragged, its wires fall back to the cheap direct bezier;
on drop, the router computes final paths and the wires settle. No per-frame
routing; matches the standing canvas-jitter constraint and reads as
intentional (pick up → place down).

## Consequences

**Positive**

- Fan-in, hubs, and tight corridors become individually traceable (focus
  swap + distributed stubs + corridors); the hover focus swap alone retires
  part of the future hub-legibility concern.
- Routing is deterministic and pure — unit-testable without a canvas, no
  flicker, stable under unrelated drags.
- Nudges journal with wire creation: one undo, coherent history; stored
  coordinates stay true for every renderer (VR, Team edition, fresh
  launches).
- Rest-state performance improves before the router even lands: neutral
  thin majority, bodies/color only on exceptions, glow confined to
  hover/selection — and the neutral majority opens a batch-draw seam (one
  sceneFunc for all quiet wires) to be measured at G6.

**Costs**

- The router is real complexity: obstacle registry, corridor allocation,
  cost model, stability bias, dirty-rect invalidation. The algorithm
  (grid A* vs visibility graph vs channel routing) is deliberately
  **unchosen until G6 measurement** supplies wire/obstacle counts and a
  frame budget.
- Multi-segment `buildWireCurve` + arc-length `pointAt` is a prerequisite
  slice before any routing behavior can render.
- The obstacle registry (G3) needs ratification during implementation:
  proposed as piece rects, expanded group boxes (descendant-union bounds),
  collapsed pills, seed-bounds manual boxes; screen-space overlays ignored.
- Corridor/gutter/adjacency constants must unify into one named family
  (`GAP_X`, corridor ceiling, `ADJACENCY_THRESHOLD` interplay) or they will
  drift.
- Distributed stubs move terminal placement into the router — more computed
  state, and the stub-label hover affordance is new paint to design within
  the ruled language.

## Alternatives Considered

- **Per-wire routing** — impossible in the current shape; each wire is
  computed in isolation and spacing needs global knowledge. This is the
  architectural forcing function, not a preference.
- **Render-only displacement for nudges** — rejected (D1a). A per-surface
  offset no other renderer can reproduce; stored positions must be real.
- **Continuous/reactive nudging** — rejected (D1b). Obstacle changes after
  wire birth move wires, never pieces; anything else invites fight loops
  and needs stored veto state.
- **Corridor cap at one wire** — dead (D1c). Transgression-whisper handles
  the tangle it guarded against; replaced by the displacement-vs-detour
  cost.
- **Static ports** — rejected at project origin; never re-propose. Fixed
  connection points make connecting a nightmare; the whole-face/midpoint
  model exists because of this rejection. **Labels-as-pseudo-ports**
  likewise died on design language. Distributed stubs (D3) are the
  descendant that survives: dynamic, router-placed, labels on hover only.
- **Midpoint-sacred terminals** — rejected (D3). Keeps the pinch point
  exactly where legibility matters most.
- **Route around at any cost / flagged-unrouted straight line** — rejected
  (D4). Marathon perimeter wires read worse than a quiet under-pass; a
  dedicated "unrouted" style adds a visual state for a rare case.
- **Live rerouting during drags** — rejected (D6). Burns the per-frame
  budget when the canvas is busiest, against the standing jitter
  constraint, with no G6 numbers to justify it.
- **Binary 20px reveal for seam wires** — rejected (D1c). Owner-flagged
  cliff; replaced by the fade band with whisper tuning.

## Scope Notes

- **Geometry only.** Wire semantics, persistence, discovery, and
  aggregation are untouched — the router computes pixels and stores
  nothing. (Nudge writes are piece state through the standard write path,
  not route state.)
- The `ADJACENCY_THRESHOLD` no-wire-at-contact behavior is preserved as-is.
- Nudging never moves anything above the adjacency rung: group membership,
  folder structure, and disk are out of reach (doctrine §3).
- The scaffold (DOM) surface is out of scope — canvas only.
- Delivery shape: slices S0–S7 as sketched in the brief, **firm as of the
  2026-07-31 rulings**. S0 (wire visual language) is independent of the
  router — a `ConnectionLine` render change only — and ships first.

## Implementation Follow-ups

- **G6 measurement gates S3+**: typical wire/obstacle counts and the
  per-frame drag budget, measured on a real project, before the routing
  algorithm is chosen; the neutral-majority batch-draw opportunity is
  measured in the same pass.
- **G3 obstacle registry** ratified during the avoidance slice (S3).
- **G1 confirmation** during S1: the selector-layer move stays inside
  existing domain layering with no app-shell manifest impact
  (Orchestration.md placement check).
- Fade-band and corridor constants tuned by eye once rendering exists;
  constants unified into one named family.
- Future notes stay in the brief, explicitly not this arc: hub-side
  bundling / quiet-wires de-emphasis, cluster-promotion affordance.

## References

- **Canonical design detail**: `docs/plans/ideas/brief-edge-routing.md`
  (requirements, mechanisms, ruling transcripts D1a–D1d, escalation
  ladder, visual-language spec, gaps G1–G6, slices S0–S7, acceptance
  sketch)
- Live mock (ruled state): `docs/plans/ideas/mock-edge-routing-d1c.html`
- Superseded in part: `docs/plans/ideas/brief-bezier-wire-refactor.md`
  (Phase 1 rest-state only; dated note in that brief)
- Adjacent briefs: `brief-cross-group-wires.md` (pair-keyed aggregation,
  PR #160), `brief-nested-group-containment.md` (union-box obstacles,
  per-surface collapse)
- Code seams: `src/utils/wireGeometry.js` (`computeWirePoints`,
  `buildWireCurve`), `src/components/ConnectionLine.jsx`,
  `src/app/selectors/` + `useWorkspaceRenderSelectors.js`
  (`buildRenderableWires`), `src/app/connectionAnchoring.js`
  (`chooseFacingSides` — replaced as geometry authority by the router),
  `src/project/useProjectPersistence.js` (`persistConnectionSides` — the
  hard-side registry writer)
