# ADR-009: GroupDropPopover Uses shadcn Popover (Not Hand-Rolled)

## Status
- Superseded (2026-07-25 — GroupDropPopover removed; owner ruling folded group
  nest/un-nest into the edit-mode grammar as silent mode-gated drops, and
  merge moved to the group context menu. See ADR-013 Addendum 2026-07-25.)
- Implemented (2026-03-20 — shipped with the nest/merge feature; served until
  2026-07-25)
- Proposed

## Date
- 2026-03-19

## Context
When a user drags a group pill onto another group, the system needs a disambiguation UI: nest the group as a child, or merge the two groups' pieces. This requires a small popover with action buttons that appears at the drop point on the canvas.

The canvas interaction zone is listed as protected in ADR-008. The question is whether GroupDropPopover is a canvas interaction component or an overlay component.

## Decision
GroupDropPopover is an **overlay component** and uses shadcn Popover (`src/components/ui/popover.jsx`).

### Rubric application (ADR-008)

1. **Is it in a protected zone?** No. The popover appears *after* the drag state machine completes. It is not part of the drag interaction — it does not involve coordinate math, canvas transforms, or drag state tracking. It is a floating decision prompt rendered outside the canvas layer.

2. **Does it need focus trap / keyboard nav / ARIA?** Yes. The popover has three actions (Nest, Merge, Cancel). It must be keyboard-navigable (Tab between buttons), Escape-dismissable, and announced to screen readers.

3. **Is it an overlay?** Yes. It is a portal-rendered popover anchored to a screen coordinate, with click-outside dismiss.

All three answers point to shadcn per the ADR-008 rubric.

### Anchor strategy
Radix Popover uses `PopoverAnchor` (already exported from `src/components/ui/popover.jsx`) with an invisible 1x1 div positioned via `position: fixed` at the drop screen coordinates. Radix handles viewport clamping automatically.

### Styling
The popover content conforms to `docs/ui-governance.md` §10.2:
- Litria glass-morphic surface (`rgba(24, 24, 24, 0.96)`, `backdrop-filter: blur(10px)`)
- Litria design tokens for borders, text, transitions
- Action buttons use `--cm-pill-*` token system (governance §4.3)
- No shadcn default colors or animations — Litria tokens override everything

## Consequences
Positive:
- Accessibility (focus trap, Escape, ARIA dialog role) handled by Radix with zero custom code.
- Portal rendering avoids z-index conflicts with canvas elements.
- Click-outside dismiss handled correctly by Radix.
- Consistent with other overlay components migrated under ADR-007 (ColorPickerPopup, GroupMenuOverlay, zoom popover).
- This establishes precedent: post-interaction decision prompts on the canvas are overlays, not canvas components.

Costs:
- The popover renders in a portal outside the canvas DOM tree, which means canvas-relative positioning must be converted to screen coordinates before passing to the component.

## Alternatives Considered

1. **Hand-rolled floating div**: Would require manual focus trapping, Escape handling, click-outside detection, and viewport clamping. The existing Litria hover card does this but is significantly more complex than needed here, and the hover card is a protected zone component for different reasons (Monaco-coupled positioning, pin state, diagnostic rendering).

2. **shadcn AlertDialog**: Overkill — AlertDialog is a modal that blocks the entire screen. The user needs a lightweight contextual prompt, not a full modal.

3. **shadcn ContextMenu**: Semantically wrong — this is not a right-click context menu. It's a decision prompt triggered by a completed drag.

### Async operation handling
The popover gates filesystem operations (folder moves via Rust `fs::rename`). While
the operation is in progress, the popover disables its buttons and shows a loading
state. Radix's `onOpenChange` is suppressed during this period to prevent accidental
dismissal. This is a presentation concern — the popover does not own the filesystem
logic, only the UI state around it.

## Scope Notes
- This ADR covers the technology decision only. Implementation details are in `docs/plans/group-nest-merge-implementation.md`.
- The filesystem-first execution model is documented in `docs/rfcs/group-nest-merge-popover.md`.
- If future canvas interactions need similar post-drag disambiguation, they should follow the same pattern: shadcn Popover with `PopoverAnchor` at the drop coordinates.
