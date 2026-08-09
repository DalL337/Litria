# Phase 5 Design Brief: Terminal/PTy Hardening Boundary

Date: 2026-02-21  
Status: COMPLETE -- Terminal implemented. Closed 2026-03-07.

## Purpose
Define a concrete Phase 5 implementation contract so terminal/PTy work stays aligned with:
- Rust hardening goals in `docs/rust-hardening-checklist.md`
- Terminal foundation PRD in `docs/plans/terminal build PRD.md`
- Domain orchestration rules in `docs/Orchestration.md`

This brief is the build-time boundary agreement, not a UI/feature PRD.

## Scope
- Execution policy boundary (what Rust executes vs what JS orchestrates)
- Terminal session lifecycle ownership split
- IPC contract and payload shape baseline
- Typed terminal error taxonomy compatible with existing Rust error contracts
- Reliability constraints (ordering, teardown, backpressure)

Out of scope:
- Full terminal UI polish
- Multi-session terminal UX
- Cross-project notification fan-in
- Node graph orchestration implementation

## Alignment Summary
No architectural conflict is expected with existing plans if these rules are kept:
1. JS `TerminalDomain` owns lifecycle orchestration and UI state.
2. Rust terminal modules own process/PTy adapter work and security checks only.
3. Terminal transport stays stream/event-focused; no domain logic in Rust.

## Ownership Model
### JS/Domain Layer (`TerminalDomain`)
- Owns session intent and lifecycle orchestration:
  - start
  - attach/detach view
  - send input
  - resize
  - end
- Owns focus integration with drawer and app shortcuts.
- Owns pill notification state and mapping from backend completion events.
- Owns project-context coupling (`projectInstance` transitions).

### Rust Layer (`terminal_session_manager`, `terminal_ipc_bridge`)
- Owns PTy/process creation and IO transport.
- Owns project-root canonical verification and session policy checks.
- Owns environment filtering and launch policy enforcement.
- Emits typed lifecycle/output/error events.

## Execution Policy Boundary (Required)
### Allowed
- Start one terminal session per active project instance.
- Spawn using a platform-explicit shell/program policy.
- Working directory must resolve within active canonical project root.
- Pass only filtered/allowlisted environment keys.

### Denied
- Arbitrary cwd outside project root.
- Implicit unrestricted launcher behavior.
- Hidden command-side effects outside explicit terminal session commands.
- Rust-side orchestration of app/domain behaviors.

## Session State Machine (Canonical)
States:
1. `idle`
2. `starting`
3. `running`
4. `stopping`
5. `ended`
6. `error`

Transitions:
- `idle -> starting` on `terminal:session-start`
- `starting -> running` on `terminal:session-started`
- `running -> stopping` on `terminal:session-end`
- `stopping -> ended` on `terminal:session-ended`
- `* -> error` on terminal command/event failure
- `error -> idle` only after explicit reset/restart intent

Lifecycle rule:
- Project switch/close must force deterministic `running|starting|stopping -> ended`.

Invariants (hard requirements):
1. Exactly one active `sessionId` per active `projectInstance`.
2. Project switch/close is authoritative and must force backend session teardown regardless of drawer/view mount state.
3. Litria app shutdown must leave zero terminal child processes and zero active terminal sessions.

## IPC Contract Baseline
Use PRD names as v1 baseline:
- Frontend -> Rust
  - `terminal:session-start`
  - `terminal:input`
  - `terminal:resize`
  - `terminal:session-end`
- Rust -> Frontend
  - `terminal:session-started`
  - `terminal:output`
  - `terminal:session-ended`
  - `terminal:process-complete`
  - `terminal:error`

Payload minimum:
- `sessionId`
- `projectId` (or equivalent instance id)
- `timestamp`
- command/event-specific fields

## Typed Error Contract Decision
### Decision
Terminal errors will use **global categories + terminal-specific codes**.

Global categories (existing):
- `AccessDenied`
- `InvalidPath`
- `Conflict`
- `NotFound`
- `Internal`

Terminal-specific code examples:
- `terminal.invalid_request`
- `terminal.session_not_found`
- `terminal.session_already_exists`
- `terminal.project_context_mismatch`
- `terminal.permission_denied`
- `terminal.spawn_failed`
- `terminal.io_failed`
- `terminal.pty_unavailable`

Rationale:
- Preserves app-wide error handling consistency.
- Avoids introducing a second incompatible category system.
- Keeps terminal diagnostics precise via `code`.

## Reliability Constraints
1. Output ordering must be preserved per `sessionId`.
2. Backpressure policy required:
   - chunk size cap
   - flush cadence
   - drop/merge strategy must be explicit and testable
3. Listener lifecycle must be deterministic and project-bound.
4. No orphan process/session after project switch, close, or app shutdown.

## Module Plan (Rust)
Planned modules:
- `src-tauri/src/terminal_session_manager.rs`
- `src-tauri/src/terminal_ipc_bridge.rs`
- `src-tauri/src/terminal_policy.rs` (cwd/env/launch enforcement)
- `src-tauri/src/terminal_types.rs` (payload and event structs)

`commands.rs` should expose thin adapters only.

## Module Plan (JS)
Planned modules:
- `src/terminal/terminalDomain.js`
- `src/terminal/useTerminalSession.js`
- `src/terminal/useTerminalDrawer.js`
- `src/terminal/usePillNotifications.js`

`App.jsx` remains composition/wiring only.

## Validation Gates (Phase 5 Slices)
For each implementation slice:
1. `npm run check:architecture`
2. `npm run test:domains`
3. `npm run build`
4. `cargo test` in `src-tauri`

Additional terminal-specific checks:
- Session lifecycle transition tests
- Project-switch teardown tests
- cwd boundary and env filtering tests
- error code/category mapping tests

## Open Decisions (Must Resolve Before Coding)
1. Final shell/program allowlist per platform.
2. Exact env allowlist.
3. Output buffering defaults (size and flush cadence).
4. Session id format and collision handling policy.
5. Whether `terminal:error` is a dedicated event or encoded per command response.

## Implementation Start Criteria
Phase 5 coding can start when:
- This brief is accepted.
- Open decisions are resolved or explicitly deferred with defaults.
- Architecture guard rules include `TerminalDomain` boundaries.
