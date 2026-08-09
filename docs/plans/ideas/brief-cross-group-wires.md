# Brief: Cross-Group Wires — Pill Anchoring, Pickers, Off-Canvas Imports

> **For:** Claude Code
> **Scope:** Making import connections work across and into groups: re-anchor
> wires to collapsed-group pills (with aggregation), extend the wire-drop
> picker to group targets, surface off-canvas import targets as a badge, and
> re-run discovery incrementally. Render/selector + interaction work — the
> connection domain's data model is untouched.
> **Stack:** React 19 + react-konva, Tauri v2.
> **Status:** ARC SHIPPED 2026-07-18 — all five slices merged: S1 pill
> re-anchor (#159), S2 aggregation + member list (#160), S3 off-canvas
> badge (#161), S4 drop-on-pill picker + preference (#162), S5 incremental
> discovery (#163). Designed 2026-07-17 with owner; core decisions ratified
> same day (journal:
> `.research/2026-07-17-glass-refraction-and-cross-group-wires.md`).
> Builds on the shipped bezier-wire refactor
> (`brief-bezier-wire-refactor.md`) and the imports-authoritative decision
> (`brief-discovery-canvas-sync.md`, 2026-06-30).

---

## Context — what's broken today

Owner report (2026-07-17): "connections through, to, and between groups —
e.g. a `main.py` or `App.jsx` importing from something outside of `src/` —
isn't working."

Investigation found the import *engine* is fine and the connection domain has
**no group awareness at all** (no same-group rule exists). Three downstream
gaps produce the symptom:

1. **Off-canvas targets are silently dropped.** Discovery only creates wires
   between files that already have pieces:
   `if (!sourcePiece || !targetPiece) continue;`
   (`useDiscoveryLifecycle.js`, `createConnectionsForEdges`). Pieces are only
   created by the wizard, scaffold-drawer drags, or group promotion — never by
   discovery. A root-level module imported from `src/` typically has no piece,
   so its edge evaporates with zero feedback.
2. **Collapsed/hidden groups drop wires instead of re-anchoring.**
   `visibleConnections` filters out any connection touching a hidden piece
   (`useWorkspaceRenderSelectors.js`). Collapse a folder group → every wire
   in/out of it vanishes; the group reads as disconnected.
3. **Discovery is load-time-only** (`decideDiscoveryStep`, run-once per load
   token). An import typed mid-session draws no wire until project reopen.

## Governing principle (owner-ratified)

**Imports are authoritative; wires are representation + info affordance
only** (extends the 2026-06-30 discovery-canvas-sync decision). A wire's
visual endpoint may move (piece ↔ pill) without changing the underlying
edge, whose identity remains the file pair. Nothing in this brief touches
edge identity, persistence, or the syntax domain.

## Design (owner decisions, 2026-07-17)

### D1 — Collapsed groups re-anchor wires to the pill

Owner's reference workflow: oAuth.py (project root) wired to main.py (in
`src/`). Group open → the wire draws across the group border (already works;
wires render above group outlines). Group collapsed → the wire draws **to the
collapsed pill and stops there**.

- Implement at the **render-selector level**: replace the hidden-endpoint
  *filter* with an endpoint *resolver* — each connection maps to a visual
  wire whose endpoint is the piece, or, when the piece is hidden by
  collapse, the collapsed pill's stub bounds (`collapsedGroupBounds` /
  `COLLAPSED_STUB_HEIGHT` in `workspaceSelectors.js`).
- Nested collapse: anchor to the **outermost collapsed ancestor** pill.
- Both endpoints hidden in the *same* collapsed group → internal wire, not
  rendered (unchanged behavior, now by rule rather than by filter accident).
- Both endpoints hidden in *different* collapsed groups → pill-to-pill wire.
- Scaffold-hidden (eye) pieces/folders keep today's behavior: wires touching
  them stay hidden. Hiding is "remove from view"; collapsing is
  "summarize" — different intents.
- The bezier brief's compute-points/draw-curve seam is the insertion point:
  anchoring feeds different endpoint rects into compute-points; the curve
  renderer is untouched. Anchor side vs. a pill: geometry fallback
  (`chooseFacingSides`) against the stub bounds.

### D2 — Aggregation at the pill (owner: "I like this")

Multiple underlying edges sharing the same visual endpoint pair (piece↔pill
or pill↔pill) render as **one wire with a count**:

- One heavier wire (reuse the existing gauge ladder; do not invent a new
  thickness scheme) + a small count chip near the pill end when count > 1.
- Click → **modeless inline list** of the underlying edges (no modal —
  standing owner rule), each entry exposing the existing wire actions
  (select / delete / add-symbol from bezier Phase 3).
- Aggregated wire color: **worst-status-wins** across the underlying edges
  (broken > orphaned > drifted > unused > pending > resolved — reuse the
  existing status-priority order rather than redefining it). *Ratified by
  owner 2026-07-17.*

### D3 — Wire drop on a group: picker, preference-gated (owner: "I like the picker idea")

Dropping a wire drag on a collapsed pill (or a group's gutter) resolves the
target via the **existing picker affordance** node-to-node connect already
uses — extended to group targets, which also covers group-to-group, not just
outside-node → group.

- Behavior is a **preference** (ADR-019 registry, Behavior room), owner
  decision — two options so "people can have the flow they want":
  1. **Open group** — the drop expands the group, user completes the
     connection normally.
  2. **Use picker** — a picker of the group's member files opens at the drop
     point; choosing one completes the connect flow against that file.
- Default: **picker** (no canvas-layout disturbance, fewer clicks —
  consistent with the low-friction principle). *Ratified by owner
  2026-07-17.*
- Drag **starting from** a pill (group-to-group's source end): complete the
  gesture first, then resolve ambiguous endpoints in order (source picker,
  then target picker if needed). Don't interrupt mid-gesture. If v1 wants to
  keep scope tight, source-from-pill may ship after drop-on-pill; the
  preference and picker component are shared either way.

### D4 — Off-canvas import badge (owner: "I actually like the badge affordance idea")

When discovery resolves an import whose target file has **no piece on
canvas**, do not spawn a piece and do not stay silent:

- The **importing piece** shows a badge: "N imports off-canvas."
- Click → inline list of the off-canvas files → choosing one **places the
  piece** (near the importer; normal spawn animation), after which the wire
  appears through the normal path.
- **Evaporation rule (owner):** the badge is *derived state*, recomputed from
  (discovered edges × pieces on canvas). The moment the file gains a piece —
  placed via the badge, the scaffold drawer, or anything else — the badge
  entry disappears and is replaced by the wire. Symmetrically, deleting the
  piece from canvas brings the badge entry back. No stored badge state.
- Discovery must therefore **retain** unmatched resolved edges (today it
  drops them at `createConnectionsForEdges`) — keep them in a queryable
  "pending edges" structure the badge selector and the place-action consume.

### D5 — Incremental discovery

Re-run discovery per-file on save / import-write (and on scaffold refresh),
not just once per load:

- The run-once machinery keys on a load token; this extends it with
  file-scoped re-runs — full-project discovery stays load-time.
- Dedup is already automatic: edge identity is the piece pair and
  `createConnectionFromDrag` direction-dedups (returns null on existing).
- This also keeps D4's pending-edges set current mid-session.

## Interaction with runtime reality (no work, awareness only)

Drawing oAuth→main writes `import oauth` into main.py. Whether *Python*
resolves that at runtime depends on `sys.path` / launch style; the discovery
engine treats both root and `src/` as source roots. The wire shows intent;
pyright + the LED health channel show whether the code agrees (a wire
coexisting with a red LED is the system working). No wire-side validation is
added.

## Out of scope

- Wire routing/collision avoidance (bezier brief's future layer).
- Connection domain data model, edge identity, persistence schema.
- Auto-spawning pieces for discovered imports (explicitly rejected — canvas
  stays curated; D4 is the replacement).
- Glass sampling fixes — separate brief (`brief-glass-backdrop-sampling.md`).

## Proposed slices (each its own branch/PR)

1. **S1 — pill re-anchor + pill-to-pill** (D1): selector-level endpoint
   resolver + tests; no aggregation yet (parallel wires acceptable
   transiently within this slice's PR only if S2 lands in the same arc).
2. **S2 — aggregation + inline edge list** (D2): grouping selector, count
   chip, modeless list wired to existing Phase-3 wire actions.
3. **S3 — pending-edges retention + off-canvas badge** (D4): discovery keeps
   unmatched edges; badge + place-action; derived evaporation.
4. **S4 — drop-on-group picker + preference** (D3): picker extension,
   ADR-019 preference registration, both behaviors.
5. **S5 — incremental discovery** (D5): file-scoped re-run on save/write +
   scaffold refresh.

Ordering: S1→S2 first (visible payoff, self-contained), S3 next (closes the
owner's original "outside src/ not working" case for discovery), S4/S5 after.

## Acceptance (arc)

- Collapsed `src/` group: oAuth.py's wire draws to the pill; expanding the
  group restores the piece-to-piece wire. Two collapsed groups importing
  across → one pill-to-pill wire with count.
- Clicking an aggregated wire lists its underlying edges; each supports the
  existing wire actions; no modal appears anywhere in the arc.
- A project-root file imported by `src/main.py` but not on canvas produces a
  badge on main.py's piece; placing it from the badge yields the wire and the
  badge entry evaporates; deleting the piece restores the badge entry.
- Dropping a wire on a collapsed pill honors the preference (open vs picker);
  the picker completes a working connect flow.
- Typing an import in the editor and saving produces the wire (or badge
  entry) without a project reopen.
- Domain tests unaffected except where new selectors/pending-edge structures
  add coverage; guards pass.
