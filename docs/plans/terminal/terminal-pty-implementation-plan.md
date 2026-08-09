# Terminal PTY Implementation Plan

**Document ID**: PLAN-TERM-PTY-001
**Date**: March 3, 2026
**Status**: COMPLETE -- Implemented. Closed 2026-03-07.
**Depends on**: PRD-TERM-001 (Terminal Foundation PRD v1.3)

---

## Overview

This plan converts the terminal stub layer (session records + echo-back commands) into a real PTY-backed terminal with xterm.js rendering in a top-rail drawer. The work is sliced into 6 phases with clear exit criteria.

---

## Crate & Package Decisions (Locked)

### Rust — PTY

| Crate | Version | Purpose |
|---|---|---|
| `portable-pty` | 0.9 | Cross-platform PTY (ConPTY on Windows, Unix PTY on Linux/macOS) |
| `win32job` | 2 | Windows Job Objects for process tree cleanup (cfg windows only) |

`portable-pty` was chosen because:
- Battle-tested (powers WezTerm), ~4M downloads
- Reader/Writer are `Send` — fits existing `std::thread::spawn` + `mpsc` pattern (same as LSP module)
- Cross-platform with documented ConPTY quirk handling
- `CommandBuilder` supports env filtering and cwd natively

### Frontend — xterm.js

| Package | Version | Purpose |
|---|---|---|
| `@xterm/xterm` | ^6.0.0 | Terminal emulator core |
| `@xterm/addon-fit` | ^0.9.0 | Auto-resize terminal to container |
| `@xterm/addon-webgl` | ^0.19.0 | GPU-accelerated rendering (3-5x faster) |
| `@xterm/addon-web-links` | ^0.10.0 | Clickable URLs in terminal output |

Deferred addons: search, unicode-graphemes, serialize, ligatures.

### Transport Decision

- **PTY output streaming**: Tauri Channel (NOT events) — purpose-built for ordered high-throughput streaming
- **Lifecycle signals**: Tauri events (session-started, session-ended, process-complete, error) — low frequency, existing pattern preserved
- **User input + resize**: Tauri invoke commands — request/response is correct model

This means `terminal:output` event in `terminalStorage.js` / `terminal_ipc_bridge.rs` will be replaced with a Channel-based approach for PTY data. The other 4 event types remain as-is.

---

## Slice 1: Rust PTY Spawn + Read Thread

**Goal**: Replace stub `SessionRecord` with a real PTY process. Terminal input writes to stdin, PTY output streams to frontend via Channel.

### 1A: Cargo dependencies + PtySession struct

Add to `Cargo.toml`:
```toml
portable-pty = "0.9"

[target.'cfg(windows)'.dependencies]
win32job = "2"
```

Create `src-tauri/src/terminal_pty.rs`:
- `PtySession` struct holding:
  - `master: Box<dyn MasterPty + Send>` (for resize)
  - `writer: Box<dyn Write + Send>` (for stdin)
  - `child: Box<dyn Child + Send + Sync>` (for wait/kill)
  - `reader_handle: Option<JoinHandle<()>>` (reader thread)
  - `shutdown: Arc<AtomicBool>` (teardown signal)
  - `job: Option<win32job::Job>` (Windows only — process tree kill)
  - `session_id: String`
  - `project_id: String`

- `spawn_pty(project_id, project_root, executable, cols, rows, channel) -> Result<PtySession>`
  - Opens PTY via `native_pty_system().openpty(PtySize { rows, cols, .. })`
  - Builds command via `CommandBuilder::new(executable)` with:
    - `cmd.cwd(project_root)`
    - `cmd.env()` set from filtered environment (wire `terminal_policy::filter_environment`)
    - Force-set `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=litria`
  - Creates Windows Job Object with `KILL_ON_JOB_CLOSE`, assigns child process
  - Spawns reader thread: blocking `read()` → coalesce → `channel.send()`
  - Returns `PtySession`

### 1B: Output batching in reader thread

Reader thread loop:
```
buffer = Vec with capacity 200KB
last_flush = Instant::now()

loop:
  read(&mut tmp_buf) → n bytes
  if n == 0 or shutdown flag: break
  append to buffer
  if buffer.len() >= 200KB or elapsed >= 5ms:
    send chunk via Channel
    clear buffer, reset timer
flush remainder on exit
```

200KB chunks + 5ms coalesce window (validated by Hyper terminal benchmarks: 58% throughput improvement).

### 1C: Wire into session manager

Modify `terminal_session_manager.rs`:
- `SessionRecord` gains a `pty: Option<PtySession>` field
- `start_session()` calls `spawn_pty()` instead of just recording metadata
- `end_session()` calls `pty.teardown()` before removing from map
- `teardown_all_sessions()` iterates and tears down each session

New Tauri command: `terminal_spawn` (async, accepts `Channel<TerminalEvent>` + cols/rows)
- Replaces or augments `terminal_session_start` to provide the Channel

Modify `terminal_input` command:
- Instead of echo-back via `emit_output`, write to `pty.writer`

