# Capture: Canvas Quick-Action Widget Group (New Node / New Group)

> **Status**: **Promoted to [ADR-018](../../adrs/018-canvas-quick-action-hud.md)** (2026-07-02) — this capture is now history/rationale; the ADR is the decision record. Design advanced 2026-07-02 — see the addendum at the bottom; it supersedes parts of "Build now vs. defer".
> **Date**: 2026-06-17
> **Origin**: Discussion following the scaffold-drawer fold-in (New Node / New Group pills replacing the old Create New Piece drawer). Question raised: can the same two actions float over the canvas as "quick buttons" for flow-of-thought creation — "I need a node *here*."
> **Dependencies**: Reuses the create handlers already kept as hooks (`handleOpenCreatePieceModal` / the scaffold new-folder path). No ADR dependency. Box-first groups depend only on the group data model / domain accepting a null `folderPath` (the reconciler already tolerates it — see below).
> **Suggested home**: `docs/plans/ideas/` until scheduled. New Node could ship independently of New Group.

---

## Problem

The scaffold drawer is now the single home for creating canvas objects (New Node / New Group pills). But the drawer is a *mode you open*; the canvas is *where you live*. For flow-of-thought creation — the moment of "I need a node right here" — opening a drawer is a context switch that breaks the creative thread.

A floating quick-action cluster over the canvas keeps creation at hand, and — more importantly — lets a new object land **where you're looking** instead of at a fixed off-screen origin.

## Decision Summary

- A **screen-anchored HUD** ("widget group") floats *in the air over the canvas*, not docked to chrome. It stays put as you pan/zoom (moves with the viewport frame, not the canvas content).
- **New Node**: keeps the naming modal (filename + label are unavoidable), but spawns at **viewport center** instead of the origin. The modal answers *what it's called*; the button answers *where it goes*.
- **New Group**: **box-first** — drop an empty, folder-less group box at viewport center and inline-rename it on the box. No modal, no folder backing yet.
- The widget group is built **now as a registry-backed container** (holds N widgets) with a global show/hide toggle. The **minimize / per-section machinery is deferred** until there are real sections to design against.

This is a thinking-partner capture; nothing here is built yet.

---

## The widget group (the HUD)

- **Screen-anchored**, not canvas-anchored. Canvas-anchored controls fly off-screen when you pan and shrink when you zoom — wrong for controls. The HUD stays in a fixed spot in the viewport frame.
- **Floats in the air over the open canvas area** — does *not* dock to chrome, so it costs no chrome real estate. It overlaps canvas content; click-through is handled by `pointer-events: none` on the container and `pointer-events: auto` on the widgets only (the established pattern — same as the search pill, minimap, status bar). Panning, lasso, and marquee-select keep working underneath.
- **Precedent exists**: the search pill, minimap, and status bar are all HTML overlays sitting above the Konva `<Stage>`. The widget group is the same species — HTML, not drawn in Konva.
- **Toggle** buys back the nick to the clean-canvas aesthetic (discoverability-always-there vs calm-hidden-until-needed is a real tension; the toggle resolves it by user choice). Likely a keybind for flow (flick the HUD on/off), persisted as a global app pref (cf. `energyLevel`).
- **Visual language**: glass pill cluster matching the search-pill treatment; New Node = electric-blue (`--cm-electric-blue`, node accent), New Group = indigo (`--cm-indigo`, group accent). Respects Live/Calm intensity for free.

## New Node — modal for naming, viewport for placement

The naming modal stays. A node needs a **filename** (real file on disk, validated for extension + uniqueness) and an optional **label** — two fields, which a single inline field can't capture cleanly. There's no getting around the modal for nodes.

The actual upgrade the viewport button delivers is **placement**, a separate axis from naming:

- Today a created node lands at the origin (`x:0, y:0`), wherever that is relative to the current view.
- "I need a node *here*" is a statement about *where*, not *what*.
- The viewport button computes the spawn point from the current view (viewport center, via the inverse of the pan/zoom transform) and hands those coordinates to the same create handler.

This is also what cleanly distinguishes the widget button from the drawer pill: **same modal, different landing spot.** Both reuse one handler; the button just passes view coordinates.

**Optional flow-maximizing variant** (decide later): click New Node → a placeholder node pops into view *instantly* → modal names it → commit (Escape removes the placeholder). The node is "there" the moment you decide; naming is the quick follow. Costs a little extra state (cleanup on cancel), but it's the most "creative mindset" version.

## New Group — box-first, folder-less, inline-named

