# Product Requirements Document: New Project Template Picker

**PRD-NP-001 | Version 1.0 | April 1, 2026**

| Field | Value |
|---|---|
| Document ID | PRD-NP-001 |
| Version | 1.0 |
| Date | April 1, 2026 |
| Status | Proposed |
| Project | Litria |
| Component | New Project Modal — 3-page scaffold wizard with card-based template picker |
| Tech Stack | React 18, Tauri v2 (Rust), existing scaffoldDomain.js |
| Prerequisites | ADR-012 |
| Prototype | `docs/prototypes/cm_new_project_template_picker_v3.html` |
| API Contract | `docs/prototypes/CM_Widget_API_Contract.md` |

---

## 1. Purpose and Scope

### 1.1 Purpose

Replace the current Create Project modal (dropdown-based scaffold with toggle) with a 3-page wizard that lets users pick their stack visually through selectable card widgets. Each card carries a `flagConfig` that compiles into a real scaffold command — visible live in the modal and executable by Litria's Rust backend or copy-pasteable into a terminal.

### 1.2 Problems Solved

1. **Low discoverability**: Current scaffold toggle is hidden behind a "Disabled/Enabled" switch. Most users will skip it and get a blank project.
2. **No wrapper choice**: The current modal assumes a single project type. Users cannot choose between Tauri, Electron, or Web Only scaffolds.
3. **Poor feedback**: The current scaffold preview shows file counts and install commands as text lines. Users cannot see the actual CLI command being composed.
4. **No theme selection**: First-run experience has no place to choose a canvas theme.

### 1.3 Scope

- 3-page modal wizard (Project Info → Stack Picker → Theme Selection)
- Card-based selection system governed by `CM_Widget_API_Contract.md`
- Live flag preview that builds real CLI commands from card selections
- Scaffold execution via Tauri IPC → Rust scaffold runner → CLI tools
- Integration with existing `LaunchScreen.jsx` (replaces `isCreateOpen` modal)
- Post-scaffold addon installation pipeline

### 1.4 Out of Scope

- Custom template authoring UI (users add cards via code per the API contract)
- Remote template registry or marketplace
- Project import/migration from other editors
- Multi-project workspace creation
- Changes to the Open Existing Project modal
- Canvas theme engine (page 3 selects a theme key; theme application is a separate domain)

---

## 2. User Stories

### US-1: Scaffold a Tauri + React + TypeScript project
**As a** Litria user, **I want to** pick Tauri → React → TypeScript from visual cards, **so that** Litria scaffolds a ready-to-run Tauri v2 desktop app with React and TypeScript preconfigured.

### US-2: Scaffold a Web Only project with a backend
**As a** Litria user building a web app, **I want to** choose Web Only → React → TypeScript → Express, **so that** Litria scaffolds a Vite + React frontend with an Express backend ready to go.

### US-3: See the scaffold command before running it
**As a** Litria user, **I want to** see the exact CLI command being built as I pick my stack, **so that** I understand what Litria is doing and can copy the command to run manually if I prefer.

### US-4: Skip the backend for desktop wrappers
**As a** Litria user choosing Tauri or Electron, **I want** the backend row to not appear at all, **so that** I'm not confused by options that don't apply — desktop wrappers ship their own backend.

### US-5: Add optional tooling
**As a** Litria user, **I want to** toggle addon cards (Tailwind, ShadCN, Router) independently of my stack choice, **so that** I get common tooling installed automatically after scaffold.

### US-6: Choose a canvas theme
**As a** Litria user creating my first project, **I want to** pick a base theme for the canvas, **so that** the editor matches my preference from the start.

---

## 3. Design Principle: Flag Preview Is Truth

The flag preview shown in page 2 is not a decoration — it is the actual command that will be executed. The UI compiles card selections into a CLI command string. The Rust scaffold runner parses this same structure. If the preview says `create-tauri-app my-app --template react-ts`, that is exactly what runs.

```
Card selections (flagConfig objects)
  → Flag assembly (JS, per emit style rules)
    → Flag preview (rendered in modal, user-visible)
      → Scaffold execution (Tauri IPC → Rust → CLI)
        → Post-scaffold steps (addon installation from # +comment annotations)
```

