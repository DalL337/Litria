# Brief: Edge Routing (Wire Path Planning)

> **Status:** Ideation — owner requirements captured 2026-07-28 (late-night
> session); decision points D1–D6 pending owner ruling. Not scheduled.
> **Update (2026-07-31):** All decision points D1–D6 are now ruled (final
> rulings: D2 discovery half, D3, D4, D6 — owner, 2026-07-31; G5 verified in
> code the same session). Normative record: **ADR-025**
> (`docs/adrs/025-edge-routing-wire-visual-language.md`). This brief remains
> the canonical detailed design; slices S0–S7 stand as the delivery shape.
> **Scope:** Geometry of the wire path only. Wire semantics (edges = symbol
> bundles, imports authoritative, representation-only doctrine) are untouched.
> **Builds on:** `brief-bezier-wire-refactor.md` (the compute-points /
> draw-curve seam — shipped), `brief-cross-group-wires.md` (pill re-anchor +
> aggregation — shipped), `brief-nested-group-containment.md` (D-ruled,
> next implementation arc).

---

## Context — where routing plugs in (verified against code, 2026-07-28)

- **The seam is already reserved.** `computeWirePoints()` in
  `src/utils/wireGeometry.js` returns exactly `[start, end]` today, with an
  in-code comment reserving waypoint insertion for routing. `buildWireCurve()`
  draws a single cubic with normal-launch control points
  (`WIRE_LAUNCH_FRACTION 0.5`, clamp 40–240px) and answers
  `pointAt(t)` — consumed by the chevron (t≈0.6) and the aggregation count
  chip (t=0.18 / 0.82).
- **Each wire is computed in isolation** inside `ConnectionLine.jsx`. No wire
  can see another wire, so inter-wire spacing (R3/R5 below) is
  *unimplementable per-wire*. Routing must become a **canvas-level pass**.
  The natural home is the selector layer next to `buildRenderableWires`
  (`useWorkspaceRenderSelectors.js`), which already sees connections,
  `piecesById`, `groups`, `getGroupBounds`, and `hiddenPieceIds` — everything
  an obstacle registry needs. `ConnectionLine` then receives its point list
  as a prop. The seam survives: compute upstream, draw downstream.
- **Anchors are edge midpoints** of the piece rect (180×110) or a
  collapsed-group pill rect, and the **side is deliberately chosen** (drag
  direction / drop edge). Bezier-brief ground truth: "honor the chosen edges."
- **Wires render beneath pieces** (layer order: group outlines → wires →
  pieces). "Never route beneath a node" is therefore a *geometric* avoidance
  requirement; z-order stays as-is, which also gives us a graceful failure
  mode (see D4).
- **`ADJACENCY_THRESHOLD = 20`** (`ConnectionLine.jsx`): endpoints within
  20px suppress the wire entirely — adjacent tiles express their connection
  by contact, not by wire. Any "adjacency" rule in this brief must not
  disturb that behavior.
- **Grid interiors already have corridors.** `gridLayout.js`: `GAP_X = 20`,
  `GAP_Y = 16`, `PADDING = 24`. The owner's ≤20px corridor spacing ceiling
  equals `GAP_X` — routing inside expanded folder groups can ride the grid
  gutters, and the corridor constants should be one named family, not three
  coincidences.
