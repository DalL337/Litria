# Litria UI Governance & Interaction Design System

> Authoritative reference for all interactive element states, colors, and transition behaviors.
> All CSS implementations must conform to this document.

---

## 1. Design Philosophy

Litria uses a **dark glass-morphic** aesthetic with **LED-inspired interaction feedback**.
LED behavior means: a clear, defined color with a subtle luminous halo — not bloom, not neon glow.
Think indicator light on hardware: crisp edge, small aura, immediate response.

### Guiding Principles

- **State clarity**: Every interactive element must communicate static, hover, active, and disabled unambiguously
- **Color hierarchy**: Indigo (resting) → Blue (attention) → Electric blue (active/committed)
- **Restraint**: LED glow is subtle (4-10px blur, 0.25-0.4 alpha). Never diffuse or bloom-like
- **Consistency**: Same color family, same transition timing, same glow treatment across all components

---

## 2. Core Color Palette

### Primary Interaction Colors

| Token                    | Hex       | RGB                  | Usage                                    |
|--------------------------|-----------|----------------------|------------------------------------------|
| `--cm-indigo`            | `#5c6bc0` | `92, 107, 192`       | Static borders, icons, pill outlines     |
| `--cm-indigo-light`      | `#7986cb` | `121, 134, 203`      | Hover state borders, icons               |
| `--cm-electric-blue`     | `#2979ff` | `41, 121, 255`       | Active/selected state (persistent)       |
| `--cm-electric-bright`   | `#448aff` | `68, 138, 255`       | Pressed flash (momentary)                |
| `--cm-purple`            | `#b39ddb` | `179, 157, 219`      | Menu bar hover                           |
| `--cm-navy`              | `#3949ab` | `57, 73, 171`        | Menu bar click / window control click    |

### Window Control Colors

| Token                    | Hex       | RGB                  | Usage                                    |
|--------------------------|-----------|----------------------|------------------------------------------|
| `--cm-control-static`    | `#505050` | `80, 80, 80`         | Window button icons at rest              |
| `--cm-control-hover`     | `#b39ddb` | `179, 157, 219`      | All window buttons on hover              |
| `--cm-control-click`     | `#3949ab` | `57, 73, 171`        | Minimize/maximize on click               |
| `--cm-close-hover`       | `#b39ddb` | `179, 157, 219`      | Close button hover (same purple)         |
| `--cm-close-click`       | `#e53935` | `229, 57, 53`        | Close button on click (red)              |

### Glow Tokens (LED Halos)

| Token                        | Value                             | Usage                           |
|------------------------------|-----------------------------------|---------------------------------|
| `--cm-glow-indigo`           | `rgba(92, 107, 192, 0.25)`       | Static subtle halo (if needed)  |
| `--cm-glow-hover`            | `rgba(121, 134, 203, 0.30)`      | Hover LED halo                  |
| `--cm-glow-active`           | `rgba(41, 121, 255, 0.35)`       | Active/selected LED halo        |
| `--cm-glow-pressed`          | `rgba(68, 138, 255, 0.45)`       | Pressed flash halo (momentary)  |
| `--cm-glow-purple`           | `rgba(179, 157, 219, 0.25)`      | Menu hover halo                 |
| `--cm-glow-close`            | `rgba(229, 57, 53, 0.40)`        | Close button click halo         |

### Surface Colors (Unchanged from existing theme)

| Token                    | Value                          | Usage                               |
|--------------------------|--------------------------------|--------------------------------------|
| `--cm-surface-base`      | `#1e1e1e`                      | App background                      |
| `--cm-surface-dark`      | `rgba(18, 18, 18, 0.92)`      | Drawer/panel backgrounds            |
| `--cm-surface-card`      | `rgba(30, 30, 30, 0.75)`      | Card/tab resting fill               |
| `--cm-surface-elevated`  | `rgba(36, 36, 36, 0.85)`      | Inputs, meta cards                  |
| `--cm-surface-hover`     | `rgba(60, 60, 60, 0.85)`      | Generic surface hover               |
| `--cm-text-primary`      | `#e6e6e6`                      | Primary text                        |
| `--cm-text-muted`        | `#a7a7a7`                      | Secondary/muted text                |
| `--cm-text-bright`       | `#ffffff`                      | Active/emphasized text              |

---

## 3. Transition Specifications