---

## 4. Product Requirements

### 4.1 Page 1 — Project Info

**Fields:**

| Field | Required | Validation |
|---|---|---|
| Project Name | Yes | Non-empty, trimmed, valid directory name (no special chars) |
| Project Folder | Yes | Non-empty, valid path. Browse button opens native folder picker via Tauri `dialog.open` |

**Behavior:**
- Next button disabled until both fields are filled
- Browse button invokes `@tauri-apps/plugin-dialog` folder picker (replaces the simulated picker in the prototype)
- Project folder uses `placeholderPath` from `usePlatformConfig()` (cross-platform placeholder)

### 4.2 Page 2 — Stack Picker

The core of this feature. Governed entirely by `CM_Widget_API_Contract.md`.

#### 4.2.1 Tier Cascade

Rows reveal in fixed order. Each row's appearance is gated by the previous row having a confirmed selection:

```
1. Wrapper      → always visible
2. Framework    → after Wrapper selection
3. Language     → after Framework selection
4. Backend      → after Language selection (Web Only scope only)
5. Addons       → after Language selection (all wrappers).
                   For Web Only, appears alongside Backend
                   (Backend has a default selection and does not block)
```

**Cascade reset rules:**
- Changing a selection in any row collapses and resets all downstream rows
- State is cleared (not just visually hidden) — `state.lang`, `state.backend`, `state.addons` are reset to defaults
- Backend row resets to "None" (defaultSelected)

#### 4.2.2 Card System

Every card follows the anatomy and field definitions in `CM_Widget_API_Contract.md` Section 1. Each card carries a `flagConfig` object (Section 2) that defines its contribution to the scaffold command.

**Selection rules:**
- Wrapper, Framework, Language, Backend: single-select within row
- Addons: multi-select (toggle on/off)

#### 4.2.3 Wrapper Row

| Card | CLI Tool | Description |
|---|---|---|
| Tauri | `create-tauri-app` | Rust-powered native desktop |
| Electron | `create-electron-app` | Node-powered native desktop |
| Web Only | `create-vite` | Browser-first, no wrapper |

#### 4.2.4 Framework Row

| Card | Scope |
|---|---|
| React | All wrappers |
| Svelte | All wrappers |
| Vue | All wrappers |
| Angular | Tauri only (uses its own CLI; Vite/Electron support deferred) |
| Solid | All wrappers |

#### 4.2.5 Language Row

| Card | Effect on Template |
|---|---|
| TypeScript | Appends `-ts` to template (Tauri/Vite) or `-typescript` (Electron) |
| JavaScript | No suffix — bare framework name used |

**Angular constraint:** Angular is TypeScript-only. When Angular is selected as the framework, TypeScript is auto-selected and locked with hint *"Angular is TypeScript-only"*. JavaScript is greyed out and unselectable. Downstream rows (Backend/Addons) reveal immediately since the language selection is satisfied.

#### 4.2.6 Backend Row (Web Only)

Only appears when wrapper is Web Only. Tauri and Electron ship their own backends.

| Card | Default | Emit |
|---|---|---|
| None | Yes (defaultSelected) | Silent (`emitStyle: none`) |
| Express | No | `# +backend:express` |
| Fastify | No | `# +backend:fastify` |
| Axum | No | `# +backend:axum` |

#### 4.2.7 Addon Row

Multi-select. All addons emit as `comment` style (`# +value`), processed as post-scaffold installation steps.

| Card | Emit | Requires |
|---|---|---|
| Tailwind | `# +tailwind` | — |
| ShadCN | `# +shadcn` | Tailwind |
| Router | `# +router` | — |

**Dependency auto-select:** Selecting ShadCN auto-selects Tailwind and locks it with a visual indicator and italic hint: *"required by ShadCN"*. Deselecting Tailwind while ShadCN is active is blocked (no-op). Deselecting ShadCN releases the lock — Tailwind stays selected but becomes freely toggleable.

#### 4.2.8 Package Manager

Radio buttons above the flag preview. Default: npm.

```
( ) npm (default)    ( ) pnpm    ( ) yarn
```

