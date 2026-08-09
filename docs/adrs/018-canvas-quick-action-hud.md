# ADR-018: Canvas Quick-Action Widget Group (HUD)

## Status
- Amended (2026-08-01 — the gate amendment's box-first *manual group* (folder-less,
  promote-later) is superseded by the group-physicality ruling
  (`docs/plans/ideas/brief-group-physicality.md`): + Group is now name-first and
  disk-first — a screen-space preview until the name commits, then the folder
  exists before the group does. Ghost groups no longer exist as a persistent
  state; legacy ones rectify on open. The box-first *interaction shape* survives;
  its deferred-materialization semantics do not.)
- Accepted — fully implemented (Phases A–C + gate amendment; PRs #96, #97, #98, #100; 2026-07-02/03)

## Date
- 2026-07-02

## Context

The scaffold drawer is the single home for creating canvas objects (New Node / New Group pills), but the drawer is a *mode you open* while the canvas is *where you live*. Flow-of-thought creation — "I need a node *here*" — breaks on the context switch, and a created node lands at the origin rather than where the user is looking.

The design was captured in `docs/plans/ideas/canvas-quick-action-widget-group.md` (2026-06-17). The original capture deferred all section machinery because the abstraction would have been designed against **a sample size of zero real sections**. That trigger fired 2026-07-02: three heterogeneous candidate sections now exist (compact action cluster, tall reference panel, control cluster), the design advanced in the doc's addendum, and an interactive prototype (`docs/prototypes/prototype-hud-widget-group.html`) validated the interaction and visual system the same day.

Precedents this builds on:

- The search pill, minimap, and status bar are HTML overlays above the Konva `<Stage>` — the HUD is the same species.
- The drawer rail is draggable — movable floating chrome exists.
- The menubar (PR #93) established the dual-surface pattern (menu item + accelerator) the HUD toggle reuses, and its Actions menu already mirrors the scaffold pills.
- ADR-014 glass material system; the button finish is the shipped `cm-hover-card` glass treatment.

## Decision

A **screen-anchored HUD** floats over the open canvas area — HTML overlay, not Konva-drawn, not docked to chrome. It holds N widget sections behind a registry contract, is draggable as a whole, and composes via a checkbox visibility menu.

### Container contract (the seam)

The HUD maps over a registry of `{ id, title, node, defaultVisible }` entries. Adding widget N+1 is append-one-entry: its section and its visibility checkbox are both generated. Help's internal subsections (M+KB / KB / Drag) are content *inside* its `node` — subsection structure does **not** exist in the container contract.

### Visibility: one state variable

A dropdown on the HUD holds one checkbox per section, **generated from the registry**. This replaces per-section collapse, minimize-to-pill, and a show/hide-as-minimize toggle as three separate mechanisms — they all reduce to *the set of checked sections*:

- Unchecked sections vanish entirely; no half-collapsed headers.
- **The pill is the degenerate rendering of the empty set**, not a special mode.
- Known cost, accepted: re-showing a section is two clicks (menu → check). Occasionally-toggled sections (Help, Pan & Zoom) fit that; a future widget wanting rapid cycling must argue for its own affordance.

### The pill rule (lock-out safety)

The menu trigger lives on the pill and **the pill is always rendered** — the one piece of permanent chrome: drag grip + menu trigger in every state. Unchecking everything can never strand the user without the menu that lets them back in.

### Whole-HUD drag

Table-stakes, not polish: a thing that "floats" but can't move reads as chrome that forgot its dock. Users park it per workflow (left-to-right, right-to-left, and shove-it-in-a-corner thinkers).

| Rule | Behavior |
|---|---|
| Grab surface | Any non-interactive glass drags (pill, section padding, titles, help rows). Buttons, inputs, and checkboxes stay clickable. Grip affordance on the pill makes movability discoverable. |
| Clamp | Clamp-to-viewport on drag, on window resize, and on state restore. User-positioned chrome owns the stranded-off-screen failure mode; split panes changing available area makes it likelier. |
| Persistence | Position + visibility set + hidden bool persist as a global app pref (same tier as `energyLevel`). |
| Deferred | Per-section drag-to-reorder, per-section resize, edge snapping. No current section needs them. |

### Keybind is a separate axis

The checkboxes *compose* the HUD; a global keybind hides *everything including the pill* (clean-canvas aesthetic). One bool over one set; no interaction between the mechanisms. Toggle homes: **View menu item + keybind**, the menubar's established dual surface. Specific key deferred to the shortcut-registry constraints (prototype used `H`; a bare letter follows the `E` edit-mode precedent for canvas-scope gestures; ADR-013 forbids `Alt+`).

### v1 sections (the validated sample set)

**Create — New Node / New Group.** Thin callers of the *same* create handlers the scaffold pills and Actions menu use; the HUD's only addition is placement — spawn coordinates computed from the viewport center via the inverse pan/zoom transform. Naming modal answers *what*, the button answers *where*.

- **New Node uses the placeholder-then-name flow** (validated in prototype): the node lands at viewport center instantly, the modal (filename + optional label) names it, Esc/cancel removes the placeholder. The node is "there" the moment you decide.
- **New Group is box-first and folder-less**: an empty group box lands at viewport center with an inline name field focused — Enter commits, Esc cancels the box. No modal, no folder backing. The group/folder reconciler is verified safe as written: it skips `folderPath: null` groups in both create and remove passes (`reconcileGroupsWithFolders.js`), so a purely visual group needs **zero reconciler change**. Membership is the group's own `pieceIds`; disk backfill is deferred.
- **Pre-build gate — RUN 2026-07-02, verdict: conditional.** The literal question ("does `folderPath: null` pass end-to-end?") is **yes** everywhere: domain commands treat it as a plain value, the reconciler skips folder-less groups (`reconcileGroupsWithFolders.js:66`), the DB schema's `folder_path` is nullable, and persistence hydration *explicitly supports* "manual" groups — `group_pieces` is documented as the membership fallback for any group without a folderPath (`useProjectPersistence.js:168`). But the gate surfaced that folderPath was never the real risk — **emptiness and geometry are**:
  1. **Empty groups are unrepresentable in the domain.** `createFolderGroup` rejects `pieceIds.length === 0`, and three commands cull *any* group that goes empty regardless of folderPath (`groupDomain.js:45,72,95` — the create-strip pass, `removePieces`, `removePieceFromGroup`). An unrelated piece deletion would erase a freshly spawned empty box.
  2. **Empty groups are invisible.** Both render paths filter on `pieceIds.length > 0` (`useWorkspaceRenderSelectors.js:70`, `WorkspaceStage.jsx:464`), and `buildGroupBounds` derives geometry purely from member pieces — no members, no bounds, nothing to draw or hit-test.
  3. **Groups have no intrinsic position.** Neither the state shape nor the `groups` table (id, name, folder_path, is_collapsed, parent_id, theme_id, color) stores x/y — "spawn at viewport center" has nowhere to live.

  **Required amendment (box-first prerequisite, contained):** a `createManualGroup({ groupId, name, seedBounds })` command permitting empty `pieceIds` with `folderPath: null`; the three cull filters exempt folder-less groups (mirroring the reconciler's skip — manual groups die only by explicit `deleteGroup`); `seedBounds` (x/y/w/h) on the group as the `buildGroupBounds` fallback when memberless, with member-derived bounds winning once pieces join; the two render filters admit memberless manual groups that carry seedBounds; a DB migration adding seed-geometry columns. Membership persistence needs nothing — the manual-group fallback already exists.

  Sequencing consequence: **New Node is fully green** (no gate applies to it). Box-first New Group ships behind this amendment — Phase A can land the HUD + New Node first with New Group following, exactly the independent-shipping split the capture doc anticipated.

**Help — shortcuts.** Categorized reference panel (Drag / M+KB / Canvas Keys subsections, internal). Rationale: the menubar teaches command accelerators next to menu items, but canvas *gestures* (pan, zoom, lasso, drag-to-group, modal taps) have no discoverable surface anywhere — a panel floating over the canvas is the one surface that can cover that gap.

- **Curation rule (decided 2026-07-02): gestures-first, non-duplicative.** Subsection order leads with Drag and Mouse+Keyboard; the keyboard subsection is restricted to keys with **no menu row** (modal gestures like `E` and the Ctrl/Alt sub-mode taps, chord-only bindings). Menu-covered accelerators (`Ctrl+P`, `Ctrl+0`, save, undo, …) are deliberately absent — the menubar is their teaching surface. This keeps the panel at a curated ~15 rows instead of an exhaustive ~30, avoiding scroll machinery.
- Data source: any KB rows that *are* registry actions should be backed by the central shortcut registry (`docs/plans/ideas/shortcut-registry.md`) or the widget becomes a fourth hand-maintained shortcut-truth surface that rots like the `Ctrl+K` label did. The registry sketch excludes gestures — under the gestures-first rule most of this widget's rows are the hand-maintained kind, which shrinks (but does not remove) the registry dependency.

**Pan & Zoom — the interlocking dial.** The prototype resolved the "controls vs reference content" identity question decisively toward controls, shaped in the puzzle-piece motif:

- One circle carved into **four wedge sectors** (`clip-path` polygons meeting at center, hairline diagonal seams) wrapping a center **hub split into Fit / 1:1**. The hub covers the wedge tips — no mis-click dead zone at center.
- A **zoom arc band** crowns the dial: an annular ring (radial-gradient mask) split at twelve o'clock into − / +, ends ~8% above the horizontal midline. Its inner edge tucks under the dial rim.
- **Hold-to-glide**: pressing an arrow pans continuously (user-driven rAF, ~8px/frame); click nudges. Arrow keys pan identically (key auto-repeat = glide). Arrow = the camera moves that way.
- Zoom % readout in the bottom-right void.
- `clip-path` clips hit-testing, so hover/press follow the visible piece shapes exactly.

### Visual system (validated in prototype)

- Glass pill cluster per ADR-014; accents: node = `--cm-electric-blue`, group = `--cm-indigo`; respects Live/Calm for free.
- All buttons wear the **`cm-hover-card` glass finish**: `linear-gradient(160deg, …)` lit top-left falling dark, plus a top-edge inset glint. Accent hovers are *tinted glass* (the gradient shifts blue/indigo), not flat fills.
- The dial reads as **one lit disc**: the four full-square wedges share a single gradient so the clipped sectors reassemble into one surface, plus an elliptical lens glare (`::after`, non-interactive) and a rim-light inset shadow following the top curve.
- **No ambient animation** (perf lock). All motion is user-driven.

### Click-through

Established overlay pattern: `pointer-events: none` on the container layer, `auto` on the HUD itself — panning, lasso, and marquee-select keep working underneath.

### Delivery slices

- **Phase A**: registry container + pill + generated checkbox menu + whole-HUD drag/clamp/persist + keybind & View-menu toggle + **Create section** wired to the existing create handlers with viewport-center coordinates (placeholder-then-name for nodes; box-first groups behind the `folderPath: null` gate).
- **Phase B**: **Pan & Zoom dial** ported to the app (self-contained; talks only to the viewport transform).
- **Phase C**: **Help widget** under the gestures-first curation rule. The registry dependency is reduced (most rows are gesture rows, hand-maintained by definition); only the Canvas Keys rows that overlap registry actions need the sourcing decision.

### Open questions (carried, non-blocking)

- Pill click when everything is unchecked: opens the menu (start here) vs one-click restore of the previous set vs click/double-click split.
- Help's default check state: candidate is checked on first run, persisted off once cleared.
- Exact keybind, resolved with the shortcut registry.

## Consequences

- **Three surfaces now call the create handlers** (scaffold pills, Actions menu, HUD). The handlers must stay the single source of truth; the HUD's placement coordinates are the only permitted delta. Any create-flow change touches one place.
- **Folder-less groups are the first shipped instance of "grouping without a disk write"** — a live down payment on plan-only mode. The `group_pieces` seam stays load-bearing; the "what happens on drag-into-visual-group" backfill is contained and deferred.
- **`backdrop-filter` creates a stacking context** — a popover spawned inside a glass container cannot z-index above sibling glass; its parent's context must be raised or the popover portaled to a top layer. Hit in the prototype (menu rendered invisible behind sections); the app's glass overlays (search pill, minimap) share the trap.
- The Help widget adds pressure to actually build the shortcut registry; its "trigger to revisit" (a new shortcut display surface) is now scheduled work rather than hypothetical.
- HUD position can overlap split-pane drop zones and other overlays; user drag + clamping is the resolution rather than reserved regions.
- Deferring reorder/resize means a fourth+ widget that genuinely needs them triggers container work at that time — by design (structure now, machinery when earned).

## Alternatives Considered

- **Dock the actions to chrome (toolbar/status bar)** — rejected; costs permanent chrome real estate and kills the "floats where you work" premise. The toggle already resolves the clean-canvas tension by user choice.
- **Canvas-anchored (Konva-drawn) controls** — rejected; canvas-anchored controls fly off-screen on pan and shrink on zoom. Controls belong to the viewport frame.
- **Three separate visibility mechanisms** (per-section collapse + minimize-to-pill + global toggle) — replaced by the single checked-set model; strictly less state and chrome.
- **Build the full section machinery in June** — correctly deferred then (sample size zero); the addendum earns only drag + visibility + pill. Reorder/resize/snapping remain unearned.
- **Zoom as discrete corner pucks** — superseded during prototyping by the arc crown; the assembled dial carries the puzzle-piece motif, floating pucks didn't.
- **Folder-backed New Group** — rejected; the reconciler's empty-folder rule would garbage-collect the group on next refresh. Box-first *means* folder-less.
- **Modal for New Group naming** — rejected; one field (name, no filename) is exactly what inline-rename-in-place fits (`InlineNameInput` precedent).

## References

- Capture + addendum: `docs/plans/ideas/canvas-quick-action-widget-group.md` (2026-06-17; addendum 2026-07-02)
- Prototype: `docs/prototypes/prototype-hud-widget-group.html` (signed-off dial + glass finish, 2026-07-02)
- Reconciler finding: `src/app/reconcileGroupsWithFolders.js`, `src/app/useGroupFolderReconciliation.js`
- Shortcut registry idea: `docs/plans/ideas/shortcut-registry.md`
- ADR-013 (interaction modes, no-Alt constraint), ADR-014 (glass material system), ADR-017 (split panes — drag-kind seam, overlay hit-testing)
- Menubar buildout: PR #93
- Forward-looking: VR endpoint vision — a screen-anchored creation palette is the 2D ancestor of a gaze-anchored palette in 3D.