A box-first group needs **exactly one field — a name** (no filename). So **inline-rename-in-place is the perfect fit**: drop an empty group box at viewport center, its name is already an editable field on the box, type it, Enter to commit, Escape to cancel. No modal. (Precedent: the scaffold tree's `InlineNameInput`.)

### The reconciler finding (the key technical truth)

We verified the group/folder reconciler ([`src/app/reconcileGroupsWithFolders.js`](../../../src/app/reconcileGroupsWithFolders.js), run by [`src/app/useGroupFolderReconciliation.js`](../../../src/app/useGroupFolderReconciliation.js)) rather than theorizing. What it actually does:

1. **It never touches folders on disk.** It only creates/deletes *group objects* (canvas side). It cannot delete a folder. (This is why a scaffold New Group folder persists empty — nothing deletes folders, ever.)
2. **An empty folder never spawns a group.** Groups are created only for folders that already contain pieces (it walks `piecesByFolder`). An empty folder isn't garbage that survived cleanup — it was never eligible to become a group.
3. **The removal rule is narrow**: it deletes a group only when that group **has a `folderPath` whose folder has gone empty** (a folder-backed group that lost all its pieces). That keeps the folder=group invariant.
4. **Folder-less groups are explicitly skipped** — `if (!group.folderPath) continue;` in the removal pass. The reconciler never creates *or* deletes a group with no folderPath. It leaves them completely alone.

**Consequence for box-first**: a group created with `folderPath: null` (a purely visual canvas container) is **already safe with the reconciler as written — zero reconciler change needed.** The only way to hit the garbage collector is to back the new box with a real-but-empty folder; then the empty-folder rule eats its group on the next refresh. So the rule is simply: **box-first group = folder-less group.**

- Membership is tracked by the group's own `pieceIds` list (visual grouping), not by a disk folder.
- "What happens to the file on disk when a piece is dragged into a visual group" = **nothing yet.** That's the deferred backfill — contained, later, not blocking anything.
- Color cascade still works: a folder-less group can carry a color and cascade it to children in canvas-space.

**One thing to trace before building**: the reconciler is confirmed safe, but verify the group **data model + domain commands** accept `folderPath: null` end-to-end (persistence, membership ops). The scary part (reconciler) is already on our side; this is the remaining unknown.

---

## Build now vs. defer — structure vs. behavior

The reasoning that settled this: **structure and behavior have different cost curves.**

### Build now (the seam — nearly free, expensive to retrofit)

- The widget group as a **registry-backed container** that maps over a small list of `{ id, node }` entries — *not* two hardcoded button siblings. New Node and New Group are the first two entries.
- Layout that stacks **N** entries, not exactly 2.
- The global **show/hide toggle** for the whole HUD (a real feature now, not speculative).

This delivers the "drop-in ready" goal: a future widget is append-one-entry.

### Defer (the machinery — speculative, sticky-if-wrong)

- Per-section minimize/collapse UI + state.
- Section headers/chrome, drag-to-reorder, resize, per-section persisted collapse state.

### Why defer the machinery (the real reason)

Not the build cost. It's that you'd be **designing the section abstraction against a sample size of zero real sections** — currently there's one button cluster, not even two distinct sections. You have no evidence about what a "section" needs to be (related-button group? arbitrary-content panel? resizable pane?).

And the failure mode is worse than wasted effort: build it now and it ships as **load-bearing**. The first real second section (color picker, layers list, …) will likely violate the guessed contract, forcing the new thing to contort or forcing a breaking rewrite of shipped code. **A shipped-but-wrong abstraction is stickier and costlier than no abstraction.** Building it now doesn't avoid the future rewrite — it schedules it earlier and makes you build twice.

This is consistent with "touch it once": that principle applies to things *coupled and known* (container shape + the two buttons → do together now). The section behavior isn't yet coupled to any concrete example, so it's a separate touch that hasn't earned its trigger.

**Payoff**: when widget #3 arrives, append it to the registry, then build minimize behavior against a real second section you can see and feel.

---

## Open questions (for whenever this is scheduled)

- **Toggle home**: keybind (best for flow) vs status-bar pill vs menu item. Persistence scope: global app pref vs per-project (likely global).
- **Fixed vs draggable** HUD position (the drawer rail is already draggable — precedent exists for movable).
- **New Node placeholder-then-name** flow vs plain modal-then-appear.
- **Spawn point** definition: viewport center vs last cursor position vs click point.
- **Folder-less group end-to-end**: confirm data model + domain commands accept `folderPath: null` (persistence + membership).

## Forward-looking

A screen-anchored quick-action cluster in 2D is the direct ancestor of a gaze-/hand-anchored creation palette in 3D/VR (a palette that follows your view rather than living in a side panel). See the VR endpoint vision — this is a small down payment on the spatial-creation model, not just convenience.

---

# Addendum 2026-07-02: sample size reached — drag + visibility model settled

The original deferral argument was "you'd design the section abstraction against a sample size of zero." That trigger has now fired: there are three candidate sections, and they're **heterogeneous in shape**, which is what makes the contract designable:

1. **New Node / New Group** — compact action cluster. Always-visible is fine; no internal state.
2. **Help / shortcuts** — a reference *panel*: tall, content-heavy, with internal subsections (M+KB, KB, Drag, …). The first widget that genuinely can't be always-visible.
3. **Pan & zoom** — either a control cluster (zoom %, fit, reset) or reference content. *(Open: which? If controls, it's a third section kind — readout + actions. If reference content, it's arguably a Help subsection and the sample count is two. Either way the contract below holds.)*

## Decisions

### Whole-HUD drag is table-stakes, not deferred machinery

The doc's core claim is "floats in the air over the canvas" — a thing that floats but can't be moved reads as chrome that forgot its dock. Users must be able to reposition it for their workflow (left-to-right thinkers, right-to-left thinkers, and "this is in my way, I'm shoving it down" thinkers). Precedent: the drawer rail is already draggable.

- **Grab surface**: any non-interactive glass drags; buttons still click, Help content still scrolls/selects. A visible grip affordance makes movability discoverable.
- **Persistence**: position is a persisted global pref (same tier as `energyLevel`), alongside the visibility set below.
- **Clamping**: user-controlled position owns a failure mode fixed position never had — window shrinks, HUD stranded off-screen, user thinks the feature vanished. Clamp-to-viewport on restore and on resize is non-negotiable. Split panes changing available canvas area makes this more likely, not less.

Note the distinction that got conflated earlier: whole-HUD drag (earned, above) vs per-section drag-to-reorder *within* the HUD (still deferred — no sample needs it).

### Visibility model: checkbox menu, not collapse

A dropdown on the HUD surface holds **one checkbox per section**, controlling what's rendered. This **replaces** per-section collapse, the global show/hide toggle-as-minimize, and minimize-to-pill as three separate mechanisms — they all reduce to **one state variable: the set of checked sections**.

- Unchecked sections vanish entirely (no half-collapsed headers eating vertical space).
- **The pill is the degenerate rendering of the empty set**, not a special "minimized mode."
- The container contract shrinks to `{ id, title, node, defaultVisible }`.
- **The dropdown is the registry made visible**: the checkbox list is *generated* from the widget registry, so widget #4 gets its row by being appended — and the menu doubles as the discoverability surface for widgets that exist but are hidden. Established pattern users already know (Figma/Photoshop panels menu, table column pickers). "Compose your HUD," not "collapse your HUD."
- Known cost, accepted: re-showing a section is two clicks (open menu → check) vs one on a clickable collapsed header. Right trade for occasionally-toggled sections (Help, pan/zoom). A future widget that wants rapid show/hide cycling can argue for its own affordance when it arrives.

### The pill rule (lock-out safety)

**The dropdown trigger lives on the pill, and the pill is always rendered.** It is the one piece of permanent chrome — drag grip + menu trigger in every state. Otherwise unchecking everything locks the user out of the menu that would let them back in. This also answers the grab-surface question uniformly: the pill is the always-there drag handle.

### Keybind is a separate axis

The checkboxes *compose* the HUD; the global keybind hides *everything including the pill* for the true clean-canvas aesthetic. One bool over one set — no interaction between the two mechanisms. Stated explicitly so they don't get merged into one confused mechanism later.

### Revised earned/deferred ledger

- **Earned**: container drag + position persistence + viewport clamping + per-section visibility (checkbox menu) + pill state + registry-generated dropdown.
- **Still deferred**: section drag-to-reorder, per-section resize, edge-snapping/magnetism. No sample needs any of it. The line moved; there is still a line.

## Help widget — connections worth honoring at build time

- **Shortcut registry collision (good kind)**: [shortcut-registry.md](shortcut-registry.md) exists because shortcut truth already lives in three disconnected places, and a label (`palette: Ctrl+K`) shipped for months with no binding behind it. A hand-maintained Help widget becomes place #4 and rots the same way. The registry doc's own revisit trigger is "next time a display surface for shortcuts is added" — this is that. **Wrinkle**: the registry sketch covers keyboard accelerators and explicitly leaves modal gestures (`E`-mode, Ctrl/Alt taps) outside it, but the Help widget's most valuable categories (M+KB, Drag) are exactly the gesture-shaped ones. Either the Help widget drags the registry forward with a gesture-entry concept, or it knowingly hand-maintains gesture rows and registry-backs only the KB rows.
- **Discoverability framing (stronger than the original doc's)**: the menubar (PR #93) already teaches command shortcuts via accelerator labels. What has *no* discoverable surface anywhere is canvas gestures — pan, zoom, lasso, drag-to-group, edit-mode taps. Menus structurally can't teach those; a help panel floating over the canvas is the one surface that can. The Help widget isn't duplicating the menubar — it covers the gap the menubar can't reach.
- **Boundary to hold**: Help's subsections (M+KB / KB / Drag) stay **internal to the Help widget** — its own content structure inside its `node`. They do *not* leak into the container contract as "sections have subsections." Otherwise we're designing second-level machinery against a sample size of one.

## Open questions (addendum)

- **Pill click when everything's unchecked**: opens the menu (explicit, predictable) vs one-click restores the previous check set (faster for shove-away/bring-back). Could be click = menu, double-click = restore. Start menu-only; let usage argue for the shortcut.
- **Help's default check state**: minimal defaults say Node/Group only, but Help is most valuable to exactly the users who don't know the dropdown exists. Candidate: checked on first run, persisted off forever once cleared.
- **Pan & zoom identity**: controls vs reference content (see sample #3 above).
- Carried from the original: spawn point definition, placeholder-then-name node flow, folder-less group end-to-end (`folderPath: null` through data model + domain commands — still the real pre-build gate).
- Superseded from the original: "toggle home" (View menu entry + keybind, mirroring the Actions-menu pattern) and "fixed vs draggable" (draggable, settled above).
