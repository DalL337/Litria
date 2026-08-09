# Release Notes

## v1.0.0 — First public release

**Date:** 2026-08-09 (PRs #111–#247)

The first build of Litria published outside the workshop. Litria is a desktop
IDE that lays your project out as a canvas of connected pieces: files are nodes,
folders are groups you can see and move, and imports are wires drawn from the
code itself.

Two long arcs land together here and define how the canvas now behaves —
**wire routing** that treats the space between nodes as real, and **group
physicality** that makes folders exist on the canvas instead of implying them.

> **Platforms.** Windows x64 (NSIS + MSI), macOS Apple Silicon and Intel (DMG),
> and Linux x86_64 (AppImage, deb, rpm).
>
> Every artifact is **unsigned** — SmartScreen and Gatekeeper will both object.
> On macOS, strip the download quarantine with
> `xattr -dr com.apple.quarantine /Applications/litria.app`.
>
> The Windows build is the one that has been used in anger. **macOS and Linux
> compile cleanly and pass the full suite in CI, but no human has launched them
> yet** — this release is the first time those artifacts have existed. Treat
> them as working-but-unproven.

---

### What changed

**Wires that respect the space between things (ADR-025)**
- Wires route **orthogonally around obstacles** instead of passing under nodes. Routing is a single canvas-wide pass, so wires can be spaced against each other rather than each solving its own path in isolation.
- **Continuous seams**: a wire never under-passes an adjacent node — it follows the corridor between them. Where several wires share a corridor they separate into lanes.
- Terminals distribute along a shared face so wires converging on one node no longer stack on a single point.
- Wires crossing a group border enter perpendicular to it, aimed at their node. Wires between two members of the same group route freely inside it.
- Wires re-anchor to a collapsed group's pill instead of vanishing, and quiet wires hop over loud ones at crossings.
- Routes are stable by construction: an unrelated change never re-flaps a settled wire.

**Folders and groups are physically real**
- **Empty folders exist on the canvas.** Creating a group creates a real directory on disk; deleting one deletes it (with confirmation). No ghost groups that exist only in the app's head.
- Group creation is **name-first**: a preview box appears, you name it, and parentage is decided by where the box sits.
- Collapsing a group hides its entire subtree, and dragging one carries every descendant with it.
- Projects opened from an earlier version have their ghost groups **rectified on open** — folders are created to back them, with a one-line notice.
- Group status LEDs aggregate honestly from every descendant, including collapsed ones.

**Editor**
- **Split editor panes** with per-tab assignment and node → pane drag.
- Monaco JSON schema service: `package.json` and `tsconfig.json` validate offline, comments and trailing commas allowed where the format permits.

**Project setup & language servers**
- **Python project creation** (ADR-020): venv/uv engines, dependency install, and a seeded canvas.
- **Language-server download manager** (ADR-005): consent-gated installs with progress, cancellation, integrity checks, and uninstall.
- Bundled servers refreshed — pyright 1.1.411, typescript-language-server 5.3.0, TypeScript 5.9.3.
- Scaffold runs are **age-gated** against supply-chain risk (ADR-021), with the package npm actually resolves checked rather than the shorthand you typed.

**Preferences, appearance & shell**
- **Preferences system** (ADR-019): a real settings surface with global and per-project scopes, backed by a central registry that a build guard enforces.
- Theme, accent, and material pickers with live glass parameters.
- **Splash screen** (ADR-024) and a launcher that remembers recent projects.
- **Build trace logs** (#212): capture a build's output to a viewable, exportable log — the first feature driven directly by canary feedback.

**Reliability & safety**
- All filesystem writes flow through one **write manager** with journaled undo and a cross-volume fallback.
- Reserved Windows filenames are refused at validation rather than at the syscall.
- Content-Security-Policy hardened (ADR-023); the security audit's findings are closed.
- Terminal drawer can hide instead of ending your shell session.

**Engineering**
- **Five build guards** now enforce architecture, app-shell boundaries, protected UI zones, domain contracts, and settings-key discipline. They are the enforcement of record — see `docs/Orchestration.md`.
- 1037 JavaScript domain tests and 232 Rust tests.
- Twenty-five ADRs documenting the decisions behind the above, all in-repo.

---

### What you may need to do

**Nothing.** Existing project databases migrate in place (v1→v3, idempotent).

If you have used a pre-release build, the first open of each project **creates
real folders** for any groups that previously existed only on the canvas, and
tells you it did. Groups that already matched a folder are untouched.

---

## v1.0.0-8 — Crash capture, terminal overhaul & onboarding paths

**Date:** 2026-07-06/07, stamped 2026-07-09 (current development build; PRs #101–#110)

Resilience and onboarding: a **five-layer crash-capture system**, a **terminal
overhaul** that makes interactive CLIs work end-to-end on Windows, two new
zero-friction project creation paths, and the entire deferred-polish list
cleared.

---

### What changed

**Crash capture & resilience (new)**
- Five capture layers: React boundary + root options, window error handlers, hardened Rust panic hook, WebView2 renderer-death watch (with crash-loop brake), and a clean-shutdown marker with phase checkpoints.
- Unclean exits surface as an **inline banner on relaunch** with content-free breadcrumbs and an assisted (prefilled GitHub issue) report path. Local-only; sourcemaps extracted at build time, never shipped.

**Terminal**
- Seven root-caused fixes for "terminal hangs on interactive prompts": sideloaded Microsoft **ConPTY** host (Win10 conhost prompt-frame bug), buffered event stream, instant cursor-handshake answer, vendored `portable-pty` with xterm-compatible flags, byte-based flow control, per-read output flush, and renderer reset per session. `npm create vite` now runs fully in-app.

**Launcher & onboarding**
- New **Blank Project** card (🌱 instant — no npm, no prerequisites; quote-stamped README, seeded canvas first frame).
- New **File** untitled session — first save materializes a workspace with LSP spin-up.
- Scaffold failures offer **"Create as Blank instead"** — every wizard path now ends in an open workspace.

**Canvas**
- **"Create Folder from Group"**: promote a manual group to a real folder on disk — files move in, membership becomes folder-derived, the dotted outline solidifies.

**Fixes & polish (deferred list cleared)**
- File menu project actions fixed (root-caused via the crash system's first real-world capture).
- Monaco's built-in TS diagnostics silenced permanently — no more stale-marker flash; LSP owns TS/JS diagnostics.
- Scaffold hide/show now also hides the group frame on canvas.
- Windows: auto-hide taskbar stays reachable while Litria is focused (startup frame-calc nudge).

---

### What you may need to do

**Nothing.** Existing project DBs migrate in place (v1→v3, idempotent). If the
sideloaded ConPTY files are missing, the terminal falls back to the in-box
console host.

---

## v1.0.0-7 — Split panes & the Quick-Action HUD

**Date:** 2026-07-02/03 (milestone marker — no installer cut; PRs #94–#100)

### What changed

**Editor**
- **Split editor panes** (ADR-017 Phase A): View → Split Editor (`Ctrl+\`), per-tab pane assignment, panes collapse when emptied, and **node → pane drag** — drop a canvas node onto a pane to open its file there.

**Canvas**
- **Quick-Action HUD** (ADR-018, all phases): draggable glass HUD with Create (New Node with spawn ghost + box-first New Group), an interlocking **pan/zoom dial** (hold-to-glide wedges, zoom arc, Fit / true-1:1 hub, live % readout), and a gestures-first **Help** widget. `H` toggles it; a ☰ menu controls widget visibility; state persists.
- **Manual groups**: empty, folder-less groups created straight on canvas (inline naming; dotted outline distinguishes them from folder groups). Workspace schema migrated v2→v3 (group seed bounds).
- Fixed a latent spawn bug: nodes created at viewport center no longer teleport to origin on reload.

---

## v1.0.0-6 — Connection wires, MIT relicense & workspace polish

**Date:** 2026-06-14 → 2026-07-01 (milestone marker — no installer cut; PRs #66–#93)

### What changed

**License**
- Relicensed from OPL v1.2 to **MIT** (2026-07-01).

**Connections & import discovery**
- **Import discovery draws wires on load** — existing imports appear as canvas connections, anchored to facing edges and deduplicated per project switch.
- **Bezier connection wires** with a directional chevron and modeless wire actions (click a wire → delete / add symbol).
- Hand-picked anchor sides persist across reopen (first workspace schema migration, v1→v2).
- Syntax import writing rebuilt as compute-final-text-then-write — edits to closed files are no longer dropped; symbol picker always shows (no silent auto-resolve); app-wide toast feedback.

**Canvas & workspace**
- Expanded group boxes are selectable/draggable with a named header tab; drag moves the whole group (never nests); Shift+drag marquee still wins.
- Context-aware **Node / Group submenus** on the action pill, with working **Save / Save All** (group-scoped) and canvas label editing.
- **Live/Calm** now pastelizes node edge colors as a render lens (stored colors stay vivid); the wizard gained a Live/Calm preview toggle.

**Theming**
- **Material system at the node level**: Glass and Matte draw strategies with four built-in presets — Glass, Obsidian, Parchment, Terminal — carrying full selection/hover chrome. Wizard seeds the chosen preset per project.

**Application shell**
- **Menubar buildout**: File / Edit / View / Actions / Settings with platform-aware accelerators; Ctrl+A select-all.
- Launcher recents backed by app-level SQLite; folder pickers remember the last-used project directory.
- Folder-group membership is now folder-derived (reconciler GCs stale rows); dead commands and scaffolding removed.

---

## v1.0.0-5 — SQLite persistence & edit-mode interactions

**Date:** 2026-06-14 (current development build)

The headline is a storage rewrite — project data moved from a JSON manifest to
**SQLite** — alongside a new edit-mode interaction model, a Workspace Style step
in the New Project wizard, and a hardened terminal lifecycle. Dozens of canvas,
LSP, and health-LED fixes round it out.

---

### What changed

**Persistence — now SQLite (ADR-015 / ADR-016)**
- Project data (pieces, groups, connections, hidden paths, viewport, editor/session state) is now stored in **SQLite**, replacing the per-project `litria.project.json` manifest. Writes are transactional instead of debounced full-file rewrites.
- Enables **open-any-folder** bootstrapping — a project DB is created on first open without a pre-existing manifest.
- The legacy JSON project manifest and its auto-migration are **retired**.

**Edit mode & interaction model (ADR-013)**
- New **edit-mode toggle** with **additive / subtractive** sub-modes. Structural changes — merging a piece into a group or extracting it — now happen **only in edit mode**; default-mode dragging is always a pure spatial move (no accidental group membership).
- Node dragging is restricted to the **left mouse button**.
- Mousewheel **zoom no longer requires Ctrl**, and a pan-stuck state was fixed.

**New Project wizard**
- Wizard options are now driven by a **compatibility matrix** (single source of truth) instead of hardcoded flags.
- New **Workspace Style** page with live preview; chosen node colors persist into the project and render on each node's **left edge** via a shared color cascade.

**Terminal lifecycle**
- The terminal drawer is now a **per-project resource**: sessions end on drawer collapse, teardown is bounded-time with a graceful shell exit before kill, and a **project-switch coordinator** awaits teardown (fixes a project-switch crash).

**Editor & LSP**
- Global **Cmd/Ctrl+S** save shortcut.
- `.tsx`/`.jsx` files now open to the LSP as `typescriptreact`/`javascriptreact`.
- Health-LED polish: pulsing animation removed (calmer), diagnostic-store lifecycle clears wired, and Monaco built-in marker coverage corrected.

**Canvas polish**
- Collapsed groups report stub bounds (no phantom footprint); collapsed folder pills carry their assigned group color.
- Folder-spawn pieces lay out in a grid instead of stacking; the group-actions menu stays within the viewport.
- **Minimap** restored and rebuilt as a glass HUD with stable, relative panning.
- The project name is merged into the **project switcher as the title** (de-duplicated from the banner).

**Under the hood**
- Persistence and platform layers hardened; extensive App.jsx shell extractions (render selectors, drop handlers, theme actions, path/viewport utilities); modifier-key detection consolidated; architecture guards expanded (protected-zone, domain-contract).

---

### What you may need to do

**Nothing.** Existing projects open straight into the SQLite-backed store. There is no manual migration step.