Non-default selections appear as `--manager <pkg>` in the flag preview. The scaffold runner translates this to the correct invocation per wrapper (`create-tauri-app --manager pnpm`, `pnpm create vite`, etc.).

#### 4.2.9 Flag Preview

Live-updating command preview at the bottom of page 2. Shows the compiled scaffold command using color-coded spans:
- `flag-key` (teal): CLI tool name
- `flag-val` (indigo): template values and project name
- `flag-comment` (muted): post-scaffold annotations

**Example outputs:**

| Selection | Preview |
|---|---|
| Tauri + React + TS | `create-tauri-app my-app --template react-ts` |
| Tauri + React + TS + Tailwind | `create-tauri-app my-app --template react-ts # +tailwind` |
| Electron + React + TS | `create-electron-app my-app --template=vite-typescript # +react` |
| Web Only + React + TS + Express | `create-vite my-app --template react-ts # +backend:express` |

### 4.3 Page 3 — Theme + Review + Create

Page 3 serves three purposes: theme selection, project review, and creation. It follows the e-commerce pattern: choose → review → confirm.

#### 4.3.1 Theme Selection

| Theme | Status | Description |
|---|---|---|
| Glass | Available (default) | Litria's glass-morphic default theme |
| Obsidian | Locked (SOON) | Deep dark theme |
| Terminal | Locked (SOON) | Retro green terminal aesthetic |
| Paper | Locked (SOON) | Light mode |

Locked themes show a `SOON` badge and are not selectable. Only Glass is selectable in v1.

**Theme boundary:** Themes affect visual style surfaces (node colors, folder group styles, backdrop treatment, surface feel). Themes do **not** alter semantic edge status colors (green/yellow/red) — those communicate import/export health and are hard-locked regardless of theme.

#### 4.3.2 Review Card — "Your Project at a Glance"

A dedicated card component on page 3 that summarizes the entire project setup in human-readable form. This is the final confirmation surface before creation.

**Card contents (in order):**

| Field | Source |
|---|---|
| Project | `state.name` from page 1 |
| Location | `state.folder` from page 1 |
| Wrapper | Selected wrapper card label |
| Framework | Selected framework card label |
| Language | Selected language card label |
| Backend | Selected backend card label (or "None") |
| Addons | Comma-separated addon labels (or "None") |
| Package Manager | Selected radio value |

Below the summary grid, the compiled scaffold command appears as secondary technical confirmation — the same command shown live on page 2.

**UX intent:** Users get a fast human-readable understanding of their project first, then a technical confirmation underneath. The labeled summary is for clarity and confidence. The command is for transparency and trust.

#### 4.3.3 Future: Advanced Options

A collapsible "Advanced Options" section is a planned future expansion surface for page 2 or page 3. It is not part of the immediate core flow. It should be designed to avoid bloating the main modal path. Placement, contents, and interaction model require separate design work.

### 4.4 Navigation

- **Back** (←): Returns to previous page with back-slide animation
- **Next** (→): Advances to next page with forward-slide animation. Disabled until current page's requirements are met
- **Cancel**: Resets all state and closes the modal
- **Create Project** (✦): Replaces Next on page 3. Triggers scaffold execution

### 4.5 Scaffold Execution Flow

When the user clicks "Create Project":

1. Button text changes to "✦ Scaffolding..." and disables
2. Assembled flag data sent to Rust via `invoke('scaffold_project', { config })`
3. Rust scaffold runner translates `flagConfig` values to CLI-specific arguments (see ADR-012)
4. Primary scaffold command executed (`create-tauri-app`, `create-electron-app`, or `create-vite`)
5. Post-scaffold steps executed for each `comment`-style annotation (addon installs, backend setup)
6. Progress events streamed back to frontend via Tauri event system
7. On success: button shows "✓ Done!", then opens the project
8. On failure: error notification with actionable message, modal stays open

---

## 5. Presentation Requirements

### 5.1 Modal

| Property | Value |
|---|---|
| Max width | 720px |
| Background | `rgba(15, 17, 26, 0.97)` |
| Border | `1px solid rgba(255, 255, 255, 0.08)` |
| Border radius | 20px |
| Box shadow | `0 40px 80px rgba(0, 0, 0, 0.6)` |
| Font (headings) | Russo One 400, 30px |
| Font (labels/mono) | JetBrains Mono |

