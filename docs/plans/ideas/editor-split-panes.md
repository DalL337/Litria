# Capture: Editor Split Panes

> **Status**: **UX signed off — ready for promotion to ADR / Phase A planning.** Refreshed 2026-07-01: all former dependencies shipped; every entry path unblocked. Interactive UX prototype at `docs/prototypes/prototype-editor-split-panes.html` — **Dai approved it same day as "a perfect v1 double pane system and interaction system."**
> **Date**: 2026-06-12 (refreshed 2026-07-01)
> **Origin**: PokkitNebula (RAVN) feedback from macOS testing — users expect split-screen editing (feedback #10)
> **Dependencies**: ADR-011 (platform config / modifier keys) — ✅ implemented (`361f6cb`, PR #42); ADR-013 (interaction-mode system) — ✅ **Phases 1-3 implemented** (PRs #54-56), so the modifier-gesture entry path is no longer gated; menu bar buildout — ✅ implemented (PR #93), adding menubar entry points this capture predates
> **Suggested home**: `docs/ideas/` for now; nothing blocks promotion to ADR

---

## Problem

Litria's editor drawer is single-pane. Testers coming from VS Code and similar IDEs expect to view and edit two files side by side. Splits are a baseline expectation for professional users, and absence reads as a gap rather than a simplification.

## Decision Summary

Split state is **domain-owned workspace state**, not an editor feature. The editor sits behind an adapter contract and renders whatever pane layout the domain describes. Maximum of two panes.

---

## Architecture

### Ownership

- The workspace/editor domain owns the truth: which panes exist, what tabs live in each, which pane has focus.
- The editor (Monaco today) is a **rendering backend** behind an adapter. Litria tells it what to show; it reports back what the user did.
- Rationale: editors become plug-and-play. A future alternative editor (CodeMirror, etc.) implements the adapter contract and inherits splits for free — no re-implementation of layout logic per editor.

### Adapter contract (socket/appliance model)

Litria → editor:
- Show file in pane
- Close file
- Save now

Editor → Litria:
- Content dirtied
- Focus moved
- Save completed

Test for any contract addition: *could a totally different editor implement this without contortions?* Nothing Monaco-specific may leak into the contract vocabulary.

### State shape

- **Main content + optional side content.** Not two numbered slots.
- Pane numbers do not exist in domain state. The UI *paints* "Pane 1" / "Pane 2" headers only while a split is active.
- Pane 1 is always the left pane; Pane 2 is always the right pane. Position is identity.
- No renumbering logic exists because numbers are decoration, not data.

### Single-file invariant (governance)

> **A file has at most one tab in the workspace.** Opening or sending it anywhere either *focuses* the existing tab (target = current pane) or *moves* it (target ≠ current pane). The only new field is `paneId` on that single tab.

This is not a new constraint — it falls out of the existing model. In `EditorSessionContext.jsx`, `tabsById` is keyed by piece ID and `tab.id === piece.id`, so the same piece cannot be represented as two tabs. The state literally cannot hold a duplicate.

Consequences of the invariant:

- **No "two panes, one file" collision to design around.** The `cm://tab/{tabId}/…` URI stays unique because there is still exactly one tab. The earlier "forbid vs. paneId-in-URI" question resolves to *forbid, for free* — no URI change, no LSP regex changes.
- **"Move" is not disposal + recreation.** It re-points the existing Monaco model from one pane's editor instance to the other via `setModel`. One model, re-parented. No second model, no cache churn.
- **Make the illegal state unrepresentable, then reinterpret the gesture.** A user who tries to open an already-open file "in the other pane" gets a *move*, not an error toast. No modal, no guard to maintain across entry paths — consistent with the low-friction UX governance.

---

## UX Flows

### Opening (discoverable → expert)

1. **Node menu** — state-aware items:
   - No split active: **"Open in new pane"** (creates the split)
   - Split active: **"Send to pane 1"** / **"Send to pane 2"** (targets an existing pane)
   - Print the modifier shortcut hint beside the menu label (VS Code style) so the menu teaches the gesture.
   - *(Refresh 2026-07-01)* Canvas right-click is the pan gesture — there is no node context menu. "Node menu" concretely means the **Actions pill Node cluster** (`GroupMenuOverlay`) **and its menubar mirror** (Actions → Node, PR #93). Both are generated surfaces now (`menuBarItems.js` builder + shared `ActionMenuForms`), so the state-aware items are defined once and appear in both places with guaranteed parity.
2. **Tab strip context menu** — "Open in new pane" / "Send to pane 1/2" on tabs, covering the "already open, now I want it beside this other file" flow.
   - *(Refresh 2026-07-01)* Add **View → Split Editor** in the menu bar with the **`Ctrl+\` / `⌘\`** accelerator — the `split` label has been reserved in `platformDefaults.js` `shortcutLabels` since the platform-config work and is still unbound. Open design question for the generic (no-file-context) verb: with only one tab open, "Split Editor" has nothing legal to move (single-file invariant) — either disable it, or define it as "move the next tab into the new pane" and disable at one tab. The prototype implements the latter for feel.

> **Degenerate-edge guard.** Because of the single-file invariant, "Open in new pane" on a file that is the *only* tab in its source pane would move it out, empty the source, and collapse it — a visible no-op that reads as broken. The menus are already state-aware, so the rule is: **do not offer "Open in new pane" when the source pane holds only that one tab.** There is nothing to split away from.
3. **Modifier + double-click** on a canvas node — opens in the side pane, creating it if needed. Routes through ADR-013's interaction-mode system (✅ shipped, PRs #54-56); actual modifier key resolved per-platform via ADR-011 (✅ implemented).
4. **Actions pill** — optional, lowest priority. Pill is the beginner surface; splits are a depth feature.
5. **Drag tab to drawer edge** — explicit fast-follow, not v1. Requires drop-zone highlighting work.
6. **Drag into a pane** *(added 2026-07-01, Dai request — prototyped)*: drag a scaffold entry, canvas node, or editor tab and drop it on a pane → opens/moves it there; drop on the right-edge zone (no split active) → split-preview highlight → creates the split. Feasibility against current Litria is good — it reuses shipped idioms:
   - **Scaffold → pane**: `useScaffoldDrag` already runs document-level listeners with `elementsFromPoint` drop resolution (`DrawerContentScaffold`) and already resolves drops onto the *canvas* (`onDragToCanvas`/`pendingCanvasDrop` consumed-by-effect). Panes are DOM regions — adding them as recognized drop targets is the same hit-test plus one more drop route.
   - **Tab → pane / tab → edge-split**: same drag engine pointed at tab elements; the single-file invariant makes cross-pane drops *moves* with zero extra rules.
   - **Canvas node → pane**: defer. During canvas drags the DOM overlays deliberately drop `pointer-events` (internals note 2 / `app-dragging`) so drags aren't swallowed — the drawer is intentionally hit-transparent mid-drag. See seam below. Modifier+double-click already covers this intent with less travel.

### Terminology

- **"Open in new pane"** — creates the split.
- **"Send to pane 1/2"** — moves/opens a file into an existing pane.
- Two verbs, two intents: *open* creates, *send* targets.

### Focus rule

**Focus follows intent.** Opening in a new pane or sending to a pane moves focus to that file in that pane. The user expressed intent about that file; focus agrees with their attention. One rule, no special cases — single-pane double-click already behaves this way.

### Closing

- Closing the last tab in a pane collapses the drawer back to single-pane view.
- No "unsplit" button or gesture. Symmetry is free.
- Same rule covers session restore: if a pane's file was deleted outside Litria and the pane would restore empty, it collapses.

### Beginner surface

Single-pane mode shows **no pane headers and no numbering chrome**. Users who never split never see the feature's UI. Progressive revelation: same primitives, deeper read.

---

## Persistence

- **Not a manifest.** Editor session state lives in the SQLite key-value store (`dbSaveEditorState` / `dbLoadEditorState`), keyed today as `open_tab_piece_ids` and `active_tab_piece_id`. Pane assignment extends this KV store, not a JSON manifest.
- Expected cost: pane-indexed keys — e.g. `open_tab_piece_ids_by_pane` and `active_tab_piece_id_by_pane` — plus a one-time migration that defaults existing single-tab sessions into pane 1. KV is more forgiving than a fixed schema, so this is additive.
- Session restore: read panes from the KV store, mount editor instances, restore focus.

---

## Known Seams / Flagged Work

| Seam | Note |
|------|------|
| `cm://tab/{tabId}/{filename}` URIs | Monaco's naming scheme leaking into Litria vocabulary. Clean up when the adapter contract is built — domain should speak pane/tab/file language only. |
| Same file in both panes — **resolved** | Settled via the single-file invariant (see Architecture → State shape). One tab per file; attempting to open an already-open file in the other pane *moves* it. No URI change, no LSP regex change, no error guard. See Out of Scope for the dual-region trade this defers. |
| Single Monaco instance | The real cost center. [EditorMonaco.jsx](src/components/EditorMonaco.jsx) assumes one `editorRef` / `onMount` / `onChange` / hover-card reference, threaded through ~8 effects. Split work = `editorRef` → `Map<paneId, editor>` plus re-threading pane context. The adapter contract is the easy part; this refactor is the lift. |
| Monaco "split" | Monaco has no native split; a second instance is mounted and laid out by Litria. This is fine — it's the adapter's job. |
| Drag *kinds* vs `app-dragging` pointer-events | Internals note 2 makes overlays hit-transparent during canvas drags so drags aren't swallowed. A file-drag that should *drop onto* the editor drawer needs the opposite. Resolution: distinguish drag kinds — piece-move drags keep the transparency; file-carry drags (scaffold row, editor tab) leave pane regions hit-testable. Flag this before building canvas-node→pane. |
| ADR-013 dependency — **resolved** | ADR-013 Phases 1-3 shipped (PRs #54-56); the modifier-gesture path is unblocked. (ADR-011 / platform config also implemented.) No entry path has an open dependency. |

---

## Out of Scope

- More than two panes / arbitrary grids
- Drag-tab-to-split (fast-follow)
- Vertical (top/bottom) splits
- Per-pane independent settings or themes
- **Dual-region view of one file** (same file open in both panes with independent scroll/cursor — the VS Code "split same file" workflow). Deliberately traded away by the single-file invariant, not an oversight. Future seam: Monaco shares one model across multiple editors natively, so this is the *only* moment that invariant would be revisited — let a piece hold two tab entries with distinct `paneId`s pointing at a shared model. v1 forbids it; the door stays unlocked.

---

## Promotion Checklist (capture → ADR)

- [x] ADR-011 complete (modifier key routing available) — implemented `361f6cb` / PR #42
- [x] ADR-013 Phase 1 (interaction-mode system) — implemented, Phases 1-3 (PRs #54-56)
- [x] Same-file-in-both-panes decision — **resolved** via the single-file invariant (one tab per file; second open = move). Dual-region view deferred to Out of Scope.
- [x] UX prototype for look/feel sign-off — `docs/prototypes/prototype-editor-split-panes.html` (2026-07-01)
- [x] Dai signs off on prototype interactions — ✅ 2026-07-01, "perfect v1 double pane system and interaction system." Generic View → Split Editor verb approved as prototyped (move-next-tab, disabled at <2 tabs or while split). Drag-into-pane (entry path 6) included in the approved v1 interaction set.

### Prototype sign-off notes — what resonated (keep in the real build)
- The **pill tabs with the subtle gradient** treatment (active tab `rgba(52,60,75,.86)` on `rgba(34,34,34,.9)` base — matches shipped editor.css)
- The **tag pill on canvas nodes** showing where a file is open (`PANE 1` / `PANE 2` / `OPEN` badge above the node) — small addition, big orientation win; not in the original capture, promote it to v1 scope
- The **minimalist pane chrome** — tiny uppercase `PANE n` header + focus ring only while split; nothing else
- [ ] Adapter contract minimum surface drafted and reviewed
- [ ] `cm://tab/` URI seam resolution decided (rename vs. wrap)
- [ ] Naming cold-reread pass on "Open in new pane" / "Send to pane 1/2"