| Property           | Duration | Easing        | Usage                                     |
|--------------------|----------|---------------|-------------------------------------------|
| `border-color`     | `150ms`  | `ease`        | All interactive border transitions        |
| `background`       | `150ms`  | `ease`        | Fill color changes                        |
| `color`            | `150ms`  | `ease`        | Icon/text color changes                   |
| `box-shadow`       | `150ms`  | `ease`        | LED glow in/out                           |
| `transform`        | `150ms`  | `ease-out`    | Micro-motion (translate, scale)           |
| Pressed flash      | `100ms`  | `ease-out`    | Bright flash settles to active state      |

**Note**: The existing 280ms drawer slide transition is unaffected. These 150ms values
apply to color/glow state changes only.

---

## 4. Component Rules

### 4.1 Drawer Tabs (Side Rail — 44x44px)

Interactive icon buttons on the left/right drawer rail.

| State              | Border              | Icon Color          | Background                    | Box-Shadow (LED)                          |
|--------------------|---------------------|---------------------|-------------------------------|-------------------------------------------|
| **Static**         | `--cm-indigo`       | `--cm-indigo`       | `--cm-surface-card`           | none                                      |
| **Hover**          | `--cm-indigo-light` | `--cm-indigo-light` | `--cm-surface-card`           | `0 0 8px 0 var(--cm-glow-hover)`         |
| **Active/Selected**| `--cm-electric-blue`| `--cm-electric-blue`| `rgba(41, 121, 255, 0.08)`   | `0 0 10px 1px var(--cm-glow-active)`     |
| **Pressed**        | `--cm-electric-bright`| `--cm-electric-bright`| `rgba(68, 138, 255, 0.12)` | `0 0 12px 1px var(--cm-glow-pressed)`    |
| **Disabled**       | `rgba(92, 107, 192, 0.25)` | `rgba(92, 107, 192, 0.25)` | `--cm-surface-card` | none                              |

**Behavior**:
- Active state is **persistent** — remains until the drawer is deselected
- Pressed flash lasts ~100ms, then settles to Active state
- Hover micro-motion: `translateX(2px)` (existing behavior, retained)
- Active state includes subtle tinted background (`electric-blue` at 8% opacity)

```css
/* Reference implementation */
.drawer-tab {
  border: 1px solid var(--cm-indigo);
  color: var(--cm-indigo);
  background: var(--cm-surface-card);
  transition: border-color 150ms ease,
              color 150ms ease,
              background 150ms ease,
              box-shadow 150ms ease,
              transform 280ms ease;
}
.drawer-tab:hover {
  border-color: var(--cm-indigo-light);
  color: var(--cm-indigo-light);
  box-shadow: 0 0 8px 0 var(--cm-glow-hover);
  transform: translateX(2px);
}
.drawer-tab.is-active {
  border-color: var(--cm-electric-blue);
  color: var(--cm-electric-blue);
  background: rgba(41, 121, 255, 0.08);
  box-shadow: 0 0 10px 1px var(--cm-glow-active);
}
.drawer-tab:active {
  border-color: var(--cm-electric-bright);
  color: var(--cm-electric-bright);
  background: rgba(68, 138, 255, 0.12);
  box-shadow: 0 0 12px 1px var(--cm-glow-pressed);
}
```

### 4.2 Top Drawer Tabs

Same rules as 4.1. The `.top-drawer-tab` and `.editor-launcher-tab` classes
follow identical state progression.

### 4.3 Pills (Notification & Status)

Rounded pill-shaped indicators driven by CSS custom properties. Users can override
any `--cm-pill-*` token to theme all pill-shaped elements globally.

#### Pill Token System

| Token                      | Default Value                          | Purpose                    |
|----------------------------|----------------------------------------|----------------------------|
| `--cm-pill-radius`         | `999px`                                | Pill border-radius         |
| `--cm-pill-border`         | `var(--cm-indigo)`                     | Static border color        |
| `--cm-pill-bg`             | `var(--cm-surface-card)`               | Static fill                |
| `--cm-pill-color`          | `var(--cm-text-primary)`               | Static text color          |
| `--cm-pill-hover-border`   | `var(--cm-indigo-light)`               | Hover border color         |
| `--cm-pill-hover-bg`       | `var(--cm-indigo)`                     | Hover fill                 |
| `--cm-pill-hover-color`    | `#ffffff`                              | Hover text (white for AA)  |
| `--cm-pill-hover-glow`     | `0 0 6px 0 var(--cm-glow-hover)`      | Hover box-shadow           |
| `--cm-pill-primary-bg`     | `var(--cm-navy)`                       | Primary variant fill       |
| `--cm-pill-primary-border` | `var(--cm-indigo)`                     | Primary variant border     |
| `--cm-pill-primary-color`  | `#ffffff`                              | Primary variant text       |