### 5.2 Page Copy

Headings sell the step. Sub-lines reduce anxiety. Neither should require prior knowledge of Litria internals.

| Page | Heading | Sub-line |
|---|---|---|
| 1 | Let's start here. | Name it. Place it. Let's build. |
| 2 | Pick your stack. | Choose what powers your project. |
| 3 | Base theme. | Set the look for your workspace. More coming soon. |

### 5.3 Card States

| State | Visual |
|---|---|
| Default | Low-opacity border, dark background |
| Hover | Brighter border, `translateY(-1px)` |
| Selected | Indigo border + glow, indigo-tinted background, check mark visible |
| Disabled | Reserved for future locked tiers |

### 5.3 Animations

All animation values are locked per `CM_Widget_API_Contract.md` Section 4.

| Animation | Duration | Easing |
|---|---|---|
| Row reveal | 400ms | `cubic-bezier(0.0, 0.0, 0.2, 1)` |
| Card hover | 200ms | ease |
| Page transition | 300ms | ease (horizontal slide) |

### 5.4 Step Indicator

Three dots in the modal header. Active dot is indigo with glow (20px wide pill). Completed dots are teal. Inactive dots are muted.

### 5.5 Accessibility

- Modal has `role="dialog"` and `aria-modal="true"`
- Focus trapped within modal while open
- All cards keyboard-navigable (tab + enter/space to select)
- Step indicator has `aria-label` describing current page
- Cancel via Escape key
- Browse button announces folder picker to screen readers

---

## 6. Cross-Platform Considerations

### 6.1 Path Handling

| Concern | Solution |
|---|---|
| Placeholder path | Uses `placeholderNewProjectPath` from `usePlatformConfig()` |
| Folder picker | Tauri `dialog.open({ directory: true })` — native OS picker |
| Path separators | Backend normalizes via `std::path::Path`. Frontend uses forward slashes |

### 6.2 CLI Tool Requirements

| Wrapper | Requires |
|---|---|
| Tauri | Node.js + npm/pnpm/yarn, Rust toolchain |
| Electron | Node.js + npm |
| Web Only | Node.js + npm |

The scaffold runner must validate that required CLI tools are available before execution. Missing tools produce a clear error: "Rust toolchain not found. Install from rustup.rs to scaffold Tauri projects."

### 6.3 Shell Execution

Scaffold commands run via `std::process::Command`, not through a user shell. This avoids shell-specific issues across platforms. Environment variables (`PATH`, `HOME`, `SystemRoot`) are inherited from the Tauri process.

---

## 7. Error Handling

### 7.1 Error Scenarios

| Scenario | User Message | Modal State |
|---|---|---|
| CLI tool not installed | "Cannot find {tool}. Install it to continue." | Stays open, button re-enabled |
| Scaffold command fails | "Scaffold failed: {stderr}. Check the output log." | Stays open, shows error |
| Post-scaffold addon fails | "Project created but {addon} install failed. Run manually: {command}" | Closes, project opens |
| Folder already exists | "A folder named '{name}' already exists at this path." | Stays open, page 1 focused |
| Permission denied | "Cannot write to '{path}'. Check folder permissions." | Stays open, page 1 focused |
| Network error (npm) | "Package install failed. Check your internet connection." | Stays open, button re-enabled |

### 7.2 Partial Success

If the primary scaffold succeeds but an addon fails, the project is still opened. A notification explains which addon failed and provides the manual install command.

---

## 8. Integration Points

### 8.1 LaunchScreen.jsx

The current `isCreateOpen` modal (lines 273-400) is replaced entirely. The existing state for `useScaffold`, `languageId`, `frameworkId`, `selectedAddons`, and `plan` moves into the new wizard component. The `onCreateProject` callback signature remains the same.

### 8.2 scaffoldDomain.js

The existing `getScaffoldLanguages()`, `getScaffoldFrameworks()`, `getScaffoldAddons()`, and `buildScaffoldPlan()` functions are preserved as the data source for card definitions. Card rendering consumes these same registries — no duplicate data.

