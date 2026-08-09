# RFC: Language Server Management System

## Status
- Partially superseded (2026-07-07): ADR-005 (Accepted, revised) supersedes this RFC on the registry schema (flat schema in `docs/plans/lsp/registry-schema-draft.md` is normative — the nested `options`/scores schema here is historical), the HTTP client (ureq, not reqwest), and the managed directory (`app_data_dir()/servers/`, not `~/.litria/`). The `installed.json` metadata shape, download event flow, and install-modal UX remain useful reference (modal simplified to one recommended server + custom, per the flat schema). Evidence trail: `docs/plans/lsp/download-manager-adr-prep.md`.
- Proposed (original 2026-03-06)

## Date
- 2026-03-06

## Owner
- Litria (solo)

## Summary
Define the architecture for bundling core language servers (Pyright, TypeScript) with Litria and providing a managed download/install/update flow for additional language servers. The system covers server discovery, registry manifests, download infrastructure, contextual install UX, and integration with the existing LSP session system.

This RFC establishes:
- v1: Bundle core servers, fall back from global to bundled.
- v2: Managed directory + download flow for additional languages.
- v3: Registry updates, version management, and cleanup tooling.

## Problem
Litria currently requires global installation of language servers. This creates:
- First-run friction for new users who lack LSP tooling.
- No discoverability for what language support is available or how to add it.
- No managed lifecycle for server versions, updates, or disk cleanup.
- No path for users to add language support for niche/custom servers.

## Goals
- Zero-config language intelligence for Python and JS/TS on first launch.
- One-click install for curated additional languages.
- Custom URL/path support for any server Litria doesn't list.
- Opinionated recommendations based on stability, performance, and security (not preference).
- Respect user autonomy: global installs always take precedence.
- Security: no execution of unverified binaries without explicit user acknowledgment.

## Non-Goals
- Extension/plugin marketplace (Litria is not VS Code).
- Auto-updating servers without user consent.
- Supporting multiple concurrent versions of the same language server.
- Building a package manager or dependency resolver.

## Architecture

### Three-Tier Server Resolution

```text
Priority 1: Global PATH    (user-managed, always wins)
Priority 2: Managed dir     (~/.litria/servers/<language>/)
Priority 3: Bundled         (resources/, core languages only)
```

Resolution is handled by updating `detect_prerequisites` / `probe_prerequisite` in the existing language pack system to check all three tiers in order.

### Registry Manifest

Litria ships a `language-server-registry.json` in `resources/`. Schema:

```json
{
  "version": "1",
  "servers": {
    "go": {
      "displayName": "Go",
      "filePatterns": ["*.go", "go.mod", "go.sum"],
      "recommended": "gopls",
      "options": {
        "gopls": {
          "displayName": "gopls",
          "provider": "Go Team",
          "stability": 5,
          "performance": 4,
          "artifacts": {
            "windows-x64": {
              "url": "https://...",
              "sha256": "...",
              "size": 48000000,
              "extractPath": "gopls.exe"
            },
            "darwin-x64": { "..." : "..." },
            "darwin-arm64": { "..." : "..." },
            "linux-x64": { "..." : "..." }
          }
        }
      }
    }
  }
}
```

Scoring fields (`stability`, `performance`) are integer 1-5 ratings displayed in the install modal. Litria does not hide the criteria — users see why a server is recommended.

### Download Flow (Rust Side)

```text
1. Resolve platform key (os + arch)
2. Look up artifact URL + expected SHA256 from registry
3. Stream download via reqwest to temp file
4. Emit progress events (lsp:download-progress) to frontend
5. Verify SHA256 of completed download
6. Extract archive to ~/.litria/servers/<language>/
7. Write version metadata (installed.json)
8. Emit completion event (lsp:download-complete)
9. Update language pack resolution to use new binary
```

For custom URLs:
- Steps 1-2 are skipped (user provides URL directly).
- Step 5 warns "Litria cannot verify this binary's integrity" and requires explicit user confirmation.
- Step 7 records source as `custom` for UX distinction.

### Managed Directory Structure

```text
~/.litria/
  servers/
    go/
      gopls.exe           (or gopls on unix)
      installed.json      (version, source, sha256, installDate)
    rust/
      rust-analyzer.exe
      installed.json
```

`installed.json` schema:
```json
{
  "serverId": "gopls",
  "version": "0.16.1",
  "source": "registry" | "custom",
  "sha256": "abc123...",
  "installedAt": "2026-03-06T...",
  "binaryPath": "gopls.exe",
  "customUrl": null | "https://..."
}
```

### Contextual Install Modal (Frontend)

Trigger: user opens a file whose extension matches a registry entry but no server is resolved (global, managed, or bundled).

Modal layout:
```text
+--------------------------------------------------+
|  Set up Go language support                       |
|                                                   |
|  (*) gopls (recommended)           45 MB          |
|      Stability: 5/5  Performance: 4/5             |
|      Provider: Go Team                            |
|                                                   |
|  ( ) go-langserver                  12 MB         |
|      Stability: 3/5  Performance: 4/5             |
|      Provider: Community                          |
|                                                   |
|  ( ) Custom                                       |
|      [ URL or local path                    ]     |
|                                                   |
|  [Install]                          [Skip]        |
+--------------------------------------------------+
```

