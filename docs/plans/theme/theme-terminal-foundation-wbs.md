# Theme + Terminal Foundation WBS (Boundary-Aligned)

Date: 2026-02-15  
Status: Draft  
Scope: Foundational work before feature implementation for Theme System (`Glass`) and Terminal Drawer/Pills.

## Purpose
Define an execution-ready work breakdown structure (WBS) that respects:
- `docs/Orchestration.md` ownership and command/query separation
- current architecture guardrails (`scripts/architecture-guard.mjs`, `scripts/app-shell-guard.mjs`)
- single-project runtime model

## Execution Order
1. Shared Foundations (required by both initiatives)
2. Theme First Steps (Phase 0/1)
3. Terminal First Steps (post-theme foundation)

Rationale:
- Theme can ship meaningful value on current frontend/domain boundaries once shared foundations are in place.
- Terminal requires additional backend IPC/event infrastructure and session lifecycle primitives that do not yet exist.

## Lane A: Shared Foundations (Pre-Feature)

### A1. Manifest normalization boundary in `ProjectDomain`
Owner: `ProjectDomain`  
Depends on: none

Scope:
- Add centralized manifest normalization/migration entrypoints for reads/writes.
- Ensure unknown/invalid payloads degrade safely to defaults.
- Add explicit `appearance` passthrough-safe defaults (without full theme UI yet).

Files (expected):
- `src/project/projectDomain.js`
- `src/project/manifest.js`
- `test/domains/projectDomain.test.mjs`

Boundary rules:
- No UI imports in `src/project/*`.
- No direct state mutation of workspace/editor domains from `ProjectDomain`.

Acceptance:
- Read/write commands normalize malformed manifest input safely.
- Existing persistence tests pass; new normalization tests added.
- `npm run check:architecture`, `npm run test:domains`, `npm run build` pass.

### A2. Project lifecycle orchestration contract
Owner: App shell orchestration + supporting domain hooks  
Depends on: A1

Scope:
- Define explicit lifecycle transitions for project open/switch/close.
- Add initialization/teardown hooks for supporting domains to attach safely.
- Ensure no stale async writes cross project instance boundaries.

Files (expected):
- `src/app/useProjectLaunch.js`
- `src/project/useProjectPersistence.js`
- `src/App.jsx` (wiring only)
- tests in `test/domains/*` as applicable

Boundary rules:
- `App.jsx` remains composition-first; avoid re-introducing mutation-heavy orchestration.
- Lifecycle side effects live in hooks/domains, not presentational components.

Acceptance:
- Switching project instance cleanly resets supporting state.
- No cross-instance write leakage in persistence queue behavior.
- Architecture and tests pass.

### A3. Frontend IPC/event bridge abstraction
Owner: integration boundary (`src/project` + new integration module)  
Depends on: A2

Scope:
- Introduce a thin typed wrapper for request/response and event subscribe/unsubscribe patterns.
- Preserve existing command behavior while creating a reusable path for terminal events later.

Files (expected):
- `src/project/storage.js` (or split into adapter + bridge)
- new integration utility module under `src/app` or `src/project` (non-UI)
- focused tests for subscribe/unsubscribe and payload normalization

Boundary rules:
- UI components must not call raw Tauri APIs directly for domain state operations.
- Domain modules remain framework-agnostic where possible.

Acceptance:
- Existing project IO flows unchanged from user perspective.
- New bridge supports deterministic teardown of listeners.
- Architecture and tests pass.

### A4. Guardrail updates for new supporting domains
Owner: architecture enforcement  
Depends on: A1-A3

Scope:
- Add explicit allowed import paths and constraints for upcoming `ThemeDomain` and `TerminalDomain` modules.
- Document forbidden dependency edges before implementation begins.

Files (expected):
- `scripts/architecture-guard.mjs`
- `scripts/app-shell-guard.mjs`
- `docs/plans/app-refactor-enforcement.md` (or a dedicated addendum)

Boundary rules:
- No domain-to-UI imports.
- No direct `App.jsx` imports except existing approved shell paths.

Acceptance:
- Guard scripts express new boundaries with no temporary loopholes beyond justified transitions.
- CI checks remain green.

## Lane B: Theme First Steps (after Shared Foundations)

