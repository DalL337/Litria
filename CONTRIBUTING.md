# Contributing to Litria

Litria is a desktop IDE built with Tauri, React, and a canvas-based workspace where files are nodes and folders are real groups on disk. We welcome contributions that make Litria better for the people who use it.

Before you open a PR, read this guide. It will save you time and save reviewers from asking the same questions.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Desktop shell | Tauri v2 (Rust backend) |
| Frontend framework | React 19 |
| Canvas | Konva + react-konva |
| Code editor | Monaco 0.52 via @monaco-editor/react |
| Terminal | xterm.js |
| Icons | Lucide React |
| Styling (utilities) | Tailwind CSS v4 |
| Styling (interactive overlays) | shadcn/ui (Radix primitives) |
| Styling (domain components) | Hand-rolled BEM CSS with Litria design tokens |

All three styling approaches coexist. See the **Styling Policy** section below for when to use which.

---

## Getting Started

```bash
# Prerequisites: Node 24+, Rust toolchain, Tauri CLI
git clone <repo-url>
cd litria
npm install

# Development
npm run dev          # Vite dev server (frontend only)
npm run tauri dev    # Full Tauri app with Rust backend

# Validation (run before every PR)
npm run check:architecture   # 6 architecture guards
npm run test:domains         # Domain unit tests
npm run build                # Production build
```

If your PR touches Rust (`src-tauri/`), also run `cargo build` and
`cargo test` there — the build must produce **zero warnings**.

---

## Project Structure

```
src/
  app/              # Domain modules (*Domain.js), selectors, hooks
  behaviors/        # Interaction behaviors (drag, lasso, adjacency)
  components/       # React components (canvas pieces, editor, UI)
  components/ui/    # shadcn/ui components (owned source, not library)
  crash/            # Crash capture, local logs, assisted reporting
  drawers/          # Drawer system (editor, scaffold, settings, terminal)
  editor/           # Monaco setup, language intelligence, headers
  history/          # Undo/redo manager
  hooks/            # Shared render hooks (node/group health, diagnostics)
  lsp/              # LSP client adapter
  platform/         # Per-OS defaults and platform config
  preferences/      # Settings registry + preferences domain (ADR-019)
  project/          # Project manifest, storage, persistence
  scaffold/         # Scaffold domain (project templates)
  styles/           # CSS files (BEM, overrides, tokens)
  terminal/         # Terminal domain, pill notifications
  theme/            # Theme defaults, material parameter contract
  utils/            # Pure helpers (paths, geometry, wire routing utils)

src-tauri/src/      # Rust backend (LSP transport, terminal, file I/O)

scripts/            # Architecture guards, tooling
test/domains/       # Domain unit tests
docs/               # ADRs, RFCs, plans, governance
```

---

## Architecture Rules

Litria uses a domain-driven architecture. Every piece of state has one owning domain. The full model is in `docs/Orchestration.md`.

### Domain Contract

Every domain file (`*Domain.js`) must:

1. Export a `create*Domain()` factory function (or `use*Domain()` for React integration domains)
2. Return an object with at least a `commands` property
3. Have a corresponding test file in `test/domains/`

### Forbidden Patterns

- **Domain to UI imports** — Domain files (`src/app/`, `src/terminal/`, etc.) cannot import from `src/components/` or `src/drawers/`
- **New App.jsx domain imports** — Do not add new domain-coupled imports to `src/App.jsx` without updating the transition allowlist with justification
- **Cyclic dependencies** — No circular imports between domains
- **Direct state mutation** — All state changes go through domain commands

These rules are enforced by six automated guards that run in CI:

| Guard | What It Checks |
|-------|---------------|
| `architecture-guard.mjs` | Domain-to-UI import ban, project isolation |
| `app-shell-guard.mjs` | No new domain imports in App.jsx |
| `protected-zone-guard.mjs` | No shadcn/Radix in protected zones (ADR-008) |
| `domain-contract-guard.mjs` | Domain factory + commands contract |
| `settings-key-guard.mjs` | Preference keys only via `PREF_KEYS`; settings registry shape invariants (ADR-019) |
| `editor-engine-guard.mjs` | Monaco stays sealed in the engine package; also prints the editor-engine contract |

Run all six with: `npm run check:architecture`

---

## Styling Policy

### When to Use What

| Approach | Use For |
|----------|--------|
| **shadcn/ui** | Interactive overlays: modals, dropdowns, popovers, context menus, dialogs, command palettes. Anything needing focus trap, keyboard nav, or ARIA roles. |
| **Tailwind utilities** | New layout, spacing, flex/grid. Styling shadcn component internals. |
| **Hand-rolled BEM CSS** | Domain-specific components, protected zones, deep custom animation. |

