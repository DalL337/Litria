# ADR-007: Adopt shadcn/ui for Interactive Primitives

## Status
- Accepted

## Date
- 2026-03-13

## Context
Litria's interactive overlay components (modals, context menus, dropdowns, popovers) are hand-rolled JSX with custom CSS. These components work but lack:

1. **Accessibility**: No focus trapping, no ARIA attributes, no keyboard navigation (Tab, Escape, arrow keys), no screen reader support.
2. **Behavioral correctness**: Click-outside dismiss, portal rendering, scroll locking, and focus restoration are either missing or partially implemented.
3. **Consistency**: Each component re-implements open/close logic independently.

These gaps increase in cost with every new interactive component. The affected components are: CreatePieceModal, UnsavedChangesPrompt, MenuBar dropdowns, ScaffoldContextMenu, GroupMenuOverlay, ColorPickerPopup, SyntaxSymbolPicker, and status bar popovers.

## Decision
Adopt shadcn/ui as the source for interactive overlay primitives. shadcn/ui is a code generation tool — not a library dependency. It copies component source files into `src/components/ui/` using Radix UI primitives, Tailwind CSS (ADR-006), and class-variance-authority (cva).

Key constraints:
- Components are **owned source code**. No opaque node_modules dependency for UI behavior.
- All shadcn components must conform to `docs/ui-governance.md` styling contract: Litria design tokens, glass-morphic surfaces, LED glow spec, pill radius conventions.
- shadcn components are **presentation-layer only** — no domain logic, no state ownership. They follow the same rules as all other presentation-layer components per `docs/Orchestration.md`.
- Migration is incremental. Each component is replaced one at a time with full parity validation.
- Protected zones (ADR-008) are excluded from shadcn adoption.

### Radix Primitives Used

| shadcn Component | Radix Primitive | Replaces |
|---|---|---|
| Dialog | `@radix-ui/react-dialog` | CreatePieceModal |
| AlertDialog | `@radix-ui/react-alert-dialog` | UnsavedChangesPrompt |
| DropdownMenu | `@radix-ui/react-dropdown-menu` | MenuBar dropdowns |
| ContextMenu | `@radix-ui/react-context-menu` | ScaffoldContextMenu |
| Popover | `@radix-ui/react-popover` | ColorPickerPopup, zoom popover, dirty files popover, GroupMenuOverlay |
| Command | `cmdk` | SyntaxSymbolPicker (candidate) |

### Dependencies Added
- `tailwind-merge` — intelligent Tailwind class merging
- `clsx` — conditional className composition
- `class-variance-authority` — variant management for component APIs
- Radix primitives — installed per component as needed (each ~5-15KB gzipped)

## Consequences
Positive:
- Accessibility compliance (WCAG 2.1 AA) for all interactive overlays with zero custom implementation.
- Focus trapping, keyboard navigation, ARIA roles, and screen reader support handled by Radix.
- Portal rendering, click-outside dismiss, scroll locking, and focus restoration handled correctly.
- Owned source code — full control over markup, styling, and behavior.
- Consistent component API patterns across all interactive overlays.

Costs:
- Bundle size increase: ~5-15KB gzipped per Radix primitive. Negligible for a Tauri desktop app.
- Tailwind CSS required as prerequisite (ADR-006).
- `src/components/ui/` directory introduces a new convention alongside existing flat `src/components/`.
- Developers must understand both hand-rolled and shadcn patterns.

## Alternatives Considered

1. **Radix primitives directly (without shadcn CLI)**: Viable but requires manually composing Radix with styling. shadcn provides pre-composed templates that save setup time. The generated code is identical to what manual composition would produce.

2. **Headless UI (Tailwind Labs)**: Fewer primitives than Radix. Missing ContextMenu, Command, and several others needed by Litria. React support is secondary to their Vue focus.

3. **Ark UI**: Newer alternative with similar goals. Smaller ecosystem, less battle-tested. Radix has broader adoption (Vercel, Linear, WorkOS).

4. **Stay hand-rolled**: Increasing cost per component. Accessibility gaps remain unaddressed. Every new modal/menu/popover re-implements the same behavioral patterns.

## Scope Notes
- This ADR covers the decision to adopt shadcn/ui. Implementation phases are defined in `docs/prds/tailwind-shadcn-migration-prd.md`.
- Components excluded from migration are defined in ADR-008.
- Styling contract enforcement is defined in `docs/ui-governance.md` Section 11.
