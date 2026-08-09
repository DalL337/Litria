# Language Server Management PRD

## Status
- Partially superseded (2026-07-07): ADR-005 (Accepted, revised) + the 7-slice build plan (`docs/plans/lsp/language-server-management-build-plan.md`) are authoritative for slice structure (7, not this PRD's 8 — platform resolution folds into the registry slice), the download stack (ureq, not reqwest), the registry schema (flat draft, normative), and the managed directory (`app_data_dir()/servers/`). The ≤70 MB installer criteria are stale — ADR-004 set ≤120 MB after bundling Node. Requirements-level content (lifecycle contracts, typed errors, UX states) remains valid. Evidence trail: `docs/plans/lsp/download-manager-adr-prep.md`.
- Proposed (original 2026-03-06)

## Date
- 2026-03-06

## Purpose
Define the implementation plan for bundling core language servers with Litria and building a managed download/install/update system for additional language servers. This PRD supersedes the provisional design in `language-support-manager-prd.md` with concrete implementation slices.

## Related Documents
- ADR-004: `docs/adrs/004-bundled-core-language-servers.md`
- ADR-005: `docs/adrs/005-managed-language-server-directory.md`
- RFC: `docs/rfcs/language-server-management.md`
- Existing PRD (provisional): `docs/plans/language-support-manager-prd.md`
- LSP Client Architecture: `docs/plans/lsp-client-architecture.md`
- Orchestration: `docs/Orchestration.md`

## Design Decisions Summary
- Core servers (Pyright + TypeScript) are bundled — no user choice, no modal.
- Additional servers are recommended with alternatives — Litria is opinionated on stability/performance/security, not taste.
- Custom URL/path input available for any language — covers the long tail.
- Resolution precedence: global PATH > managed directory > bundled.
- Per-user managed directory (`~/.litria/servers/`), no elevation required.
- `reqwest` streaming HTTP for downloads, SHA256 verification, Tauri event progress.

## Domain Ownership
- `LanguageSupportDomain`: install state machine, registry queries, availability selectors.
- Infrastructure adapters: download, verification, extraction, filesystem.
- Presentation layer: install modal, progress UI, settings panel.
- LSP packs (`src-tauri/src/lsp/packs/`): binary resolution, session lifecycle.

## Architecture Guard Impact
- New `src/lsp/` frontend files (lspClient wrappers, event subscriptions) are under existing `src/lsp/` path.
- `LanguageSupportDomain` remains at `src/app/languageSupportDomain.js` per Orchestration.md.
- No new domain-to-UI imports. Modal components live in presentation layer.
- Architecture guard `DOMAIN_PREFIXES` may need `src/lsp/` added if frontend LSP files grow.

---

## Slice 1: Bundle Core Servers

**Goal**: Litria ships with Pyright + TypeScript Language Server embedded. Zero-config language intelligence on first launch.

### Rust Backend
- [ ] Add Pyright npm package to `src-tauri/resources/servers/python/`
- [ ] Add TypeScript Language Server to `src-tauri/resources/servers/typescript/`
- [ ] Configure `tauri.conf.json` `resources` field to include `servers/` directory
- [ ] Update `probe_prerequisite` to check bundled path as final fallback
- [ ] Update `detect_prerequisites` to report source tier (global vs bundled) in response
- [ ] Add `get_bundled_server_path()` helper to resolve `resources/servers/<lang>/` at runtime
- [ ] Verify bundled servers launch correctly via existing `spawn_server()` transport

### Integration Tests
- [ ] Test: global server found -> global used, bundled ignored
- [ ] Test: no global server -> bundled server resolved and launched
- [ ] Test: bundled server missing -> graceful error (not panic)

### Build Validation
- [ ] Verify production build includes `resources/servers/` in MSI/installer
- [ ] Verify installer size remains under 120 MB (was 70 MB; corrected 2026-07-22 per ADR-004's Node-bundling budget — ADR-005 follow-up)
- [ ] Run test trio (`check:architecture`, `test:domains`, `build`)

---

## Slice 2: Managed Server Directory

**Goal**: Establish `~/.litria/servers/` directory structure and resolution integration.

### Rust Backend
- [ ] Create `src-tauri/src/lsp/server_manager.rs` module
- [ ] Implement `ensure_servers_dir()` — create `~/.litria/servers/` if missing
- [ ] Implement `get_managed_server_path(language_id)` — resolve from managed dir
- [ ] Implement `read_installed_metadata(language_id)` — parse `installed.json`
- [ ] Implement `write_installed_metadata(language_id, metadata)` — write `installed.json`
- [ ] Implement `remove_managed_server(language_id)` — delete binary + metadata
- [ ] Update `probe_prerequisite` chain: global -> managed -> bundled
- [ ] Add Tauri commands: `lsp_list_installed`, `lsp_uninstall_server`

### Data Model
- [ ] Define `InstalledServerMeta` struct (serverId, version, source, sha256, installedAt, binaryPath, customUrl)
- [ ] Define `ServerSource` enum: `Registry`, `Custom`
- [ ] Define `ResolutionTier` enum: `Global`, `Managed`, `Bundled`

### Tests
- [ ] Test: managed server found -> managed used, bundled fallback skipped
- [ ] Test: managed server removed -> resolution falls through correctly
- [ ] Test: `installed.json` corrupt -> treated as not installed, no crash
- [ ] Run test trio

---

## Slice 3: Registry Manifest

**Goal**: Ship a curated `language-server-registry.json` with Litria that defines available servers per language.

### Registry File
- [ ] Create `src-tauri/resources/language-server-registry.json`
- [ ] Define schema: version, servers map, per-server options with artifacts
- [ ] Populate initial entries: Go (gopls), Rust (rust-analyzer), C/C++ (clangd)
- [ ] Include per-option metadata: displayName, provider, stability, performance, size
- [ ] Include per-platform artifact entries: url, sha256, size, extractPath

### Rust Backend
- [ ] Create `src-tauri/src/lsp/registry.rs` module
- [ ] Implement `load_registry()` — parse manifest from resources at startup
- [ ] Implement `get_language_options(language_id)` — return server options for a language
- [ ] Implement `get_recommended(language_id)` — return recommended server ID
- [ ] Implement `match_file_to_language(file_extension)` — map extension to registry entry
- [ ] Add Tauri command: `lsp_get_registry`

### Tests
- [ ] Test: registry loads and parses correctly
- [ ] Test: unknown language returns empty options
- [ ] Test: file extension matching resolves correct language
- [ ] Test: malformed registry file -> graceful error, not crash
- [ ] Run test trio

---

## Slice 4: Download Infrastructure

**Goal**: Rust-side HTTP download with streaming progress, checksum verification, and archive extraction.

### Dependencies
- [ ] Add `reqwest` with `stream` feature to `Cargo.toml`
- [ ] Add `sha2` crate for SHA256 verification
- [ ] Add `zip` or `flate2` + `tar` crates for archive extraction (evaluate which covers artifact formats)

### Rust Backend
- [ ] Create `src-tauri/src/lsp/download.rs` module
- [ ] Implement `download_server(url, dest_path, expected_sha256, app_handle)`:
  - Stream response body to temp file
  - Emit `lsp:download-progress` events (throttled to max 10/sec)
  - Return downloaded file path
- [ ] Implement `verify_checksum(file_path, expected_sha256)` -> Result<bool>
- [ ] Implement `extract_archive(archive_path, dest_dir)` -> Result<extracted binary path>
- [ ] Implement full install pipeline: download -> verify -> extract -> write metadata -> cleanup temp
- [ ] Handle cancellation: listen for cancel signal, abort reqwest request, clean up temp file
- [ ] Add Tauri command: `lsp_install_server { language_id, server_id, custom_url? }`

### Event Definitions
- [ ] Define `DownloadProgress` payload: languageId, serverId, bytesReceived, totalBytes, phase
- [ ] Define `DownloadComplete` payload: languageId, serverId, binaryPath, version
- [ ] Define `DownloadFailed` payload: languageId, serverId, errorCategory, message, retryHint

### Error Handling
- [ ] Network failure -> typed error with retry hint
- [ ] Checksum mismatch -> reject, notify user, clean up
- [ ] Disk full -> typed error with required vs available space
- [ ] Extraction failure -> rollback, retain previous version if present
- [ ] Custom URL: skip checksum verification, emit warning event

### Tests
- [ ] Test: checksum verification passes for known hash
- [ ] Test: checksum verification fails for tampered file
- [ ] Test: temp file cleaned up on download failure
- [ ] Test: progress events emitted with correct payload shape
- [ ] Run test trio

---

## Slice 5: Install Modal UI

**Goal**: Contextual modal triggered when user opens a file for an unsupported language.

### Detection Trigger
- [ ] Add `useLanguageDetection` hook — on file open, check extension against registry
- [ ] If no server resolved (any tier) and registry has options, show modal
- [ ] If no server resolved and no registry entry, show "unsupported language" toast (no modal)
- [ ] Suppress modal if user previously dismissed for this language (per-session memory)

### Modal Component
- [ ] Create `src/components/LanguageServerInstallModal.jsx`
- [ ] Render recommended server (pre-selected) with stability/performance scores and size
- [ ] Render alternative servers as radio options with same metadata
- [ ] Render "Custom" option with URL/path text input
- [ ] "Install" button triggers `lsp_install_server` Tauri command
- [ ] "Skip" button dismisses modal and suppresses for session

### Progress State
- [ ] Subscribe to `lsp:download-progress` events during install
- [ ] Show progress bar with percentage, bytes downloaded / total, phase label
- [ ] "Cancel" button triggers download cancellation
- [ ] On `lsp:download-complete`: close modal, auto-start LSP session if file still open
- [ ] On `lsp:download-failed`: show error with message, retry button, copyable diagnostics

### Custom URL Flow
- [ ] Validate URL format (must be https://) or local path (must exist)
- [ ] For URLs: show "Litria cannot verify this binary's integrity" warning before install
- [ ] For local paths: skip download, copy/symlink to managed dir, write metadata as `Custom` source
- [ ] User must explicitly confirm custom install (not just click Install)

### Tests
- [ ] Component renders correctly with registry data
- [ ] Radio selection switches between options
- [ ] Custom URL validation catches invalid inputs
- [ ] Progress bar updates from mock events
- [ ] Run test trio

---

## Slice 6: Session Integration

**Goal**: Wire installed managed servers into the LSP session lifecycle so they activate automatically.

### Rust Backend
- [ ] Update all language packs to include managed-dir resolution in prerequisites
- [ ] Add new language packs for registry languages (Go, Rust, C/C++) gated on managed install
- [ ] Ensure `lsp_start_session` works with managed server paths
- [ ] Ensure `lsp_stop_session` + `lsp_teardown_all` handle managed servers identically

### Frontend
- [ ] Update `lspClient.js` to trigger session start after successful install
- [ ] Add `useManagedLspLifecycle` hook — on project open, start sessions for all resolved servers
- [ ] Ensure managed servers participate in existing `lsp:diagnostics` event flow

### Tests
- [ ] Test: install server -> session auto-starts -> diagnostics flow
- [ ] Test: uninstall server -> session stops -> no diagnostics for that language
- [ ] Test: managed server crash -> error surfaced via existing `lsp:error` event
- [ ] Run test trio

---

## Slice 7: Version Management and Settings

**Goal**: Users can view installed servers, check for updates, and manage disk usage.

### Settings Panel
- [ ] Add "Language Servers" section to settings UI
- [ ] List installed servers: name, version, source (registry/custom), size, install date
- [ ] Show resolution tier badge: "Global", "Managed", "Bundled"
- [ ] "Uninstall" button per managed server (disabled for bundled)
- [ ] "Check for Updates" button per managed server
- [ ] Show total managed directory disk usage

### Update Flow
- [ ] Compare installed version against registry manifest version
- [ ] If update available: show "Update Available" badge with new version + changelog URL
- [ ] Update action: download new version -> verify -> swap binary atomically -> update metadata
- [ ] Retain previous version until new version verified (no broken intermediate state)

### Cleanup
- [ ] "Uninstall" stops active session, removes binary + metadata, refreshes UI
- [ ] Prevent uninstall of bundled core servers (Pyright, TypeScript)
- [ ] Show confirmation dialog before uninstall

### Tests
- [ ] Settings panel renders installed server list correctly
- [ ] Update detection identifies version differences
- [ ] Uninstall removes files and updates resolution
- [ ] Bundled servers cannot be uninstalled
- [ ] Run test trio

---

## Slice 8: Platform Artifact Resolution

**Goal**: Handle OS + architecture differences for compiled language servers.

### Rust Backend
- [ ] Implement `get_platform_key()` -> `windows-x64` | `darwin-x64` | `darwin-arm64` | `linux-x64` | `linux-arm64`
- [ ] Registry lookup uses platform key to select correct artifact entry
- [ ] If no artifact for current platform: surface "Not available for your platform" in modal
- [ ] Handle executable permissions on Unix (chmod +x after extraction)

### Registry
- [ ] Ensure all registry entries have platform-specific artifact URLs
- [ ] Document artifact packaging requirements (zip for Windows, tar.gz for Unix)

### Tests
- [ ] Test: correct platform key detected on current OS
- [ ] Test: missing platform artifact returns clear error, not crash
- [ ] Run test trio

---

## Delivery Order

Slices are ordered by dependency:

```text
Slice 1 (bundle core)
  |
  v
Slice 2 (managed directory)
  |
  v
Slice 3 (registry manifest)  +  Slice 8 (platform resolution)
  |                              |
  +--------- combined ----------+
  |
  v
Slice 4 (download infrastructure)
  |
  v
Slice 5 (install modal UI)
  |
  v
Slice 6 (session integration)
  |
  v
Slice 7 (version management + settings)
```

Slices 3 and 8 can be developed in parallel. All other slices are sequential.

## Acceptance Criteria (End-to-End)
- Litria installs and provides Python + JS/TS intelligence with zero user setup.
- Opening a `.go` file triggers contextual install modal with scored server options.
- Selecting a server downloads, verifies, extracts, and activates language intelligence.
- Custom URL/path input works with security warning for unverified binaries.
- Global installs always take precedence over managed/bundled servers.
- Uninstalling a managed server cleans up disk and stops active sessions.
- Settings panel shows all servers with version, source, and disk usage.
- All operations are cancellable, rollback-safe, and surface actionable errors.

## Risk Mitigations
- **Installer size growth**: monitored per slice, target < 120 MB with bundled core (was 70 MB; corrected 2026-07-22 per ADR-004).
- **reqwest dependency size**: evaluated at Slice 4, alternative HTTP clients considered if too heavy.
- **Platform coverage gaps**: registry entries flagged as incomplete during Slice 8, modal shows availability clearly.
- **Custom URL trust**: explicit user confirmation required, warning UI non-dismissable.
- **Registry staleness**: versioned with Litria releases initially, remote fetch evaluated as future enhancement.