### B1. Theme contract + defaults in domain layer (Phase 0)
Owner: `ThemeDomain` (new supporting domain)  
Depends on: A1, A4

Scope:
- Create `ThemeDomain` with built-in `Glass` config + token resolver.
- Add explicit command/query API surface from PRD.
- Keep behavior read-only at this slice (no editor UI for palette editing yet).

Files (expected):
- `src/app/themeDomain.js` (or `src/theme/themeDomain.js`)
- selector module(s) for resolved tokens
- tests under `test/domains/` for resolution + fallback behavior

Boundary rules:
- `ThemeDomain` does not import UI components.
- Persistence writes remain routed through `ProjectDomain` only.

Acceptance:
- Default theme resolves to `glass` for missing/invalid manifest appearance.
- Token resolution produces stable piece visual tokens.
- Domain tests pass.

### B2. Read-only theme wiring into presentation (Phase 1)
Owner: Presentation layer + shell wiring  
Depends on: B1

Scope:
- Replace hard-coded piece styling inputs with resolved theme selectors.
- Keep shell/drawer/artboard colors inherited (no shell redesign in this slice).
- Add minimal settings readout for active theme.

Files (expected):
- `src/components/PuzzlePiece.jsx`
- `src/components/ConnectionLine.jsx` (only if tokenized in this slice)
- `src/drawers/DrawerContentSettings.jsx`
- `src/styles/` (split CSS modules)
- `src/App.jsx` (composition wiring only)

Boundary rules:
- UI reads selectors only; no manifest/file writes from components.
- No direct cross-domain mutation from presentation components.

Acceptance:
- Piece base/highlight/outline render from theme tokens.
- No regression in core piece interaction workflows.
- Architecture + tests + build pass.

### B3. Theme persistence round-trip baseline
Owner: `ProjectDomain` + `ThemeDomain` integration  
Depends on: B1

Scope:
- Persist and reload minimal `appearance` shape with schema version-safe defaults.
- Ensure fallback to built-in `glass` for missing/corrupt values.

Files (expected):
- `src/project/projectDomain.js`
- `src/project/useProjectPersistence.js` (or equivalent integration hook)
- domain tests for manifest round-trip

Boundary rules:
- Only `ProjectDomain` performs manifest writes.

Acceptance:
- Theme state survives restart for project-scoped data.
- Corrupt appearance payload auto-recovers to default safely.

## Lane C: Terminal First Steps (after Theme foundations)

### C1. Backend terminal contract scaffold (no full UI yet)
Owner: Rust backend (`src-tauri`)  
Depends on: A3

Scope:
- Add command/event contract stubs for session lifecycle and process-complete notifications.
- Define terminal execution safety constraints (cwd canonical root checks, env filtering, and explicit shell launch policy).
- Define typed transport error categories for terminal command/event failures.
- Keep single-project, single-session model.
- Include no-op or controlled mock behavior if PTY backend is not yet finalized.

Files (expected):
- `src-tauri/src/lib.rs`
- backend module split(s) as needed (`terminal_session_manager`, `terminal_ipc_bridge`)

Boundary rules:
- Backend events remain transport-oriented; no frontend UI assumptions.
- PTY/process modules must not contain workspace/piece/node domain mutation logic.

Acceptance:
- Contract endpoints compile and are callable.
- Session IDs and project instance IDs are carried consistently.

### C2. Frontend terminal session hook + listener lifecycle
Owner: supporting frontend domain/hook layer  
Depends on: C1, A2, A3

Scope:
- Introduce `useTerminalSession` with start/input/output/resize/end wiring.
- Add `xterm.js` + fit addon integration path for terminal rendering/resize.
- Implement deterministic subscribe/unsubscribe tied to project lifecycle.
- Add stream handling expectations (output ordering, batching/backpressure-safe rendering path).

Files (expected):
- `src/app/useTerminalSession.js` (or equivalent)
- `src/drawers/TerminalDrawerBody.jsx` (or equivalent host component)
- integration tests (session lifecycle)

Boundary rules:
- No direct backend calls from presentational terminal component.

Acceptance:
- Project switch/close tears down listeners and session state safely.
- No leaked listeners across project instances.

