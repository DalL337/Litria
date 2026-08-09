# Product Requirements Document: Terminal Foundation (Scoped v1)

**PRD-TERM-001 | Version 1.3 | February 19, 2026**

| Field | Value |
|---|---|
| Document ID | PRD-TERM-001 |
| Version | 1.3 |
| Date | February 19, 2026 |
| Status | COMPLETE -- Implemented. Closed 2026-03-07. |
| Project | Litria |
| Component | Terminal Drawer + Pill Notifications (Scoped) |
| Tech Stack | Rust (Tauri backend), React frontend, xterm.js |
| Notes | Planning artifact only. No implementation in this phase. |

---

## 1. Purpose and Scope

### 1.1 Purpose

Define a foundation PRD for terminal capabilities that fits Litria's current architecture today and creates a clean path toward PTY-backed execution in the Rust backend.

### 1.2 Scope (v1)

This version is intentionally scoped to current application constraints.

- **Single active project context only** (matches current app runtime model).
- **One terminal session per active project instance.**
- **Terminal UI lives inside existing drawer ecosystem.**
- **Pill notifications are in-project only in v1** (stubbed for future cross-project expansion).
- **Backend contract is designed so PTY can be introduced cleanly without reworking frontend boundaries.**

### 1.3 Out of Scope (v1)

- Cross-project notification fan-in and multi-window aggregation.
- Multi-tab terminal sessions per project.
- Notification history center or persistence across app restarts.
- User settings UI for terminal behavior and notification tuning.
- Final visual polish/theming decisions beyond existing UI conventions.

---

## 2. Current Architecture Fit

### 2.1 Runtime Reality

The current app operates with a single active `projectInstance` at a time. Terminal behavior and pill behavior must follow this model in v1.

### 2.2 Frontend Boundary Fit

Terminal and pills must align with existing shell and layering boundaries:

- `App.jsx` remains composition-first.
- UI stays in `src/components` / `src/drawers`.
- Behavior/state orchestration stays in hooks under allowed domain boundaries.
- Existing drawer host patterns and overlay conventions are reused.


### 2.4 Separation of Responsibilities (Required)

To preserve architecture boundaries and avoid domain blur:

- Rust/Tauri owns PTY/process execution, session primitives, host security checks, and transport events.
- Frontend/domain layers own terminal UI state, focus/drawer behavior, notification state, and orchestration with projectInstance lifecycle.
- Domain behavior (piece/node/workspace logic) must not migrate into PTY backend modules.
- UI components must not directly perform OS/process operations; all execution routes through typed IPC contracts.

---

## 3. Product Requirements (v1)

### 3.1 Terminal Session Model

1. The system provides one terminal session bound to the active project root.
2. Session lifecycle is tied to active project lifecycle:
- On project open: session can be created or prepared.
- On drawer open: terminal view connects to session output.
- On drawer close: terminal view may disconnect while session continues.
- On project close/switch: session is terminated.
3. Working directory is the active project root path.
4. Input/output is bidirectional through Tauri IPC contracts.
5. v1 supports one session only; no tab/session manager.

### 3.2 Terminal Drawer UX (v1)

1. Terminal is presented through existing drawer architecture.
2. Opening/closing terminal does not alter canvas layout model.
3. Keyboard focus behavior is explicit:
- Focus in terminal: terminal receives keystrokes.
- Focus out of terminal: app shortcuts remain active.
4. Escape handling is focus-aware to avoid conflicts.

### 3.3 Pill Notifications (v1 Stub)

1. When a terminal-invoked process completes, backend emits a structured completion event for the active project.
2. Frontend creates a pill notification from that event.
3. Pill behavior in v1 is minimal and current-state aligned:
- Display message + severity + timestamp.
- Persist until dismissed or app session ends.
- Optional quick action may open/focus terminal drawer.
4. Pill state is in-memory only in v1.
5. v1 pills are **single-project scoped**, but event payload shape is future-ready for cross-project routing.

### 3.4 Pill Payload Shape (Forward-Compatible)

Required for v1:

- `id` (string)
- `projectId` (string)
- `message` (string)
- `severity` (`success | warning | error`)
- `timestamp` (datetime)
- `exitCode` (number | null)

Reserved for future cross-project expansion:

- `projectPath` (string)
- `sourceInstanceId` (string)
- `preview` (string[])

---

## 4. Technical Contract Foundation

### 4.1 IPC Contracts (v1 baseline)

All names are provisional and may be finalized during implementation design review.

- `terminal:session-start` (Frontend -> Rust)
- `terminal:session-started` (Rust -> Frontend)
- `terminal:input` (Frontend -> Rust)
- `terminal:output` (Rust -> Frontend)
- `terminal:resize` (Frontend -> Rust)
- `terminal:session-end` (Frontend -> Rust)
- `terminal:session-ended` (Rust -> Frontend)
- `terminal:process-complete` (Rust -> Frontend, pill source event)