#### State Table

| State              | Outline                    | Fill                       | Text Color               | Box-Shadow                    |
|--------------------|----------------------------|----------------------------|--------------------------|-------------------------------|
| **Static**         | `--cm-pill-border`         | `--cm-pill-bg`             | `--cm-pill-color`        | none                          |
| **Hover**          | `--cm-pill-hover-border`   | `--cm-pill-hover-bg`       | `--cm-pill-hover-color`  | `--cm-pill-hover-glow`        |
| **Primary**        | `--cm-pill-primary-border` | `--cm-pill-primary-bg`     | `--cm-pill-primary-color`| none                          |
| **Primary Hover**  | `--cm-indigo-light`        | `--cm-indigo`              | `#ffffff`                | `--cm-pill-hover-glow`        |
| **Contextual**     | Semantic color*            | `--cm-pill-bg`             | Semantic color*          | none                          |

*Semantic colors for contextual pills (unchanged from existing):
- Success: `rgba(74, 222, 128, 0.35)` border, `#4ade80` text
- Error: `rgba(248, 113, 113, 0.45)` border, `#f87171` text
- Warning: `rgba(253, 200, 104, 0.45)` border, `#FFC107` text
- Info: `rgba(120, 180, 255, 0.45)` border, `#7eb6ff` text

#### Elements Using Pill Tokens

All of the following consume `--cm-pill-*` tokens and inherit the same visual language:

- `.pill-notification` — toast-style notification pills
- `.launch-action` — launch screen buttons (add `.is-primary` for emphasis)
- `.launch-toggle` — scaffold toggle (`.is-active` uses primary variant)
- `.launch-addon` — scaffold add-on checkboxes (`.is-selected` uses tinted navy)
- `.launch-input`, `.launch-select` — form controls (indigo focus ring)

**Behavior**:
- On hover, fill transitions from dark grey to solid indigo
- Text must go to full white (`#ffffff`) on indigo fill for WCAG AA contrast
- Contextual semantic pills (success/error/warning) retain their existing color scheme —
  the indigo treatment applies to default/neutral pills only

```css
/* Reference — any pill-shaped element */
.my-pill {
  border-radius: var(--cm-pill-radius);
  border: 1px solid var(--cm-pill-border);
  background: var(--cm-pill-bg);
  color: var(--cm-pill-color);
  transition: border-color var(--cm-transition-fast),
              background var(--cm-transition-fast),
              color var(--cm-transition-fast),
              box-shadow var(--cm-transition-fast);
}
.my-pill:hover {
  border-color: var(--cm-pill-hover-border);
  background: var(--cm-pill-hover-bg);
  color: var(--cm-pill-hover-color);
  box-shadow: var(--cm-pill-hover-glow);
}
/* Primary variant */
.my-pill.is-primary {
  background: var(--cm-pill-primary-bg);
  border-color: var(--cm-pill-primary-border);
  color: var(--cm-pill-primary-color);
}
```

### 4.4 Menu Bar Items

Top-level menu buttons (File, Edit, View, etc.).

| State              | Text Color                  | Background                    | Box-Shadow                            |
|--------------------|-----------------------------|-------------------------------|---------------------------------------|
| **Static**         | `rgba(220, 220, 220, 0.75)` | `transparent`                | none                                  |
| **Hover**          | `#ffffff`                   | `rgba(179, 157, 219, 0.15)` | `0 0 6px 0 var(--cm-glow-purple)`    |
| **Open/Click**     | `#ffffff`                   | `rgba(57, 73, 171, 0.25)`   | none                                  |
| **Disabled**       | `rgba(200, 200, 200, 0.3)` | `transparent`                | none                                  |

**Behavior**:
- Hover shows purple tint with subtle LED glow
- Click/open shows navy/indigo tint (no glow — the dropdown is the visual anchor)
- Text brightens to full white on both hover and click

```css
/* Reference implementation */
.menu-item-btn {
  color: rgba(220, 220, 220, 0.75);
  background: transparent;
  transition: color 150ms ease,
              background 150ms ease,
              box-shadow 150ms ease;
}
.menu-item-btn:hover {
  color: #ffffff;
  background: rgba(179, 157, 219, 0.15);
  box-shadow: 0 0 6px 0 var(--cm-glow-purple);
}
.menu-item-btn.is-open {
  color: #ffffff;
  background: rgba(57, 73, 171, 0.25);
  box-shadow: none;
}
```