### C3. Drawer + pill minimal integration
Owner: presentation + terminal supporting hook  
Depends on: C2

Scope:
- Add terminal drawer entry within existing drawer architecture.
- Add in-memory pill store scoped to active project.
- Support optional quick action to focus terminal drawer.

Files (expected):
- `src/components/useAppDrawers.jsx`
- new drawer component(s)
- new pill state hook/module

Boundary rules:
- Reuse existing drawer shell; do not create a parallel shell model.
- Pill persistence remains in-memory for v1.

Acceptance:
- Terminal opens/closes in existing drawer system.
- Pill notifications render and dismiss within active project scope.
- Keyboard focus behavior does not break existing app shortcuts outside terminal focus.

## Cross-Cutting Validation Gate (run at each slice)
- `npm run check:architecture`
- `npm run test:domains`
- `npm run build`

Optional slice-specific gate:
- Manual parity pass for piece creation, drag/select, group flows, scaffold open/edit, save/load.

## Deferred Until After This WBS
- Theme advanced color picker (wheel/scale mode)
- Theme-bound diagnostic channel animations (`base/gloss/edgeBloom` full wiring)
- Terminal multi-session/multi-tab behavior
- Cross-project pill aggregation/history

## Decision Record
- Theme is sequenced before terminal implementation slices after shared foundations.
- Terminal backend contract work begins only after lifecycle + IPC abstractions are in place.
- No slice is allowed to bypass `ProjectDomain` for manifest persistence.

## Execution Checklist

Use this section as the active tracker during implementation.  
Rule: do not start a dependent item until its dependency checkbox is complete.

### Shared Foundations (Lane A)
- [ ] A1. Manifest normalization boundary in `ProjectDomain`
- [ ] A1.1 Define normalization/migration helpers in `src/project/projectDomain.js`.
- [ ] A1.2 Add `appearance` default/fallback handling in manifest normalization path.
- [ ] A1.3 Add/extend tests in `test/domains/projectDomain.test.mjs` for malformed/partial manifest cases.
- [ ] A1.4 Verify no forbidden imports introduced in `src/project/*`.
- [ ] A1 Gate: `npm run check:architecture` pass.
- [ ] A1 Gate: `npm run test:domains` pass.
- [ ] A1 Gate: `npm run build` pass.

- [ ] A2. Project lifecycle orchestration contract
- [ ] A2.1 Define explicit open/switch/close lifecycle behavior for supporting domains.
- [ ] A2.2 Ensure persistence queue isolation across `projectInstance` transitions.
- [ ] A2.3 Keep `App.jsx` wiring-only for lifecycle composition.
- [ ] A2.4 Add/extend tests for cross-instance safety behavior.
- [ ] A2 Gate: `npm run check:architecture` pass.
- [ ] A2 Gate: `npm run test:domains` pass.
- [ ] A2 Gate: `npm run build` pass.

- [ ] A3. Frontend IPC/event bridge abstraction
- [ ] A3.1 Introduce invoke/listen wrapper with deterministic subscribe/unsubscribe lifecycle.
- [ ] A3.2 Route project IO through bridge without user-visible behavior change.
- [ ] A3.3 Add focused tests for payload normalization and unlisten teardown.
- [ ] A3 Gate: `npm run check:architecture` pass.
- [ ] A3 Gate: `npm run test:domains` pass.
- [ ] A3 Gate: `npm run build` pass.

- [ ] A4. Guardrail updates for new supporting domains
- [ ] A4.1 Update `scripts/architecture-guard.mjs` with `ThemeDomain` and `TerminalDomain` boundary rules.
- [ ] A4.2 Update `scripts/app-shell-guard.mjs` allowlist only as justified transition entries.
- [ ] A4.3 Document new dependency constraints in planning/enforcement docs.
- [ ] A4 Gate: `npm run check:architecture` pass.
- [ ] A4 Gate: `npm run test:domains` pass.
- [ ] A4 Gate: `npm run build` pass.

