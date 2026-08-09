# Import Connections Implementation Plan

**Status: COMPLETE** -- Connection-driven code updates implemented. Closed 2026-03-07.

## Purpose
Implement connection-driven code updates using the architecture defined in:
- `docs/rfcs/syntax-domain-architecture.md`
- `docs/adrs/001-editor-agnostic-syntax-core.md`
- `docs/adrs/002-ast-lsp-source-of-truth.md`
- `docs/adrs/003-dynamic-symbol-backed-ports.md`
- `docs/Orchestration.md` (overall governance and boundary safeguard)

## Scope
- JavaScript/TypeScript-first connection-to-import workflow.
- Editor-agnostic syntax core with Monaco adapter.
- Dynamic symbol-backed ports and reconciliation.

## Non-Goals (This Plan)
- Full multi-language support.
- Editor replacement work (only adapter boundary readiness).
- Final UX polish for all graph-density scenarios.

## Milestone 0: Domain Scaffolding + Contracts

### Outcome
Create `syntax-domain` boundaries, state contracts, and command/query surface without full behavior yet.

### Checklist
- [ ] Create `syntax-domain` module with explicit command/query API.
- [ ] Define initial domain state shape for symbols, ports, connections, bindings.
- [ ] Define event input contract (file changed, connect requested, symbol selected).
- [ ] Define output diff contract (ports/connection state changes + patch plans).
- [ ] Add adapter boundary interface for Monaco integration.
- [ ] Add architecture guard updates to enforce boundary ownership.
- [ ] Confirm milestone changes comply with `docs/Orchestration.md` ownership rules.

### Test Set
- [ ] Unit: domain initializes with empty but valid state.
- [ ] Unit: command/query signatures are stable and type-checked (where applicable).
- [ ] Unit: adapter can call domain commands without Monaco runtime.
- [ ] Guard: boundary/import rules fail on forbidden cross-layer imports.
- [ ] Smoke: existing app boot path remains functional with domain wired but mostly no-op behavior.
- [ ] Validation trio: `npm run test:domains` passes.
- [ ] Validation trio: `npm run check:architecture` passes.
- [ ] Validation trio: `npm run build` passes.

## Milestone 1: Safe Scaffold Flow (Unresolved Import Stub)

### Outcome
A drag connection creates a valid unresolved import scaffold in target file and a visible pending state.

### Checklist
- [ ] Implement `connect` command to create `pending` connection intent.
- [ ] Generate unresolved import placeholder patch plan for JS/TS target files.
- [ ] Apply patch through Monaco adapter edit pipeline.
- [ ] Surface visual pending/unresolved status in graph/UI.
- [ ] Add user prompt hook for post-connect symbol selection.
- [ ] Ensure repeated connect operations are idempotent for same connection intent.
- [ ] Confirm milestone changes comply with `docs/Orchestration.md` ownership rules.

### Test Set
- [ ] Unit: `connect` creates pending connection record with stable IDs.
- [ ] Unit: placeholder import plan is syntactically valid for in-scope JS/TS files.
- [ ] Integration: drag connection updates code and graph state together.
- [ ] Integration: undo/redo (if enabled for this flow) returns to prior code+state.
- [ ] Regression: no auto-import of arbitrary/all exports occurs.
- [ ] Validation trio: `npm run test:domains` passes.
- [ ] Validation trio: `npm run check:architecture` passes.
- [ ] Validation trio: `npm run build` passes.

## Milestone 2: Symbol Discovery + Picker Resolution

### Outcome
Resolve pending connections by selecting real exports from source file AST/LSP analysis.

### Checklist
- [ ] Implement export symbol extraction for JS/TS modules.
- [ ] Build candidate set for source node/file when connection is pending.
- [ ] Auto-resolve only when exactly one valid candidate exists.
- [ ] Implement picker resolution command to bind selected symbol.
- [ ] Replace placeholder import with exact import syntax from selected symbol.
- [ ] Persist `resolvedSymbolId` and import binding association.
- [ ] Confirm milestone changes comply with `docs/Orchestration.md` ownership rules.

### Test Set
- [ ] Unit: export extraction handles default and named exports in target scope.
- [ ] Unit: candidate list excludes invalid/unimportable entries.
- [ ] Unit: single-candidate auto-resolve path produces resolved state.
- [ ] Integration: multi-candidate flow requires selection and then resolves.
- [ ] Regression: incorrect import form (default vs named) is not emitted.
- [ ] Validation trio: `npm run test:domains` passes.
- [ ] Validation trio: `npm run check:architecture` passes.
- [ ] Validation trio: `npm run build` passes.

## Milestone 3: Dynamic Port Reconciliation

### Outcome
Ports are generated from current symbol truth and update as code changes.

