# Rust Hardening Checklist

Date: 2026-02-21
Status: In Progress (Phase 5 complete; prior-phase residual checklist items remain)

## Purpose
This checklist defines phased Rust/Tauri hardening work that strengthens security and reliability without breaking the current architecture direction:
- `App.jsx` remains composition/UI shell.
- JS domains keep ownership of app behavior and state orchestration.
- Rust stays a constrained system boundary for trusted IO/process operations.

## Architectural Guardrails (Do Not Violate)
1. No domain logic migration into Rust.
2. No hidden side effects in Tauri commands (all side effects explicit, command-scoped).
3. Rust commands must expose stable, typed contracts consumed by owning JS domains.
4. UI must receive actionable error categories (not opaque string failures).
5. Hardening changes must preserve terminal parity goals and future node architecture options.

## Contract Evolution Policy (App-Wide)
Rust hardening must not silently break app-wide contracts. Contract changes are allowed when needed, as long as behavior remains working end-to-end.

Required rules:
- [ ] No silent contract breaks across Rust -> JS domain -> UI boundaries.
- [ ] Any contract change must be explicitly documented (old shape vs new shape).
- [ ] All consumers must be updated in the same slice (Rust command, domain adapter, UI handler, tests).
- [ ] Use compatibility shims when a staged transition is required.
- [ ] Keep user-visible behavior parity unless an intentional UX change is documented.

Acceptance checklist for contract changes:
1. Define boundary delta (request/response/error changes).
2. Update all affected callers and handlers.
3. Run validation gates (`check:architecture`, `test:domains`, `build`, and Rust tests where relevant).
4. Verify key workflows still operate correctly (open/save/scaffold, and terminal flows when applicable).

## Phase 0: Baseline and Contract Inventory
Goal: Document and freeze current Rust command surface before tightening.

Checklist:
- [x] Enumerate all Tauri commands and events currently exposed.
- [x] Map each command to owning JS domain (`ProjectDomain`, future `TerminalDomain`, etc.).
- [x] Classify each command by risk: read, write, delete, execute, or mixed.
- [x] Define request/response schemas for each command (including error types).
- [ ] Capture current behavior snapshots for critical flows (open/save/scaffold).

Exit criteria:
- [x] Single source doc exists for command contracts and domain ownership.
- [x] No unowned command remains.

## Phase 1: Filesystem Safety Hardening
Goal: Ensure all filesystem operations are root-confined and symlink-safe.

Checklist:
- [x] Canonicalize and validate all input paths against approved workspace roots.
- [x] Block path traversal (`..`, mixed separators, and ambiguous relative forms).
- [x] Enforce symlink-aware boundary checks after canonical resolution.
- [x] Centralize allow/deny policy in one Rust path-guard module.
- [x] Add unit tests for allowed paths, denied paths, symlink escapes, and edge cases.

Exit criteria:
- [x] Every filesystem command goes through the same guard path.
- [ ] Path guard unit tests cover positive/negative cases across platforms.

## Phase 2: Write Integrity and Data Durability
Goal: Prevent partial/corrupt writes and make recovery behavior deterministic.

Checklist:
- [x] Move project/manifest writes to atomic write pattern (temp + fsync + replace).
- [x] Add backup/rollback strategy for critical writes where needed.
- [x] Ensure write operations are idempotent where practical.
- [x] Add explicit file-lock/concurrency behavior policy (single writer assumption or guard).
- [x] Add integration tests for interrupted write and retry scenarios.

Exit criteria:
- [x] Manifest/project writes are atomic and tested.
- [x] Failure mode is deterministic and surfaced clearly to JS/UI.

## Phase 3: Typed Errors and JS/UI Compatibility
Goal: Improve UX and orchestration reliability via typed, stable error contracts.

Checklist:
- [x] Replace string-only error responses with typed categories (`AccessDenied`, `InvalidPath`, `Conflict`, `NotFound`, `Internal`).
- [x] Include safe user-facing message plus internal diagnostic code.
- [x] Map each Rust error type to a JS domain handling path.
- [x] Ensure UI receives enough context for precise toasts/modals without leaking sensitive internals.
- [x] Add regression tests for error mapping behavior in JS domains.

Exit criteria:
- [x] No critical Rust command returns untyped errors.
- [x] UI error handling is predictable and test-backed.

## Phase 4: Module Boundaries and Test Depth
Goal: Improve maintainability without changing ownership boundaries.

Checklist:
- [x] Split `src-tauri/src/lib.rs` into focused modules (paths, fs ops, command adapters, errors).
- [x] Keep public command API thin; route logic through internal modules.
- [x] Add Rust unit tests per module plus integration tests for command adapters.
- [x] Document module ownership and extension rules.
- [x] Verify no JS domain behavior was re-implemented in Rust.

Exit criteria:
- [x] `lib.rs` is composition-only or minimal command wiring.
- [x] Test coverage exists for high-risk modules.

## Phase 5: PTY + Future Node Architecture Readiness
Goal: Harden now without blocking terminal parity or node execution architecture later.