During download:
```text
+--------------------------------------------------+
|  Installing gopls for Go                          |
|                                                   |
|  [=========>              ] 34%  15.3 / 45 MB     |
|  Downloading...                                   |
|                                                   |
|  [Cancel]                                         |
+--------------------------------------------------+
```

### Integration with Existing LSP System

The language pack system (`src-tauri/src/lsp/packs/`) already defines per-language packs with `Prerequisite` and `detect_prerequisites`. Changes:

1. `Prerequisite` gains a new variant or field for managed-directory path.
2. `probe_prerequisite` checks: global PATH -> managed dir -> bundled resources (core only).
3. `get_pack()` returns the same `LanguagePack` regardless of resolution tier.
4. New Tauri commands: `lsp_install_server`, `lsp_uninstall_server`, `lsp_list_installed`, `lsp_check_updates`.

### Security Model

- Registry artifacts: HTTPS-only URLs, mandatory SHA256 verification.
- Custom URLs: HTTPS required, SHA256 cannot be verified, user sees explicit warning.
- Custom local paths: no verification needed (user's own binary).
- No auto-execution of downloaded binaries until verification passes.
- No privilege escalation required (per-user directory).

## Event Flow

### Install
```text
Frontend                    Rust Backend
   |                            |
   |-- lsp_install_server ----->|
   |                            |-- resolve artifact
   |                            |-- start download
   |<-- lsp:download-progress --|   (repeated)
   |                            |-- verify checksum
   |                            |-- extract + place
   |                            |-- write installed.json
   |<-- lsp:download-complete --|
   |                            |
   |-- lsp_start_session ------>|   (auto-start if file open)
```

### Uninstall
```text
Frontend                    Rust Backend
   |                            |
   |-- lsp_stop_session ------->|   (if active)
   |-- lsp_uninstall_server --->|
   |                            |-- remove binary + metadata
   |<-- lsp:server-removed -----|
```

## Failure Modes and Handling

- Download fails mid-stream: temp file cleaned up, retry available, no partial install.
- Checksum mismatch: download rejected, user notified with copyable error details.
- Platform artifact missing: modal shows "Not available for your platform" for that option.
- Disk full: typed error with current usage and required space.
- Custom URL unreachable: standard HTTP error surfaced with retry.
- Extraction fails: rolled back, previous version retained if present.

## Performance Constraints

- Download progress events throttled to max 10/second to avoid UI flooding.
- Archive extraction runs on a background thread, not the main Tauri thread.
- Registry manifest is read from disk at startup, not fetched remotely on every file open.
- Server resolution is cached per session after first probe.

## Domain Ownership

Per Orchestration.md domain model:
- `LanguageSupportDomain` owns: install state machine, registry queries, installed server metadata, availability selectors.
- Infrastructure adapters own: HTTP download, filesystem operations, checksum verification, archive extraction.
- Presentation layer owns: install modal, progress UI, settings panel.
- LSP session system (`src-tauri/src/lsp/`) owns: binary resolution, session lifecycle, language pack contracts.

## Phase Plan

### Phase 1: Bundle Core Servers
- Embed Pyright + TS server in `resources/`.
- Update `probe_prerequisite` fallback chain.
- No new UI, no download infrastructure.

### Phase 2: Managed Directory + Download Flow
- Implement `~/.litria/servers/` directory management.
- Add `reqwest` streaming download with progress events.
- Add checksum verification and archive extraction.
- Ship initial `language-server-registry.json`.
- New Tauri commands for install/uninstall/list.

### Phase 3: Install Modal UX
- Build contextual install modal (trigger on unsupported file open).
- Three-tier selection (recommended, alternatives, custom).
- Progress and error states.
- Custom URL warning flow.

### Phase 4: Version Management + Settings
- Update detection against registry manifest.
- Settings panel showing installed servers, versions, disk usage.
- Uninstall flow with cleanup.
- "Check for updates" action per server.

## Acceptance Criteria
- Litria launches with full Python + JS/TS intelligence without any global installs.
- Opening a `.go` file triggers install modal with server options.
- Selecting a server downloads, verifies, extracts, and activates it.
- Custom URL/path input works with appropriate security warnings.
- Global installs take precedence over managed/bundled servers.
- Uninstalling a managed server cleans up binary and metadata.
- All download/install operations are cancellable and rollback-safe.

## Open Questions
- Registry update cadence: ship with Litria releases only, or allow fetching updated registry from a URL?
- Maximum managed directory size before warning users?
- Should Litria offer to remove managed servers when uninstalling Litria itself?

## Risks
- Platform artifact availability varies by server project (some may lack ARM64 builds).
- Custom URL trust model relies on user judgment for unverified binaries.
- Registry maintenance burden grows with each curated language.
- Download infrastructure adds `reqwest` as a new Rust dependency.

## Related Documents
- ADR-004: `docs/adrs/004-bundled-core-language-servers.md`
- ADR-005: `docs/adrs/005-managed-language-server-directory.md`
- Language Support Manager PRD: `docs/plans/language-support-manager-prd.md`
- LSP Client Architecture: `docs/plans/lsp-client-architecture.md`