### Checklist
- [ ] Generate ports from symbol index rather than static templates.
- [ ] Reconcile port add/update/remove on parse refresh.
- [ ] Keep stable `portId` identity independent of label text.
- [ ] Support label metadata from comments/tags as optional overlay.
- [ ] Add transitional UI state for recently removed or unresolved ports.
- [ ] Ensure graph redraw is diff-driven rather than full reset.
- [ ] Confirm milestone changes comply with `docs/Orchestration.md` ownership rules.

### Test Set
- [ ] Unit: port creation/removal reflects symbol set deltas.
- [ ] Unit: label change does not break existing connection identity.
- [ ] Integration: editing exports in source file updates visible ports.
- [ ] Integration: removed symbol transitions existing connection to broken/drifted.
- [ ] Performance: reconcile cycle remains within agreed latency budget on representative files.
- [ ] Validation trio: `npm run test:domains` passes.
- [ ] Validation trio: `npm run check:architecture` passes.
- [ ] Validation trio: `npm run build` passes.

## Milestone 4: Drift Detection + Recovery Actions

### Outcome
Code and connection intent stay synchronized with explicit handling when refactors break assumptions.

### Checklist
- [ ] Detect symbol rename/remove and mark connection `drifted` or `broken`.
- [ ] Detect module path move and attempt resolver remap.
- [ ] Preserve connection intent even when resolution breaks.
- [ ] Provide recovery actions (reselect symbol, update path, dismiss).
- [ ] Add parse-failure fallback to last-known-good graph state with warning status.
- [ ] Record reconciliation diagnostics for debugging.
- [ ] Confirm milestone changes comply with `docs/Orchestration.md` ownership rules.

### Test Set
- [ ] Unit: rename path remaps when stable identity permits.
- [ ] Unit: remove path yields broken state and unresolved binding.
- [ ] Integration: moving module updates import path when remap succeeds.
- [ ] Integration: parse error in one file does not corrupt global graph state.
- [ ] Regression: manual code edits do not silently delete connection intent.
- [ ] Validation trio: `npm run test:domains` passes.
- [ ] Validation trio: `npm run check:architecture` passes.
- [ ] Validation trio: `npm run build` passes.

## Milestone 5: Performance Hardening + Scale UX

### Outcome
Workflow remains responsive for high-degree nodes (for example `app.jsx` import hubs).

### Checklist
- [ ] Add debounce strategy for editor change events (target range defined in RFC).
- [ ] Limit reparsing to affected files where possible.
- [ ] Add graph aggregation for dense nodes (grouped/bundled edge view).
- [ ] Add focused reveal mode (group- or node-level edge expansion).
- [ ] Add instrumentation for unresolved->resolved funnel and drift frequency.
- [ ] Tune defaults using measured latency and interaction metrics.
- [ ] Confirm milestone changes comply with `docs/Orchestration.md` ownership rules.

### Test Set
- [ ] Performance: typing in active file remains responsive under representative project load.
- [ ] Performance: connection operation meets target response thresholds.
- [ ] Integration: aggregated view preserves ability to resolve/edit specific connection.
- [ ] Integration: focus filters do not mutate underlying domain truth.
- [ ] Regression: telemetry hooks do not alter command behavior.
- [ ] Validation trio: `npm run test:domains` passes.
- [ ] Validation trio: `npm run check:architecture` passes.
- [ ] Validation trio: `npm run build` passes.

## Milestone 6: Production Readiness Gate

### Outcome
Feature is ready for broader rollout behind/on top of feature flag controls.

### Checklist
- [ ] Validate all acceptance criteria from RFC against implemented behavior.
- [ ] Complete manual UX sweep for pending/resolved/drifted/broken states.
- [ ] Verify adapter/domain boundary via architecture checks.
- [ ] Finalize feature-flag rollout strategy and fallback behavior.
- [ ] Document known limitations and deferred items.
- [ ] Publish operator/dev troubleshooting notes.
- [ ] Confirm milestone changes comply with `docs/Orchestration.md` ownership rules.

### Test Set
- [ ] Full automated suite for domain + integration passes in CI.
- [ ] Manual end-to-end flow check on a representative project.
- [ ] Failure-injection scenarios (symbol remove, parse fail, path move) pass expected recovery behavior.
- [ ] Rollback test: disabling feature flag restores prior behavior safely.
- [ ] Release checklist sign-off captured in plan evidence section.
- [ ] Validation trio: `npm run test:domains` passes.
- [ ] Validation trio: `npm run check:architecture` passes.
- [ ] Validation trio: `npm run build` passes.
- [ ] Final governance gate: `docs/Orchestration.md` compliance confirmed before sign-off.

## Evidence
- PR(s): `_____`
- Test outputs: `_____`
- Manual validation notes: `_____`
- Known limitations at ship: `_____`