Checklist:
- [x] Define execution policy boundary now (what Rust may execute vs what JS orchestrates).
- [x] Keep PTY lifecycle/state in JS domain orchestration, Rust as adapter/runtime boundary.
- [x] Add allowlist/validation for executable entry points and working directories.
- [x] Ensure terminal streams/events are transport-focused, not domain-logic-focused.
- [x] Validate that future node graph execution can reuse the same hardened command boundary.

Exit criteria:
- [x] PTY path is compatible with hardening constraints.
- [x] Node architecture migration remains feasible without security rollback.

Design artifact:
- `docs/plans/phase5-terminal-pty-design-brief.md`

## Run Evidence (2026-02-21, Phase 5 Slice 1)
- `npm run check:architecture`: pass
- `npm run test:domains`: pass (49/49)
- `npm run build`: pass
- `cargo test` (`src-tauri`): pass (19 Rust tests)

Artifacts:
- Terminal boundary design + teardown invariants: `docs/plans/phase5-terminal-pty-design-brief.md`
- Backend terminal contract scaffold:
  - `src-tauri/src/terminal_types.rs`
  - `src-tauri/src/terminal_policy.rs`
  - `src-tauri/src/terminal_session_manager.rs`
  - `src-tauri/src/commands.rs` (terminal command adapters)

## Run Evidence (2026-02-21, Phase 5 Slice 2)
- `npm run check:architecture`: pass
- `npm run test:domains`: pass (51/51)
- `npm run build`: pass
- `cargo test` (`src-tauri`): pass (20 Rust tests)

Artifacts:
- JS terminal orchestration shell:
  - `src/terminal/terminalStorage.js`
  - `src/terminal/terminalDomain.js`
  - `src/terminal/useTerminalLifecycle.js`
- App composition wiring:
  - `src/App.jsx`
- Backend global teardown command:
  - `src-tauri/src/commands.rs` (`terminal_teardown_all`)

## Run Evidence (2026-02-21, Phase 5 Slice 3)
- `npm run check:architecture`: pass
- `npm run test:domains`: pass (52/52)
- `npm run build`: pass
- `cargo test` (`src-tauri`): pass (26 Rust tests)

Artifacts:
- Terminal executable/cwd policy enforcement:
  - `src-tauri/src/terminal_policy.rs`
  - `src-tauri/src/terminal_session_manager.rs`
  - `src-tauri/src/commands.rs` (`terminal_session_start` with optional executable)
- Terminal transport-bridge scaffold (event names + typed event payload):
  - `src-tauri/src/terminal_ipc_bridge.rs`
- Lifecycle teardown transition test:
  - `test/domains/terminalLifecycle.test.mjs`

## Run Evidence (2026-02-21, Phase 5 Slice 4)
- `npm run check:architecture`: pass
- `npm run test:domains`: pass (52/52)
- `npm run build`: pass
- `cargo test` (`src-tauri`): pass (27 Rust tests)

Artifacts:
- Reusable execution policy boundary for terminal and future node runtime:
  - `src-tauri/src/execution_policy.rs`
  - `src-tauri/src/terminal_policy.rs` (delegates boundary validation to shared policy)
- Terminal command transport emits (session/output/end/process-complete/error) with typed payloads:
  - `src-tauri/src/commands.rs`
  - `src-tauri/src/terminal_ipc_bridge.rs`

## Validation Gate Per Phase
Run and record the standard test trio after each completed phase/slice:
1. `npm run check:architecture`
2. `npm run test:domains`
3. `npm run build`

For Rust-heavy slices, also run Rust-targeted tests:
- `cargo test` (inside `src-tauri`)

## Run Evidence (2026-02-21)
- `npm run check:architecture`: pass
- `npm run test:domains`: pass (48/48)
- `npm run build`: pass
- `cargo test` (`src-tauri`): pass

Artifacts:
- Command contract inventory: `docs/rust-command-contracts.md`

## Run Evidence (2026-02-21, Phase 2 Slice)
- `npm run check:architecture`: pass
- `npm run test:domains`: pass (48/48)
- `npm run build`: pass
- `cargo test` (`src-tauri`): pass (8 Rust tests)

Artifacts:
- Atomic write + lock policy module: `src-tauri/src/write_ops.rs`

## Run Evidence (2026-02-21, Phase 3 Slice)
- `npm run check:architecture`: pass
- `npm run test:domains`: pass (49/49)
- `npm run build`: pass
- `cargo test` (`src-tauri`): pass (10 Rust tests)

Artifacts:
- Typed Rust error contract: `src-tauri/src/errors.rs`
- JS domain/storage error mapping: `src/project/storage.js`, `src/project/projectDomain.js`

## Run Evidence (2026-02-21, Phase 4 Slice)
- `npm run check:architecture`: pass
- `npm run test:domains`: pass (49/49)
- `npm run build`: pass
- `cargo test` (`src-tauri`): pass (13 Rust tests)

Artifacts:
- Module ownership rules: `docs/rust-module-ownership.md`
- Composition-only entrypoint: `src-tauri/src/lib.rs`

## Non-Goals (For This Milestone)
- Building full terminal UX.
- Implementing node execution orchestration.
- Changing visual theming/presentation behavior.

## Suggested Sequence
1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5

Rationale: lock down trust boundary first, then harden data integrity, then improve error contracts, then refactor internals, then validate forward compatibility for terminal/node phases.
