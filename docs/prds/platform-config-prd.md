# Product Requirements Document
## Platform Configuration System

**Project:** Litria
**Component:** Core Infrastructure
**Version:** 1.0
**Status:** Ready for Development
**Relates to:** ADR-011, RFC `platform-config.md`, macOS feedback log

---

## 1. Overview

A two-layer runtime platform detection system that eliminates hardcoded Windows assumptions from the UI. Rust detects the OS and configures window chrome before the webview mounts. The frontend reads a declarative platform defaults map via a React context hook. Components consume platform config instead of making platform assumptions.

---

## 2. Goals

- Eliminate all hardcoded Windows assumptions from user-facing UI
- Provide a single, declarative source of truth for platform-specific behaviors
- Resolve macOS feedback items #1, #2, #4, #9, #12 through config, not one-off fixes
- Make future platform-sensitive features trivial to implement correctly

---

## 3. Non-Goals

- Replacing existing `#[cfg(target_os)]` compile-time Rust branching (backend stays as-is)
- Implementing keyboard shortcut registration (this provides labels only)
- First-launch-only detection or cached config files
- Platform-specific build pipelines (covered by ADR-010)

---

## 4. Tech Stack

| Layer | Technology |
|---|---|
| Detection (Rust) | `std::env::consts::OS` |
| Window config | Tauri v2 `WindowBuilder` API |
| IPC | Tauri command (`get_platform_config`) |
| Frontend config | Plain JS module (`platformDefaults.js`) |
| React integration | Context + `usePlatformConfig()` hook |

---

## 5. Architecture

See RFC `platform-config.md` for full technical design.

**Layer 1 — Rust (pre-window):**
- `platform.rs`: `PlatformConfig` struct + `detect_platform()` function
- `main.rs`: configure window decorations/titlebar before webview mount
- Tauri command: `get_platform_config` returns OS + flags to frontend

**Layer 2 — Frontend (post-mount):**
- `platformDefaults.js`: OS → UI behavior mapping (modifier keys, paths, hidden files, shell, shortcut labels)
- `usePlatformConfig.js`: React context + hook
- `App.jsx`: context provider wrapping app content

---

## 6. Platform Defaults Matrix

| Property | Windows | macOS | Linux |
|---|---|---|---|
| Modifier key | `Ctrl` | `⌘` | `Ctrl` |
| Alt key label | `Alt` | `⌥` | `Alt` |
| Placeholder path | `C:\Projects\my-project` | `~/Projects/my-project` | `~/projects/my-project` |
| Hidden files | `Thumbs.db`, `desktop.ini` | `.DS_Store`, `._*`, `.Spotlight-V100`, `.Trashes` | `.directory` |
| Preferred shell | `powershell` | `$SHELL` (fallback: zsh) | `$SHELL` (fallback: bash) |
| Window controls | Custom (Litria titlebar) | Native traffic lights | Custom (Litria titlebar) |
| Decorations | `false` | `true` | `false` |
| Titlebar style | — | `overlay` | — |
| Save shortcut label | `Ctrl+S` | `⌘S` | `Ctrl+S` |
| Undo label | `Ctrl+Z` | `⌘Z` | `Ctrl+Z` |
| Redo label | `Ctrl+Y` | `⇧⌘Z` | `Ctrl+Shift+Z` |

---

## 7. Integration Points

| Need | Source | Consumer |
|---|---|---|
| OS detection | `std::env::consts::OS` | `platform.rs` |
| Window decorations | `PlatformConfig.decorations` | `main.rs` WindowBuilder |
| Titlebar style | `PlatformConfig.titlebar_style` | `main.rs` WindowBuilder |
| Platform config IPC | `get_platform_config` command | `App.jsx` on mount |
| Placeholder paths | `usePlatformConfig().placeholderPath` | `LaunchScreen.jsx` |
| Window controls | `usePlatformConfig().showWindowControls` | `MenuBar.jsx` |
| Hidden files | `usePlatformConfig().hiddenFiles` | `DrawerContentScaffold.jsx` |
| Shortcut labels | `usePlatformConfig().shortcutLabels` | `MenuBar.jsx`, dropdown items |
| Shell preference | `PlatformConfig` + terminal policy | `terminal_policy.rs` |

---

## 8. macOS Feedback Resolution Map

| Feedback # | Issue | Resolved by |
|---|---|---|
| #1 | Windows-specific placeholder paths | `placeholderPath` config |
| #2 | Freeze on maximize | `decorations: true` + native traffic lights |
| #4 | Terminal defaults to `sh` | `preferredShell` + `$SHELL` env var |
| #9 | Double menubar | `decorations: true` + `showWindowControls: false` |
| #12 | `.DS_Store` in scaffold | `hiddenFiles` filter |

