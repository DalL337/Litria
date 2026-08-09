# Brief: Multi-Session Support (two projects, two windows)

> **Status**: Direction brief / not yet planned for implementation
> **Author**: DalL337 + Claude
> **Date**: 2026-07-05
> **Why now**: discovered as the structural prerequisite for the extension **sandbox window**
> (`extension-sandbox-design.md`) — the designated test workspace is a second project open in a
> second window of the same process. Multi-window is also independently valuable (reference a
> second project while working; eventual split-across-monitors workflows).

---

## Problem

Litria today is one project, one window, per process. The extension sandbox window needs a
second, fully capable project session alongside the main one. Rather than special-casing the
sandbox, the sane move is general multi-session support that the sandbox window simply rides —
with its distinctive chrome (inset, rounded, red tab) layered on top.

## Current state (code audit, 2026-07-05)

The app is **closer to multi-session than expected**. The backend was mostly written
per-request rather than per-global.

### Already multi-session-ready

- **LSP sessions** are keyed by `(project_id, language_id)` — `src-tauri/src/lsp/session.rs:42`
  holds `HashMap<SessionKey, LspSession>` with `session_key = "{project_id}::{language_id}"`.
  Two projects running the same language get distinct server processes today.
- **Terminal/ConPTY sessions** are keyed by `project_id` —
  `src-tauri/src/terminal_session_manager.rs:10` (`SESSIONS_BY_PROJECT`). (Enforces one
  terminal *per project*, which is fine.)
- **Backend commands are stateless per-request**: no `.manage()` / `State<...>` anywhere
  (`src-tauri/src/lib.rs:23`); the frontend passes `project_root` / `project_id` into each
  command explicitly. There is no global "current project path" in Rust to untangle.
- **No filesystem watchers** to re-scope — scaffold refresh is a frontend counter, not an OS
  watcher registry.

### Hard blockers (the actual work)

1. **The project DB is a single-slot process-wide singleton.**
   `src-tauri/src/db/mod.rs:11` — `static PROJECT_DB: OnceLock<Mutex<Option<Connection>>>`.
   `open_workspace_db` overwrites the slot; `with_workspace_db` errors if empty. Exactly one
   `<project_root>/.litria/workspace.db` can be open per process.
2. **Single-window config, no window creation.** `tauri.conf.json:13-18` declares one window
   ("main"); no `WebviewWindowBuilder` usage exists anywhere in `src/` or `src-tauri/`.
3. **Frontend project switch is destructive and in-place.**
   `src/App.jsx:146` — single `projectInstance` state; `useProjectLaunch.js:163-246` tears down
   terminal/LSP/diagnostics and swaps it, reusing the single DB slot.

### Hygiene items (real but small)

- `WRITE_LOCK` (`src-tauri/src/write_ops.rs:11`) serializes atomic writes process-wide —
  correct with two projects, just a shared contention point; key per-project if it ever shows.
- App DB (recent projects/preferences) is a separate singleton in app-data — genuinely global,
  stays a singleton; needs only concurrent-access sanity.

## Direction

The load-bearing insight: **each Tauri window hosts its own webview, i.e. its own React tree.**
Blocker #3 largely dissolves on its own — a second window running the app naturally has its own
`projectInstance`, its own diagnostics store, its own canvas state. The frontend doesn't need a
multi-project store; it needs to *not assume it's the only instance*. That leaves the backend
DB keying and window plumbing as the real work.

### Phase 0 — key the DB layer by project (the one hard change)

- `PROJECT_DB: OnceLock<Mutex<Option<Connection>>>` →
  `Mutex<HashMap<ProjectId, Connection>>` (or Tauri managed state).
- `with_workspace_db(...)` grows a `project_id` parameter. Callers already have the id in hand
  everywhere it matters — the LSP/terminal registries prove the pattern.
- **Same-project-in-two-windows guard**: `workspace.db` is single-writer; opening a project
  that's already open should focus the existing window, not double-open. In-process registry
  check (cheap, covers the one-process reality); a lock file only if multiple app processes
  ever become supported.
- Mechanical, testable in isolation, and valuable even before any second window exists.

### Phase 1 — window creation & identity

- Spawn via `WebviewWindowBuilder` with a distinct label; label ↔ project binding lives in an
  in-process session registry (label → project_id/root).
- Window boot path: the new webview loads the same app; an init payload (or query on the
  window label) tells it which project to launch, reusing `handleOpenProjectInstance` minus the
  teardown-of-previous step.
- Lifecycle policy: closing the last window exits the app (clean-shutdown ethos); closing a
  secondary window tears down exactly its project's sessions (LSP, terminal, DB entry) — the
  per-project keying from Phase 0 makes this a targeted cleanup, not a global one.
- Per-window close guard (`useWindowCloseGuard`) already exists per-webview; verify it binds to
  `getCurrentWindow()` correctly for non-main labels.

### Phase 2 — polish & the sandbox window rider

- Window state memory (size/pos per role), menubar correctness per window focus, recent-projects
  arbitration in the app DB.
- The **sandbox window** then becomes: Phase 1 window + sandbox chrome (inset, rounded corners,
  red rail tab) + journal-no-flush write mode + dev-mode extension install. All sandbox-specific,
  none of it session-infrastructure.

## Sizing intuition

Smaller than it looks. Phase 0 is a mechanical refactor of one module plus its call sites;
Phase 1 is new-but-thin plumbing; the risk surface is lifecycle edges (same project twice,
last-window close, secondary-window teardown ordering) rather than architecture. The audit
found no deep global to unwind — the codebase's habit of passing `project_id` explicitly paid
off.

## Non-goals

- Two projects in **one** window (tabs/workspace switching) — different feature.
- Shared canvas or cross-window piece drag.
- Multiple app *processes* coordinating — one process, N windows.
- Any sandbox-specific behavior — that's `extension-sandbox-design.md`'s remit.

## References

- `docs/plans/ideas/extension-sandbox-design.md` — the consumer that surfaced this
- Audit source locations: `src-tauri/src/db/mod.rs:11`, `src-tauri/src/lsp/session.rs:42-50`,
  `src-tauri/src/terminal_session_manager.rs:10`, `src-tauri/src/write_ops.rs:11`,
  `src/App.jsx:146`, `src/app/useProjectLaunch.js:163-246`, `tauri.conf.json:13-18`
