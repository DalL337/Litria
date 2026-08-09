# Tailwind + shadcn/ui Migration PRD

## Purpose
Define the phased execution plan for introducing Tailwind CSS and shadcn/ui into Litria. Each phase is independently shippable with its own exit criteria.

## Governing Documents
- ADR-006: Adopt Tailwind CSS as Utility Layer
- ADR-007: Adopt shadcn/ui for Interactive Primitives
- ADR-008: Protected Zones — shadcn Exclusions
- RFC: UI Component Layer Strategy (`docs/rfcs/ui-component-layer-strategy.md`)
- Litria Design System: `docs/ui-governance.md`

## Scope

### In Scope
- Tailwind CSS installation and configuration
- shadcn CLI initialization and `components/ui/` scaffold
- Incremental migration of interactive overlay components
- Litria styling contract enforcement on all shadcn components
- `cn()` utility helper for class composition

### Out of Scope
- Migration of existing BEM CSS files to Tailwind utilities
- New features or UX redesign
- Protected zone components (ADR-008)
- Light theme / multi-theme support
- Mobile/responsive redesign

---

## Phase 0: Tailwind Foundation

### Objective
Install Tailwind CSS and verify zero visual change to existing UI.

### Deliverables — COMPLETED
1. ~~Install dependencies~~: `tailwindcss`, `@tailwindcss/postcss`, `autoprefixer`, `clsx`, `tailwind-merge`, `class-variance-authority`
2. ~~Create `postcss.config.js`~~ with `@tailwindcss/postcss` plugin (Tailwind v4 uses a separate PostCSS package)
3. ~~Create `src/styles/tailwind.css`~~ with `@theme` block for Litria token mappings (Tailwind v4 uses CSS-based config, no `tailwind.config.js`)
4. ~~Preflight disabled~~ by importing only `tailwindcss/theme` and `tailwindcss/utilities` — Litria's `reset.css` is preserved
5. ~~Create `src/lib/utils.js`~~ with `cn()` helper (clsx + tailwind-merge)
6. ~~Wire into `App.jsx`~~ — `import './styles/tailwind.css'` before `tokens.css`
7. ~~Build verified~~ — passes with zero visual change, CSS bundle size unchanged

### Tailwind v4 Config — CSS-Based Theme (in `src/styles/tailwind.css`)
```css
@import "tailwindcss/theme" layer(theme);
@import "tailwindcss/utilities" layer(utilities);

@theme {
  --color-cm-indigo: var(--cm-indigo);
  --color-cm-indigo-light: var(--cm-indigo-light);
  --color-cm-electric-blue: var(--cm-electric-blue);
  --color-cm-electric-bright: var(--cm-electric-bright);
  --color-cm-purple: var(--cm-purple);
  --color-cm-navy: var(--cm-navy);

  --color-surface-base: var(--cm-surface-base, #1e1e1e);
  --color-surface-dark: var(--cm-surface-dark);
  --color-surface-card: var(--cm-surface-card);
  --color-surface-elevated: var(--cm-surface-elevated);

  --color-text-primary: var(--cm-text-primary);
  --color-text-muted: var(--cm-text-muted);
  --color-text-bright: var(--cm-text-bright);

  --radius-pill: 999px;
  --radius-card: 14px;
  --radius-panel: 12px;
  --radius-squircle: 10px;

  --transition-duration-fast: 150ms;
  --transition-duration-drawer: 280ms;
}
```

**Note**: Tailwind v4 does not use `tailwind.config.js`. All theme configuration lives in the `@theme` block inside `src/styles/tailwind.css`.

### Exit Criteria
- [ ] `npm run build` passes
- [ ] Existing UI is visually identical (manual check — every major view)
- [ ] Tailwind utility classes work in a test element (add and remove a temporary `className="bg-red-500"` to verify pipeline)
- [ ] `cn()` helper works correctly
- [ ] No new warnings or errors in console

---

## Phase 1: First shadcn Component (Dialog)

### Objective
Replace CreatePieceModal with shadcn Dialog. Validate the full pipeline: shadcn CLI → Litria styling → functional parity.

### Deliverables
1. Initialize shadcn: `components.json` config pointing to `src/components/ui/`
2. Add Dialog component: `npx shadcn add dialog`
3. Restyle Dialog to Litria glass-morphic treatment:
   - Overlay: `rgba(0, 0, 0, 0.45)` backdrop
   - Content: `border-radius: 14px`, Litria surface/border tokens, backdrop-filter blur
   - Transitions matching `--cm-transition-fast`
4. Replace CreatePieceModal internals with Dialog primitive
5. Preserve all existing behavior: form fields, validation, error display, keyboard shortcuts
6. Remove old modal CSS from `modals.css` (CreatePieceModal section only)

### Migration Map
| Old | New |
|---|---|
| `.create-piece-modal-shell` (positioning div) | `Dialog.Portal` + `Dialog.Overlay` |
| `.create-piece-modal` (card) | `Dialog.Content` (Litria-styled) |
| Manual open/close state | `Dialog.Root` open prop |
| Manual escape handler | Radix built-in |
| No focus trap | Radix built-in |
| No ARIA | Radix built-in (`role="dialog"`, `aria-labelledby`, etc.) |

