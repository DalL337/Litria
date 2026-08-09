# ADR-004: Bundled Core Language Servers and Node.js Runtime

## Status
- Accepted — Implemented (2026-06-13)
- Proposed (original 2026-03-06; updated 2026-04-01 to expand scope to include Node.js runtime)

## Date
- 2026-03-06 (original)
- 2026-04-01 (Node.js addition)
- 2026-06-13 (marked implemented after verification — see Implementation Status)

## Context
Litria currently requires users to install language servers globally (Pyright for Python, TypeScript Language Server for JS/TS). Litria detects these at runtime via `detect_prerequisites` / `probe_prerequisite` and connects to them when present.

This works well for a thin client model but creates a first-run friction barrier: users must know which LSPs to install, install them manually, and ensure they are on PATH before Litria can provide language intelligence.

Additionally, the New Project Template Picker (PRD-NP-001) introduces a scaffold runner that executes CLI tools (`create-tauri-app`, `create-vite`, `npm install`) which require Node.js and npm. Without a bundled Node runtime, the scaffold feature fails silently on machines without Node installed — particularly when the app is launched from the OS shell (Start menu, Dock) where developer PATH entries may not be inherited.

The combined size of all bundled dependencies is approximately 110 MB:
- Pyright: ~28 MB
- TypeScript Language Server + compiler: ~23 MB
- Node.js LTS + npm: ~40 MB
- Litria binary + webview: ~12 MB

This is well under competitive benchmarks (VS Code ~150 MB, JetBrains IDEs ~500+ MB, Discord ~300 MB) and consistent with Litria's resource efficiency goals. Litria's differentiator is runtime performance (80-150MB RAM, 1-5% idle CPU, 2s boot), not install size.

## Decision
Bundle Pyright, the TypeScript Language Server, and Node.js LTS as embedded resources in the Litria installer.

Specifically:
- Ship all bundled dependencies inside Tauri's `resources/` directory.
- Update `detect_prerequisites` to check for globally installed versions first.
- Fall back to bundled versions in `resources/` when no global install is found.
- Globally installed versions always take precedence (power user override).
- Node.js is pinned to the active LTS line (24.x) — must match the version Litria is developed and tested against.
- npm ships with Node and does not require separate bundling.

## Consequences
Positive:
- Zero-configuration language intelligence on first launch for Python and JS/TS.
- Zero-configuration scaffold execution — New Project "just works" without requiring users to install Node.
- No external dependency or internet requirement for core language support or project scaffolding.
- Total installer size remains under 120 MB, well under competitive benchmarks.
- Power users retain full control by installing their preferred global versions.
- Bundled Node serves dual purpose: runs LSP servers (Pyright, tsserver are npm packages) and powers the scaffold runner.

Costs:
- Installer size increases from ~12 MB to ~110 MB.
- Litria assumes update responsibility for bundled Node.js LTS + server versions across releases.
- Version pinning requires coordination with Litria release cycles.
- Node.js LTS updates every 12 months — Litria must track and test each LTS promotion.

## Alternatives Considered
- Two installers (Lite vs Complete):
  - Rejected due to doubled release maintenance and user confusion.

- First-run download (ship thin, download on launch):
  - Rejected because it requires internet on first run and adds download/retry/update infrastructure for core functionality.

- Keep current model (global install required):
  - Rejected because first-run friction contradicts Litria's "just works" goal.

## Bundled Version Manifest

All pinned versions are tracked in `src-tauri/src/lsp/packs/versions.rs`.

| Dependency | Pinned Version | Purpose |
|---|---|---|
| Pyright | 1.1.411 | Python language server |
| TypeScript Language Server | 5.3.0 | JS/TS language server |
| TypeScript Compiler | 5.9.3 | Required by tsserver |
| Node.js | 24.14.0 (LTS) | Runtime for LSP servers + scaffold runner |
| npm | (ships with Node) | Package management for scaffold CLI tools |

> **Pin refresh (2026-07-22):** Pyright 1.1.390 → 1.1.411,
> typescript-language-server 4.3.3 → 5.3.0, TypeScript 5.4.5 → 5.9.3.
> TypeScript stays on the 5.x line deliberately — adopting the 7.x
> native-port major is a separate integration decision, not a pin refresh.
> Verified Windows-side: re-staged via `npm run bundle:servers`, all three
> staged entry points run and report the new versions under the bundled
> Node runtime. macOS/Linux parity pass rides the existing platform hold.

## Scope Notes
- This ADR covers Python (Pyright), JS/TS (TypeScript Language Server), and Node.js runtime.
- Additional language servers are managed separately through the Language Support Manager (see RFC).
- Bundled server versions are tracked in `src-tauri/src/lsp/packs/versions.rs`.
- This ADR aligns with the Language Support Manager PRD `docs/plans/language-support-manager-prd.md`.
- Node.js bundling also supports PRD-NP-001 (New Project Template Picker) and ADR-012 (scaffold command builder).

## Implementation Status (verified 2026-06-13)

The decision is fully implemented in code:

- **Bundling**: `scripts/bundle-servers.mjs` stages Pyright + typescript-language-server + the TypeScript compiler into `src-tauri/resources/servers/`; `scripts/bundle-node.mjs` stages the Node.js runtime into `src-tauri/resources/node/`. Both read pins from `src-tauri/src/lsp/packs/versions.rs` (single source of truth).
- **Packaging**: `src-tauri/tauri.conf.json` bundles both resource trees (`resources: ["resources/servers", "resources/node"]`). `npm run build:release` runs `npm run bundle` before `tauri build` so the resources are staged for the installer.
- **Resolution**: `src-tauri/src/lsp/resolver.rs` implements the 3-tier fallback (global PATH → managed → bundled), wired into the spawn path in `lsp/session.rs` and into prerequisite detection (`lsp_detect_prerequisites`). Global installs take precedence; `resolve_node` enforces a global Node ≥18 version gate before falling through to the bundled runtime.
- **Graceful failure**: when no tier resolves a server, spawn returns a structured `CommandError::not_found` ("No '<lang>' server found (checked PATH, managed, bundled)") rather than crashing, and the prerequisite layer surfaces it to the UI.

Known follow-ups (not blocking this ADR's acceptance):

- **Managed tier is a stub** (`probe_managed` returns `None`) — wired in later by the Language Support Manager build plan. *Resolved 2026-07-17: `probe_managed` went live with the ADR-005 download-manager slices (PR #137; full arc #135–#143).*
- **Bundled version pins predate current releases** (Pyright `1.1.390`, typescript-language-server `4.3.3`, TypeScript `5.4.5`). A pre-beta refresh of these pins — with the `versions.rs` re-stage + manual parity pass — is recommended but deferred. *Resolved 2026-07-22 Windows-side: pins refreshed to 1.1.411 / 5.3.0 / 5.9.3 (see the dated note under the Bundled Version Manifest); macOS/Linux parity rides the platform hold.*
