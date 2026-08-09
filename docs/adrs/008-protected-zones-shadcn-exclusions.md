# ADR-008: Protected Zones — Components Excluded from shadcn Migration

## Status
- Accepted

## Date
- 2026-03-13

## Context
ADR-007 adopts shadcn/ui for interactive overlay primitives. However, several areas of the Litria UI are domain-specific, tightly coupled to external systems (Monaco, canvas coordinate math), or already well-implemented with custom behavior that no component library addresses. Migrating these areas would require significant rework with no accessibility or behavioral gain.

This ADR defines which zones are excluded from shadcn adoption and establishes a reusable rubric for future decisions.

## Decision
The following zones are **protected** — they remain hand-rolled CSS and custom JSX. Do not introduce shadcn or Radix primitives into these areas.

### Protected Zone Registry

| Zone | Files | Rationale |
|---|---|---|
| **Monaco Editor** | `monaco-overrides.css`, `EditorMonaco.jsx`, `monacoSetup.js` | Monaco owns its own DOM tree, widget system, and event lifecycle. `!important` overrides target Monaco's internal class names. No Radix primitive maps to editor widgets. |
| **Litria Hover Card** | `hover-card.css`, hover card logic in `EditorMonaco.jsx` | Custom React overlay with pin state, diagnostic severity variants, signature rendering, and Monaco-coupled positioning. Not a generic popover — behavioral requirements exceed what Radix Popover provides. |
| **Canvas Interaction** | `canvas.css`, `PuzzlePiece.jsx`, `ConnectionLine.jsx`, `LassoBox.jsx`, `EdgeGlow.jsx` | Coordinate-math-driven components with transform calculations, drag state machines, and spatial relationships. No UI library addresses canvas interaction patterns. |
| **Minimap** | `Minimap.jsx` | Canvas-derived spatial overview. Domain-specific rendering with no overlay behavior. |
| **Drawer System** | `drawers.css` (~700 lines), `EditorDrawer.jsx`, `useAppDrawers.jsx` | Bespoke slide/transform animation with LED glow border-image gradients, rail tabs, midtabs, top drawers, scrim layers, and drag-to-reposition. shadcn's Sheet is conceptually similar but would require full rewrite of all drawer behavior. |
| **Pill Notifications** | `pill-notification.css`, `PillNotification.jsx` | Lightweight toast system already integrated with Litria token system. Working, performant, visually consistent. shadcn Toast/Sonner provides no gain over current implementation. |
| **Status Bar** | `status-bar.css`, `StatusBar.jsx` | Static layout bar with simple button states. No interactive primitives needed for the bar itself. (Note: popovers *within* the status bar — zoom slider, dirty files list — are migration candidates under ADR-007.) |
| **Scaffold Tree** | `scaffold.css`, `ScaffoldContextMenu.jsx` tree internals | Custom tree with drag-and-drop reordering, inline editing, visibility toggles, and drop indicators. No shadcn primitive covers tree interaction. (Note: the right-click context menu *triggered by* the tree is a migration candidate.) |
| **Launch Screen** | `launch.css`, `LaunchScreen.jsx` | Full-screen scaffold selection flow with custom pill-based form controls. Already uses Litria pill token system. No shadcn primitive maps to this layout. |

### Decision Rubric for Future Components

When deciding whether a new component should use shadcn or be hand-rolled, apply this rubric:

```
1. Does the component need focus trapping, keyboard navigation,
   or ARIA role management?
   → YES: Strong candidate for shadcn (Radix handles this)
   → NO: Continue to question 2

2. Is the component an overlay (modal, popover, dropdown,
   context menu, tooltip, dialog)?
   → YES: Use shadcn unless it falls in a protected zone
   → NO: Continue to question 3

3. Does the component involve coordinate math, canvas transforms,
   drag state machines, or editor-coupled positioning?
   → YES: Hand-roll. No UI library addresses these patterns.
   → NO: Continue to question 4

4. Does the component have deep custom animation (slide transforms,
   border-image gradients, multi-stage transitions)?
   → YES: Hand-roll. Radix primitives don't control animation internals.
   → NO: Continue to question 5

5. Is the component purely layout/visual with no interactive behavior?
   → YES: Use Tailwind utilities or existing BEM CSS.
          shadcn adds no value for static elements.
   → NO: Evaluate case-by-case. Default to shadcn for
         interactive chrome, hand-roll for domain-specific behavior.
```

## Consequences
Positive:
- Prevents wasted effort migrating components where shadcn provides no value.
- Protects domain-specific UI from framework-imposed constraints.
- Provides a clear, reusable rubric for future technology decisions.
- Prevents scope creep during migration phases.

Costs:
- Two component patterns coexist long-term (shadcn in `components/ui/` and hand-rolled in `components/`).
- Requires developer awareness of which zones are protected and why.

## Alternatives Considered

1. **Migrate everything to shadcn**: Would require rewriting the drawer system, hover card, and canvas components with no behavioral gain. Estimated 2-3x the effort for zero accessibility improvement in these zones.

2. **No protected zone registry**: Risk of ad-hoc decisions per component leading to inconsistent adoption or unnecessary rewrites.

## Scope Notes
- This registry should be updated when new protected zones are identified or when a previously protected zone becomes a migration candidate.
- The decision rubric in this ADR is referenced by `docs/ui-governance.md` Section 11.
