# ADR-017: Editor Split Panes

## Status
- Implemented — all phases (2026-07-22): Phase A shipped PR #95 (2026-07-02, owner-verified live, incl. the canvas-node→pane drag pulled forward from Phase C); Phases B + C delivered as the split-editor completion arc, PRs #180–#184 — pane persistence, the where-is-it-open node tag, shift+double-click entry, resizable divider, tab→pane + scaffold→pane drags
- Accepted — Phase A in implementation (2026-07-01)

## Date
- 2026-07-01

## Context

Litria's editor drawer is single-pane. Testers coming from VS Code and similar IDEs expect to view and edit two files side by side (feedback #10); splits are a baseline expectation for professional users, and absence reads as a gap rather than a simplification.

The design was captured in `docs/plans/ideas/editor-split-panes.md` (2026-06-12), refined 2026-07-01, and validated through an interactive prototype (`docs/prototypes/prototype-editor-split-panes.html`) that Dai signed off the same day as the v1 interaction system. All former dependencies have shipped:

- **ADR-011** (runtime platform config / modifier keys) — per-platform modifier resolution and the long-reserved `Ctrl+\` / `⌘\` `split` accelerator label.
- **ADR-013** (interaction-mode system, Phases 1–3) — gates the modifier-gesture entry path.
- **Menu bar buildout** (PR #93) — the generated menu surfaces (`menuBarItems.js` builder + `ActionMenuForms`) that state-aware split items slot into.

Nothing blocks implementation; this ADR promotes the capture to a decision record and defines the delivery slices.

## Decision

Split state is **domain-owned workspace state**, not an editor feature. The editor session domain owns which panes exist, which tabs live in each, and which pane has focus; the editor (Monaco today) renders whatever pane layout the domain describes. Maximum of two panes.

### State shape

- **Main content + optional side content** — not two numbered slots. Pane 1 is always left, pane 2 always right; *position is identity*. Pane numbers are painted by the UI only while a split is active; no renumbering logic exists because numbers are decoration, not data.
- The only new per-tab field is `paneId`. `focusedPaneId` is new session state. "Split active" is derived (pane 2 is non-empty), never stored.

### Single-file invariant (governance)

> **A file has at most one tab in the workspace.** Opening or sending it anywhere either *focuses* the existing tab (target = current pane) or *moves* it (target ≠ current pane).

This falls out of the existing model — `tabsById` is keyed by piece ID and `tab.id === piece.id`, so the state cannot hold a duplicate. Consequences:

- No "two panes, one file" collision exists. The `cm://tab/{tabId}/…` Monaco URI stays unique; no LSP regex changes.
- **Move is not disposal + recreation.** The existing Monaco model is re-parented to the other pane's editor instance via `setModel`. One model, no cache churn.
- A user who tries to open an already-open file "in the other pane" gets a *move*, not an error. Illegal state is unrepresentable; the gesture is reinterpreted. No modal, no toast-as-error, consistent with low-friction governance.

### Interaction rules (validated in the prototype)

| Rule | Behavior |
|---|---|
| Open creates, Send targets | No split: **"Open in new pane"** creates it. Split active: **"Send to pane 1/2"** targets. Menu labels print the gesture hint. |
| Degenerate guard | Never offer "Open in new pane" (menu or drag split-zone) for a pane's *only* tab — it would empty the source and instantly collapse. |
| Focus follows intent | Opening/sending focuses that file in that pane. One rule, no special cases. |
| Collapse on empty | Closing a pane's last tab collapses to single-pane. No unsplit button; the remaining pane becomes the main pane. Covers session restore of deleted files. |
| Progressive chrome | Single-pane mode shows zero pane UI. `PANE 1` / `PANE 2` headers and the focus ring exist only while split. |

Sign-off notes to preserve in the build: gradient pill tabs (shipped editor.css treatment), the **where-is-it-open tag pill on canvas nodes** (`PANE 1` / `PANE 2` / `OPEN` badge — promoted into v1 scope), minimalist pane chrome.

### Entry paths

