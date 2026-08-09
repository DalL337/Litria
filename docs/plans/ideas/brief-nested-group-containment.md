# Brief: Nested Group Visual Containment

> **Status**: RULED — all five decision points decided by the owner
> 2026-07-28 (same day; rulings recorded inline in §6). Ready for slicing
> per §7; no open questions remain.
> **Date**: 2026-07-28
> **Owns**: PRD-GNM-001 §10.2 ("nested groups render flat" — the promoted design task) and the PRD-FSM-001 §3.4 policy divergence.
> **Evidence base**: `.research/2026-07-25-fsm-breakdown.md`, `.research/2026-07-26-nested-group-canvas-vanish.md` (gitignored investigation journals; findings restated here so this brief is self-contained).

## 1. Problem

Nesting is now cheap to do (edit+additive drag, scaffold folder drag, §3.3
in-pipeline creation) and the data layer is trustworthy end-to-end: parentId
is derived from folder containment, hit-testing is innermost-wins, and parent
bounds union their descendants. But the *visual* language of containment is
still mostly absent. The 2026-07-26 incident chain showed where this ends:
a nested single-piece group whose box was geometrically present but
effectively invisible, read by the owner as data corruption. The data was
fine; the pixels lied.

What §10.2 originally recorded — "canvas renders nested groups as flat
peers, no visual indicator of parent-child relationship" — is now partially
false. This brief inventories what shipped, names the real remaining gaps,
and puts the open policy questions in front of the owner as concrete
decision points.

## 2. What already shipped (do not re-design)