Modify `terminal_resize` command:
- Call `pty.master.resize(PtySize { rows, cols, .. })`

### 1D: Deterministic teardown sequence

`PtySession::teardown()`:
```
1. shutdown.store(true, SeqCst)
2. Drop writer (closes stdin pipe → shell sees EOF)
3. Close PTY master (breaks output pipe → reader thread unblocks)
4. Wait for child with 2-second timeout
5. If timeout: TerminateJobObject (Windows) / SIGKILL process group (Unix)
6. Join reader thread
7. Drop Job Object handle (final safety net)
```

### 1E: Tauri lifecycle hook

Switch `lib.rs` from `.run()` to `.build().run()`:
```rust
app.run(|_app_handle, event| {
    if let tauri::RunEvent::ExitRequested { .. } = event {
        let _ = terminal_session_manager::teardown_all_sessions();
    }
});
```

### Exit criteria (Slice 1)
- `cargo test` passes for terminal modules
- PTY spawns powershell.exe, reads output, writes input via Tauri commands
- Teardown kills entire process tree (verify with Task Manager)
- `npm run check:architecture` passes
- `npm run test:domains` passes

---

## Slice 2: Frontend xterm.js Foundation

**Goal**: xterm.js renders in a container, wired to PTY via Channel (output) and invoke (input/resize).

### 2A: Install npm packages

```
npm install @xterm/xterm @xterm/addon-fit @xterm/addon-webgl @xterm/addon-web-links
```

Add to `tauri.conf.json` CSP if needed:
- `style-src 'self' 'unsafe-inline'` (xterm injects inline styles)

### 2B: Terminal renderer component

Create `src/components/TerminalRenderer.jsx`:
- Mounts `@xterm/xterm` Terminal instance into a container ref
- Loads addons: fit, webgl (with context-loss recovery), web-links
- `terminal.onData(data => invoke('terminal_input', { ... }))` for user keystrokes
- `fitAddon.fit()` on mount + ResizeObserver on container
- `terminal.onResize(({ cols, rows }) => invoke('terminal_resize', { ... }))` for resize propagation
- Channel `onmessage` → `terminal.write(chunk)` for PTY output
- `terminal.dispose()` in cleanup
- Props: `projectId`, `sessionId`, `channel`, `isVisible`

Important: `loadAddon(webglAddon)` must be called AFTER `terminal.open()`.

### 2C: Update terminalStorage.js for Channel transport

Add a new function `terminalSpawnWithChannel(projectId, projectRoot, executable, cols, rows)`:
- Creates `new Channel()` from `@tauri-apps/api/core`
- Invokes `terminal_spawn` command passing the channel
- Returns `{ channel, sessionId, projectId }`

Keep existing event-based functions for lifecycle signals (session-started, session-ended, etc).

### 2D: Update terminalDomain.js

Add `spawnWithChannel` command that:
- Calls the new `terminalSpawnWithChannel` storage function
- Stores the channel reference alongside active session state
- Returns channel for the UI component to subscribe to

### Exit criteria (Slice 2)
- xterm.js renders in a test container
- Typing in xterm sends keystrokes to PTY
- PTY output appears in xterm
- Resize propagates from container → xterm → PTY
- `npm run build` passes (no bundle errors)
- `npm run test:domains` passes
- `npm run check:architecture` passes

---

## Slice 3: Top Rail Drawer

**Goal**: Terminal UI lives in a top rail with Lucide icons, panel slides down into viewport.

### 3A: Top rail drawer context

Create `src/drawers/TopDrawerContext.jsx`:
- Same pattern as existing `DrawerContext.jsx`
- `TopDrawerProvider` with `activeId`, `isOpen`, `openDrawer()`, `closeDrawer()`, `toggleDrawer()`
- Initial drawers: `[{ id: 'terminal', label: 'Terminal', icon: Terminal }]`
- Future: add `{ id: 'console', label: 'Console', icon: SquareTerminal }`

### 3B: Top rail shell component

Create `src/drawers/TopDrawerShell.jsx`:
- Horizontal icon rail positioned at top of CanvasArea
- Uses same structural pattern as `DrawerShell.jsx` but horizontal axis
- Panel slides DOWN when activated (transform: translateY)
- CSS classes: `.top-drawer-root`, `.top-drawer-rail`, `.top-drawer-panel`
- Escape key closes the panel
- Click-outside (scrim) dismisses

### 3C: Terminal drawer content

Create `src/drawers/DrawerContentTerminal.jsx`:
- Hosts `TerminalRenderer` component
- Manages terminal session lifecycle:
  - On first open with active project: spawn PTY session
  - On panel hide: keep session alive (PTY continues running)
  - On panel show: reconnect to existing channel output
  - On project switch: teardown handled by `useTerminalLifecycle`
- Keyboard focus: terminal receives keystrokes when panel is visible and focused

### 3D: Wire into App.jsx

- Import `TopDrawerProvider` and `TopDrawerShell`
- Compose alongside existing `DrawerProvider`
- Add to `ALLOWED_DOMAIN_IMPORTS` in app-shell-guard if new imports needed

