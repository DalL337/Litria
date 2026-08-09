# ADR-011: Runtime Platform Configuration via Two-Layer Detection

## Status
- Accepted — Implemented (`361f6cb`; modifier-key consolidation PR #42)

## Date
- 2026-03-24

## Context

macOS tester feedback (2026-03-23) surfaced multiple issues caused by hardcoded Windows assumptions: placeholder paths, window chrome conflicts, terminal defaulting to ancient `sh`, `.DS_Store` polluting the scaffold tree, and `Ctrl` labels where macOS expects `⌘`. These are not bugs — they are missing platform awareness.

Currently, platform-specific behavior is handled ad-hoc:
- Rust side: `#[cfg(target_os)]` compile-time branching in terminal, filesystem, and process code
- Frontend: zero platform awareness — all UI assumes Windows

This creates two problems:
1. Every new platform-sensitive feature re-invents detection logic
2. Frontend has no centralized way to ask "what platform am I on?"

## Decision

Implement a **two-layer runtime platform detection system**:

**Layer 1 — Rust (pre-window):** Detects OS via `std::env::consts::OS` at startup. Configures Tauri window properties (decorations, titlebar style) before the webview mounts. Exposes a `get_platform_config` Tauri command that returns the detected OS and platform-specific flags.

**Layer 2 — Frontend (post-mount):** A `platformDefaults` module maps OS identifiers to UI behaviors (modifier keys, placeholder paths, hidden files, shell preferences, shortcut labels). Components read from the resolved config — never from hardcoded platform assumptions.

Detection runs **every launch**, not on first-launch-only. The OS is immutable for a given binary, but detecting every time eliminates config corruption as a failure mode and keeps the system stateless.

## Alternatives Considered

### First-launch detection with cached JSON
Detect once, write to disk, read on subsequent launches. Rejected: adds a failure mode (stale/corrupt config) for zero benefit — platform detection is a single syscall, not expensive enough to cache.

### Compile-time feature flags only
Use `#[cfg(target_os)]` everywhere and conditional compilation for frontend bundles. Rejected: would require separate builds per platform for the frontend bundle. Tauri already compiles per-platform, but the React bundle is platform-agnostic — runtime detection preserves this.

### Tauri's built-in `os` plugin only
Use `@tauri-apps/plugin-os` for all detection. Partially adopted: the plugin provides the OS identifier to the frontend, but doesn't solve pre-window Rust configuration. The two-layer approach uses native Rust detection for Layer 1 and the plugin (or a lightweight Tauri command) for Layer 2.

## Consequences

### Positive
- Single source of truth for "what platform am I on" in both Rust and JS
- New platform-sensitive features just read from the config — no detection logic duplication
- macOS feedback items #1, #2, #4, #9, #12 resolved by config, not one-off fixes
- Platform config is declarative and auditable (one file per layer)

### Negative
- Adds a startup dependency: frontend must wait for platform config before rendering platform-sensitive UI (mitigated: config is available synchronously via Tauri command before first paint)
- Two config locations (Rust + JS) must stay in sync conceptually, though they cover different concerns

### Neutral
- Does not replace existing `#[cfg(target_os)]` Rust code for compile-time platform branching (terminal policy, filesystem ops). Those remain appropriate for backend-only concerns. This system covers runtime UI behavior only.

## References
- macOS tester feedback: `docs/feedback/macos-feedback.md`
- ADR-010: Cross-platform build and distribution strategy
- Tauri v2 window configuration: `WindowBuilder` API
