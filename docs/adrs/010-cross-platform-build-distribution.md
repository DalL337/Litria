# ADR-010: Cross-Platform Build, Distribution & Platform Abstraction

## Status
- Extended (2026-07-28 — cross-device move fallback delivered; see the addendum in the `fs::rename` section)
- Validated (macOS confirmed working 2026-03-23)

## Date
- 2026-03-20 (proposed)
- 2026-03-23 (updated with macOS validation findings)

## Context
Litria is built on Tauri v2, which compiles to native binaries for Windows, macOS, and Linux. Today Litria is developed and tested exclusively on Windows 10. The codebase already contains platform-conditional Rust code (terminal shell selection, filesystem sync, process cleanup, dev server teardown) but there is no documented standard for how platform differences are handled, what distribution targets are supported, or what platform-specific constraints affect feature design.

As Litria approaches distribution readiness and features like group nest/merge introduce filesystem operations that behave differently across operating systems, a formal decision on cross-platform strategy is needed.

### Current platform-specific code inventory

| File | Pattern | Purpose |
|---|---|---|
| `terminal_policy.rs` | `#[cfg(target_os = "windows")]` | Shell allowlist: PowerShell/cmd (Windows) vs sh/bash/zsh (Unix) |
| `terminal_pty.rs` | `#[cfg(target_os = "windows")]` | Win32 job objects for reliable child process cleanup |
| `write_ops.rs` | `#[cfg(unix)]` / `#[cfg(not(unix))]` | `fsync` on parent directory (Unix only, no-op on Windows) |
| `path_guard.rs` | `#[cfg(unix)]` / `#[cfg(windows)]` | Symlink creation in tests (different OS APIs) |
| `lib.rs` | `#[cfg(all(debug_assertions, target_os = "windows"))]` | Dev server cleanup (taskkill for orphaned Vite process) |
| `Cargo.toml` | `[target.'cfg(windows)'.dependencies]` | `win32job`, `windows` crate (Win32 API bindings) |

### Current build configuration

- `tauri.conf.json` sets `"targets": "all"` and includes both `.icns` (macOS) and `.ico` (Windows) icons
- CI (`.github/workflows/architecture-guard.yml`) runs on `ubuntu-latest` only — architecture guards and domain tests, no platform matrix
- No code signing, notarization, or installer customization is configured

## Decision

### 1. Supported platforms and distribution formats

| Platform | Installer Format | Priority | Status |
|---|---|---|---|
| Windows 10/11 (x86_64) | NSIS (.exe) | Primary | Active development |
| macOS 12+ (x86_64 + aarch64) | DMG (.dmg) with app bundle | Primary | Validated — compiles and runs from clean clone |
| Linux (x86_64) | AppImage (.AppImage) + .deb | Secondary | Planned |

**Rationale**: NSIS over MSI for Windows (simpler, more customizable, better user experience). DMG over pkg for macOS (standard for desktop apps, no admin privileges needed). AppImage as primary Linux format (no root required, single-file distribution, broad distro compatibility) with .deb for Debian/Ubuntu users who prefer system package management.

Tauri v2 supports all of these via its bundle configuration. No custom installer code is needed.

### 2. Platform abstraction standard

All platform-conditional code must follow these rules:

**a. Use `#[cfg(target_os = "...")]` for OS-specific behavior, `#[cfg(unix)]` for POSIX-shared behavior.**

Prefer `#[cfg(unix)]` when Linux and macOS share the same behavior (e.g., fsync, shell selection). Use `#[cfg(target_os = "macos")]` only when macOS differs from Linux (e.g., notarization, Homebrew paths).

**b. Every `#[cfg]` block must have a complementary branch.**

No silent omissions. If Windows has a job object, Unix must have an explicit no-op or alternative. The existing `write_ops.rs` pattern is the canonical example:

```rust
#[cfg(unix)]
fn sync_parent_dir(path: &Path) -> Result<(), String> { /* fsync */ }

#[cfg(not(unix))]
fn sync_parent_dir(_: &Path) -> Result<(), String> { Ok(()) }
```

**c. Platform-specific dependencies use `[target.'cfg(...)'.dependencies]` in Cargo.toml.**

Never gate dependencies with feature flags when the real discriminator is the target OS.

**d. Path handling uses forward slashes for relative paths throughout the frontend.**

The Rust backend normalizes via `std::path::Path` which handles both separators. `path_guard::validate_relative_path` rejects mixed separators. This is the standard — frontend code must never construct backslash paths.

**e. Frontend code must not assume Windows conventions in user-facing text.**

Placeholder paths, example strings, default directory suggestions, and any other user-visible text that references file paths must be platform-aware. Use Tauri's `os.platform()` or equivalent to branch at render time. Hardcoded `C:\` paths are not acceptable even as placeholder text — they signal "this app wasn't built for your OS" to macOS/Linux users.

**f. Window chrome must respect platform conventions.**