### Protected Zones

These areas must remain hand-rolled. Do not introduce shadcn or Radix primitives into them.

The canonical list is in `scripts/protected-zone-guard.mjs`. In summary:

- Monaco editor zone (EditorMonaco.jsx, monacoSetup.js, editorHeaders.js, editorLanguage.js, pythonLocalIntelligence.js, EditorSessionContext.jsx)
- Litria hover card (hover logic in EditorMonaco.jsx)
- Canvas interaction (PuzzlePiece.jsx, ConnectionLine.jsx, LassoBox.jsx, EdgeGlow.jsx)
- Minimap (Minimap.jsx)
- Drawer system (DrawerShell.jsx, DrawerContext.jsx, all DrawerContent*.jsx, TopDrawerShell.jsx, TopDrawerContext.jsx)
- Pill notifications (PillNotification.jsx)
- Status bar layout (StatusBar.jsx)
- Scaffold tree internals (ScaffoldContextMenu.jsx)
- Launch screen and preferences panel (LaunchScreen.jsx, PreferencesPanel.jsx)

The full rationale is in `docs/adrs/008-protected-zones-shadcn-exclusions.md`. The `protected-zone-guard.mjs` script enforces this automatically.

### Design Tokens

All UI must conform to `docs/ui-governance.md` — Litria design tokens, glass-morphic surfaces, LED glow spec, border radius conventions, and WCAG AA contrast ratios.

---

## The Five Pillars

Every PR is evaluated against five governance pillars. Your PR template will walk you through each one, but here is the short version:

1. **Safe** — No new attack surface, validated inputs, no leaked data
2. **Sane** — Fits the architecture, doesn't duplicate existing work, has a reason to exist
3. **Performant** — No unmeasured overhead; if it costs resources, the trade-off is justified
4. **Reliable** — Works on Windows, macOS, and Linux; no platform-specific assumptions
5. **Easy to Use** — Serves the person at the keyboard; intuitive, low friction, learner-friendly

---

## PR Process

1. **Check for an existing Issue first.** Features and New Domains should have a prior Issue or Discussion thread before you start coding. Fixes and small Refactors can skip this if the scope is self-evident.

2. **Create a feature branch.** Name it descriptively: `fix/hover-card-dismiss`, `feat/zoom-slider`, `domain/clipboard`.

3. **Write your code.** Follow the architecture rules and styling policy above.

4. **Run the validation trio locally:**
   ```bash
   npm run check:architecture
   npm run test:domains
   npm run build
   ```

5. **Open a PR against `main`.** Fill out the PR template completely. Incomplete templates will be sent back before code review begins.

6. **Respond to review feedback.** We review for pillar compliance first, then code quality.

---

## Adding a New Domain

New domains change the architecture permanently. The bar is higher:

1. Open an Issue or Discussion first explaining why the domain is needed
2. Get alignment before writing code
3. Evaluate placement against `docs/Orchestration.md`
4. Follow the domain contract (factory + commands + selectors)
5. Add the domain to the Domain Master List in `docs/Orchestration.md`
6. Add a test file in `test/domains/`
7. Ensure all 6 architecture guards pass

---

## Governance References

| Document | Purpose |
|----------|---------|
| `docs/Orchestration.md` | Domain model, dependency rules, execution plan |
| `docs/ui-governance.md` | Design tokens, styling contract, visual standards |
| `docs/adrs/` | Architecture Decision Records (25) |
| `docs/rfcs/` | Requests for Comment (proposed designs) |
| `docs/CAPABILITIES.md` | Capabilities & features inventory |

---

## License

Litria is released under the [MIT License](License.md).

By submitting a Pull Request, you agree that:

- You have the legal right to submit the contribution;
- Your contribution is provided under the same MIT License that covers the project (inbound = outbound);
- You remain the author of your contribution — this is a license, not a copyright transfer.

---

## Developer Certificate of Origin (DCO)

All commits must include a `Signed-off-by` line certifying that you have the right to submit this work under the MIT License.

Add it automatically with:

```bash
git commit -s -m "your commit message"
```

This produces a line like:

```
Signed-off-by: Jane Doe <jane@example.com>
```

By signing off, you are making the following certification (see [developercertificate.org](https://developercertificate.org)):

> I wrote this code, or I have the right to submit it. I understand it will be included in Litria and licensed under the MIT License.

PRs without signed commits will be sent back before review begins. This is not bureaucracy — it protects you as much as it protects the project.

---

## Code of Conduct

Be respectful, be constructive, be specific. We are building something for learners and professionals alike. Treat every contributor the way you would want to be treated on your first open source PR.
