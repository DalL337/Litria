# ADR-006: Adopt Tailwind CSS as Utility Layer

## Status
- Accepted

## Date
- 2026-03-13

## Context
Litria uses hand-rolled BEM-style CSS (~2,900 lines across 16 files) with a custom design token system in `src/styles/tokens.css`. The current approach works but has two limitations:

1. Every new component requires writing new CSS classes from scratch, even for common layout/spacing patterns already solved by utility frameworks.
2. shadcn/ui (the target component library for interactive primitives — see ADR-007) requires Tailwind CSS as a prerequisite.

The project has no existing CSS framework. All styling is custom `.css` files with class-based selectors and CSS custom properties.

## Decision
Install Tailwind CSS as a **utility layer alongside existing CSS**. Tailwind does not replace or migrate existing styles. Both systems coexist indefinitely.

Key constraints:
- Tailwind's `theme.extend` maps Litria design tokens (`--cm-indigo`, `--cm-surface-card`, etc.) into Tailwind utility classes. Tokens remain authoritative in `tokens.css`.
- Tailwind's preflight reset is disabled or reconciled with the existing `reset.css` (both set `margin: 0; padding: 0; box-sizing: border-box`). One is removed to avoid duplication.
- Existing CSS files are untouched. No class renaming, no migration of existing styles.
- New components may use Tailwind utilities, BEM CSS, or a mix — both are valid.

## Consequences
Positive:
- Unlocks shadcn/ui adoption (ADR-007).
- Reduces boilerplate for layout, spacing, flex, and grid patterns in new components.
- Tailwind's purge removes unused utilities — zero bundle impact for unused classes.
- Aligns with DSCRS stack direction (Tauri + React + Tailwind).

Costs:
- Adds `tailwindcss`, PostCSS, and `autoprefixer` to the build pipeline.
- Two styling approaches coexist, requiring team awareness of when to use which.
- Tailwind config file must stay in sync with `tokens.css` if tokens change.

Neutral:
- No performance impact. Tailwind generates static CSS at build time.
- No visual change to any existing component on initial install.

## Alternatives Considered

1. **CSS Modules**: Scoped class names solve naming collisions but don't provide utility classes or enable shadcn. Would require significant refactoring of existing global CSS.

2. **Styled Components / Emotion**: CSS-in-JS adds runtime overhead (conflicts with Litria's performance targets) and does not enable shadcn.

3. **Stay hand-rolled only**: Viable but increases cost of every new interactive component and blocks shadcn adoption. Accessibility gaps in hand-rolled modals/menus remain unaddressed.

## Scope Notes
- This ADR covers the Tailwind installation and configuration only.
- Component migration decisions are governed by `docs/ui-governance.md` Section 11.
- Protected zones where Tailwind should not be the primary styling approach are defined in ADR-008.