Payload goals:

- Include stable `sessionId`.
- Include active `projectId` (or equivalent instance identifier).
- Include `exitCode` where applicable.

Security and runtime constraints (v1 required):

- Session start must enforce working directory within active project root (canonical path check, symlink-aware).
- Runtime environment passed to spawned processes must be explicitly filtered/allowlisted.
- Shell/program launch policy must be explicit per platform (no implicit arbitrary launcher behavior).
- Session teardown must be deterministic on project switch/close and app shutdown.

### 4.2 Frontend Modules (target shape)

- `TerminalDrawerBody` (render + terminal host container)
- `useTerminalSession` (session I/O lifecycle)
- `useTerminalDrawer` (open/close/focus integration)
- `usePillNotifications` (in-project pill state and dismissal)

### 4.3 Rust Modules (target shape)

- `terminal_session_manager` (session lifecycle)
- `terminal_ipc_bridge` (event routing)
- `process_signal_emitter` (completion payload emission)


### 4.4 Typed Error Contract (v1 baseline)

Terminal command and event payloads should use typed error categories instead of free-form strings.

Minimum categories:

- invalid-request`r
- session-not-found`r
- session-already-exists`r
- project-context-mismatch`r
- permission-denied`r
- spawn-failed`r
- io-failed`r
- pty-unavailable`r

Goal: frontend/domain behavior stays deterministic while backend implementations evolve.

### 4.5 Stream and Lifecycle Reliability Requirements

- 	erminal:output ordering is preserved per sessionId.
- Backpressure strategy is defined (batching/chunk limits) to avoid UI event floods.
- Listener subscribe/unsubscribe behavior is deterministic and tied to lifecycle transitions.
- No orphan process/session remains after project switch/close.

---

## 5. Dependency Direction

### 5.1 Required for v1

- `xterm.js` (frontend terminal rendering)
- compatible xterm fit addon (container sizing)
- Tauri 2.x IPC primitives (already platform standard in Litria)

### 5.2 Deferred/Decision Gate

- Rust PTY crate final choice and version lock
- optional xterm addons beyond fit

Rationale: dependency adoption should follow finalized IPC/session design to avoid premature lock-in.

---

## 6. Acceptance Criteria (Foundational v1)

1. PRD reflects single-project runtime constraints and does not require multi-project orchestration.
2. Session lifecycle is specified in a way that maps to current project open/close behavior.
3. Drawer integration is specified using existing drawer architecture, not a new shell model.
4. IPC contract set is defined with clear directionality and payload intent.
5. Pill notifications are specified for in-project runtime use now, with forward-compatible payload fields for future cross-project routing.
6. Deferred items are explicit (cross-project fan-in, multi-session terminals, persistent notification history).
7. Rust/frontend responsibility split is explicit and enforced in implementation design.
8. v1 terminal security constraints are defined (cwd policy, env filtering, launch policy).
9. Typed error categories are defined for command/event failure handling.
10. Stream ordering, backpressure, and teardown guarantees are specified for session reliability.

---

## 7. Risks and Constraints

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Scope creep back to multi-project notification behavior in v1 | High | Medium | Keep v1 acceptance criteria single-project only |
| Keyboard shortcut conflicts with terminal focus | Medium | High | Explicit focus-state ownership and escape rules |
| IPC payload drift between frontend/backend | Medium | Medium | Contract-first event naming + typed payload definitions |
| PTY portability differences across OS | Medium | Medium | Defer crate lock until technical design and platform validation |
| PTY output volume causes UI lag/event flooding | Medium | Medium | Define batching/backpressure policy and validate stream behavior under load |
| Session/process leaks across project lifecycle transitions | High | Medium | Enforce deterministic teardown and listener cleanup tied to project switch/close |

---

## 8. Versioning Notes

### 8.1 What Changed from Prior Draft

- Added pill notifications back as a **scoped v1 stub**.
- Kept pill behavior strictly single-project for current Litria runtime.
- Added forward-compatible pill payload fields reserved for future cross-project routing.
- Preserved deferred PTY dependency decision gate.

### 8.2 Next Planned PRD Evolution

A future PRD version may introduce:

- cross-project pill fan-in,
- terminal session multiplexing,
- persistent notification history,
- settings and advanced terminal customization.

---

## Revision History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1.0 | February 14, 2026 | Litria Team | Initial draft |
| 1.1 | February 15, 2026 | Codex | Re-scoped to current architecture and foundational single-project terminal plan |
| 1.2 | February 15, 2026 | Codex | Reintroduced pill notifications as single-project stub with forward-compatible payload schema |
| 1.3 | February 19, 2026 | Codex | Added explicit Rust/frontend separation, terminal security constraints, typed errors, and stream/lifecycle reliability requirements |


