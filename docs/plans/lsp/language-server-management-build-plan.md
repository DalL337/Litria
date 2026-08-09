# Language Server Management — Build Plan

## Status
- **Delivered (2026-07-13→17)** — slices 3–7 shipped via the ADR-005 build (PRs #135–#141, #142 settings surface, #143 probe hardening). As ADR-005's acceptance foresaw, two slice shapes were superseded in flight: the nested registry schema of slices 3–5 by the **flat schema** (`registry-schema-draft.md`, normative per ADR-005), and slice 5's install **modal** by the **consent pill** (ADR-005 2026-07-10 addendum, no-modal rule). Slice details below are historical record.
- Proposed (2026-03-25)
- Slices 1-2 implemented (2026-04-03) — see `bundled-runtime-build-plan.md`

## Context

Litria has a working generic LSP client (slices 1A-1D) with bundled core servers. Python (pyright), TypeScript Language Server, and Node.js 24 LTS ship inside the installer — users do not need to install anything for Python/JS/TS language intelligence. The 3-tier resolver (global → managed → bundled) and first-run Node.js extraction are implemented.

This plan covers the **extensibility layer** beyond the bundled core: managed directory for additional servers, registry, download infrastructure, install UI, and settings panel.

**References**: PRD (`docs/prds/language-server-management-prd.md`), RFC (`docs/rfcs/language-server-management.md`), ADR-004, ADR-005, `bundled-runtime-build-plan.md`.

---

## Size Budget

| Component | Size |
|-----------|------|
| Current frontend dist | ~13 MB |
| Rust binary (release) | ~8-12 MB est. |
| pyright (bundled) | ~19 MB |
| typescript-language-server + typescript | ~26.6 MB |
| Node.js LTS (per-platform) | ~40 MB |
| **Estimated installer** | **~103 MB** |

Target ≤120 MB is flexible. Updated 2026-04-03 to include Node.js bundling per ADR-004. See `bundled-runtime-build-plan.md` for the full bundled runtime plan including Node.js.

> **Note**: Slices 1-2 of this plan are implemented by Slices A-C of the bundled runtime plan.

---

## Key Design Constraint — RESOLVED

> `LanguagePack.command` was `&'static str` and could not hold runtime-resolved paths.
>
> **Resolved (2026-04-03)**: `ResolvedCommand` struct with `executable: PathBuf`, `prefix_args: Vec<String>`, and `tier: ResolutionTier` is implemented in `lsp/resolver.rs`. `spawn_server()` accepts a `ResolvedCommand` and switches behaviour based on the tier. The `LanguagePack` struct retains `command: &'static str` for PATH probing — resolution happens in `resolve_server()` between prerequisite detection and spawn.

---

## Slice 1: Server Resolution Layer (Rust) — DONE

> Implemented 2026-04-03 as Slice A of `bundled-runtime-build-plan.md`.
> Files: `lsp/resolver.rs`, `lsp/packs/mod.rs` (ResolvedCommand, ResolutionTier), `lsp/transport.rs`, `lsp/session.rs`.

**Goal**: Introduce 3-tier resolution (global → managed → bundled) without changing current behavior. No servers bundled yet — just the resolution plumbing.

**Why first**: Every subsequent slice depends on the resolution layer. Building it empty lets us test the fallback chain before adding real servers.

### Tasks

**1a. `ResolvedCommand` type + resolver function**
- Add `ResolvedCommand` enum to `packs/mod.rs`
- Add `resolve_server(language_id, app_handle) -> Option<ResolvedCommand>`:
  1. Probe global PATH (existing `probe_prerequisite` on `pack.command`)
  2. Check managed dir (`~/.litria/servers/{language_id}/`)
  3. Check bundled resources via `app_handle.path().resource_dir()`
  4. Return first found, or None
- Add `ResolutionTier` enum: `Global`, `Managed`, `Bundled`

**1b. Update `spawn_server()` to accept `ResolvedCommand`**
- Change signature: `spawn_server(pack, resolved_cmd, project_root, ...)`
- `Global` → `Command::new(pack.command)` (unchanged behavior)
- `Managed` / `Bundled` → `Command::new("node").arg(resolved_path).args(pack.args)`
  - Both pyright and tsserver are Node.js scripts, not native binaries
- Update `start_session()` to call `resolve_server()` before `spawn_server()`

**1c. Update `detect_prerequisites` to report resolution tier**
- Add `resolution_tier: Option<String>` to `LspPrerequisitesPayload`
- Frontend can show "Using: global install" / "bundled" / "managed" in status

**1d. Managed directory scaffolding**
- Add `ensure_servers_dir()` → creates `~/.litria/servers/` if missing
- Add `get_managed_server_path(language_id)` → checks for `{dir}/{language_id}/node_modules/.bin/` entry point
- No actual content yet — just the directory structure and lookup

### Tests
- Resolution returns `None` when no tier has the server (clean machine scenario)
- Resolution returns `Global` when command is on PATH
- Managed path returns `None` when directory is empty
- `spawn_server` still works identically for global commands (regression)

### Acceptance
- `cargo test` passes
- Existing Python + TS sessions work exactly as before (no user-visible change)
- `detect_prerequisites` response includes `resolution_tier: "global"`

---

## Slice 2: Bundle Core Servers — DONE

> Implemented 2026-04-03 as Slices B+C of `bundled-runtime-build-plan.md`.
> Files: `scripts/bundle-servers.mjs`, `scripts/bundle-node.mjs`, `bundled_runtime.rs`, `tauri.conf.json`, `lib.rs` (startup extraction).
> Includes Node.js 24 LTS bundling (not in original plan — added via ADR-004 update).

**Goal**: Ship pyright + typescript-language-server + typescript in the Tauri resources directory. Zero-config language intelligence on first launch.

### Tasks

**2a. Package the servers**
- Create build script `scripts/bundle-servers.js`:
  - `npm pack pyright@{PYRIGHT_VERSION}` → extract to `src-tauri/resources/servers/python/`
  - `npm pack typescript-language-server@{TSSERVER_VERSION}` → extract to `src-tauri/resources/servers/typescript/`
  - `npm pack typescript@{TYPESCRIPT_VERSION}` → extract to `src-tauri/resources/servers/typescript/`
  - Wire up `node_modules/.bin/` symlinks / entry points so `node <path>/langserver.index.js --stdio` works
- Add `scripts/bundle-servers.js` to `beforeBuildCommand` chain (or make it a separate prep step)
- `.gitignore` the `src-tauri/resources/servers/` directory (don't commit 45 MB of npm packages)

**2b. Tauri resource configuration**
- Add to `tauri.conf.json`:
  ```json
  "bundle": {
    "resources": {
      "src-tauri/resources/servers/**/*": "servers/"
    }
  }
  ```
- Verify `app_handle.path().resource_dir()` resolves to the correct runtime path

**2c. Bundled resolution**
- Implement `get_bundled_server_path(language_id, app_handle)` in resolution layer
- For python: resolve to `{resource_dir}/servers/python/node_modules/pyright/langserver.index.js`
- For typescript: resolve to `{resource_dir}/servers/typescript/node_modules/typescript-language-server/lib/cli.mjs`
- Wire into `resolve_server()` as tier 3

**2d. Update prerequisite flow**
- When bundled server is found, the `pyright-langserver` / `typescript-language-server` prerequisite should pass even if not on global PATH
- Still require Node.js ≥18 on PATH (needed to run the bundled JS)
- Still require Python ≥3.8 for pyright (user's project dependency, not ours)
- `tsc` prerequisite can be relaxed when bundled TypeScript is available

### Tests
- Bundled path resolves correctly from resource dir
- Prerequisite detection passes with bundled server (no global install)
- Session starts with bundled server path
- Global install still takes precedence over bundled
- Build output includes `servers/` in the bundle

### Acceptance
- Fresh machine with Node.js but no `npm install -g pyright` → Python intelligence works
- `detect_prerequisites` shows `resolution_tier: "bundled"`
- Installer size < 70 MB (flexible target)

---

## Slice 3: Registry Manifest + Platform Resolution

**Goal**: Ship a curated `language-server-registry.json` defining available additional servers (Go, Rust, C/C++).

### Tasks

**3a. Registry schema and initial data**
- Create `src-tauri/resources/language-server-registry.json`
- Schema:
  ```json
  {
    "version": 1,
    "servers": {
      "go": {
        "recommended": "gopls",
        "options": {
          "gopls": {
            "displayName": "gopls (Google)",
            "provider": "golang.org",
            "stability": "stable",
            "artifacts": {
              "windows-x64": { "url": "...", "sha256": "...", "size": 0 },
              "darwin-arm64": { "url": "...", "sha256": "...", "size": 0 },
              "linux-x64": { "url": "...", "sha256": "...", "size": 0 }
            }
          }
        }
      }
    }
  }
  ```
- Initial entries: Go (gopls), Rust (rust-analyzer), C/C++ (clangd)
- Research and populate real artifact URLs + SHA256 hashes for latest stable releases

**3b. Registry module (Rust)**
- Create `src-tauri/src/lsp/registry.rs`
- `load_registry(app_handle)` → parse from resources at startup
- `get_language_options(language_id)` → return available servers for a language
- `get_recommended(language_id)` → return recommended server ID
- `match_extension_to_language(ext)` → map `.go` → `"go"`, `.rs` → `"rust"`, etc.
- Add Tauri command: `lsp_get_registry`

**3c. Platform resolution**
- `get_platform_key()` → `windows-x64` | `darwin-x64` | `darwin-arm64` | `linux-x64` | `linux-arm64`
- Registry lookup filters artifacts by current platform
- Missing platform artifact → clear error message, not crash

**3d. New pack stubs for registry languages**
- Add `packs/go.rs`, `packs/rust_analyzer.rs`, `packs/clangd.rs` with pack definitions
- These packs are gated: `get_pack()` only returns them if the server is installed in managed dir
- Prerequisites: the server binary itself (in managed dir), plus language runtime if applicable

### Tests
- Registry loads and parses correctly
- Unknown language returns empty options
- Extension matching resolves correctly (`.go` → go, `.rs` → rust)
- Malformed registry → graceful error
- Platform key detection correct on current OS

### Acceptance
- `lsp_get_registry` returns registry data to frontend
- Opening a `.go` file can query what servers are available (even if none installed yet)

---

## Slice 4: Download Infrastructure (Rust)

**Goal**: HTTP download with progress, SHA256 verification, archive extraction.

### Tasks

**4a. New dependencies**
- Add to `Cargo.toml`:
  - `ureq = "3"` — lightweight synchronous HTTP client (~200-400 KB binary impact)
  - `sha2 = "0.10"` — SHA256 verification
  - `zip = "2.0"` — ZIP extraction (Windows artifacts)
  - `flate2 = "1.0"` + `tar = "0.4"` — tar.gz extraction (Unix artifacts)
- Run `cargo check` to verify dependency tree, note binary size impact
- Note: ureq is synchronous — downloads run on a dedicated thread (same pattern as LSP read loop)

**4b. Download module**
- Create `src-tauri/src/lsp/download.rs`
- `download_server(url, dest_path, expected_sha256, app_handle)`:
  - Stream response body to temp file
  - Emit `lsp:download-progress` Tauri events (throttled ≤10/sec)
  - Return downloaded file path
- `verify_checksum(file_path, expected_sha256)` → `Result<bool>`
- `extract_archive(archive_path, dest_dir)` → `Result<PathBuf>` (extracted binary path)
  - Detect format from extension (.zip vs .tar.gz)

**4c. Install pipeline**
- `install_server(language_id, server_id, custom_url, app_handle)`:
  1. Look up registry entry (or use custom_url)
  2. `ensure_servers_dir()`
  3. Download to temp file
  4. Verify checksum (skip for custom URLs, emit warning)
  5. Extract to `~/.litria/servers/{language_id}/`
  6. Write `installed.json` metadata
  7. Clean up temp file
  8. Emit `lsp:download-complete` event
- Handle cancellation via `AtomicBool` flag checked during download loop (same pattern as LSP `is_stopping`)
- Add Tauri command: `lsp_install_server { language_id, server_id, custom_url? }`

**4d. Error handling**
- Network failure → typed error with retry hint
- Checksum mismatch → reject, clean up, notify
- Disk full → typed error with required vs available space
- Extraction failure → rollback, retain previous version if present

**4e. Metadata model**
- `InstalledServerMeta` struct: server_id, version, source (Registry/Custom), sha256, installed_at, binary_path
- `installed.json` per language in managed dir

### Tests
- Checksum verification passes for known hash
- Checksum verification fails for tampered file
- Temp file cleaned up on failure
- Progress events emit correct payload shape
- Install pipeline writes metadata correctly

### Acceptance
- Can download and install a server from a URL via Tauri command
- Metadata written to `~/.litria/servers/{lang}/installed.json`
- Downloaded server resolves as `Managed` tier in resolution chain

---

## Slice 5: Install UI (Frontend)

**Goal**: Three entry points for installing a language server — all lead to the same install modal. The user should never have to think about how to get language support.

### Entry Points (all trigger the same install modal)

1. **Reactive — file open trigger**: User opens a `.go` file, Litria detects no server, shows install modal automatically. Lowest friction for the "I just opened a file" case.

2. **Proactive — settings panel**: User goes to Settings → Language Servers, sees available languages listed alongside installed ones, clicks Install. For the "I know I want C++ before I start" case.

3. **New Project flow**: User creates a new C++ project. If the C++ server isn't installed, Litria prompts install as part of project creation. Seamless — user picks a language, installs support, and starts coding in one flow.

### Tasks

**5a. Install modal component (shared)**
- Create `src/components/LanguageServerInstallModal.jsx`
- Uses shadcn Dialog (already available in `src/components/ui/dialog.jsx`)
- Accepts `languageId` prop — works the same regardless of which entry point opened it
- Shows: server name, what it provides (diagnostics, completions, hover), download size
- "Install" button → `lsp_install_server` Tauri command
- "Cancel" button → dismiss
- Progress bar with percentage + phase label during download
- On complete: close modal, auto-start LSP session
- On failure: show error with retry button, copyable diagnostics

**5b. Reactive trigger — file open detection**
- Create `src/lsp/useLanguageDetection.js`
- On file open: check extension against registry (via `lsp_get_registry`)
- If no server resolved (any tier) AND registry has options → open install modal
- If no server resolved AND no registry entry → show "unsupported language" toast
- Suppress modal if user dismissed for this language (per-session memory)

**5c. Proactive trigger — settings panel**
- In the Language Servers settings section (Slice 7), list both installed AND available servers
- Available (not installed) servers show an "Install" button
- Clicking Install opens the same install modal

**5d. New Project trigger**
- When scaffold creates a project for a registry language (Go, Rust, C/C++):
  - Check if server is installed
  - If not: open install modal before or immediately after project creation
  - If yes: proceed normally, LSP activates automatically
- This integrates with existing scaffold/project creation flow

**5e. Custom URL flow**
- Accessible from install modal via "Advanced: Use custom server" link
- Validate URL format (https://) or local path (must exist)
- URLs: show integrity warning before install
- Local paths: copy/symlink to managed dir, skip download
- Explicit confirmation required for custom installs

### Tests
- Modal renders correctly from all three entry points
- Progress bar updates from mock events
- Custom URL validation catches invalid inputs
- New Project flow triggers install when server missing

### Acceptance
- Opening a `.cpp` file (no server) → install modal → Install → diagnostics flow. Two clicks.
- Settings → Language Servers → C/C++ "Install" → same modal → done. Two clicks.
- New Project → C++ → prompted to install → install → project ready with intelligence. Three clicks.
- All three paths feel like the same experience

---

## Slice 6: Session Integration

**Goal**: Wire managed/installed servers into the LSP session lifecycle for automatic activation.

### Tasks

**6a. Auto-start managed servers**
- Update `usePythonLspLifecycle.js` and `useTsLspLifecycle.js` to work with any resolution tier
- Create generic `useLspLifecycle.js` hook:
  - On project open: for each language with a resolved server (any tier), start session
  - On install complete: start session for newly installed language
  - On uninstall: stop session for that language

**6b. Dynamic pack activation**
- Update `get_pack()` to check managed dir for installed registry servers
- If gopls installed in managed dir → return Go pack
- Pack `command` field uses `ResolvedCommand::Managed` path

**6c. Diagnostics flow**
- Managed servers participate in existing `lsp:diagnostics` event flow (no changes needed — transport is generic)
- Provider registration (hover, completion, etc.) needs per-language provider files or a generic adapter

### Tests
- Install server → session auto-starts → diagnostics flow
- Uninstall server → session stops → no diagnostics for that language
- Managed server crash → error surfaced via existing `lsp:error` event

### Acceptance
- Installing Go server → immediately get diagnostics in `.go` files
- Uninstalling → diagnostics stop, no orphan processes

---

## Slice 7: Settings Panel + Version Management

**Goal**: Users can view installed servers, check updates, manage disk usage.

### Tasks

**7a. Settings panel section**
- Add "Language Servers" section to settings UI
- Two groups:
  - **Installed**: name, version, source badge (global/managed/bundled), install date, size
  - **Available**: name, description, "Install" button → opens install modal (from Slice 5)
- "Uninstall" button per managed server (disabled for bundled)
- Total managed directory disk usage

**7b. Update detection**
- Compare installed version against registry manifest version
- "Update Available" badge if newer version in registry
- Update action: download new → verify → swap atomically → update metadata
- Retain previous version until new version verified

**7c. Uninstall flow**
- Stop active session
- Remove binary + metadata from managed dir
- Refresh UI
- Confirmation dialog before uninstall
- Bundled servers cannot be uninstalled

### Tests
- Settings panel renders installed server list
- Update detection identifies version differences
- Uninstall removes files and updates resolution
- Bundled servers show "Bundled" badge, uninstall disabled

### Acceptance
- Settings shows all servers with accurate metadata
- Can update a managed server without downtime
- Can uninstall a managed server cleanly

---

## Delivery Order

```
Slice 1: Resolution Layer (Rust plumbing, no user-visible change)
  ↓
Slice 2: Bundle Core Servers (zero-config first launch)
  ↓
Slice 3: Registry + Platform Resolution  ← can partially parallel with Slice 2
  ↓
Slice 4: Download Infrastructure (ureq, SHA256, extraction)
  ↓
Slice 5: Install Modal UI
  ↓
Slice 6: Session Integration (auto-start managed servers)
  ↓
Slice 7: Settings Panel + Version Management
```

Slices 1-2 deliver the highest immediate value (zero-config for Python + TS). Slices 3-7 build the extensibility layer.

---

## Decisions (locked 2026-03-25)

### D1: Core servers ship pre-installed in release builds
Pyright and typescript-language-server + typescript are pre-packaged into the Tauri resources directory. They ship with every release — no first-run download. Dev builds use global PATH installs (current behavior). A CI gate ensures release builds always include the servers.

### D2: ~~Node.js is a stated system requirement for beta~~ — SUPERSEDED
~~Both bundled servers are pure JS and need Node.js to run. This is acceptable — Litria's target user is a developer who already has Node.js. The prerequisite check surfaces a clear error with install guidance if missing. Revisit bundling Node.js for 1.0 stable only if user feedback shows friction.~~

**Superseded by**: `bundled-runtime-build-plan.md` (2026-04-03). ADR-004 was updated (2026-04-01) to include Node.js LTS bundling. Node.js is now bundled alongside pyright and tsserver. See Slices A-D of the bundled runtime plan for implementation details.

### D3: Build TypeScript bundling now, design for swappability
Microsoft's TypeScript 7 (Go rewrite) will eventually ship a native LSP binary that replaces typescript-language-server. Timeline is uncertain (late 2026–2027). We build bundling now because beta users need TS intelligence today. The `ResolvedCommand` abstraction in Slice 1 makes swapping trivial — a native binary becomes a `Managed` or `Bundled` resolution with no Node.js dependency.

### D4: Registry ships with Litria for beta, remote fetch is future
The `language-server-registry.json` is baked into the installer. To add new servers or update versions, release a new Litria version. Remote fetch (Litria checks a hosted JSON file for updates) is a future enhancement — when needed, it's just a ~5 KB JSON file hosted on GitHub Pages or raw repo URL. The file points to official distributors (GitHub Releases, go.dev, etc.) for actual binary downloads — Litria never hosts server binaries.

### D5: Use ureq (lightweight HTTP) for beta
`ureq` is synchronous, ~10 dependencies, ~200-400 KB binary impact. Sufficient for downloading one file at a time. `reqwest` (~50 dependencies, ~1-2 MB) is overkill for beta needs. Upgrade to reqwest only if async/parallel downloads become a requirement.

---

## Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Installer size exceeds 70 MB target | Both servers are pure JS, compress well (~9.4 MB compressed). Target is flexible. Monitor per-slice. |
| ureq insufficient for download needs | ureq handles single-file downloads with progress. Swap to reqwest if parallel downloads needed later. |
| Node.js not installed | Prerequisite check catches this early with actionable error. Documented in system requirements. |
| Registry staleness between Litria releases | Acceptable for beta — frequent releases expected. Remote fetch is a designed future enhancement. |
| TypeScript 7 makes TS bundling obsolete | ResolvedCommand abstraction makes swap trivial. Infrastructure (managed dir, registry, UI) still applies. |
| Custom URL security | Explicit user confirmation, integrity warning, no auto-execution of unverified binaries. |
| Platform gaps (e.g., no arm64 artifact) | Registry declares availability per platform. Modal shows clear "not available" message. |
