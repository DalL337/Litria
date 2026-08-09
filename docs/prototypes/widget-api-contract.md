# Litria — Widget API Contract
**Version:** 0.1.0  
**Status:** Draft  
**Scope:** New Project Modal — Template Picker (Page 2)  
**Platform:** Cross-platform (Windows, macOS, Linux via Tauri)

---

## Overview

This document governs the structure, behavior, and data contract for all **widget cards** used inside the Litria New Project modal. It exists so that contributors adding new cards, rows, or selection tiers do so consistently — visually, behaviorally, and in terms of the flag data they emit to the Rust scaffold runner.

The interactive prototype in `/docs/prototypes/cm_new_project_template_picker_v3.html` is the canonical visual reference for this contract. When in doubt, match the prototype.

> **Platform rule:** No card, row, or widget behavior may depend on or reference a specific operating system. All UI interactions use web-layer APIs only. No OS-native dialogs, file pickers, or shell calls are permitted from within the widget layer — those belong in the Rust backend.

---

## Section 1 — Card Anatomy

Every template card is a self-contained selectable unit. All fields below are **required** unless marked optional. A card missing a required field will be rejected in code review.

```
┌─────────────────────────────┐
│  ✓  (selected check — top right, hidden until selected)
│
│  [icon]   32×32px, rounded 8px, themed background
│
│  Card Name        ← 1–3 words, title case
│  Card Description ← 1 short sentence, JetBrains Mono, muted
│
│  [Badge Tag]      ← category label, all caps, color-coded
└─────────────────────────────┘
```

### Field Definitions

| Field | Required | Rules |
|---|---|---|
| `name` | ✅ | 1–3 words, title case, no punctuation |
| `description` | ✅ | Max 40 characters, plain language |
| `icon` | ✅ | Emoji or Lucide icon. No custom SVGs without approval |
| `iconBackground` | ✅ | `rgba()` value only. Must match tier color palette (see Section 5) |
| `badge` | ✅ | All caps, max 10 chars, uses badge color system (see Section 5) |
| `flagConfig` | ✅ | Flag configuration object — defines this card's scaffold contribution (see Section 2) |
| `defaultSelected` | Optional | Boolean. Only one card per row may carry this. Renders pre-selected on row reveal |
| `isNone` | Optional | Boolean. Marks a card as a no-op selection (e.g. "None" in the backend row). Still emits a value of `null` to the flag builder |

### Card States

A card must handle all four states cleanly:

| State | Visual |
|---|---|
| Default | Low-opacity border, dark background |
| Hover | Brighter border, 1px lift via `translateY(-1px)` |
| Selected | Indigo border + glow, indigo-tinted background, check mark visible |
| Disabled | Not currently used in this modal. Reserved for future locked tiers |

---

## Section 2 — Tag / Flag Contract

Every card declares its contribution to the compiled scaffold command. This is the **data layer** of the widget system — separate from its visual layer.

### Flag Object Shape

Each card must define a `flagConfig` object:

```json
{
  "flagConfig": {
    "tier": "wrapper | framework | lang | backend | addon",
    "emitKey": "string — the CLI flag key, e.g. --template",
    "emitValue": "string — the value appended after the key, e.g. react",
    "emitStyle": "flag | append | comment | none",
    "wrapperScope": ["tauri", "electron", "web"],
    "requires": ["string — addon IDs this card depends on (optional)"]
  }
}
```

### Dependency Handling

When a card has a `requires` array, selecting it auto-selects all required cards. The required cards are visually locked (cannot be deselected) and show a hint: *"required by {card name}"*. Deselecting the dependent card releases the lock — required cards stay selected but become freely toggleable.

**Example:** ShadCN requires Tailwind. Selecting ShadCN auto-selects Tailwind and locks it. Deselecting ShadCN releases Tailwind.

### Emit Styles

| Style | Behaviour | Example Output |
|---|---|---|
| `flag` | Emits as `--key value` | `--template react` |
| `append` | Appends directly to previous value, no space | `react-ts` |
| `comment` | Emits as a `# +value` annotation (non-executable hint) | `# +tailwind` |
| `none` | Emits nothing. Used for "None" default cards | *(silent)* |

### Wrapper Scope

`wrapperScope` is an array declaring which runtime wrappers this card is valid for. The flag builder ignores cards outside the active wrapper scope.

```json
"wrapperScope": ["tauri"]           // Tauri only
"wrapperScope": ["tauri", "electron"] // Both desktop wrappers
"wrapperScope": ["web"]             // Web Only only
"wrapperScope": ["tauri", "electron", "web"] // Universal
```