### 4.5 Menu Dropdown Actions

Individual items inside an open dropdown menu.

| State              | Text Color          | Background          |
|--------------------|---------------------|---------------------|
| **Static**         | `--cm-text-primary` | `transparent`       |
| **Hover**          | `#ffffff`           | `rgba(92, 107, 192, 0.18)` |
| **Disabled**       | `rgba(200, 200, 200, 0.3)` | `transparent` |

**Behavior**:
- Dropdown actions use a softer indigo tint on hover (not purple — the purple
  is reserved for the top-level menu button to differentiate hierarchy)

### 4.6 Window Controls (Minimize, Maximize, Close)

Custom titlebar buttons. Currently using native Tauri decorations — these rules
apply when custom controls are implemented.

| State           | Min/Max Icon     | Min/Max BG                   | Close Icon       | Close BG                     |
|-----------------|------------------|------------------------------|------------------|------------------------------|
| **Static**      | `--cm-control-static` | `transparent`           | `--cm-control-static` | `transparent`           |
| **Hover**       | `#ffffff`        | `rgba(179, 157, 219, 0.15)` | `#ffffff`        | `rgba(179, 157, 219, 0.15)` |
| **Click**       | `#ffffff`        | `rgba(57, 73, 171, 0.25)`   | `#ffffff`        | `rgba(229, 57, 53, 0.85)`   |

**Behavior**:
- All three buttons share the same hover state (purple tint)
- Minimize and Maximize use navy/indigo on click
- Close uses red on click — this is a universal convention and signals destructive intent
- LED glow on close click: `0 0 8px 0 var(--cm-glow-close)`
- No LED glow on min/max click (the action is immediate, no persistent state)

```css
/* Reference implementation */
.window-control {
  color: var(--cm-control-static);
  background: transparent;
  transition: color 150ms ease,
              background 150ms ease,
              box-shadow 150ms ease;
}
.window-control:hover {
  color: #ffffff;
  background: rgba(179, 157, 219, 0.15);
}
.window-control:active {
  color: #ffffff;
  background: rgba(57, 73, 171, 0.25);
}
.window-control-close:active {
  background: rgba(229, 57, 53, 0.85);
  box-shadow: 0 0 8px 0 var(--cm-glow-close);
}
```

---

## 5. LED Glow Specification

### Anatomy of the LED Effect

```
  ┌─────────────────────┐
  │  box-shadow halo    │  ← blur: 6-12px, spread: 0-1px, alpha: 0.25-0.45
  │  ┌───────────────┐  │
  │  │  border-color  │  │  ← the "LED" itself — solid accent color
  │  │  ┌─────────┐  │  │
  │  │  │  icon /  │  │  │  ← icon or text in matching accent color
  │  │  │  content │  │  │
  │  │  └─────────┘  │  │
  │  └───────────────┘  │
  └─────────────────────┘
```

### Glow Intensity Scale

| State    | Blur  | Spread | Alpha | Perceived Effect          |
|----------|-------|--------|-------|---------------------------|
| Static   | 0     | 0      | 0     | No glow                   |
| Hover    | 8px   | 0      | 0.30  | Noticeable but restrained |
| Active   | 10px  | 1px    | 0.35  | Clearly lit               |
| Pressed  | 12px  | 1px    | 0.45  | Brief bright flash        |

### Rules

1. **Never exceed 12px blur** — that crosses into bloom territory
2. **Spread stays at 0-1px** — keeps the halo tight to the element
3. **Alpha never exceeds 0.45** — prevents overwhelming the surrounding UI
4. **Glow color always matches border color family** — no mismatched halos
5. **Pressed glow is momentary** — 100ms then settles to active level
6. **Static elements have no glow** — glow is reserved for interaction feedback

---

## 6. Color Relationship Map

```
  STATIC              HOVER               ACTIVE              PRESSED
  ──────              ─────               ──────              ───────
  Indigo              Indigo Light        Electric Blue       Electric Bright
  #5c6bc0      →      #7986cb      →      #2979ff      →      #448aff
  ░░░░░░░             ▒▒▒▒▒▒▒             ▓▓▓▓▓▓▓             ████████

  Each step increases:
  - Luminosity: darker → brighter
  - Saturation: muted → vivid
  - Glow intensity: none → subtle → clear → flash

  Menu bar follows a separate track:
  Purple (#b39ddb) on hover → Navy (#3949ab) on click
  This differentiates navigation chrome from workspace interaction.
```