### Theme First Steps (Lane B)
- [ ] B1. Theme contract + defaults in domain layer (Phase 0)
- [ ] B1.1 Create `ThemeDomain` command/query API skeleton.
- [ ] B1.2 Implement built-in `glass` token defaults and resolver behavior.
- [ ] B1.3 Add fallback behavior for missing/invalid `appearance`.
- [ ] B1.4 Add domain tests for resolver determinism and fallback safety.
- [ ] B1 Gate: `npm run check:architecture` pass.
- [ ] B1 Gate: `npm run test:domains` pass.
- [ ] B1 Gate: `npm run build` pass.

- [ ] B2. Read-only theme wiring into presentation (Phase 1)
- [ ] B2.1 Replace piece hard-coded visual constants with resolved theme selectors/tokens.
- [ ] B2.2 Keep shell/drawer/artboard surface colors in inherit-current mode.
- [ ] B2.3 Add minimal settings readout for active theme id/name.
- [ ] B2.4 Run manual parity smoke: piece select/drag/group/connection/editor open.
- [ ] B2 Gate: `npm run check:architecture` pass.
- [ ] B2 Gate: `npm run test:domains` pass.
- [ ] B2 Gate: `npm run build` pass.

- [ ] B3. Theme persistence round-trip baseline
- [ ] B3.1 Persist minimal `appearance` shape through `ProjectDomain` only.
- [ ] B3.2 Reload and resolve active theme on project open.
- [ ] B3.3 Corrupt payload fallback verified to built-in `glass`.
- [ ] B3.4 Add/extend manifest round-trip tests.
- [ ] B3 Gate: `npm run check:architecture` pass.
- [ ] B3 Gate: `npm run test:domains` pass.
- [ ] B3 Gate: `npm run build` pass.

### Terminal First Steps (Lane C)
- [ ] C1. Backend terminal contract scaffold
- [ ] C1.1 Add command/event contract stubs in `src-tauri` for terminal session lifecycle.
- [ ] C1.2 Include `projectInstance` identity and `sessionId` in payloads.
- [ ] C1.3 Add controlled no-op/mock behavior where PTY backend is deferred.
- [ ] C1.3a Add cwd canonical root checks and env filtering to terminal start flow.
- [ ] C1.3b Define typed terminal error categories for command/event responses.
- [ ] C1.3c Verify PTY/process modules do not perform workspace/piece/node domain mutations.
- [ ] C1.4 Ensure Rust build/compile baseline remains healthy.
- [ ] C1 Gate: frontend architecture checks pass.
- [ ] C1 Gate: backend compile check pass.

- [ ] C2. Frontend terminal session hook + listener lifecycle
- [ ] C2.1 Add `xterm.js` + fit addon dependencies and baseline wiring.
- [ ] C2.2 Implement `useTerminalSession` start/input/output/resize/end orchestration.
- [ ] C2.3 Bind listener lifecycle to project open/switch/close transitions.
- [ ] C2.4 Add tests for cleanup/no listener leaks across instance switches.
- [ ] C2.4a Add stream stress test coverage (ordering + no unbounded UI event flood behavior).
- [ ] C2 Gate: `npm run check:architecture` pass.
- [ ] C2 Gate: `npm run test:domains` pass.
- [ ] C2 Gate: `npm run build` pass.

- [ ] C3. Drawer + pill minimal integration
- [ ] C3.1 Add terminal drawer entry through existing drawer architecture.
- [ ] C3.2 Implement `TerminalDrawerBody` host mount/dispose lifecycle for `xterm.js`.
- [ ] C3.3 Add in-memory pill state scoped to active project.
- [ ] C3.4 Add quick action path to focus/open terminal drawer from pill.
- [ ] C3.5 Validate focus ownership and shortcut behavior when terminal is focused/unfocused.
- [ ] C3 Gate: `npm run check:architecture` pass.
- [ ] C3 Gate: `npm run test:domains` pass.
- [ ] C3 Gate: `npm run build` pass.

### Cross-Cutting Release Gates
- [ ] G1. No forbidden domain/UI import violations introduced.
- [ ] G2. `App.jsx` remains composition-first; no mutation-heavy regressions.
- [ ] G3. Project manifest persistence remains routed through `ProjectDomain` only.
- [ ] G4. Manual parity closeout run recorded in planning docs.

### Status Snapshot Template
- Date:
- Completed items:
- In-progress item:
- Blockers:
- Next item:



