# Litria — Capabilities & Features

> **Version**: 1.0.1 | **Date**: 2026-08-30 | **Status**: Public Beta (MIT)

## How to read this document

**Capabilities are parents; features are their children.** A capability is
something Litria's internals can *do* — an engine, an invariant, a pipeline.
A feature is a user-facing expression derived from that capability. Every
feature listed here traces to the capability above it; if a proposed feature
has no parent capability, that's the signal a new capability must be built
(or the feature rethought).

Each section states the capability, lists the features derived from it, and
points at the documents of record. Implementation detail lives in the ADRs
and `docs/Orchestration.md`, not here — this inventory records *what Litria
can do*, not *how the code does it*. (This document once drifted into
describing code that didn't exist; pointers over restatement is the fix.)

---

## 1. Spatial Workspace Engine

**Capability:** an infinite Konva canvas that renders code files as physical
glass-tile pieces with stable spatial identity — position, scale, and
viewport survive across sessions.

**Features**
- Infinite pan/zoom canvas (0.25×–1.5×; wheel zooms at pointer, trackpad pans)
- Glass-tile nodes with material-dispatched rendering (glass blur + rim
  refraction, or matte), left-edge organizational color cascade, selection
  and frosted-while-editing states
- Node search + home position (`Ctrl+P`), fit-to-view (`Ctrl+0` /
  `Ctrl+Shift+0`), minimap with stable relative panning
- Quick-Action HUD (registry-driven, draggable): New Node / New Group, pan
  wedges with hold-to-glide, zoom dial with Fit and true-1:1, curated
  shortcut help; `H` hides it, state persists
- Viewport, positions, and layout persist per project (SQLite)

*Built on:* ADR-014 (glass material), ADR-018 (HUD), `docs/ui-governance.md`.

---

## 2. Structural Mirror (folder ⇔ group invariant)

**Capability:** the canvas and the filesystem are one structure. Every
folder on disk has a group on canvas — empty folders included — and every
group is a real folder. No structural operation is a "ghost": creating,
nesting, merging, or deleting a group is a disk operation, and disk changes
reconcile back into canvas state. Duplicate or folder-less group records
self-heal on project open.

**Features**
- Folder groups materialize automatically for every folder (a tree-fed
  reconciler runs at open and on scaffold changes)
- **Nesting is real**: parent/child derives from folder containment;
  collapse folds the whole subtree into the parent's pill (child collapse
  states preserved for restore); drag carries the whole subtree; nested
  header tabs keep legible headroom
- **Name-first, disk-first group creation**: the + Group pill drops a
  preview box with an inline name input — nothing exists until the name
  commits, at which point the folder is created (parented by where the box
  sits: inside an open group nests, open canvas goes to root)
- Empty groups are first-class: seed-positioned, draggable (moves commit
  and survive reopen), countable, deletable
- Group deletion is a confirmed disk operation (folder and contents)
- Merge via the group menu (explicit, target-picked); nest/un-nest via
  edit-mode drags; both filesystem-first through the write manager
- Self-healing on open: legacy folder-less groups get folders minted and
  files moved in (one informational pill reports it); duplicate same-folder
  records collapse to one
- Collapsed pills show subtree file counts; scaffold hide/eye also hides
  the group frame on canvas

*Built on:* PRD-FSM-001 (write manager), `docs/plans/ideas/brief-group-physicality.md`,
`docs/plans/ideas/brief-nested-group-containment.md`, ADR-013 addendum.

---

## 3. Filesystem Write Pipeline

**Capability:** a single journaled mutation pipeline (the write manager)
owns every structural disk write — moves, renames, folder creates/deletes —
and keeps pieces, tabs, connections, syntax registrations, SQLite rows, and
the scaffold tree in sync with each one. Refusals happen before state
changes (reserved names, locked files, cross-device moves with rollback).

**Features**
- Drag a node between groups → the file moves on disk
- Rename nodes/groups → files and folders rename, with reserved-name
  refusals surfaced before anything changes
- Batch delete with tab closure, connection cleanup, and LSP unregistration
- Cross-device (EXDEV) moves fall back to copy+delete with rollback
- Undoable filesystem operations (journaled deletes)

*Built on:* PRD-FSM-001, implementation-policy "state follows disk".

---

## 4. Code-Relationship Intelligence (syntax domain)

**Capability:** an editor-agnostic engine that parses JS/TS imports and
exports, indexes symbols and definitions per file, discovers existing
import relationships across the project, and writes real import/export
code — computing whole-file text from authoritative state and writing to
the open Monaco model or to disk.