### Exit Criteria
- [ ] CreatePieceModal opens/closes correctly
- [ ] Form validation works (name required, duplicate detection)
- [ ] Escape key dismisses modal
- [ ] Focus is trapped within modal while open
- [ ] Focus returns to trigger element on close
- [ ] Visual appearance matches Litria glass-morphic style
- [ ] `npm run build` passes
- [ ] No console errors

---

## Phase 2: Menus (DropdownMenu + ContextMenu)

### Objective
Replace MenuBar dropdowns and ScaffoldContextMenu with shadcn equivalents.

### Deliverables
1. Add DropdownMenu component: `npx shadcn add dropdown-menu`
2. Add ContextMenu component: `npx shadcn add context-menu`
3. Restyle both to Litria treatment:
   - Menu panel: `border-radius: 6px`, `#1e1e1e` background, `box-shadow`, Litria border tokens
   - Items: indigo hover tint `rgba(92, 107, 192, 0.18)`, text brightening to white
   - Separator: `rgba(210, 210, 210, 0.12)`
   - Disabled items: `rgba(200, 200, 200, 0.3)` text, no hover
4. Replace MenuBar dropdown rendering with DropdownMenu
5. Replace ScaffoldContextMenu with ContextMenu
6. Preserve all existing menu items, shortcuts display, and disabled states

### Exit Criteria
- [ ] All MenuBar dropdowns open/close correctly
- [ ] Arrow key navigation works within menus
- [ ] Keyboard shortcuts still display correctly
- [ ] Disabled items are non-interactive
- [ ] ScaffoldContextMenu triggers on right-click
- [ ] Visual appearance matches existing menus
- [ ] `npm run build` passes

---

## Phase 3: Popovers

### Objective
Replace floating panel components with shadcn Popover.

### Deliverables
1. Add Popover component: `npx shadcn add popover`
2. Restyle to Litria glass-morphic treatment
3. Migrate components:
   - ColorPickerPopup → Popover
   - GroupMenuOverlay → Popover (or DropdownMenu if toggle-based)
   - Status bar zoom popover → Popover
   - Status bar dirty files popover → Popover
4. Preserve all internal content (color swatches, slider, file list)

### Exit Criteria
- [ ] All popovers open/close with correct positioning
- [ ] Click-outside dismisses popover
- [ ] Escape dismisses popover
- [ ] Internal content (swatches, slider, file list) functions correctly
- [ ] Popovers don't clip at viewport edges
- [ ] `npm run build` passes

---

## Phase 4: AlertDialog + Command

### Objective
Replace UnsavedChangesPrompt with AlertDialog and evaluate SyntaxSymbolPicker as Command candidate.

### Deliverables
1. Add AlertDialog component: `npx shadcn add alert-dialog`
2. Add Command component: `npx shadcn add command` (depends on `cmdk`)
3. Replace UnsavedChangesPrompt with AlertDialog
4. Evaluate SyntaxSymbolPicker migration to Command:
   - If symbol picker benefits from search/filter UX → migrate
   - If current list-based UX is sufficient → defer
5. Restyle both to Litria treatment

### Exit Criteria
- [ ] UnsavedChangesPrompt shows with backdrop overlay
- [ ] Three-button action layout preserved (Don't Save / Cancel / Save)
- [ ] Focus trapped in dialog
- [ ] ARIA alertdialog role applied
- [ ] Command evaluation documented (migrate or defer decision)
- [ ] `npm run build` passes

---

## Protected Zones (Do Not Touch)

Per ADR-008, these components are excluded from all migration phases:

- Monaco editor zone (monaco-overrides.css, EditorMonaco.jsx, monacoSetup.js)
- Litria hover card (hover-card.css, hover card logic in EditorMonaco.jsx)
- Canvas interaction (canvas.css, PuzzlePiece, ConnectionLine, LassoBox, EdgeGlow)
- Minimap
- Drawer system (drawers.css, EditorDrawer, useAppDrawers)
- Pill notifications (pill-notification.css, PillNotification)
- Status bar layout (status-bar.css, StatusBar — but popovers within it are Phase 3)
- Scaffold tree internals (scaffold.css tree/drag components)
- Launch screen (launch.css, LaunchScreen)

---

## Rollback Strategy

Each phase is independently reversible:
- Phase 0: Remove Tailwind dependencies and config. Restore reset.css if modified.
- Phase 1-4: Revert component file to previous version. Restore CSS section from `modals.css` / `menu-bar.css` / etc.
- shadcn components in `src/components/ui/` are owned source — delete them to remove.
- Radix dependencies are per-component — remove the specific `@radix-ui/*` package.

No phase depends on a subsequent phase. Rollback of Phase 3 does not affect Phase 1 or 2.

---

## Success Criteria

1. All migrated components pass WCAG 2.1 AA accessibility requirements (focus trap, keyboard nav, ARIA roles).
2. Visual appearance is indistinguishable from pre-migration UI (same surfaces, borders, glows, transitions).
3. No performance regression — no measurable increase in load time or interaction latency.
4. Build passes after each phase.
5. Protected zones remain untouched.
