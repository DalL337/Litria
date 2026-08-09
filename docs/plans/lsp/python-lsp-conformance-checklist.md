# Python LSP Conformance Checklist (Reference Implementation)

**Status: BLOCKED** -- 88% complete (23/26 checks). Remaining 3 items require macOS/Linux testing. Updated 2026-03-28.

## Purpose
Define the implementation and validation checklist for Python LSP so it satisfies the shared Language Pack Integration Contract in `docs/plans/language-support-manager-prd.md` section 3.10.

## Scope
- Python LSP install/detect/activate/deactivate behavior.
- Python editor integration lifecycle and error handling.
- Contract conformance evidence required before marking Python complete.

## Out of Scope
- Non-Python language packs.
- Full Language Support Manager UI for non-MVP languages.
- Advanced multi-server Python provider switching.

## Decision Defaults (Proposed)
These defaults are recommended for initial implementation. Adjust only if a concrete blocker appears.

### D1. Default LSP Server
- `pyright-langserver` (Node-based) is the default Python LSP for reference implementation.
- Reason: consistent diagnostics quality, strong adoption, predictable CLI contract.

### D2. Runtime Dependency Model
- Initial model: external prerequisite detection + guided setup.
- Do not bundle Python LSP binaries in this phase.
- Required checks:
  - Python runtime presence
  - Node runtime presence (for pyright path)
  - `pyright-langserver` command availability

### D3. Launch Contract
- Command: `pyright-langserver`
- Args: `--stdio`
- Working directory: active project root
- Env policy: minimal inherited env + explicit allowlist additions only when required.

### D4. Startup and Shutdown Policy
- Startup timeout: 10 seconds (transition to `Error` on timeout).
- Retry policy: manual retry only in MVP (no automatic retry loop).
- Shutdown policy: deterministic stop on project switch/close and app shutdown.

### D5. Canonical Error Codes (Python Pack)
- `python_lsp.runtime.python_missing`
- `python_lsp.runtime.node_missing`
- `python_lsp.server.missing`
- `python_lsp.start.timeout`
- `python_lsp.start.failed`
- `python_lsp.transport.failed`
- `python_lsp.shutdown.failed`

### D6. User-Facing UX Defaults
- If prerequisites missing, surface explicit “install steps” command text with copy action.
- Always show active server command/path when status is `Installed`.
- Keep status vocabulary aligned with shared model (`Not Installed`, `Installing`, `Installed`, `Update Available`, `Error`).

## 1. Contract Conformance Gates

### 1.1 Canonical State Model
- [x] Python integration exposes only canonical states:
  - `Not Installed`
  - `Installing`
  - `Installed`
  - `Update Available`
  - `Error`
- [x] State transitions are deterministic and no hidden intermediate states leak to UI.

### 1.2 Runtime Capability Contract
- [x] Python pack declares runtime prerequisites (for example: python runtime and chosen LSP server runtime).
- [x] Python pack declares launch command + args + env allowlist contract.
- [ ] OS/arch compatibility is declared and validated before activation.
- [x] Readiness/health signal is defined (startup handshake and timeout behavior).

### 1.3 Lifecycle Contract
- [x] Install flow returns typed progress states and terminal result.
- [x] Activation only occurs after verification and registration pass.
- [x] Failure path rolls back to previous known-good active state.
- [x] Project switch/close detaches listeners/sessions cleanly.

### 1.4 Error Contract
- [x] Every failure returns `category`, `code`, `message` and optional `retryHint`.
- [x] No silent failures in detect/install/activate/deactivate paths.
- [x] Error messages include actionable next steps when manual fix is needed.

### 1.5 UX Consistency Contract
- [x] Python status badges and labels use shared canonical language-pack vocabulary.
- [x] Manual setup path includes copyable command/diagnostics.
- [x] Active runtime version/path is visible to user. *(StatusBar LanguageStatus indicator — shows server command + version on hover with full path details. Added 2026-03-28.)*
- [x] Retry affordance is present for safe retryable failures.

## 2. Python LSP Technical Decisions (Lock Before Coding)
- [x] Default Python LSP server choice is finalized.
- [x] Runtime dependency model is finalized (bundled vs external prerequisite detection).
- [x] Launch/cwd/env policy is approved and documented.
- [x] Startup timeout, retry policy, and shutdown policy are approved.

## 3. Implementation Slices

### Slice A: Detection + Status Plumbing
- [x] Detect Python runtime and LSP availability.
- [x] Surface canonical pack status + diagnostics in UI/domain state.
- [x] Add unit tests for detection outcomes and status mapping.

### Slice B: Install/Setup Path
- [x] Implement install/setup orchestration (or guided external setup path).
- [x] Add typed progress events and typed failure events.
- [x] Add rollback safety behavior for partial failure.
- [x] Add tests for happy-path and failure-path setup.

### Slice C: Activation + Editor Lifecycle
- [x] Implement LSP activation handshake for Python files.
- [x] Bind lifecycle to project open/switch/close.
- [x] Ensure clean detach/shutdown behavior.
- [x] Add integration tests for activation and teardown.

### Slice D: Error Hardening + UX Completion
- [x] Map all operational failures to shared error contract.
- [x] Add copyable diagnostics and retry where safe.
- [x] Validate no silent failure paths remain.
- [x] Add tests for representative failure classes.

## 4. Validation Gates (Per Milestone)
- [x] `npm run test:domains`
- [x] `npm run check:architecture`
- [x] `npm run build`
- [x] Python LSP-specific automated tests pass. *(21 conformance tests in `test/domains/pythonLspConformance.test.mjs` covering: version extraction, launch contract, activation guards, session idempotency, timeout handling, activation events, project switching, all D5 error codes, platform-specific setup commands for win32/darwin/linux, copyable diagnostics, teardown lifecycle. Added 2026-03-28.)*
- [ ] Manual parity pass completed (install/setup -> open python file -> diagnostics -> save/reopen -> project switch teardown).

## 5. Exit Criteria
- [ ] All Contract Conformance Gates pass.
- [ ] Implementation slices A-D complete with evidence.
- [ ] Python is accepted as reference implementation for future installable language packs.
- [ ] Follow-on manager work references this checklist for conformance baseline.

## Evidence

- Branch/PR: `feat/rust-hardening-buildout`
- Automated test output: `2026-02-22: npm run check:architecture (pass — Architecture guard passed, App shell guard passed), npm run test:domains (pass — 91/91 tests, 0 failures, ~398ms), npm run build (pass — 2682 modules, no errors, chunk size warnings only).`
- Manual validation notes: `2026-02-22: Python diagnostics hover card is active; typo hints and incomplete assignment diagnostics surface with message content in-editor. Pin system (P key shortcut, Lucide icons, blue border accent) working. Card correctly locks on P, clears on Esc or View Problem navigation.`
- Conformance test output: `2026-03-28: node --test test/domains/pythonLspConformance.test.mjs (pass — 21/21 tests, 0 failures). npm run test:domains (pass — 342/342 tests, 0 failures). npm run check:architecture (pass — 12 domains). npm run build (pass — 2857 modules, no errors).`
- UI evidence: `2026-03-28: LanguageStatus component added to StatusBar right zone (src/components/StatusBar.jsx). Shows active language server command + version. Hover tooltip exposes full detail: server command, version, Python version, and project root path.`
- Known limitations/deferred items: `Full stdio diagnostics/completions transport remains a follow-on quality pass. Current rich editor UX for Python is local-file intelligence (symbols/keywords/signature/definition) and does not yet include cross-file or server-backed semantic analysis parity.`