### Exit criteria (Slice 3)
- Top rail visible with Terminal icon
- Clicking icon opens terminal panel sliding down
- Terminal connects to PTY session for active project
- Escape / click-outside closes panel
- Switching projects tears down terminal session
- Architecture guards pass

---

## Slice 4: Backpressure + Flow Control

**Goal**: Prevent UI lag under high-volume PTY output (e.g., `cat large_file`).

### 4A: Frontend watermark flow control

In `TerminalRenderer.jsx`, add write-callback tracking:
- Track `pendingCallbacks` count
- Every 100KB of writes, use `terminal.write(chunk, callback)` form
- When `pendingCallbacks > HIGH_WATERMARK (5)`: invoke `terminal_pause`
- When `pendingCallbacks < LOW_WATERMARK (2)`: invoke `terminal_resume`

### 4B: Rust pause/resume support

Add `terminal_pause` and `terminal_resume` Tauri commands:
- Set/clear an `AtomicBool` on the `PtySession`
- Reader thread checks flag each iteration, blocks on a `Condvar` when paused

### Exit criteria (Slice 4)
- `yes | head -c 50M` completes without browser tab crash
- UI remains responsive (>30 FPS) during high-volume output
- Pause/resume cycle verified in logs

---

## Slice 5: Environment Allowlist Expansion

**Goal**: Terminal is usable for real developer workflows (git, npm, python, etc).

### 5A: Expand terminal_policy.rs allowlist

Windows:
```
PATH, PATHEXT, SYSTEMROOT, SYSTEMDRIVE, WINDIR, COMSPEC,
TMP, TEMP, USERPROFILE, USERNAME, HOMEDRIVE, HOMEPATH,
APPDATA, LOCALAPPDATA, PROGRAMFILES, PROGRAMFILES(X86), PROGRAMDATA
```

Unix:
```
PATH, HOME, TMPDIR, TMP, TEMP, USER, LOGNAME, SHELL,
TERM, COLORTERM, LANG, LC_ALL, LC_CTYPE,
XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_RUNTIME_DIR, EDITOR, VISUAL
```

Force-set (not inherited):
- `TERM` = `xterm-256color`
- `COLORTERM` = `truecolor`
- `TERM_PROGRAM` = `litria`

### 5B: Add env filtering tests

Verify that blocked vars (`LD_PRELOAD`, `NODE_OPTIONS`, `BASH_ENV`, `PROMPT_COMMAND`, etc.) are never passed through.

### Exit criteria (Slice 5)
- `git status`, `npm install`, `python --version` work in terminal
- Blocked env vars confirmed absent in child process
- Cargo tests pass

---

## Slice 6: Pill Notifications (v1 Stub)

**Goal**: Backend process completion emits a pill notification visible in the UI.

### 6A: Pill notification state

Create pill state management (in-memory, single-project scoped per PRD):
- Pill payload shape: `{ id, projectId, message, severity, timestamp, exitCode }`
- Dismiss action, auto-expire optional
- Quick action: open/focus terminal drawer

### 6B: Wire process-complete event to pill

When PTY child exits:
- Reader thread detects EOF
- Emit `terminal:process-complete` event with exit code
- Frontend creates pill from event payload

### 6C: Pill UI component

Minimal pill display near the top rail:
- Message + severity color + timestamp
- Click to open terminal drawer
- Dismiss button

### Exit criteria (Slice 6)
- Running `exit` in terminal shows a pill notification
- Running a command that fails (exit code != 0) shows error-severity pill
- Pill click opens terminal drawer
- Architecture guards pass

---

## Cross-Cutting Concerns

### Architecture guard compliance
- All `src/terminal/` files are domain-scoped (guard updated in this session)
- No UI imports from terminal domain modules
- New drawer components live in `src/drawers/` and `src/components/` (presentation layer)

### Testing strategy
- **Rust unit tests**: PTY spawn, teardown sequence, env filtering, session assertions
- **Frontend domain tests**: terminalDomain command/selector behavior (existing pattern, adapter mocks)
- **Integration**: Manual verification of PTY I/O, teardown, backpressure (automated E2E deferred)

### PRD traceability

| PRD Requirement | Covered In |
|---|---|
| 3.1 Session model (one per project) | Slice 1C |
| 3.2 Drawer UX | Slice 3 |
| 3.3 Pill notifications | Slice 6 |
| 3.4 Pill payload shape | Slice 6A |
| 4.1 IPC contracts | Slice 1C, 2C |
| 4.1 Security (cwd, env, launch policy) | Slice 1A, 5A |
| 4.4 Typed error contract | Existing (terminal_types.rs, terminalStorage.js) |
| 4.5 Stream ordering + backpressure | Slice 1B, 4 |
| 4.5 Deterministic teardown | Slice 1D, 1E |

---

## Revision History

| Version | Date | Changes |
|---|---|---|
| 1.0 | March 3, 2026 | Initial sliced implementation plan |