**Features**
- **Import discovery**: on open, existing imports become wires on the
  canvas automatically (re-derived each load; imports stay authoritative)
- Draw a wire between two files → symbol picker (grouped, multi-select,
  single symbol pre-selected) → real import statements written
- Wire deletion and symbol add via a floating per-wire action menu
- Rename-safe: import edits locate their targets at apply time (stale
  line guesses fail closed instead of corrupting files)
- Off-canvas import badges: pieces show counts for imports whose files
  aren't on canvas yet; placing from the badge wires them immediately
- Wires to collapsed groups re-anchor to the pill; drops on a pill resolve
  via preference (member picker or expand-and-aim)

*Built on:* ADR-001/002/003, `docs/rfcs/syntax-domain-architecture.md`,
brief-cross-group-wires, brief-python-wires.

---

## 5. Wire Routing Engine

**Capability:** a global, deterministic, canvas-wide routing pass — every
wire's path is computed together against a registry of obstacles (pieces,
pills, group boxes), so inter-wire spacing, obstacle avoidance, and border
discipline are possible at all. Same inputs → same routes.

**Features**
- Orthogonal-with-fillets routed wires that avoid pieces and boxes instead
  of cutting through them
- Corridor lanes with legible separation; N-lane seams — wires sharing a
  seam never stack
- **Seam maintenance**: settled arrangements part flush piece pairs so a
  wire is never sealed under adjacency (wires override adjacency — standing
  doctrine); pieces nudge apart at wire birth, one undo per gesture
- Group borders are gated: member wires pass through purposefully,
  stranger wires route around
- Wire aggregation (same endpoints → one wire with a count chip),
  directional chevron, status-colored gauge, loud-wire hop-over at
  crossings, unroutable wires dim gracefully
- During drags: zero routing (cheap direct curves for moving wires, frozen
  settled routes for the rest); final paths compute on drop

*Built on:* ADR-025, `docs/plans/ideas/brief-edge-routing.md`.

---

## 6. Language Intelligence

**Capability:** a Rust-side LSP client (stdio transport, session registry,
crash detection without auto-restart) plus a three-tier server resolution
chain — global install → managed directory → bundled — so language
features work on first launch with nothing installed, and better servers
are adopted when present.

**Features**
- Python and TypeScript/JavaScript intelligence out of the box: hover,
  completions, go-to-definition, signature help, symbols, diagnostics
  (`.tsx`/`.jsx` handled spec-correctly as react variants)
- Bundled runtimes in the installer: Node.js 24.14.0, pyright 1.1.411,
  typescript-language-server 5.3.0, TypeScript 5.9.3
- **Managed server directory** (ADR-005): rust-analyzer and clangd install
  from a registry of pinned downloads with per-event consent pills, checksum
  verification, and install / uninstall / re-verify from the Preferences
  panel; Go is supported via toolchain hint (offer the command, the terminal
  is the consent). A server already on `PATH` always wins over a managed or
  bundled one
- Python local intelligence providers supplement the LSP (hover,
  completions, definitions) for instant single-file responsiveness
- Custom Python hover card: diagnostic stacking, pin (`P`), severity labels
- Server crashes surface as readable pack errors; recovery is user-driven
  (next file event), never a hidden restart loop

*Built on:* ADR-004 (bundled), ADR-005 (managed), `docs/plans/lsp/`.

---

## 7. Health & Diagnostics Channel

**Capability:** a normalized per-file diagnostic store (LSP + Monaco
built-in services) feeding one health model — every surface that reports
code health derives from the same source.

**Features**
- Node corner LEDs: dirty (blue), errors (red), warnings (amber), clean
  (green), empty (grey)
- **Group aggregate LEDs**: worst-of-subtree — problems in a nested child
  folder propagate to every ancestor pill (problems outrank activity:
  red > amber > blue > green)
- Wire status coloring and loudness derive from endpoint health + syntax
  edge status
- Scope note: diagnostics exist for files with live editor/LSP sessions;
  never-opened files report by content heuristic only

*Built on:* ADR-014 (LED spec), `src/hooks/` health model.

---

## 8. Editing Engine

**Capability:** embedded Monaco (0.52) with tiered contributions, custom
theme with semantic tokens, per-tab model tracking with save baselines, and
a pane-aware session domain — editor state is project state.

**Features**
- Multi-tab editing with dirty tracking and an unsaved-changes gate on
  project switch/exit