| Mechanic | State | Where |
|---|---|---|
| parentId as derived state (nearest-ancestor folder containment; reconciler emits hints, FSM §3.3 creations parent-linked at birth; explicit-null clears persisted) | ✅ PR #191 | `useGroupFolderReconciliation`, `applyFsSyncPlan`, Rust `GroupUpdate` |
| Innermost-containing-group-wins hit testing (piece drags, pill drags; own-group containment rule) | ✅ PR #192 | `findInnermostGroupAt` |
| Parent bounds union descendant bounds + clearance | ✅ PR #195/#196 | `buildGroupBoundsWithDescendants`, `NESTED_BOUNDS_CLEARANCE = 14` ([workspaceSelectors.js:192](../../../src/app/selectors/workspaceSelectors.js#L192)) |
| Nested visual affordances: `+8` nest pad and `[4,4]` dash keyed on `outline.parentId` | ✅ (pre-existing, fires since #191) | [WorkspaceStage.jsx:133](../../../src/components/WorkspaceStage.jsx#L133), :167, :209 |
| Emptied-group DB-row persistence (no ghost rows) | ✅ PR #193 | `collectEmptiedFolderGroups` |
| Scaffold tree containment rendering (rails, ticks, elbows) | ✅ PRs #196–#203 | scaffold.css / renderTree |

## 3. The remaining gaps

### G1 — No reserved interior space; child boxes degenerate

Bounds are *derived from wherever pieces happen to sit*. A child group's box
is its pieces' bounding rect (+pad); nothing gives a nested group visual
breathing room inside its parent, and nothing prevents unrelated pieces from
sitting on top of it. The degenerate case (07-26, "heisenburg"): a
single-piece child group's box == the node's rect, its header tab occluded by
a grid-adjacent node above (pieces render over group boxes by design), side
borders reduced to 1px slivers in the column gutters. Effectively invisible
even when rendering correctly.

### G2 — Parent box drag does not carry descendants

Both drag surfaces (collapsed pill and expanded outline/header tab) route
through `handleGroupPillDragStart`
([useCanvasInteractionController.js:451](../../../src/app/useCanvasInteractionController.js#L451)),
whose piece snapshot is built from `group.pieceIds` alone — no parentId
walk anywhere in the drag path. The delta is applied by
`pieceDomain.commands.previewMoveSnapshotPieces` and committed over the
same snapshot keys.

The asymmetry makes it worse than "children stay behind": since #195, the
box the user *grabs* is the descendant-union bounds — it visually encloses
the children — but only the parent's direct members move. Mid-drag the
children sit still, and on the next render the parent's bounds re-union the
unmoved children, so the box the user "moved" snaps back to encompass them.
The drag reads as broken, not as a scoping choice.

### G3 — Parent collapse ignores descendants

`buildHiddenPieceIds` hides only the collapsed group's **own** pieceIds
([workspaceSelectors.js:71](../../../src/app/selectors/workspaceSelectors.js#L71)),
and neither `buildGroupPills` nor the outline selector filters on
ancestor-collapsed state. Collapsing a parent shrinks it to its 80px pill
stub while descendant boxes, pills, and pieces keep rendering at their
original coordinates — visually detached from (and typically overlapping)
the parent pill. There is no "the folder closed" reading on canvas the way
there is in the scaffold.

**Prior art in-repo**: wire re-anchoring already solves the ancestry
question — `outermostCollapsedGroup` walks the parentId chain
([workspaceSelectors.js:363](../../../src/app/selectors/workspaceSelectors.js#L363))
so wires anchor to the outermost collapsed ancestor. The hide/badge logic
wants the same walk.

### G4 — Empty folders have no canvas existence

Groups exist only where pieces are: the reconciler removes any folder-backed
group whose folder has zero direct pieces, and `keepGroup` culls
move/delete-emptied groups from state. An empty folder is visible in the
scaffold but is *nothing* on canvas — the 07-26 incident-2 asymmetry the
owner read as "something is amiss." Also blocks a natural workflow: you
cannot create an empty folder-group on canvas and drag pieces into it.

### G5 — §3.4 policy divergence (behavior contradicts the PRD)

PRD-FSM-001 §3.4 says: a folder-backed group emptied by piece *deletion* is
**kept** and marked "visually empty" (the folder still exists on disk;
silently destroying user structure surprises). Shipped behavior — keepGroup
cull + reconciler removal + #193's row deletion — **dissolves** emptied
groups, for both delete-emptied and move-emptied cases. One of the two must
change: the code or the PRD. Note G5 and G4 are the same question at
different moments: "keep visually empty" is only meaningful if an empty
group can render (G4).

## 4. Design directions

### G1 — containment geometry

Options, cheapest first:

- **a) Occlusion fixes only**: render group header tabs *above* pieces (or
  clamp tab placement to a free edge), and give child boxes a minimum size
  (e.g. node rect + 2×pad floor) so a one-node child always shows a visible
  frame. No layout engine; boxes still follow pieces. Cheap, targeted at the
  exact 07-26 failure.
- **b) Containment tint**: nested groups additionally get a translucent fill
  (depth-shaded, like the scaffold's rails read) so "inside" is a region,
  not just a border. Pairs with (a); still no layout.
- **c) Reserved-space layout**: parent bounds allocate a dedicated child
  region; child boxes get placement rules (snap inside, avoid member
  pieces). For *free-form* placement this is a real layout engine —
  significant, and it cuts against the canvas's pieces-go-where-you-put-them
  identity. **However**: the auto-arrange path is half-built already —
  `computeGridLayout` has first-class subfolder-row reservation
  (`subfolderGroupIds` → positions, gap, height accounting;
  [gridLayout.js:101](../../../src/utils/gridLayout.js#L101)) that every
  call site currently feeds an empty array, with a "subfolder groups come
  in Phase 2+" comment at
  [useCanvasUiActions.js:47](../../../src/app/useCanvasUiActions.js#L47).
  Wiring that up gives reserved child space in grid-layout flows
  (folder reveal / arrange actions) without touching free placement.

**Recommendation**: a + b now, plus lighting up the existing
`subfolderGroupIds` seam for grid-layout flows; full free-form layout rules
only if the owner wants managed layout at all (see D5).

### G2 — drag cascade

Dragging a parent's box/tab should move the whole subtree (descendant
groups' pieces included) — matching what "picking up a folder" means
everywhere else in the app. Mechanically: resolve descendant pieceIds via
the parentId chain at drag start and apply the delta to the union set.
Selection-drag of individual pieces stays untouched. Low-risk, pure
interaction change; no filesystem involvement (positions only).

### G3 — collapse semantics

Collapsing a parent should read as "the folder closed": hide descendant
groups' pieces AND their boxes/pills, badge the parent pill with the total
descendant count. Expand restores. Alternative (rejected): auto-collapsing
each descendant — mutates children's own collapse state, loses their
expanded/collapsed choices on restore.

### G4 + G5 — empty groups (policy first, pixels second)

If the owner rules "keep emptied groups" (§3.4 as written): keepGroup and
the reconciler stop culling folder-backed groups whose FOLDER still exists
(disk is the arbiter — the reconciler already knows the tree); an empty
group renders as its box at last-known bounds (seedBounds-style, like
manual groups) with an "empty" treatment; explicit `deleteFolder` remains
the way a group dies. This also naturally gives empty folders a canvas
presence (scaffold-created folders could appear as empty boxes — or only
formerly-populated ones; sub-decision D2b).

If the owner rules "dissolve is correct": PRD §3.4 gets a dated supersession
note, current behavior stands, and G4 reduces to "should scaffold-created
empty folders appear on canvas at all?" — which can be answered "no,
scaffold is the empty-folder surface" at zero cost.

## 5. What this brief does NOT cover

- Wire/connection routing across nested boundaries (no observed issue).
- The scaffold tree (done, #196–#203, owner-verified).
- Cross-group piece drag semantics (innermost-wins shipped, #192).
- Manual (folder-less) groups — unaffected by all of the above except
  where noted.

## 6. Owner decision points — RULED 2026-07-28

- **D1 (§3.4)**: **KEEP visually empty** (PRD-FSM-001 §3.4 as written; the
  code changes, not the PRD). With D2 below, the delete-emptied vs
  move-emptied sub-question dissolves: a group lives exactly as long as
  its folder does, however it got empty.
- **D2**: **Full scaffold parity** — every folder on disk has a canvas
  presence, including scaffold-created empty ones.
- **D3**: **Yes** — parent collapse hides the whole subtree.
- **D4**: **Yes** — parent box drag carries the whole subtree.
- **D5**: **As recommended** — occlusion fixes + containment tint + the
  existing grid-layout `subfolderGroupIds` seam; no free-form layout
  engine.

**The model these rulings compose into** (the invariant slices must
protect): **folder on disk ⇔ box on canvas.** Disk is the single source of
truth (owner's 2026-07-26 instinct, now doctrine for this surface);
membership, nesting, existence, and emptiness all derive from it. The
scaffold visibility eye remains the noise valve — scaffold-hidden paths
already filter out of `renderableGroups`, so full parity does not force
every folder of a large project onto the canvas.

**D2 scope note for slice 6**: full parity changes the reconciler's
contract — today it creates groups only for folders with direct pieces and
removes pieceless ones; it must instead create/keep a group for every
(non-hidden) folder. Newly created empty folders need a spawn position
(seedBounds-style, like manual groups; nested ones spawn inside their
parent's box).

- **D6 (added 2026-07-28, same session)**: canvas collapse and scaffold
  tree expansion are **independent per-surface view states — no mirroring
  in either direction, and no cross-surface awareness affordances.**
  Owner rationale: scaffold browsing involves constant expand/collapse
  churn, and mirroring it into the canvas would make regions jump and
  jitter as draws/redraws collect — distracting action-at-a-distance
  (this is also a standing performance constraint on future cross-surface
  ideas). The softer affordances were considered and rejected: dimming a
  scaffold row reads as "is this unavailable now?", and a new badge
  clutters the tree. The parity doctrine (§6 invariant) governs
  **structure only**; fold state is presentation, owned by each surface.

## 7. Slicing sketch (once ruled)

1. G2 drag cascade (self-contained, no policy dependency).
2. G1a occlusion fixes + minimum child box (Rule 6 screenshot loop).
3. G1b containment tint (Rule 6).
4. G1c-lite: feed real `subfolderGroupIds` into the existing
   `computeGridLayout` seam for arrange/reveal flows.
5. G3 collapse subtree (hidden-piece selectors + pill badge; reuse the
   `outermostCollapsedGroup` ancestry walk).
6. G4/G5 per D1/D2 (touches keepGroup, reconciler, WorkspaceStage empty
   rendering, PRD addendum either way).

Each slice independently shippable; 1–4 need no rulings beyond D4/D5.