---

## 9. Implementation Checklist

### Slice A: Rust Platform Detection + Window Config

- [ ] Create `src-tauri/src/platform.rs` with `PlatformConfig` struct
- [ ] Implement `detect_platform()` returning OS-specific config
- [ ] Add `get_platform_config` Tauri command
- [ ] Register command in `main.rs` invoke handler
- [ ] Modify `main.rs` window creation to use `PlatformConfig.decorations`
- [ ] Modify `main.rs` to set `titlebar_style: overlay` on macOS
- [ ] Verify: `cargo build` passes on Windows with no behavior change

### Slice B: Frontend Platform Defaults + Hook

- [ ] Create `src/platform/platformDefaults.js` with full OS matrix
- [ ] Create `src/platform/usePlatformConfig.js` with context + hook
- [ ] Add `PlatformContext.Provider` to `App.jsx` wrapping app content
- [ ] Call `get_platform_config` on mount, resolve defaults by OS
- [ ] Verify: default falls back to Windows config if command fails

### Slice C: Component Integration — Window Chrome

- [ ] `MenuBar.jsx`: conditionally render `WindowControls` based on `showWindowControls`
- [ ] `MenuBar.jsx`: add top padding when `titlebar_style === 'overlay'` (macOS ~28px)
- [ ] Verify on Windows: no visual change to existing titlebar behavior

### Slice D: Component Integration — UI Strings

- [ ] `LaunchScreen.jsx`: replace hardcoded placeholder paths with `placeholderPath` / `placeholderNewProjectPath`
- [ ] `MenuBar.jsx`: replace `Ctrl+` shortcut labels with `shortcutLabels.*` from config
- [ ] Any other hardcoded `Ctrl+` labels: find with grep, replace with config values

### Slice E: Scaffold Hidden File Filter

- [ ] Extend scaffold tree filter to include `hiddenFiles` from platform config
- [ ] Implement glob-prefix matching for patterns like `._*`
- [ ] Verify: `.DS_Store` filtered on macOS, `Thumbs.db` filtered on Windows
- [ ] Verify: existing `litria.project.json` filter still works

### Slice F: Terminal Shell Preference

- [ ] Modify `terminal_policy.rs`: read `$SHELL` env var on Unix
- [ ] If `$SHELL` is in allowlist, use it as default instead of first entry
- [ ] Fall through `shellFallbackOrder` if `$SHELL` is not available or not allowed
- [ ] Verify on Windows: no change (PowerShell remains default)

### Slice G: Validation

- [ ] Architecture guard passes (`npm run check:architecture`)
- [ ] Domain tests pass (`npm run test:domains`)
- [ ] `npm run build` succeeds
- [ ] Manual test on Windows: no visual or behavioral regression
- [ ] Manual test on macOS (tester): #1, #2, #4, #9, #12 resolved

---

## 10. Files to Create or Modify

| File | Action | Slice |
|---|---|---|
| `src-tauri/src/platform.rs` | Create | A |
| `src-tauri/src/main.rs` | Modify — window config + command registration | A |
| `src/platform/platformDefaults.js` | Create | B |
| `src/platform/usePlatformConfig.js` | Create | B |
| `src/App.jsx` | Modify — context provider + mount call | B |
| `src/components/MenuBar.jsx` | Modify — conditional window controls + shortcut labels | C, D |
| `src/components/LaunchScreen.jsx` | Modify — placeholder paths from config | D |
| `src/drawers/DrawerContentScaffold.jsx` | Modify — hidden file filter | E |
| `src-tauri/src/terminal_policy.rs` | Modify — `$SHELL` preference | F |

---

## 11. Out of Scope

- Keyboard shortcut registration/binding (future milestone — this provides labels only)
- Platform-specific build/distribution pipelines (ADR-010)
- Theme differences per platform (not needed — Litria theme is cross-platform by design)
- Mobile / tablet / web targets
- Auto-update mechanisms

---

## 12. Acceptance Criteria

| ID | Criteria |
|---|---|
| AC-01 | `get_platform_config` returns correct OS on Windows and macOS |
| AC-02 | Windows build shows no visual or behavioral regression |
| AC-03 | macOS build uses native traffic lights, no custom window controls |
| AC-04 | macOS build shows no double menubar |
| AC-05 | Placeholder paths reflect detected OS |
| AC-06 | `.DS_Store` does not appear in scaffold tree on macOS |
| AC-07 | Terminal defaults to user's `$SHELL` on macOS (typically zsh) |
| AC-08 | Shortcut labels show `⌘` on macOS, `Ctrl` on Windows |
| AC-09 | `usePlatformConfig()` hook works in any component under the provider |
| AC-10 | Graceful fallback to Windows defaults if Tauri command fails |
