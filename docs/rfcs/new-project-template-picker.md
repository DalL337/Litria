# RFC: New Project Template Picker — Multi-Wrapper Scaffold System

**Status:** Proposed
**Date:** 2026-04-01
**Owner:** Litria (solo)
**Relates to:** ADR-012, PRD-NP-001, `CM_Widget_API_Contract.md`

---

## 1. Problem

The current Create Project modal is a toggle-gated form with `<select>` dropdowns. It has three limitations:

1. **No wrapper choice** — users cannot choose between Tauri, Electron, or Web Only scaffolds
2. **Low engagement** — the scaffold section is hidden behind a "Disabled/Enabled" toggle; most users skip it
3. **Opaque output** — the scaffold preview shows file counts, not the actual CLI command being run

The result: users create blank projects and set up their stack manually, defeating the purpose of having a scaffold system.

---

## 2. Design Overview

A 3-page modal wizard replaces the current single-page create modal:

```
┌────────────────────────────────────────────────────────┐
│  NEW PROJECT                               ● ○ ○       │
│────────────────────────────────────────────────────────│
│                                                        │
│  Page 1: Project Info                                  │
│  ┌──────────────────────────────────────────────────┐  │
│  │  Project Name    [________________]              │  │
│  │  Project Folder  [________________] [Browse →]   │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  Page 2: Stack Picker (card-based, tier cascade)       │
│  ┌──────────────────────────────────────────────────┐  │
│  │  [Tauri]  [Electron]  [Web Only]     ← Wrapper   │  │
│  │  [React] [Svelte] [Vue] [Angular] [Solid] ← Fw  │  │
│  │  [TypeScript]  [JavaScript]          ← Language  │  │
│  │  [None]  [Express]  [Fastify] [Axum] ← Backend*  │  │
│  │  [Tailwind]  [ShadCN]  [Router]      ← Addons   │  │
│  │  ( ) npm  ( ) pnpm  ( ) yarn         ← Pkg Mgr  │  │
│  │                                                  │  │
│  │  create-tauri-app my-app --template react-ts     │  │
│  └──────────────────────────────────────────────────┘  │
│  * Backend row: Web Only scope only                    │
│                                                        │
│  Page 3: Theme + Review + Create                       │
│  ┌──────────────────────────────────────────────────┐  │
│  │  [Glass ✓]  [Obsidian 🔒]  [Terminal 🔒]  [Paper 🔒] │  │
│  │                                                  │  │
│  │  ┌ Your Project at a Glance ──────────────────┐  │  │
│  │  │  Project     my-app                        │  │  │
│  │  │  Wrapper     Tauri                         │  │  │
│  │  │  Framework   React                         │  │  │
│  │  │  Language    TypeScript                    │  │  │
│  │  │  ...                                       │  │  │
│  │  │  ─────────────────────────────────────     │  │  │
│  │  │  create-tauri-app my-app --template ...    │  │  │
│  │  └────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────┘  │
│                                                        │
│  [Cancel]                        [←] [→] [Create ✦]   │
└────────────────────────────────────────────────────────┘
```

---

## 3. Data Flow