---

## 7. Accessibility Notes

### Contrast Ratios (WCAG AA on dark backgrounds)

| Foreground          | Background              | Ratio  | Pass |
|---------------------|-------------------------|--------|------|
| `#5c6bc0` (indigo)  | `rgba(30, 30, 30)`      | 4.8:1  | AA   |
| `#7986cb` (light)   | `rgba(30, 30, 30)`      | 6.2:1  | AA   |
| `#2979ff` (electric) | `rgba(30, 30, 30)`     | 5.5:1  | AA   |
| `#ffffff` on `#5c6bc0` pill fill              | 5.3:1  | AA   |
| `#b39ddb` (purple)  | `rgba(18, 18, 18)`      | 5.7:1  | AA   |

### Focus States (Keyboard Navigation)

Focus-visible states should mirror the hover treatment:
- Outline: `2px solid var(--cm-indigo-light)`
- Outline-offset: `2px`
- Box-shadow: same as hover glow

This ensures keyboard users get equivalent visual feedback to mouse users.

### Reduced Motion

When `prefers-reduced-motion: reduce` is active:
- Disable `translateX`/`translateY` micro-motions
- Keep color transitions (instant or 50ms)
- Keep LED glow (static, no animation)

---

## 8. CSS Custom Properties Block

Add to `:root` in `src/styles/tokens.css`:

```css
:root {
  /* --- Litria Interaction Colors --- */
  --cm-indigo:          #5c6bc0;
  --cm-indigo-light:    #7986cb;
  --cm-electric-blue:   #2979ff;
  --cm-electric-bright: #448aff;
  --cm-purple:          #b39ddb;
  --cm-navy:            #3949ab;

  /* --- Litria Glow Tokens --- */
  --cm-glow-indigo:     rgba(92, 107, 192, 0.25);
  --cm-glow-hover:      rgba(121, 134, 203, 0.30);
  --cm-glow-active:     rgba(41, 121, 255, 0.35);
  --cm-glow-pressed:    rgba(68, 138, 255, 0.45);
  --cm-glow-purple:     rgba(179, 157, 219, 0.25);
  --cm-glow-close:      rgba(229, 57, 53, 0.40);

  /* --- Litria Window Controls --- */
  --cm-control-static:  #505050;
  --cm-control-hover:   #b39ddb;
  --cm-control-click:   #3949ab;
  --cm-close-click:     #e53935;

  /* --- Litria Surfaces (codified from existing) --- */
  --cm-surface-base:     #1e1e1e;
  --cm-surface-dark:     rgba(18, 18, 18, 0.92);
  --cm-surface-card:     rgba(30, 30, 30, 0.75);
  --cm-surface-elevated: rgba(36, 36, 36, 0.85);
  --cm-text-primary:     #e6e6e6;
  --cm-text-muted:       #a7a7a7;
  --cm-text-bright:      #ffffff;

  /* --- Litria Transitions --- */
  --cm-transition-fast:  150ms ease;
  --cm-transition-glow:  150ms ease;
  --cm-transition-press: 100ms ease-out;
}
```

---

## 9. Implementation Checklist

Components to update when applying this governance:

- [ ] **Drawer tabs** (`.drawer-tab`, `.top-drawer-tab`, `.editor-launcher-tab`) — indigo static → electric blue active
- [ ] **Pill notifications** (`.pill-notification`) — indigo outline, hover fill
- [x] **Menu bar buttons** (`.menu-item-btn`) — purple hover, navy click (migrated to shadcn DropdownMenu)
- [x] **Menu dropdown actions** (`.cm-dropdown-item`) — indigo tint hover (migrated to shadcn DropdownMenu)
- [ ] **Window controls** — implement custom titlebar with governed states
- [ ] **Focus-visible states** — add keyboard focus treatment matching hover
- [ ] **Reduced motion** — add `prefers-reduced-motion` media query
- [ ] **CSS variables** — add `:root` block to `src/styles/tokens.css`

---

## 10. Tailwind + shadcn Component Styling Contract

### 10.1 Technology Decision Framework

When building or modifying a UI component, apply the following rubric to determine the appropriate technology:

**Use shadcn/ui (Radix + Tailwind) when:**
- The component is an interactive overlay (modal, popover, dropdown, context menu, dialog, tooltip, command palette)
- The component needs focus trapping, keyboard navigation, or ARIA role management
- The component needs portal rendering, click-outside dismiss, or scroll locking