### 8.3 useProjectLaunch.js

The existing `handleCreateProject` logic is extended to support the new scaffold config format (wrapper + framework + lang + backend + addons + theme).

### 8.4 Rust Backend

New Tauri commands:
- `scaffold_project(config: ScaffoldConfig) -> Result<ScaffoldResult>` — runs the primary scaffold CLI
- `install_addon(project_path: &str, addon: &str) -> Result<()>` — runs post-scaffold addon installations
- `check_tool_available(tool: &str) -> Result<bool>` — validates CLI tool availability

### 8.5 Existing Scaffold Code — Reuse Plan

The current scaffold system has two layers. One generates files; the other wires them into the canvas. Only the generator is replaced.

**1. Extend the registry** (`scaffoldDomain.js`)
- Add `flagConfig` metadata to `SCAFFOLD_REGISTRY` entries so the card system reads from the same data source
- `createScaffoldDomain()`, `getScaffoldLanguages()`, `getScaffoldFrameworks()`, `getScaffoldAddons()` survive as card data providers
- `toInstallCommand()` is reused for addon install recipes

**2. Replace the file generator** (`scaffoldDomain.js` + `applyScaffoldPlan.js`)
- `getBaseFiles()`, `getCoreFiles()`, `getEntryFile()` are replaced — CLI tools generate their own file structures
- `buildScaffoldPlan()` is replaced — plans are built from `flagConfig` card selections, not internal stubs
- `getTemplateForFile()` in `applyScaffoldPlan.js` is replaced — CLI tools write their own file contents

**3. Keep the canvas wiring** (`applyScaffoldPlan.js`)
- `buildFolderTree()`, `registerGroups()`, `layoutPieces()` — turns whatever files landed on disk into canvas pieces and groups. Works identically regardless of scaffold source
- Piece creation loop, manifest update, connection wiring — all reused as-is
- Secret validation + `.env` generation via `secretGenerator.js` — security layer stays
- Call this layer *after* CLI scaffold finishes, in the same position it runs today after internal template generation

> **Fallback note:** The internal scaffold templates (JS/TS/Python/JSON stubs) can be preserved as a fallback for when CLI tools aren't installed. "Can't find `create-tauri-app`? Here's a basic starter structure."

---

## 9. Files Touched

### New Files

| File | Purpose |
|---|---|
| `src/components/NewProjectWizard.jsx` | 3-page wizard modal component |
| `src/components/TemplateCard.jsx` | Reusable card widget per API contract |
| `src/components/FlagPreview.jsx` | Live scaffold command preview |
| `src/components/ProjectReviewCard.jsx` | Page 3 "Your Project at a Glance" summary card |
| `src-tauri/src/scaffold_runner.rs` | Rust scaffold execution engine |

### Modified Files

| File | Change |
|---|---|
| `src/components/LaunchScreen.jsx` | Replace `isCreateOpen` modal with `NewProjectWizard` |
| `src/scaffold/scaffoldDomain.js` | Add `flagConfig` metadata to language/framework/addon registries |
| `src/app/useProjectLaunch.js` | Extend `handleCreateProject` for new config format |
| `src-tauri/src/lib.rs` | Register new scaffold commands |

### Unchanged Files

| File | Reason |
|---|---|
| `src/styles/launch.css` | Wizard uses own scoped styles matching prototype |
| `src/components/EditorLauncherTab.jsx` | Launcher tab calls into LaunchScreen — no interface change |

---

## 10. Acceptance Criteria

### 10.1 Functional