```
┌──────────────────────────────────────────────────────────────────┐
│  Frontend (React)                                                │
│                                                                  │
│  scaffoldDomain.js ──→ Card data (name, icon, flagConfig)        │
│         │                                                        │
│         ▼                                                        │
│  TemplateCard.jsx ──→ User clicks card                           │
│         │                                                        │
│         ▼                                                        │
│  NewProjectWizard ──→ State: { wrapper, framework, lang,         │
│         │               backend, addons, name, folder, theme }   │
│         │                                                        │
│         ▼                                                        │
│  FlagPreview.jsx ──→ Assembles flagConfig objects into            │
│         │             CLI command string (live preview)           │
│         │                                                        │
│         ▼                                                        │
│  invoke('scaffold_project', config) ─── Tauri IPC ───┐           │
│                                                      │           │
└──────────────────────────────────────────────────────┼───────────┘
                                                       │
┌──────────────────────────────────────────────────────┼───────────┐
│  Rust Backend                                        ▼           │
│                                                                  │
│  scaffold_runner.rs                                              │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  1. Validate CLI tool availability                       │    │
│  │  2. Translate flagConfig → CLI-specific arguments        │    │
│  │  3. Execute primary scaffold (std::process::Command)     │    │
│  │  4. Parse # +comment annotations                        │    │
│  │  5. Execute post-scaffold steps (addon installs)         │    │
│  │  6. Stream progress events → frontend                    │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                  │
│  CLI Translation Table:                                          │
│  ┌──────────────┬─────────────────────┬────────────────────────┐ │
│  │ Wrapper      │ Template Format     │ Framework Handling     │ │
│  ├──────────────┼─────────────────────┼────────────────────────┤ │
│  │ Tauri        │ --template react-ts │ Part of template name  │ │
│  │ Electron     │ --template=vite-ts… │ Post-scaffold (comment)│ │
│  │ Web Only     │ --template react-ts │ Part of template name  │ │
│  └──────────────┴─────────────────────┴────────────────────────┘ │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

---

## 4. Tier Cascade System

The stack picker uses a cascading selection model. Each tier gates the next tier's visibility.

### 4.1 Cascade Rules

- A row must not render until its parent row has a confirmed selection
- Changing a selection collapses and **resets state** for all downstream rows
- A row with a `defaultSelected` card (e.g., Backend "None") reveals with that card pre-selected and does not block the next row
- All rows except Addons are single-select. Addons are multi-select

### 4.2 Wrapper Scoping

The Backend row is scoped to Web Only. When Tauri or Electron is selected, the Backend row never appears because those wrappers ship their own backend (Rust for Tauri, Node for Electron).

The `wrapperScope` field on each card's `flagConfig` enables future scoping of any card to specific wrappers (e.g., a Tauri-only addon).

### 4.3 Reset Behavior

| Action | Resets |
|---|---|
| Change Wrapper | Framework, Language, Backend, Addons |
| Change Framework | Language, Backend, Addons |
| Change Language | Backend (to "None"), Addons |
| Change Backend | Nothing (Addons already visible) |
| Cancel / Page back | Everything |

---

## 5. Flag Assembly

The flag preview builds the scaffold command by iterating over selected cards' `flagConfig` objects in tier order:

```
1. Start with CLI tool name (from wrapper selection)
2. Append project name
3. Process flag-style configs (--template)
4. Process append-style configs (language suffix)
5. Process comment-style configs (# +addon annotations)
6. Skip none-style configs
```

### 5.1 Emit Styles

| Style | Behavior | Example |
|---|---|---|
| `flag` | `--{emitKey} {emitValue}` | `--template react` |
| `append` | Concatenated to previous flag value | `react` + `-ts` = `react-ts` |
| `comment` | `# +{emitValue}` annotation | `# +tailwind` |
| `none` | No output | (silent) |

### 5.2 Electron Special Case

Electron Forge templates are bundler-based (`vite`, `vite-typescript`), not framework-based. The scaffold runner handles this:
- Template flag uses the bundler: `--template=vite-typescript`
- Framework choice emitted as comment: `# +react`
- Scaffold runner installs the framework as a post-scaffold dependency

---

## 6. Scaffold Runner Architecture

The Rust scaffold runner (`scaffold_runner.rs`) is responsible for translating the frontend's `ScaffoldConfig` into executable commands.

### 6.1 ScaffoldConfig

```rust
pub struct ScaffoldConfig {
    pub project_name: String,
    pub project_path: String,
    pub wrapper: String,       // "tauri" | "electron" | "web"
    pub framework: String,     // "react" | "svelte" | "angular"
    pub language: String,      // "ts" | "js"
    pub backend: Option<String>, // None | "express" | "fastify" | "axum"
    pub addons: Vec<String>,   // ["tailwind", "shadcn", "router"]
    pub theme: String,         // "glass"
}
```

### 6.2 Execution Pipeline

```rust
pub async fn scaffold_project(config: ScaffoldConfig) -> Result<ScaffoldResult> {
    // 1. Validate target directory
    // 2. Check CLI tool availability
    // 3. Build primary command from config
    // 4. Execute primary scaffold
    // 5. Install framework (Electron only — post-scaffold)
    // 6. Install backend (Web Only — post-scaffold)
    // 7. Install addons (all wrappers — post-scaffold)
    // 8. Write theme preference to litria.project.json
    // 9. Return result with any partial failures
}
```

### 6.3 Post-Scaffold Recipes

Each `comment`-style annotation maps to an install recipe:

| Annotation | Recipe |
|---|---|
| `# +tailwind` | `npm install -D tailwindcss @tailwindcss/vite` + config init |
| `# +shadcn` | `npx shadcn-ui@latest init` (requires Tailwind) |
| `# +router` | `npm install react-router-dom` (framework-dependent) |
| `# +backend:express` | `npm install express` + server stub |
| `# +backend:fastify` | `npm install fastify` + server stub |
| `# +backend:axum` | Separate Cargo project init |
| `# +react` (Electron) | `npm install react react-dom` + Vite config |

---

## 7. Integration with Existing Code

### 7.1 LaunchScreen.jsx

The `isCreateOpen` state and its associated modal markup (lines 273-400) are replaced by a `<NewProjectWizard>` component. The interface contract remains:

```jsx
<NewProjectWizard
  isOpen={isCreateOpen}
  onClose={() => setIsCreateOpen(false)}
  onCreateProject={onCreateProject}
/>
```

### 7.2 scaffoldDomain.js

Existing registry functions gain `flagConfig` metadata:

```js
// Before:
{ id: 'react', name: 'React' }

// After:
{ id: 'react', name: 'React', flagConfig: {
    tier: 'framework',
    emitKey: '--template',
    emitValue: 'react',
    emitStyle: 'flag',
    wrapperScope: ['tauri', 'electron', 'web']
  }
}
```

The existing `buildScaffoldPlan()` function continues to work for backward compatibility during the transition.

### 7.3 Platform Config

The wizard uses `usePlatformConfig()` for:
- `placeholderNewProjectPath` — page 1 folder input placeholder
- `modifierKey` — keyboard shortcut labels if needed

---

## 8. Phase Plan

| Phase | Scope | Depends On |
|---|---|---|
| **1. Modal UI** | 3-page wizard, card rendering, tier cascade, flag preview (display only) | None |
| **2. Scaffold Execution** | Rust scaffold runner, Tauri commands, CLI validation, primary scaffold | Phase 1 |
| **3. Post-Scaffold** | Addon install recipes, backend setup, partial failure handling | Phase 2 |
| **4. Polish** | Theme wiring, copy-to-clipboard, progress streaming, cross-platform QA | Phases 1-3 |

Phase 1 is self-contained and shippable: the modal works, the flag preview builds correct commands, and users can copy the command to run manually. Phases 2-3 add the "do it for me" path.

---

## 9. Resolved Decisions

1. **Package manager**: Default to npm. Radio buttons above the flag preview (`npm (default) | pnpm | yarn`) let power users change it. Non-default selections appear as `--manager <pkg>` in the flag preview. Tauri supports `--manager` natively; for Vite/Electron the scaffold runner translates to the correct invocation prefix.

2. **Vue and Solid**: Included in v1. Both are supported by `create-tauri-app` and `create-vite`. Framework row now shows: React, Svelte, Vue, Angular, Solid.

3. **Addon dependencies**: Auto-select with explanation. Selecting ShadCN auto-selects Tailwind, locks it with a visual indicator (`dep-locked` class) and an italic hint: *"required by ShadCN"*. Deselecting Tailwind while ShadCN is active is blocked. Deselecting ShadCN releases the lock — Tailwind stays selected but becomes freely toggleable. The `flagConfig` schema gains a `requires` field (e.g., `"requires": ["tailwind"]`) so the UI can derive dependencies from card data.

4. **Scaffold progress**: Phase-level updates only ("Scaffolding project...", "Installing dependencies...", "Configuring Tailwind..."). Per-line stdout is noisy and unhelpful for most users.

5. **scaffoldDomain coexistence**: The existing registry and `buildScaffoldPlan()` coexist with the new card system during transition. The card system reads from the same registry (extended with `flagConfig`). Full replacement deferred until the new system is validated in production.

---

## 10. Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| CLI tools evolve and break flag formats | Medium | Medium | Scaffold runner translates internally; flag changes are isolated to the runner |
| Users don't have required tools installed | High | Low | `check_tool_available` validation before execution, clear install instructions |
| Post-scaffold addon recipes become stale | Medium | Low | Recipes are small, self-contained; community can contribute updates |
| Electron framework integration is fragile | Medium | Medium | Start with React-only Electron support; expand after validation |

---

## 11. File Structure

```
src/components/
  NewProjectWizard.jsx      — 3-page wizard modal
  TemplateCard.jsx           — Card widget (per API contract)
  FlagPreview.jsx            — Live command preview (page 2)
  ProjectReviewCard.jsx      — "Your Project at a Glance" summary (page 3)

src/scaffold/
  scaffoldDomain.js          — Extended with flagConfig metadata

src-tauri/src/
  scaffold_runner.rs         — CLI execution engine
  lib.rs                     — Register new commands

docs/prototypes/
  cm_new_project_template_picker_v3.html  — Interactive prototype
  CM_Widget_API_Contract.md               — Widget data contract
```

---

## References
- ADR-012: `docs/adrs/012-widget-scaffold-command-builder.md`
- PRD-NP-001: `docs/prds/new-project-template-picker-prd.md`
- Widget API Contract: `docs/prototypes/CM_Widget_API_Contract.md`
- Interactive Prototype: `docs/prototypes/cm_new_project_template_picker_v3.html`
- Existing scaffold: `src/scaffold/scaffoldDomain.js`
- Platform config: ADR-011, `src/platform/usePlatformConfig.js`