- **Split editor panes** (`Ctrl+\`): node→pane and tab→pane drags,
  shift+double-click to open in the other pane, resizable persisted
  divider, P1/P2 residency chips on nodes
- Save system: `Ctrl+S` / `Ctrl+Shift+S` global capture-phase, canvas-level
  Save / Save All on the action pill, serialized Save-As for untitled
  sessions
- Crash-safe: working copies persist; unsaved work survives restarts
- JSON editing with schema validation (package.json/tsconfig vendored
  schemas, jsonc comment tolerance)
- Tabs/panes/session persist per project and restore tolerantly

*Built on:* ADR-017 (split panes), Monaco ESM setup notes in
`docs/plans/editor/`.

---

## 9. Embedded Terminal

**Capability:** real PTY sessions (vendored portable-pty + sideloaded
Microsoft ConPTY on Windows 10) with byte-based flow control and buffered
event streams — interactive CLIs work end-to-end inside the app.

**Features**
- Full interactive terminal (xterm.js + WebGL): `npm create vite` runs
  prompts → menus → scaffold → dev server entirely in-app
- Win10 interactive-prompt fix shipped in the installer (ConPTY pair
  sideloaded; graceful fallback to in-box conhost)
- Flow control survives floods (`cat huge-file`) without freezing typing
- Process-completion pills (success/failure) even while the drawer is
  hidden
- **Drawer close is preference-steered**: End (default) stops the shell;
  Hide keeps the session alive for instant reopen. Project switch and app
  exit always hard-kill — clean shutdown is not steerable

*Built on:* terminal PTY plan + ADR-019 (`terminalDrawerClose`).

---

## 10. Persistence Engine

**Capability:** two-tier SQLite (per-project `workspace.db` + app-level
registry) with version-gated idempotent migrations, plus human-readable
TOML for preferences — every kind of state has one physical home, and
"is it a preference?" is answered by where it lives.

**Features**
- Instant project open/resume: pieces, groups (with seed geometry),
  connections (with persisted anchor sides), viewport, tabs, hidden paths
- Open-any-folder bootstrapping: returning project → marker rebuild →
  fresh bootstrap, no ceremony
- Recents with pinning; project switcher in the title bar
- Preferences in `preferences/*.litria.toml` (global + per-project layers);
  repo `litria.toml` stays sparse project truth (never preferences)
- Schema v3; migrations run idempotently on open

*Built on:* ADR-015, ADR-016, ADR-019 (stores split).

---

## 11. Preferences & Settings Registry

**Capability:** a declarative registry where every preference is declared
once (scope, propagation, type, always-visible caption, surfaces) and every
settings surface renders registry queries — no surface can sprawl, and a
guard makes hard-coding a settings key a build failure.

**Features**
- Preferences panel on the Launcher (global) and in-app via File menu
  (global + per-project overrides with reset-to-global)
- Live-inherit vs seed-at-creation propagation, stated in the UI
- Current registry: theme, energy (Live/Calm, project-overridable), wire
  drop behavior (project-overridable), default project location, default
  base theme, splash screen, build-trace pause, build-log auto-send,
  terminal drawer close
- Settings drawer refit: Theme / Accent / Material pills with a
  material-declared parameter area
- Managed-server inventory (install/uninstall/re-verify) surfaces in the
  panel

*Built on:* ADR-019, `src/preferences/registry.js` (the registry of
record), `scripts/settings-key-guard.mjs`.

---

## 12. Theming Engine

**Capability:** a versioned flat token system (47 tokens, v3) with material
dispatch — color is orthogonal to material, energy is a render-time lens,
and themes are user-ownable objects with protected built-ins.

**Features**
- Four built-in presets (Glass, Obsidian, Parchment, Terminal), fork-able,
  delete/rename-protected
- Glass and Matte materials; material-specific parameter knobs surface only
  when relevant
- 16 accent swatches; per-piece, per-group, and per-folder color with a
  single resolution cascade (canvas and wizard preview cannot drift)
- Live/Calm energy axis: static intensity lens (softened rim, dimmed LEDs,
  pastelized edges) — stored colors stay vivid
- Per-group theme assignment

*Built on:* ADR-014, `docs/plans/ideas/theme-material-system.md` (future
rework).

---

## 13. Interaction Grammar

**Capability:** a mode/token system where destructive or structural
gestures are explicit — default mode is always a safe spatial move, and
structural intent (merge, extract, nest) requires edit mode.

**Features**
- `E` toggles edit mode; `Ctrl`/`Alt` taps pick additive (drop merges) /
  subtractive (drop extracts / un-nests) — with status-bar pill and +/−
  cursors
- Silent mode-gated nest and un-nest by drag; source group dims during
  subtractive drags
- Lasso select (`Shift+drag`) with stranded-marquee failsafe; multi-select
  via `Ctrl`/`Shift+click`; `Ctrl+A` select all
- One undo per gesture, including seam adjustments the gesture caused
- Innermost-wins hit testing for nested drops; invisible (folded) groups
  are never drop targets

*Built on:* ADR-013 (+ 2026-07-25 addendum), canvas interaction internals.

---

## 14. Project Creation

**Capability:** a matrix-driven scaffolding pipeline (Rust runner with
streamed step events, non-interactive npm execution) plus instant creation
paths, all gated by a supply-chain security posture: dependency lifecycle
scripts stay off, with explicit consent to run them.

**Features**
- 4-page New Project wizard: runtime → framework → language → addons →
  backend, matrix-validated; workspace-style page with live preview through
  the real color/material pipeline
- Framework coverage: Tauri / Vite / Electron wrappers × React, Svelte,
  Vue, Angular, Solid (matrix-pruned combinations); Tailwind/shadcn/router
  addons; Express/Fastify backends
- Python project creation with `uv` (version floor into `litria.toml
  [environment]`, machine-local interpreter binding kept out of team truth)
- **Blank Project**: instant, no prerequisites — substrate files, seeded
  canvas; scaffold failures offer "create as Blank instead"
- **New File**: untitled single-file session; first save materializes a
  workspace — the fast path stays fast
- Security gate (ADR-021): scaffolds install with scripts off; a first-open
  consent pill offers running them, with build traces and optional build
  logs
- Build trace stays on screen by preference (always / warnings / never)

*Built on:* ADR-012 (matrix), ADR-020 (Python), ADR-021 (security gate),
`src/scaffold/compatibility-matrix.js`.

---

## 15. Crash Capture & Resilience

**Capability:** five capture layers spanning JS, Rust, and the WebView host
— a crash anywhere leaves an attributable local record, and unclean exits
are detected on the next launch.

**Features**
- React boundary + root hooks, window handlers, hardened Rust panic hook,
  WebView2 renderer-death watch (with crash-loop brake), phase-checkpointed
  clean-shutdown marker
- Friendly crash screen ("files already saved are safe") with Reload /
  View Logs / Report
- Local-only records at `~/.litria/logs/crashes/`; relaunch banner with
  content-free breadcrumbs
- Assisted reporting: prefilled GitHub issue (URL repoints to the public
  repo at flip time)
- Per-version sourcemap archives extracted at build for symbolicating
  release-binary stacks

*Built on:* `docs/plans/ideas/crash-log-system.md` (B5).

---

## 16. Application Shell & Platform

**Capability:** a composition-only shell (App.jsx) wiring domains under
guard enforcement, with runtime platform configuration so one binary
behaves natively per OS.

**Features**
- Five-menu menubar (File/Edit/View/Actions/Settings) mirroring canvas
  actions, platform-aware accelerators
- Launcher with four creation paths, recents, preferences, crash notices
- Custom window chrome, splash screen (preference-gated, ADR-024),
  project-switcher title
- Security hardening: CSP enabled (ADR-023), Rust-owned file dialogs
  (ADR-022), external file-drop navigation guard
- Clean shutdown: terminals, LSP servers, and dev servers torn down; zero
  background processes after close

*Built on:* ADR-011 (platform config), ADR-022/023, `docs/Orchestration.md`
§shell contract.

---

## Engineering Substrate

The capability layer itself is held together by enforced architecture:

| Metric | Current |
|--------|---------|
| Domain modules | 15 (registry: `docs/Orchestration.md` §2) |
| Architecture guards | **6** — imports, app shell, protected zones, domain contract, settings keys, editor engine |
| JS tests | **1049** across 85 suites (`test/domains/`) |
| Rust tests | **257** |
| ADRs | **25** |
| Tauri commands | ~81 registered (registry of record: `src-tauri/src/lib.rs`) |
| Workspace DB schema | v3 (2 migrations) |
| Theme tokens | 47 (v3) |
| Bundled runtimes | Node 24.14.0, pyright 1.1.411, ts-ls 5.3.0, ts 5.9.3 |

Guards are the enforcement of record; when this document and a guard
disagree, the guard wins and this document gets fixed.