macOS uses native traffic light controls (close/minimize/zoom) positioned top-left. Custom titlebar buttons (`decorations: false` + JS-rendered controls) must not be used on macOS — Tauri's `titleBarStyle: "overlay"` provides native controls over custom content. Windows retains the custom `WindowControls` component. The `decorations` and `titleBarStyle` settings should be resolved at runtime based on the host OS, not hardcoded in `tauri.conf.json`.

### 3. `fs::rename` cross-filesystem limitation

`std::fs::rename` is atomic on the same filesystem but **fails with `EXDEV` on Linux when source and destination are on different mount points** (common with `/home` on a separate partition). macOS typically avoids this because most user directories are on the same APFS volume. Windows `MoveFileEx` handles cross-volume moves transparently.

**Decision**: Document this as a known limitation for v1. The project root and all its contents are expected to reside on a single filesystem. A future enhancement (tracked in the Filesystem Write Manager PRD) can add a copy-then-delete fallback when `fs::rename` returns `EXDEV`.

**Immediate mitigation**: `move_project_path` in `project_ops.rs` should surface a user-friendly error message when the rename fails due to cross-device link, rather than the raw OS error.

> **Addendum (2026-07-28):** the copy-then-delete fallback shipped in
> `project_ops.rs` (`move_with_cross_device_fallback`), closing this
> limitation — details and error contract in PRD-FSM-001 §3.5's delivery
> addendum. One correction to the paragraph above: Windows `MoveFileEx`
> only moves across volumes transparently with `MOVEFILE_COPY_ALLOWED`,
> which `std::fs::rename` does not pass — a C:→D: move failed the same
> way, so the fallback keys on `io::ErrorKind::CrossesDevices` (covers
> Unix `EXDEV` and Windows `ERROR_NOT_SAME_DEVICE`) and is not
> platform-gated. Verified empirically via the Rust unit tests in
> `project_ops.rs` (injected cross-device errors; real cross-drive moves
> are not reproducible on a single-filesystem machine).

### 4. Code signing and distribution trust

| Platform | Requirement | Strategy |
|---|---|---|
| Windows | SmartScreen warning without EV certificate | Defer until distribution. Standard code signing certificate initially, EV when download volume justifies cost. |
| macOS | Notarization mandatory for Gatekeeper | Apple Developer Program enrollment required before first macOS release. `tauri-cli` supports `notarytool` integration. |
| Linux | No OS-level signing requirement | GPG-sign release artifacts. AppImage can optionally embed a signature. |

Code signing is a distribution concern, not a build concern. It will be configured in CI when the first platform-specific release pipeline is built.

### 5. CI platform matrix

Expand the existing single-runner CI to a platform matrix when macOS/Linux development begins:

```yaml
strategy:
  matrix:
    os: [ubuntu-latest, windows-latest, macos-latest]
```

**Gate criteria for adding a platform to CI**: When the first PR targets that platform or when a platform-conditional `#[cfg]` block is added that cannot be tested on the current CI runner.

Until then, the single `ubuntu-latest` runner is sufficient for architecture guards and domain tests (pure JS, no platform-specific behavior).

### 6. Bundled LSP binaries (cross-platform artifact strategy)

Per ADR-004, Pyright and TypeScript Language Server will be bundled. These are Node.js packages (platform-independent JavaScript). No per-platform binary resolution is needed for these two servers.

Future language servers that ship native binaries (e.g., rust-analyzer, gopls) will require per-platform artifact resolution. The Language Support Manager PRD defines the pack model with `os/arch` artifact fields. This ADR defers native binary bundling to that PRD.

### 7. PTY and terminal

`portable-pty` (v0.9) abstracts PTY creation across platforms:
- Windows: ConPTY
- macOS/Linux: forkpty

The `terminal_policy.rs` shell allowlist is already platform-conditional. No additional abstraction is needed. The Win32 job object pattern in `terminal_pty.rs` ensures reliable process cleanup on Windows; Unix relies on process group signals (SIGHUP on pty close), which `portable-pty` handles.

### 8. LSP prerequisite and environment portability

**a. Prerequisite command alternates.**

The `Prerequisite` struct assumes a single command name per tool. macOS does not ship a bare `python` binary — only `python3`. The `Prerequisite` model must support an `alternates` list so that `probe_prerequisite` can try `python` then fall back to `python3` (or any future platform variant) without duplicating the entire prerequisite entry.

**b. Platform-aware environment allowlists.**