1. **Tab strip context menu** — state-aware items per the rules table. *(Slice A)*
2. **Actions pill Node cluster + menubar mirror** — same items, defined once in the generated surfaces. *(Slice A or fast-follow)*
3. **View → Split Editor** with `Ctrl+\` — the generic verb moves the *next tab* into a new pane; disabled at <2 tabs or while split. Approved as prototyped. *(Slice A)*
4. **Modifier + double-click** on a canvas node — opens into the side pane, creating it if needed. Routes through ADR-013 interaction modes. *(Slice B)*
5. **Drag into a pane** — scaffold row / editor tab dragged onto a pane opens/moves it there; right-edge split-preview zone creates the split. Reuses the shipped drag idioms (`useScaffoldDrag` document listeners + `elementsFromPoint` drop resolution). *(Slice B/C)*
   - **Seam**: canvas drags make DOM overlays hit-transparent (`app-dragging`, internals note 2). File-carry drags need the opposite. Resolution: distinguish drag *kinds* — piece-move drags keep transparency; file-carry drags leave pane regions hit-testable. Canvas-node→pane drag is deferred behind this seam.

### Persistence

Editor session state lives in the SQLite KV store. Pane assignment extends the existing keys (`open_tab_piece_ids`, `active_tab_piece_id`) with pane-indexed variants plus a one-time default of existing sessions into pane 1. *(Slice B)* Phase A restores everything into pane 1 (today's behavior, unchanged).

### Delivery slices

- **Phase A (this ADR's implementation start)**: pane model in the editor session domain (`paneId`, `focusedPaneId`, move/collapse/focus rules), two-pane rendering in `EditorDrawer` with per-pane tab strips and progressive chrome, second Monaco instance, entry via tab context menu + View → Split Editor (`Ctrl+\` binding + label). Domain rules covered by `node --test` domain tests. No persistence change, no drag, no modifier gesture.
- **Phase B**: pane-aware persistence + restore; modifier+double-click entry; Actions pill / menubar Node-cluster items if not landed in A.
- **Phase C**: drag-into-pane (tab → pane, scaffold → pane, edge split-zone) behind the drag-kinds seam; resizable divider.

> **Delivery note (2026-07-22, PRs #180–#184):** Phases B and C shipped with
> two deltas from the slice text above. (1) Persistence uses a single new
> `tab_pane_ids` key (a pieceId→paneId map) + `pane_split_ratio` rather than
> pane-indexed variants of the existing keys — the reducer's snapshot restore
> already re-derived per-pane actives and focus, so duplicating them in
> storage would have been drift-prone; pre-Phase-B saves restore all-into-
> pane-1 exactly as specced. (2) The modifier entry is **shift**+double-click:
> Ctrl+mousedown starts a wire drag before dblclick can fire, and Alt is the
> ADR-013 subtractive token with the §Windows menu-focus hazard this ADR's
> prerequisites already flagged. The canvas-node→pane drag listed under
> Phase C had been pulled forward into Phase A (PR #95); the where-is-it-open
> node tag from the sign-off notes shipped as P1/P2 chips, split-active only.

## Consequences

- `EditorMonaco.jsx` is the real lift: its single `editorRef` threads through its mount/change/hover effects. Split work re-parents that to per-pane instances (`Map<paneId, editor>` or two component instances) without letting Monaco vocabulary leak into the session domain.
- LSP, markers, and dirty tracking are keyed by file/model, not by editor widget — they are unaffected by pane count.
- Dual-region view of one file (same file in both panes, independent scroll) is deliberately traded away by the single-file invariant. Monaco natively supports multiple editors on one model, so the door stays unlocked: revisiting means letting a piece hold two tab entries with distinct `paneId`s over a shared model. v1 forbids it.
- The hover-card system and the Monaco TS marker-leak flash are known single-editor bug surfaces; Phase A verification must exercise both panes.

## Alternatives Considered

- **Arbitrary grids / >2 panes (VS Code model)** — rejected. Two panes cover the compare/reference workflows that motivated the request at a fraction of the layout and state complexity; the drawer is an overlay on the canvas, not the primary surface.
- **Duplicate tabs with shared models (dual-region)** — deferred, not rejected (see Consequences).
- **Minimal `splitTabId`-only slice (shared tab strip)** — considered as a de-risk step, dropped after the prototype: the signed-off interaction system has per-pane tab strips, and shipping a different interim model would demo one UX and deliver another.
- **Editor-level split (let Monaco own layout)** — rejected; Monaco has no native split, and pane truth in the domain is what keeps a future editor backend swappable (consistent with ADR-001/002's editor-agnostic direction).

## References

- Capture: `docs/plans/ideas/editor-split-panes.md` (2026-06-12, refreshed + signed off 2026-07-01)
- Prototype: `docs/prototypes/prototype-editor-split-panes.html`
- Feedback: `docs/feedback/macos-feedback.md` #10
- ADR-011 (platform config), ADR-013 (interaction modes), ADR-015 (SQLite persistence)
- Menu bar buildout: PR #93; docs PR #94