- **Same-pair multiplicity is already solved.** Pair-keyed aggregation
  (cross-group wires D2, PR #160) collapses parallel edges between the same
  endpoints into one wire + count chip. Corridor spacing here concerns wires
  between *different* pairs sharing space.
- **Nested groups are coming.** Per the containment brief rulings, a parent
  group box is the union of descendant bounds — large obstacles, and a wire
  into a nested node crosses multiple borders. Collapse state is per-surface
  (containment D6): the router's input is whatever this surface currently
  renders.

## Requirements (owner, 2026-07-28)

- **R1 — Obstacle avoidance.** An edge never routes beneath a node or a
  group box.
- **R2 — Shortest route.** Subject to R1 and spacing, take the shortest
  available path.
- **R3 — Legible separation.** Edges converging on the same node or on
  nearby nodes keep visible space between them.
- **R4 — Adjacency accommodation.** If flush-adjacent obstacles block a
  needed route, the adjacency is "broken visually" to accommodate it
  (semantics → D1).
- **R5 — Corridor spacing.** Space between adjacent routes is at most 20px
  (canvas space); smaller is allowed for legibility and space concerns.
- **R6 — Border discipline.** Routes respect group borders: cross
  purposefully, heading toward the specific target node inside a folder
  group — no skimming along the inside of a box.
- **R7 — Sweep quality.** No spaghetti. Right-angle corners preferred;
  drops and rises may be straight or longer curves.

## Design sketch (pre-ruling; mechanisms, not commitments)

- **Router = pure function** `(obstacles, terminals, previousRoutes) →
  routeMap` keyed by wire id, memoized at the selector layer. Deterministic:
  same inputs, same routes (testable; no flicker).
- **Orthogonal corridor routing.** Terminal stubs launch along the chosen
  face normal (keeps the shipped normal-launch look at the node), then
  Manhattan segments to the target stub. Corners get a constant fillet
  radius; long drops/rises may relax into gentle curves (R7).
- **Spacing by corridor offsets.** Wires sharing a corridor are offset in
  steps ≤20px, compressing when the corridor is tight (R5). Spacing is
  canvas-space — it scales with zoom like everything else and never triggers
  a reroute on zoom.
- **Stability bias.** Prefer a wire's previous route when its cost is within
  tolerance of the new optimum (anti-flap), and reroute only wires whose
  corridor intersects a changed obstacle rect. Routes that flap on unrelated
  drags are spaghetti in time instead of space, and the standing
  perf constraint (churn → canvas-jitter) applies.
- **Draw-job extension.** `buildWireCurve` grows from a single cubic to a
  multi-segment path with **arc-length-parameterized `pointAt(t)`** so the
  chevron and count chip keep working unchanged.

## Wire visual language (ruled 2026-07-29 — owner, D1c session)

Grew out of the D1c whisper discussion. **Supersedes the rest-state gauge
and color decisions of `brief-bezier-wire-refactor.md` Phase 1** (dated
supersession note added there). Render-layer only: the compute/draw seam,
status logic, and the connection domain are untouched.

- **Rest = topology.** Wires rest thin, solid, neutral — conventional
  node-editor language. A healthy wire has nothing to say: resolved
  imports, calls, and references rest quiet (green becomes neutral).
- **Exception-based status** (owner-ratified refinement: "something that
  isn't working or isn't fully fleshed out should in fact be the center
  of attention"). Unhealthy wires do not wait to be hovered:
  broken/orphaned (red), drifted/pending (amber), unused (yellow) rest
  **popped** — body + status color + presence. Quiet when fine, loud when
  wrong — the LED philosophy applied to wires. Preserves the PR #166
  property: dead imports read red from first load, no hover required.
  Aggregation keeps worst-status-wins; "worst = healthy" now renders
  neutral instead of green.
- **Hover = inspect.** The wire pops: widens to the current gauge ladder,
  takes its status color + glow, chevron reveals (existing behavior).
  Animated; intensity rides the Live/Calm theme axis. Off-hover returns
  to rest.
- **Hover focus swap (global).** While a wire is popped by hover, every
  other wire drops a half-step. This doubles as the hub-legibility tool —
  trace one wire out of an App.jsx-grade storm (retires part of the
  future-notes hub item).
- **Click = hold.** Selection keeps the pop + glow and the modeless wire
  menu (delete / add-symbol) exactly as shipped today.
- **Routing-constant consequences.** Thin rest bodies shrink corridor
  spacing, seam widths, and hop arcs across the board (two thin wires fit
  ~20px of seam vs ~36px at 5px gauge); the R5 ≤20px figure stands as the
  ceiling. The on-screen zoom floor for neutral wires may drop below the
  2px color-channel floor — overview zoom shows structure, while
  exception wires stand out from altitude. Hit path unchanged: 14px
  screen-space, independent of drawn gauge, so thin wires stay grabbable.
- **Hover is paint-only (owner ruling, 2026-07-29).** A hover pop never
  changes geometry: no nudge, no reroute, no corridor re-spacing. The
  popped wire simply **draws over** the other wires and connections —
  top of the wire stack, still beneath tiles — because it is the focus;
  slight overlap with corridor neighbors is fine since they are dimmed
  under it. Doctrine: **geometry responds to structure (wire birth,
  piece moves); appearance responds to attention (hover, select,
  health).** Corridors are sized for rest gauge only.
- **Performance posture (owner rationale + agent calibration,
  2026-07-29).** On-demand state draw scales: at rest only exception
  wires carry body/color, and glow (canvas shadow — the genuinely
  expensive draw) stays confined to hover/selection as today. Thinner
  strokes and tighter hop arcs (radius follows under-wire gauge)
  rasterize fewer pixels and read better while panning. The larger
  opportunity the neutral majority opens: quiet wires become visually
  identical, so they can be batch-drawn in a single pass (one sceneFunc
  over all neutral wires) with individual nodes only for exception /
  hovered / selected wires — measure at G6 time, this is the big-repo
  win.
- **Sequencing.** Independent of the router — can ship as its own slice
  before any routing lands (ConnectionLine render change only).
- **Live mock:** `docs/plans/ideas/mock-edge-routing-d1c.html` — reworked
  2026-07-29 post-ruling to show the *ruled* state (the deliberation
  panels are gone): static state ladder, CSS-live hover focus swap (no
  JS), whisper + hop seam, no-cap multi-wire corridor. Hover panels only
  work in a browser. Working artifact; owner ruled it need not be
  committed.

## Gaps

- **G1 — Architecture move.** Routing relocates point computation from
  per-wire component scope to a global selector-layer pass. Likely stays
  inside the existing domain layering (same home as `buildRenderableWires`);
  confirm no app-shell manifest impact.
- **G2 — Draw job is single-segment today.** Multi-point path + arc-length
  `pointAt` is a prerequisite slice.
- **G3 — Obstacle registry undefined.** Proposed: piece rects, expanded
  group boxes (descendant-union bounds), collapsed pills, seed-bounds manual
  boxes. Screen-space overlays (count chips, off-canvas badge) are ignored.
  Needs ratification.
- **G4 — Hit-stroke vs spacing.** Wire hit path is `max(stroke, 14/scale)`.
  Parallel wires closer than the hit width overlap hit areas — selection
  ambiguity. Needs a rule (Konva topmost-wins may be acceptable; hover
  feedback disambiguates).

  > **Largely mitigated (2026-07-29):** the hover focus swap makes
  > which-wire-am-I-on instantly legible even in tight corridors —
  > owner-verified on the live mock ("especially when you have wires
  > right next to each other — that's game changing"). Topmost-wins +
  > focus swap is likely sufficient; also relaxes pressure on R3/R5
  > spacing, since tight parallel wires stay individually traceable.
- **G5 — Discovery-side assignment unverified.** How discovery-created wires
  choose their sides today is unchecked; it decides whether the D2 split
  (manual vs discovery wires) is meaningful.

  > **VERIFIED (2026-07-31).** Discovery sides come from
  > `chooseFacingSides()` (`connectionAnchoring.js`) — pure nearest-facing
  > geometry (primary axis picks the source face, target gets the
  > opposite), recomputed every discovery run and never persisted. Durable
  > side rows are written only by `persistConnectionSides`
  > (`useProjectPersistence.js`), which is called solely from the two
  > manual-draw paths (wire-drag connect, drop-on-pill); discovery consults
  > that map as a per-pair hard override and falls back to geometry
  > (`createConnectionsForEdges`, `useDiscoveryLifecycle.js`). The D2 split
  > is therefore already the shape of the data flow — router-owned
  > discovery sides cost zero new state.
- **G6 — Perf envelope unmeasured.** Typical wire/obstacle counts and the
  per-frame budget during drags need numbers before algorithm selection
  (grid A* vs visibility graph vs channel routing).

## Decision points (owner ruling requested)

- **D1 — What does "break the adjacency visually" mean (R4)?**
  When flush neighbors block a route:
  - (a) Treat the flush pair as one merged obstacle and route around —
    nothing moves.
  - (b) Open a render-only seam between them (pixels part, positions don't).
  - (c) Actually displace layout — inside grid groups the layout engine
    could insert a gutter; for free-placed pieces this moves things the user
    placed deliberately.
  Tension to rule on: (c) inside grid groups is cheap and principled (the
  engine owns those positions); (c) for free pieces violates placement
  sacredness; (b) may read as a glitch on glass tiles. Default proposal:
  (a) everywhere, (c) considered later for grid interiors only.

  > **Owner direction (2026-07-28, same-night discussion): nudge — option
  > (c).** Adjacency was originally designed as an *organizational
  > affordance*, not a wall; the router may part flush neighbors so a wire
  > can pass between them. This turns D1 from "whether" into "how" — four
  > sub-decisions pending:
  >
  > - **D1a — Displacement model: RULED (owner, 2026-07-28) — persistent.**
  >   Stored x/y must be real: the VR mode/version renders from the same
  >   coordinates, and so does every fresh project launch and every
  >   teammate's machine (Team edition). A render-only offset is a
  >   per-surface lie that no other renderer can reproduce — things would
  >   draw wrong on every new launch. Doctrine line this ruling draws:
  >   **positions are world state** (persisted, shared, one source of
  >   truth for all renderers), distinct from per-surface **view state**
  >   (collapse/fold, per containment-brief D6). The router writes real
  >   positions through the standard write path, animated, journaled with
  >   the wire-creation action so one undo reverts both.
  > - **D1b — Trigger discipline: RULED (owner, 2026-07-28) — one-shot.**
  >   Pieces move only at wire birth or an explicit reroute action;
  >   afterwards, obstacle changes move *wires*, never pieces. A user
  >   re-flushing a parted pair blocks the corridor and the wire reroutes
  >   around — the human veto falls out with no stored veto state and no
  >   fight loop.
  > - **D1c — Corridor width vs contact suppression: RESOLVED (owner,
  >   2026-07-29, ruled over the visual mock
  >   `docs/plans/ideas/mock-edge-routing-d1c.html`).** Fade band
  >   adopted with **whisper tuning** (fade begins ~12px → ~33% ghost at
  >   a 16px seam; owner: "I like the whisper seam"). The ruling session
  >   then grew into the wire visual language rework (see §Wire visual
  >   language) plus three mechanisms ruled here:
  >   - **Transgression-whisper (derived, stateless).** A seam wire
  >     crossed by transit wires renders whispered + hopped — computed
  >     from geometry at render time, no stored "router-parted" flag.
  >     Remove the transit wire and plain distance-fade resumes;
  >     re-flush the pair and it disappears back into contact.
  >   - **Hops (electrical-diagram bridges).** At asymmetric-visibility
  >     crossings — a whispered/neutral wire crossing a popped one — the
  >     quiet wire hops the loud one ("makes it more noticeable that
  >     there is something under it"). Hop ownership is assigned at
  >     route time and never flips on hover: opacity swaps, shape
  >     doesn't. Symmetric crossings (both quiet or both loud) stay
  >     plain right angles. Part-resolves D5.
  >   - **Corridor cap: dead as a rule.** The Section-D tangle it
  >     guarded against cannot occur under transgression-whisper (the
  >     seam wire stays ghosted at any width, hopping each transit
  >     wire). Replaced by a router *cost*: seam-widening displacement
  >     vs detour — the router stops widening when going around gets
  >     cheaper. Owner is explicitly comfortable with many wires
  >     funneling through a growing gap ("information-science / org
  >     chart perspective"); seams may exceed 16/20 to fit hop arcs
  >     ("that's fine"), and thin rest-state wires shrink all these
  >     constants anyway. Owner is uneasy with the binary
  >   mechanic itself — "under a certain point suppressed, past a certain
  >   point revealed" — while also recognizing that always-showing every
  >   wire is a legibility trap (own example: an App.jsx-grade hub imports
  >   a ton; all wires visible would get heavy). Discussion state:
  >   - **Reframe:** contact suppression is the micro end of a continuum
  >     the app already ships — contact expresses the relationship with no
  >     ink; a collapsed group expresses many relationships as one
  >     aggregated pill wire; distance gets a full routed wire. Proximity
  >     substitutes for ink at every scale. The 20px cliff is an
  >     implementation artifact, not the semantic.
  >   - **Proposed fix for the cliff: a fade band.** Wire opacity ramps
  >     from 0 at contact to full over a named band (e.g. fully hidden
  >     ≤16px, fully visible by ~28–32px) instead of binary pop at 20.
  >     No new state; kills the magic-number reveal. Corridor width (16px)
  >     then sits either in the invisible zone or the ghost zone — tunable
  >     constant, decide by eye.
  >   - **Hub legibility is a separate problem.** Adjacency can declutter
  >     at most the handful of tiles that fit flush around one node's
  >     perimeter; a 30-import hub stays heavy regardless of this ruling.
  >     The shipped answer is grouping + collapse aggregation; if
  >     ungrouped hubs still read heavy, that's a future affordance
  >     (hub-side bundling / quiet-wires de-emphasis) — future-notes, not
  >     this brief's scope.
  >   - ~~Corridor cap still recommended~~ **Superseded (2026-07-29):**
  >     the cap is dead — see the resolution above. The who-parted-them
  >     sticky variant was also rejected in favor of the stateless
  >     transgression-whisper derivation.
  > - **D1d — Cluster gestalt: direction agreed (owner, 2026-07-28),
  >   refined for intra-cluster wires.** Flush clusters route-around by
  >   default (implicit group under R6); grid-group interiors nudge via
  >   gutter widening, never freeform displacement. Owner refinement to
  >   fold in: wires between nodes *within* the block, not just through
  >   it — and the governing hierarchy, owner-stated: **the wire is the
  >   relationship affordance and ranks one tier above adjacency (a UX/
  >   organization affordance).** The relationship is always expressed;
  >   organization yields minimally and only when needed. Escalation
  >   ladder (proposed):
  >   1. **Adjacent + connected** → contact *is* the display; no wire
  >      (existing behavior, strongest expression of the relationship).
  >   2. **Same-cluster, non-adjacent, both endpoints have exposed
  >      perimeter faces** → route around the outside, hugging the block.
  >      No seams open. (In a 3×2 block every tile has an exposed face.)
  >   3. **An endpoint (or its anchored face) is buried** — e.g. the
  >      center tile of a 3×3 block, enclosed on all four sides → now
  >      adjacency is genuinely the blocker: open the minimal approach
  >      seam (one-wire corridor per D1c cap), nearest the target.
  >   4. **Seam impossible too** (cascade would exceed limits) → D4
  >      fallback.
  >   The D2 coupling is **RULED (owner, 2026-07-28): open the seam.** A
  >   user-anchored face buried against a neighbor is honored — the router
  >   never re-sides it; adjacency yields. Owner doctrine recorded with it:
  >   *"adjacency is the starting point of organizing a folder group or a
  >   set of nodes that share no group. It's not a rule, it's an
  >   affordance."* Adjacency is proto-organization — the bottom rung of a
  >   maturity ladder (flush adjacency → manual dotted group → folder
  >   group → disk structure), and the router may disturb organization in
  >   proportion to how uncommitted it is: flush adjacency parts readily
  >   (a seam), group interiors yield only through their own layout engine
  >   (gutter widening), disk structure is never touched.
  >
  > Undo note (pairs with D1a-persistent): a router-initiated nudge should
  > journal *with* the wire-creation action so one undo reverts both.
- **D2 — Is the user-chosen side a hard constraint?** Shortest-route can
  conflict with a far-side anchor (anchored right, target to the left →
  honest rendering is a wrap-around). Options: chosen side always wins
  (router just makes the wrap clean) / router may re-side anchors / split —
  user-dragged wires honor the side, discovery-created wires are
  router-owned (pending G5).

  > **Half-ruled by extension (owner, 2026-07-28, via the D1d seam
  > ruling):** a user-anchored side is a hard constraint — the router
  > never re-sides it, even when the face is buried (it opens a seam
  > instead). The hierarchy now standing: **explicit user gesture ≥
  > relationship > organization.** Remaining open half: **discovery-created
  > wires**, whose sides were picked by code, not by a gesture — no tier
  > of the hierarchy protects them. Agent recommendation: router-owned
  > (free to choose faces that minimize seams and detours). Verify G5
  > (how discovery assigns sides today) before finalizing.

  > **RULED (owner, 2026-07-31): router-owned.** Discovery-created sides
  > belong to the router, which replaces `chooseFacingSides` as the
  > geometry authority for pairs without a persisted override. G5 was
  > verified first (see G5 note): user-chosen sides are already the only
  > persisted tier, so the split costs zero new state. D2 closed.
- **D3 — Terminal congestion.** Many wires into one face all converge on
  the midpoint, defeating R3 exactly where it matters most. Options:
  midpoint stays sacred and wires fan only on approach / distribute stub
  endpoints along the chosen face (side preserved, midpoint relaxed).

  > **Design lineage (owner, 2026-07-29 — context for whoever rules
  > this):** wires/connections have been the owner's bane since the
  > project began. Static **ports** were the original idea, rejected
  > because fixed points make connecting a nightmare — that rejection is
  > why the whole-face/edge-midpoint model exists. A second idea,
  > **labels as pseudo-ports**, died on unresolved design language.
  > Note for D3: distributed stubs *are* pseudo-ports born dynamically —
  > they exist only where wires exist, placed by the router, never a
  > static grid. And the paint-only/attention doctrine dissolves the old
  > labels problem: a stub can reveal its symbol label on hover (pure
  > paint, no permanent appearance to design). The port ghost resurfaces
  > here with, for the first time, a language to answer it.

  > **RULED (owner, 2026-07-31): distributed stubs.** Stub endpoints
  > distribute along the chosen face — side preserved, midpoint relaxed —
  > with hover-revealed symbol labels (paint-only). The origin-era ports
  > problem closes with the dynamic/attention answer above.
- **D4 — Unroutable fallback.** Dense canvas, walled-in target, or a route
  whose detour cost is absurd: de-emphasized under-pass (wire dims and passes
  beneath — the current z-order already renders this gracefully) / always
  route around no matter the cost / straight line flagged as unrouted.
  Proposal: de-emphasized under-pass.

  > **RULED (owner, 2026-07-31): de-emphasized under-pass.** The wire dims
  > and passes beneath obstacles; existing z-order renders it gracefully and
  > no new visual state enters the language.
- **D5 — Crossings.** Spacing separates parallel wires, but crossings are
  topologically unavoidable in a nontrivial graph. Plain right-angle
  crossings (proposal — they read cleanly) vs bridge "hops" at crossing
  points (busier, node-editor-familiar).

  > **Part-ruled (owner, 2026-07-29, via D1c):** plain right-angle
  > crossings by default; hops exactly at asymmetric-visibility
  > crossings — the quiet wire hops the loud one, route-time ownership,
  > geometry never flips on hover. See D1c resolution.
- **D6 — Drag-time behavior.** While a piece is being dragged: keep the
  cheap direct bezier and settle into the routed path on drop (proposal —
  matches the jitter constraint and reads as intentional), vs live
  rerouting every frame.

  > **RULED (owner, 2026-07-31): cheap drag, settle on drop.** The dragged
  > piece's wires fall back to the direct bezier in flight; the router
  > computes final paths on drop. No per-frame routing.

## Future notes (out of scope — don't lose)

- **Hub legibility.** A heavily-imported ungrouped node (App.jsx-grade)
  stays wire-heavy regardless of routing; adjacency can declutter only the
  few tiles that fit flush around one perimeter. Shipped answer: grouping +
  collapse aggregation. If still heavy in practice: hub-side bundling or a
  quiet-wires de-emphasis (unselected wires dim) as its own affordance.
- **Cluster promotion.** If flush adjacency is the starting point of
  organization (owner doctrine, D1d), the ladder suggests a promotion
  affordance: select a flush cluster → "make group" (parallel to the
  existing manual-group → folder promotion path).

## Out of scope

- Wire semantics, persistence, discovery, aggregation — routing computes
  pixels and stores nothing.
- Nudging never moves anything above the adjacency rung: group membership,
  folder structure, disk. (D1d proportionality.)
- Multi-anchor / multi-port node model changes. Edge = symbol bundle,
  unchanged.
- The scaffold surface (DOM) — canvas only.
- The `ADJACENCY_THRESHOLD` no-wire-when-touching behavior — preserved as-is.

## Proposed slices (rough; firm up after rulings)

> **Firm as of 2026-07-31** — all D1–D6 rulings are in (ADR-025). S0 is
> independent of the router and ships first; S3+ remain gated on the G6
> measurement pass for algorithm selection.

0. **S0 — Wire visual language.** Neutral rest + exception pops +
   hover/click ladder + global focus swap. Independent of the router;
   can ship first (ConnectionLine render change only).
1. **S1 — Router skeleton + architecture move.** Global pass at the selector
   layer emitting pass-through straight routes; behavior-identical render.
2. **S2 — Poly draw job.** Multi-segment `buildWireCurve` + arc-length
   `pointAt`; chevron/chip unchanged.
3. **S3 — Obstacle avoidance (R1/R2).** Registry per G3 ruling; orthogonal
   routes with fillets (R7).
4. **S4 — Corridors + spacing (R3/R5).** Shared-corridor offsets, terminal
   treatment per D3.
5. **S5 — Border discipline (R6).** Purposeful crossings; grid-gutter
   interior routing; nested-border traversal.
6. **S6 — Adjacency + fallbacks (R4, D1/D4).**
7. **S7 — Stability & perf.** Dirty-rect rerouting, previous-route bias,
   drag mode per D6, measured against G6 numbers.

## Acceptance sketch (arc-level)

- No wire passes beneath a node or group box in a routable layout; the D4
  fallback renders where routing is impossible.
- Parallel wires in a shared corridor hold ≤20px separation, compressing
  gracefully; fan-in at a busy node stays individually traceable.
- Routes are orthogonal-with-fillets, deterministic, and stable under
  unrelated piece drags (no flap).
- Chevron, count chip, hit-testing, and the wire menu behave exactly as
  today on routed paths; rest/hover/select appearance follows the Wire
  visual language section (neutral rest, exception pops, focus swap).
- Drag interaction stays smooth per the D6 ruling; no canvas jitter
  regressions.