LSP language packs currently include Windows-specific env vars (`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `TEMP`, `TMP`) alongside cross-platform ones. macOS requires `TMPDIR` (not `TEMP`/`TMP`), and `SHELL` and `LANG` are expected in Unix subprocess environments. The fix is a shared `platform_env_base()` helper in the packs module that uses `#[cfg]` to return the correct base set, with each pack appending its language-specific vars.

```rust
pub(crate) fn platform_env_base() -> Vec<&'static str> {
    let mut v = vec!["PATH", "HOME", "USER"];

    #[cfg(target_os = "windows")]
    v.extend_from_slice(&["USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP"]);

    #[cfg(not(target_os = "windows"))]
    v.extend_from_slice(&["TMPDIR", "SHELL", "LANG"]);

    v
}
```

This follows the same pattern as rule 2b — every `#[cfg]` block has a complementary branch.

### 9. macOS validation findings (2026-03-23)

A macOS tester (PokkitNebula) cloned the repository, compiled with standard Rust/Node toolchain via Homebrew, and ran Litria successfully. This is the first cross-platform validation of the codebase.

**What worked without changes:**
- Tauri v2 compilation (Rust backend + React frontend)
- Launch screen rendering
- Project scaffolding and language support UI
- File system operations (path normalization, project tree)
- Terminal PTY creation via `portable-pty`

**Issues discovered:**

| Issue | Severity | Root Cause | Fix |
|---|---|---|---|
| Placeholder paths show `C:\` on macOS | Low (cosmetic) | Hardcoded Windows paths in `LaunchScreen.jsx` | Platform-detect at render time (rule 2e) |
| Freeze/crash on maximize button | High (crash) | `toggleMaximize()` on undecorated window in WKWebView | Native traffic lights on macOS (rule 2f) |

**Issues predicted (not yet hit by tester):**

| Issue | Severity | Root Cause | Fix |
|---|---|---|---|
| `python` not found on macOS | Medium | No bare `python` binary; only `python3` | `Prerequisite.alternates` field (section 8a) |
| LSP env missing `TMPDIR` | Low | Allowlist has Windows vars, not macOS | `platform_env_base()` helper (section 8b) |

**Key takeaway:** The tiered platform model (Primary/Secondary/Tertiary) overstated the cross-platform effort. The Rust backend and React frontend are effectively platform-agnostic already. The remaining work is a small set of frontend platform checks and LSP environment tweaks — not architectural changes. macOS has been promoted from Secondary/Planned to Primary/Validated.

## Consequences

Positive:
- macOS validation proves the architecture is cross-platform with minimal platform-specific work remaining.
- Documented abstraction patterns (rules 2a–2f) cover both backend `#[cfg]` blocks and frontend platform branching.
- The `fs::rename` limitation is acknowledged upfront rather than discovered as a production bug on Linux.
- Distribution format decisions are locked, preventing rework when installers are built.
- macOS promotion to Primary means both major desktop platforms are actively validated.

Costs:
- macOS notarization requires an Apple Developer Program enrollment ($99/year).
- CI matrix expansion increases build time and runner costs.
- The `fs::rename` cross-device limitation is accepted rather than solved — Linux users with split-partition layouts may encounter errors on filesystem operations until the Filesystem Write Manager adds a fallback.
- Window chrome divergence (custom controls on Windows, native traffic lights on macOS) adds a small conditional rendering path in the frontend.

## Alternatives Considered

1. **Solve `fs::rename` cross-device now**: Adds complexity to `move_project_path` for a scenario that only affects Linux users with non-standard partition layouts. Deferred to the Filesystem Write Manager where the copy-then-delete fallback can be implemented once alongside batch operations.

2. **MSI instead of NSIS for Windows**: MSI requires WiX tooling, is less flexible for custom install flows, and provides no meaningful advantage for a single-user desktop application.

3. **Flatpak instead of AppImage for Linux**: Flatpak requires a runtime and sandboxing setup. AppImage is simpler (single file, no installation, no root) and aligns with Litria's "just works" philosophy. .deb covers users who prefer system package management.

4. **Require code signing before first release**: Delays distribution unnecessarily. SmartScreen warnings on Windows are acceptable for early adopters. macOS notarization is the only hard gate.

5. **Single CI runner forever**: Platform-conditional code that isn't tested on the target platform is a reliability risk. The matrix should expand as platform-specific code grows.

## Scope Notes
- This ADR covers build targets, distribution formats, platform abstraction patterns, and cross-platform constraints.
- Installer UX (custom install screens, auto-update) is out of scope — that is a separate product decision.
- Per-language-server binary resolution is deferred to the Language Support Manager PRD.
- The `fs::rename` fallback implementation is deferred to the Filesystem Write Manager PRD.
- CI pipeline details (caching, artifact publishing, release automation) are implementation concerns, not architectural decisions.

## References
- ADR-004: Bundled Core Language Servers
- `src-tauri/src/project_ops.rs` — `move_project_path` uses `fs::rename`
- `src-tauri/src/write_ops.rs` — canonical platform-conditional pattern
- `src-tauri/src/terminal_policy.rs` — platform-conditional shell allowlist
- `src-tauri/src/terminal_pty.rs` — Win32 job object pattern
- `src-tauri/src/lsp/packs/python.rs` — Python pack with prerequisite definitions
- `src-tauri/src/lsp/packs/typescript.rs` — TypeScript pack with env allowlist
- `src/components/LaunchScreen.jsx` — hardcoded Windows placeholder paths (lines 278, 426)
- `src/components/MenuBar.jsx` — custom window controls with `toggleMaximize()` (line 36)
- `docs/rfcs/filesystem-write-manager.md` — deferred cross-device fallback
- `docs/plans/language-support-manager-prd.md` — per-platform artifact resolution for native LSP binaries
- `docs/feedback/macos-feedback.md` — running log of macOS tester feedback