### Example — React Card

```json
{
  "name": "React",
  "description": "Component-driven UI",
  "icon": "⚛️",
  "iconBackground": "rgba(97, 218, 251, 0.1)",
  "badge": "FRAMEWORK",
  "flagConfig": {
    "tier": "framework",
    "emitKey": "--template",
    "emitValue": "react",
    "emitStyle": "flag",
    "wrapperScope": ["tauri", "electron", "web"]
  }
}
```

### Example — TypeScript Language Card (append style)

```json
{
  "name": "TypeScript",
  "description": "Typed, safer, recommended",
  "icon": "🔷",
  "iconBackground": "rgba(49, 120, 198, 0.1)",
  "badge": "LANGUAGE",
  "flagConfig": {
    "tier": "lang",
    "emitKey": null,
    "emitValue": "-ts",
    "emitStyle": "append",
    "wrapperScope": ["tauri", "electron", "web"]
  }
}
```

### Example — None Backend Card (silent)

```json
{
  "name": "None",
  "description": "Frontend only",
  "icon": "🚫",
  "iconBackground": "rgba(255, 255, 255, 0.04)",
  "badge": "DEFAULT",
  "defaultSelected": true,
  "isNone": true,
  "flagConfig": {
    "tier": "backend",
    "emitKey": null,
    "emitValue": null,
    "emitStyle": "none",
    "wrapperScope": ["web"]
  }
}
```

### Example — Tailwind Addon Card (comment style)

```json
{
  "name": "Tailwind",
  "description": "Utility-first CSS",
  "icon": "🌊",
  "iconBackground": "rgba(56, 189, 248, 0.1)",
  "badge": "ADDON",
  "flagConfig": {
    "tier": "addon",
    "emitKey": null,
    "emitValue": "tailwind",
    "emitStyle": "comment",
    "wrapperScope": ["tauri", "electron", "web"]
  }
}
```

### Example — ShadCN Addon Card (with dependency)

```json
{
  "name": "ShadCN",
  "description": "Accessible UI components",
  "icon": "🧩",
  "iconBackground": "rgba(255, 255, 255, 0.05)",
  "badge": "ADDON",
  "flagConfig": {
    "tier": "addon",
    "emitKey": null,
    "emitValue": "shadcn",
    "emitStyle": "comment",
    "wrapperScope": ["tauri", "electron", "web"],
    "requires": ["tailwind"]
  }
}
```

### Scaffold Runner Translation

The `emitValue` is Litria's internal representation. The Rust scaffold runner translates these to the correct CLI arguments per wrapper:

| Wrapper | CLI Tool | Template Format | Framework Handling |
|---|---|---|---|
| Tauri | `create-tauri-app` | `--template react-ts` | Part of template name |
| Electron | `create-electron-app` | `--template=vite-typescript` | Post-scaffold step (comment annotation) |
| Web Only | `create-vite` | `--template react-ts` | Part of template name |

Electron Forge templates use the **bundler** name (`vite`, `vite-typescript`), not the framework. The framework choice is applied as a post-scaffold installation step and appears as a `# +framework` comment in the flag preview.

Addons and backend selections are always emitted as `comment` style annotations (`# +value`). The scaffold runner processes these as post-scaffold installation steps.

---

## Section 3 — Row Behavior Rules

Rows are the grouping containers for cards within a tier. They have their own rules separate from the cards inside them.

### Row Reveal Order

Rows always reveal in this fixed sequence. The order is non-negotiable:

```
1. Wrapper      → always visible on page load
2. Framework    → reveals after Wrapper selection
3. Language     → reveals after Framework selection
4. Backend      → reveals after Language selection, Web Only scope only
5. Addons       → reveals after Language selection. For Web Only, appears alongside Backend (Backend carries a default selection and does not block)
```

### Row Reveal Rules

- A row **must not render** until its parent row has a confirmed selection.
- If the user changes a selection in an earlier row, all downstream rows **collapse and reset** to default state.
- A row with a `defaultSelected` card reveals with that card already selected. It does not block the next row from appearing — the downstream row may reveal immediately alongside it.
- Rows are **single-select** except Addons, which is **multi-select**.
- The backend row is **wrapper-scoped to Web Only**. It must never appear when Tauri or Electron is selected.

### Row Collapse on Parent Change

When a user changes a wrapper selection:
- Framework row collapses and resets
- Language row collapses and resets
- Backend row collapses and resets
- Addon row collapses and resets
- Flag preview clears back to placeholder