| # | Criterion | Validation |
|---|---|---|
| F1 | Page 1 blocks Next until name and folder are filled | Leave fields empty, verify Next is disabled |
| F2 | Browse opens native folder picker | Click Browse, verify OS-native folder dialog |
| F3 | Wrapper selection reveals Framework row | Select Tauri. Verify Framework row slides in |
| F4 | Tier cascade resets downstream on parent change | Select Tauri → React → TS. Change to Electron. Verify Framework/Language/Addons reset |
| F5 | Backend row only appears for Web Only | Select Tauri. Verify no Backend row. Select Web Only → React → TS. Verify Backend appears |
| F6 | Addons appear alongside Backend for Web Only | Select Web Only → React → TS. Verify both Backend and Addons visible (Backend has default) |
| F7 | Flag preview shows correct Tauri command | Select Tauri → React → TS. Verify: `create-tauri-app my-app --template react-ts` |
| F8 | Flag preview shows correct Electron command | Select Electron → Svelte → TS. Verify: `create-electron-app my-app --template=vite-typescript # +svelte` |
| F9 | Flag preview shows correct Vite command with backend | Web Only → React → TS → Express. Verify: `create-vite my-app --template react-ts # +backend:express` |
| F10 | JavaScript produces bare template name | Tauri → React → JS. Verify: `--template react` (no `-js` suffix) |
| F11 | Addons appear as comment annotations | Select any stack + Tailwind. Verify `# +tailwind` in preview |
| F12 | Multi-select works for addons | Select Tailwind + ShadCN + Router. Verify all three in preview |
| F13 | Cancel resets all state | Fill all pages, click Cancel. Reopen. Verify everything is reset |
| F14 | Create Project executes scaffold | Complete all pages, click Create Project. Verify CLI runs and project is created on disk |
| F15 | Post-scaffold addons install | Select React + Tailwind. Verify Tailwind is installed after scaffold |
| F16 | Theme selection persists | Select Glass on page 3. Verify theme key passed to project creation |
| F17 | Locked themes are not selectable | Click Obsidian. Verify no selection change |

### 10.2 Cross-Platform

| # | Criterion | Platform | Validation |
|---|---|---|---|
| P1 | Placeholder path matches OS | All | Windows: `C:\Projects\...`, macOS: `~/Projects/...`, Linux: `~/projects/...` |
| P2 | Folder picker uses native dialog | All | Verify OS-native folder picker on each platform |
| P3 | Scaffold command runs successfully | All | Create a Tauri + React + TS project on each platform |

### 10.3 Accessibility

| # | Criterion | Validation |
|---|---|---|
| A1 | Modal traps focus | Tab through modal, verify focus doesn't escape |
| A2 | Cards selectable via keyboard | Tab to card, press Enter. Verify selection |
| A3 | Escape closes modal | Press Escape. Verify modal closes |
| A4 | Screen reader announces page changes | Navigate pages. Verify announcements |

### 10.4 Performance

| # | Criterion | Target |
|---|---|---|
| R1 | Modal opens | < 100ms |
| R2 | Card selection + cascade animation | < 500ms total |
| R3 | Flag preview updates | < 16ms (single frame) |
| R4 | Scaffold execution feedback | First progress event within 2s |

---

## 11. Implementation Phases

### Phase 1: Modal UI + Card System (no execution)
- `NewProjectWizard.jsx` with 3-page navigation
- `TemplateCard.jsx` with card states and selection logic
- Tier cascade with reset behavior
- `FlagPreview.jsx` with live command assembly
- Replace `isCreateOpen` modal in `LaunchScreen.jsx`
- Wire card data from `scaffoldDomain.js`

### Phase 2: Scaffold Execution
- `scaffold_runner.rs` — Rust CLI execution engine
- `scaffold_project` Tauri command
- `check_tool_available` validation
- Progress event streaming
- Error handling and user feedback

### Phase 3: Post-Scaffold Pipeline
- `install_addon` Tauri command
- Addon install recipes (Tailwind, ShadCN, Router)
- Partial success handling
- Backend setup for Web Only projects

### Phase 4: Polish
- Theme selection wiring (persist and apply on project open)
- Copy-to-clipboard for flag preview
- Keyboard navigation refinement
- Cross-platform QA

---

## References
- ADR-012: Declarative Widget Card System for Scaffold Command Generation
- RFC: `docs/rfcs/new-project-template-picker.md`
- Widget API Contract: `docs/prototypes/CM_Widget_API_Contract.md`
- Interactive Prototype: `docs/prototypes/cm_new_project_template_picker_v3.html`
- Existing scaffold system: `src/scaffold/scaffoldDomain.js`
- Launch screen: `src/components/LaunchScreen.jsx`
- Project launch hook: `src/app/useProjectLaunch.js`