**Use Tailwind utilities when:**
- Building new layout or visual-only components (spacing, flex, grid, typography)
- Supplementing existing BEM CSS in new code
- Styling shadcn component internals

**Use hand-rolled BEM CSS when:**
- The component is in a protected zone (ADR-008): Monaco editor, canvas, drawers, hover card, pills, status bar, scaffold tree, launch screen
- The component involves coordinate math, canvas transforms, or drag state machines
- The component has deep custom animation (slide transforms, border-image gradients, multi-stage transitions)
- The component is purely domain-specific with no equivalent in any UI library

**Decision flowchart:**
```
Is it in a protected zone (ADR-008)?
  → YES: Hand-roll
  → NO: Does it need focus trap / keyboard nav / ARIA?
    → YES: shadcn
    → NO: Is it an overlay (modal, popover, menu)?
      → YES: shadcn
      → NO: Is it purely layout/visual?
        → YES: Tailwind utilities or BEM CSS
        → NO: Evaluate case-by-case (default to shadcn for interactive chrome)
```

### 10.2 shadcn Styling Requirements

Every shadcn component added to `src/components/ui/` must conform to these rules:

1. **Token consumption**: Use Litria design tokens from `tokens.css` for all colors, surfaces, borders, and transitions. Do not hardcode values that duplicate existing tokens.

2. **Glass-morphic surfaces**: Overlay content panels use semi-transparent backgrounds (`rgba(24, 24, 24, 0.96)` or similar), `backdrop-filter: blur()`, and subtle borders (`rgba(212, 212, 212, 0.28)`).

3. **Border radius**:
   - Dialog/card panels: `14px` (`rounded-card` in Tailwind config)
   - Menu panels: `6px`
   - Pill-shaped elements: `999px` (`rounded-pill` in Tailwind config)
   - Input fields: `999px` (pill) or `10px` (squircle) depending on context

4. **LED glow**: Interactive states follow the glow specification in Section 5. shadcn components must not introduce their own glow/shadow patterns outside the Litria system.

5. **Transitions**: Use `--cm-transition-fast` (150ms ease) for color/opacity changes. Do not use default shadcn/Radix animation timings.

6. **Overlay backdrops**: `bg-black/20 backdrop-blur-[2px]` frosted glass for all modals/dialogs (Dialog and AlertDialog overlays).

7. **WCAG compliance**: All text/background combinations must meet AA contrast ratios per Section 7.

### 10.3 Directory Convention

```
src/components/
  ui/                  ← shadcn-generated components (owned source)
    alert-dialog.jsx
    button.jsx
    command.jsx
    context-menu.jsx
    dialog.jsx
    dropdown-menu.jsx
    popover.jsx
  CanvasArea.jsx       ← hand-rolled components (unchanged)
  EditorMonaco.jsx
  ...
src/lib/
  utils.js             ← cn() helper (clsx + tailwind-merge)
```

### 10.4 Protected Zone Registry

Components excluded from shadcn/Tailwind migration. Full rationale in ADR-008.

| Zone | Key Files | Status |
|---|---|---|
| Monaco editor | monaco-overrides.css, EditorMonaco.jsx | Protected |
| Litria hover card | hover-card.css | Protected |
| Canvas interaction | canvas.css, PuzzlePiece, ConnectionLine, LassoBox | Protected |
| Minimap | Minimap.jsx | Protected |
| Drawer system | drawers.css, EditorDrawer, useAppDrawers | Protected |
| Pill notifications | pill-notification.css, PillNotification | Protected |
| Status bar layout | status-bar.css, StatusBar | Protected |
| Scaffold tree | scaffold.css tree/drag internals | Protected |
| Launch screen | launch.css, LaunchScreen | Protected |

### 10.5 Governance References

- ADR-006: Tailwind adoption rationale
- ADR-007: shadcn adoption rationale
- ADR-008: Protected zone definitions and decision rubric
- RFC: `docs/rfcs/ui-component-layer-strategy.md`
- PRD: `docs/prds/tailwind-shadcn-migration-prd.md`

---

## 11. Versioning

| Version | Date       | Changes                                    |
|---------|------------|--------------------------------------------|
| 1.0     | 2026-03-03 | Initial governance — interaction colors, LED spec, component rules |
| 1.1     | 2026-03-13 | Added Section 10 — Tailwind + shadcn component styling contract, decision framework, protected zones |
| 1.2     | 2026-03-13 | Post-migration update — marked completed menu items in Section 9, updated overlay backdrop to frosted glass, expanded ui/ directory listing, all 4 migration phases complete |