When a user changes a framework selection:
- Language row collapses and resets
- Backend row collapses and resets
- Addon row collapses and resets

When a user changes a language selection:
- Backend row collapses and resets (Web Only)
- Addon row collapses and resets

---

## Section 4 — Animation Contract

Animation behavior is **locked**. Contributors may not introduce new animation styles, durations, or easing curves without a design review approval.

### Row Reveal Animation

| Property | Value |
|---|---|
| Duration | `400ms` |
| Easing | `cubic-bezier(0.0, 0.0, 0.2, 1)` — decelerating ease-out |
| `max-height` transition | `400ms` |
| `opacity` transition | `320ms` with `60ms` delay |
| `transform` transition | `400ms` with `40ms` delay |
| Starting transform | `translateY(-14px)` |
| Ending transform | `translateY(0)` |

### CSS Implementation

```css
.subsection {
  overflow: hidden;
  max-height: 0;
  opacity: 0;
  transform: translateY(-14px);
  transition:
    max-height 0.4s cubic-bezier(0.0, 0.0, 0.2, 1),
    opacity    0.32s cubic-bezier(0.0, 0.0, 0.2, 1) 0.06s,
    transform  0.4s  cubic-bezier(0.0, 0.0, 0.2, 1) 0.04s;
}

.subsection.visible {
  max-height: 220px;
  opacity: 1;
  transform: translateY(0);
}
```

### Card Hover

```css
transform: translateY(-1px);
transition: all 0.2s ease;
```

### Page Navigation Animation

Page transitions use a horizontal slide. Forward = slide from right. Back = slide from left. Duration `300ms`, standard ease.

---

## Section 5 — Color and Badge System

All colors use `rgba()` values. No hardcoded hex colors on card elements. No OS-specific theming hooks.

### Tier Color Palette

| Tier | Icon Background | Badge Background | Badge Text |
|---|---|---|---|
| Tauri (Desktop/Rust) | `rgba(255, 140, 50, 0.12)` | `rgba(255, 140, 50, 0.15)` | `#fb923c` |
| Electron (Desktop/Node) | `rgba(20, 184, 166, 0.12)` | `rgba(20, 184, 166, 0.15)` | `#2dd4bf` |
| Web | `rgba(99, 102, 241, 0.12)` | `rgba(99, 102, 241, 0.15)` | `#818cf8` |
| Optional / Default | `rgba(255, 255, 255, 0.04)` | `rgba(255, 255, 255, 0.06)` | `rgba(255,255,255,0.3)` |

### Badge Label Conventions

| Context | Badge Text |
|---|---|
| Desktop wrapper | `DESKTOP` |
| Web wrapper | `WEB` |
| Rust-powered | `RUST` |
| Node-powered | `NODE` |
| Default selection | `DEFAULT` |
| Upcoming / locked | `SOON` |
| Addon selection | `ADDON` |

---

## Section 6 — Reset Contract

Every card and row must return cleanly to its initial state when a reset is triggered. Resets are triggered by: wrapper change, page back-navigation, or Cancel button.

### Full Reset Checklist

- [ ] All card `selected` classes removed
- [ ] All `defaultSelected` cards restored to selected state
- [ ] All subsection rows remove `visible` class (collapsed)
- [ ] Flag preview returns to placeholder string
- [ ] `state` object returns to: `{ wrapper: null, framework: null, lang: null, backend: 'none', addons: Set() }`
- [ ] Next button re-greys (disabled) until selections are re-made
- [ ] Done button hidden, Next button visible

### Partial Reset (parent row change)

Only downstream rows reset. The changed row and all rows above it retain their state.

---

## Contributing — Checklist

Before opening a PR that adds or modifies a widget card or row:

- [ ] Card includes all required fields from Section 1
- [ ] `flagConfig` is fully defined with correct `emitStyle` and `wrapperScope`
- [ ] Card is placed in the correct row tier
- [ ] If the card is wrapper-scoped, `wrapperScope` array reflects this
- [ ] Card renders correctly in all four states (default, hover, selected, and reset)
- [ ] No OS-specific code or APIs used
- [ ] Animation values not modified from Section 4 spec
- [ ] Colors use the palette from Section 5 only
- [ ] Reset behavior tested manually against Section 6 checklist
- [ ] Prototype HTML updated to reflect the new card if it changes visible layout

---

*This document is maintained alongside the prototype. If the prototype changes, this doc must be updated in the same PR.*
