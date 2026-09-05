# Litria

> A visual desktop IDE where your code lives on a canvas — not just in a file.

![Public Beta](https://img.shields.io/badge/status-public%20beta-green)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue)
![License](https://img.shields.io/badge/license-MIT-lightgrey)

> Litria is developed by a sole dev, with all application code written by Claude. The ideas, patterns, architecture, and scope are the dev's. Contributors are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).

Litria gives your project structure a shape. **Files are nodes. Folders are real
groups on disk. Imports are routed wires drawn from the code itself.**

Structure and relationships are first-class here — the canvas is a living
architecture view, not a side-panel graph generated after the fact. Drag a node
into a folder group and the file moves on disk. And the code inside each node is
exactly what it looks like: ordinary, exportable, editable source.

This isn't a no-code tool or a diagram maker. It's a native desktop IDE built 
for people who think visually and code seriously. Whether you're mapping out a 
new project, teaching someone how programs connect, or just tired of losing the 
big picture inside a file tree.

---

## Download

### **[⬇ Get the latest release](https://github.com/DalL337/Litria/releases/latest)**

| Platform | What to grab |
|---|---|
| **Windows** x64 | `litria_<version>_x64-setup.exe` — recommended. `.msi` also available for managed installs. |
| **macOS** Apple Silicon | `litria_<version>_aarch64.dmg` |
| **macOS** Intel | `litria_<version>_x64.dmg` |
| **Linux** x86_64 | `litria_<version>_amd64.AppImage` (portable, no root), or `.deb` / `.rpm` |

Builds are **unsigned**, so your OS will object the first time:

- **Windows** — SmartScreen warns: *More info → Run anyway*.
- **macOS** — unsigned and un-notarized, so macOS often claims the app is *"damaged"*. It isn't. After dragging Litria to Applications:
  ```bash
  xattr -dr com.apple.quarantine /Applications/litria.app
  ```
  That strips the download-quarantine flag. It does not disable Gatekeeper.
- **Linux (AppImage)** — `chmod +x litria_<version>_amd64.AppImage` then run it.

> **Windows is the build that gets used daily.** **macOS** has been launched and run by
> a tester — briefly, on one machine, which is enough to say it works and not enough to
> call it proven. The **Linux** builds compile and pass the full test suite in CI but
> have not yet been launched by a human. Both should work — please tell us when they don't.

Prefer to build it yourself? Jump to [Getting into it](#getting-into-it).

---

## What's working in this beta

- Infinite canvas where every node is a real file on disk
- Folder groups that mirror your real project structure — nesting, collapse,
  and drag all operate on the whole subtree, and every group is a real
  folder on disk
- Routed wires drawn from your real imports — obstacle avoidance, corridor
  lanes, and legible separation. Wires are first-class citizens, not decoration
- Monaco editor with full LSP language intelligence: Python and
  TypeScript/JavaScript bundled and working on first launch;
  rust-analyzer and clangd installable from the managed
  server directory; Go via your own toolchain. A server already on your `PATH`
  always takes precedence over the bundled one
- Progressive disclosure for large projects: hide nodes you aren't working on,
  and the imports they carried surface as a count badge on the importing node —
  click it to bring a file back and rewire it instantly
- Canvas layout is project state: node positions, scale, and viewport persist
  with the project rather than resetting between sessions
- Split editor panes, multi-tab workflows, crash-safe unsaved-work recovery
- Visual groups, connections, and undo/redo
- Embedded terminal (with hide-don't-kill) and project scaffolding wizard
- Preferences system with global + per-project layers
- Crash logging with local records and assisted reporting
- Native desktop app: macOS, Windows, Linux
- Glass theme with material presets and customizable accent colors

---

## How to help

This is a real beta. Things will break. Here's what matters most right now:

1. **Use it:** open a real project. See how far you get.
2. **File issues:** bugs, rough edges, confusing moments. All of it helps.
3. **Share it:** if it resonates, point someone else at it.
4. **Contribute:** read [CONTRIBUTING.md](CONTRIBUTING.md). The architecture 
   is documented and guarded.

Roadmap feedback is welcome in
[Discussions](https://github.com/DalL337/Litria/discussions). We want to know
what you'd build with this.

---

## Getting into it

Here's everything you need to build, run, and understand the codebase.

## Tech Stack

- React 19
- Vite
- Tauri v2 (Rust backend shell)
- Monaco Editor (`@monaco-editor/react`)
- Konva / React Konva (infinite canvas)
- Tailwind CSS v4 (utility layer, no preflight)
- shadcn/ui (Radix primitives: Dialog, AlertDialog, DropdownMenu, Popover)

## Prerequisites

### Build / Run

| Tool | Version | Install |
|------|---------|---------|
| Node.js | 24.14.0 LTS | [nodejs.org](https://nodejs.org/) or `nvm install 24` |
| npm | 11.9.0 (ships with Node) | Included with Node.js |
| Rust | 1.94.1+ | [rustup.rs](https://rustup.rs/) |
| Tauri v2 system deps | Per OS | [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |

> **Version note:** These are the exact versions Litria is developed and tested against. Older versions may work but are not guaranteed. When in doubt, match these.

### Language Intelligence (LSP features)

Litria bundles Node.js, Pyright, and TypeScript Language Server inside the installer. Language intelligence for Python and JS/TS works on first launch with no additional setup.

**Python (`.py`)** — powered by Pyright. Requires Python 3.8+ on `PATH` for full type inference (Pyright needs to see your Python environment for import resolution).

**TypeScript / JavaScript** — powered by typescript-language-server. No prerequisites.

**Power users:** If you have your own global `pyright`, `typescript-language-server`, or `node` installed, Litria will use those instead of the bundled versions. Global installs always take precedence.

## Getting Started

```bash
npm install
npm run dev
```

To run as a Tauri desktop app during development:

```bash
npm run tauri dev
```

## Build

Web build:

```bash
npm run build
```

Release build (bundles Node.js + language servers into installer):

```bash
npm run bundle         # stage bundled runtimes (idempotent)
npx tauri build        # compile + package installer
```

## Available Scripts

- `npm run dev`: Start Vite development server.
- `npm run build`: Build frontend assets into `dist/`.
- `npm run preview`: Preview the built frontend locally.
- `npm run bundle`: Download Node.js + install pinned language servers + stage the ConPTY pair into `src-tauri/resources/` for release builds.
- `npm run bundle:servers`: Bundle language servers only (pyright + tsserver).
- `npm run bundle:node`: Download platform-specific Node.js binary only.
- `npm run bundle:conpty`: Stage the sideloaded Microsoft ConPTY pair (terminal support on Windows 10).
- `npm run bundle:check`: Verify the staged bundle.
- `npm run build:release`: Bundle runtimes + build frontend (shorthand for CI).
- `npm run check:architecture`: Run all 6 architecture guards (import boundaries, app shell, protected zones, domain contracts, settings keys, editor engine).
- `npm run test:domains`: Run domain-level unit tests.
- `npm run check`: Run architecture guards + build (CI shorthand).
- `npm run tauri`: Run Tauri CLI commands.
- `npm run tauri:clean`: Clean Rust build artifacts in `src-tauri/`.

## Project Structure

- `src/`: Frontend application code.
  - `src/app/`: Domain logic (pure JS, no React/Monaco imports).
  - `src/components/`: React components.
  - `src/components/ui/`: shadcn/ui primitives (owned source).
  - `src/editor/`: Monaco editor integration, language intelligence.
  - `src/preferences/`: Settings registry + preferences domain (ADR-019).
  - `src/crash/`: Crash capture, local logs, assisted reporting.
  - `src/styles/`: CSS (BEM conventions + Tailwind utilities).
  - `src/lib/`: Shared helpers (`cn()` utility).
- `src-tauri/`: Tauri/Rust application shell and config.
- `public/`: Static assets copied by Vite.
- `test/`: Domain-level unit tests.
- `scripts/`: Architecture guards and tooling.
- `docs/`: Development documentation (not bundled into builds).
  - `docs/prds/`: Product requirements documents.
  - `docs/plans/`: Implementation plans and build checklists (idea captures live in `docs/plans/ideas/`).
  - `docs/adrs/`: Architecture decision records.
  - `docs/rfcs/`: Design proposals.

## Notes

- `docs/` is development documentation and is not bundled into app build output by default.
- Future/experimental directions are intentionally not documented here.

## Keyboard Shortcuts

All `Ctrl` shortcuts map to `Cmd` on macOS.

### Canvas / Global

| Shortcut | Action |
|----------|--------|
| `Ctrl+Z` | Undo |
| `Ctrl+Shift+Z` / `Ctrl+Y` | Redo |
| `Ctrl+0` | Fit all nodes to view |
| `Ctrl+Shift+0` | Fit selection (or all) to view |
| `Ctrl+P` | Open / close node search |
| `Ctrl+A` | Select all nodes |
| `Ctrl+\` | Toggle split editor panes |
| `E` | Toggle edit mode (additive / subtractive) |
| `H` | Hide / show the canvas HUD |
| `Ctrl+Click` node | Toggle node in selection |
| `Shift+Click` node | Extend / modify selection |
| `Shift+Drag` on empty canvas | Lasso select nodes |

### Editor

| Shortcut | Action |
|----------|--------|
| `Ctrl+S` | Save focused tab (when dirty) |
| `Ctrl+Shift+S` | Save all dirty tabs |
| `Ctrl+Space` | Trigger autocomplete |
| `P` | Pin / unpin hover card (while card is visible) |
| `Escape` | Dismiss hover card |

### Editor Tabs

| Shortcut | Action |
|----------|--------|
| `Enter` / `Space` | Activate focused tab |

### Scaffold Tree

| Shortcut | Action |
|----------|--------|
| `↑` / `↓` | Navigate items (wraps at edges) |
| `→` | Expand folder or move to first child |
| `←` | Collapse folder or move to parent |
| `Enter` | Open file or toggle folder |
| `Escape` | Cancel active drag operation |

### Inline Rename / New File Input

| Shortcut | Action |
|----------|--------|
| `Enter` | Confirm name |
| `Escape` | Cancel input |

### Menus & Drawers

| Shortcut | Context | Action |
|----------|---------|--------|
| `Escape` | Context menu | Dismiss menu |
| `Escape` | Symbol picker | Dismiss picker |
| `Escape` | Top drawer | Close active drawer |

## Contributing

We welcome contributions. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR. It covers the tech stack, architecture rules, styling policy, and our five governance pillars.

## License

[MIT License](License.md)
