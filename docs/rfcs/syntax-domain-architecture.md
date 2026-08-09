# RFC: Syntax Domain Architecture for Connection-Driven Code Updates

## Status
- Proposed

## Date
- 2026-02-17

## Owner
- Litria (solo)

## Summary
Define an editor-agnostic `syntax-domain` that powers connection-driven code updates (for example, dragging from `behaviors` to `app.jsx` to create/update imports). The domain owns parsing, symbol discovery, reconciliation, and code patch planning. Monaco integration is moved to an adapter layer.

This RFC establishes a safe MVP path:
- v1: create valid unresolved import stubs + explicit user selection.
- v2: resolve exact symbols from source exports.
- v3: reconcile on code changes and refactors.

## Problem
Current connection ideas risk coupling correctness to UI assumptions (fixed ports, comments as truth, editor-specific logic). That creates fragile behavior and high edge-case cost:
- unclear symbol targeting ("import what exactly?")
- stale connection state when files change
- poor portability if Monaco-specific logic is deeply embedded

## Goals
- Keep import/code generation correct via AST/LSP-backed symbol truth.
- Support dynamic ports that appear/disappear with real code state.
- Separate semantic logic from editor implementation details.
- Preserve good UX with labels/highlights/prompts without requiring comment enforcement.
- Enable phased rollout with low-risk behavior first.

## Non-Goals
- Full multi-language support in first implementation.
- Perfect semantic classification for every symbol kind on day one.
- Replacing Monaco immediately.

## Decision
Adopt a three-layer model:

1. `syntax-domain` (core, editor-agnostic)
- Parse source files.
- Build symbol index (imports/exports + metadata).
- Maintain connection graph and reconcile intent vs code truth.
- Produce patch plans for imports/related syntax edits.

2. `editor-adapter/monaco`
- Listen to Monaco model events.
- Debounce updates and invoke domain commands.
- Apply edits/decorations/prompts returned by domain/UI orchestrator.

3. `graph-ui orchestration`
- Render nodes/ports/edges.
- Manage interaction states (pending, unresolved, resolved, drifted).
- Trigger symbol picker flows after connection.

## Source of Truth Rules
- Code truth is from AST/LSP analysis.
- Comments/tags are optional metadata only (labeling/grouping/help text).
- Missing comments must not break import generation.
- Invalid comments may warn, but must not change correctness.

## Data Model (Initial)

### Symbol
- `symbolId`: stable identifier (module path + export identity).
- `filePath`
- `name`
- `exportKind`: `default | named | type`
- `language`
- `meta`: optional labels/docs (including parsed comment tags).

### Port
- `portId`: stable id derived from symbol/file identity.
- `nodeId`
- `direction`: `in | out`
- `kind`: `importSlot | exportSymbol | other`
- `label`: display string (from metadata fallback to symbol name).
- `status`: `active | unresolved | removed_recently`

### Connection
- `connectionId`
- `sourcePortId`
- `targetPortId`
- `intent`: what user wired conceptually
- `resolvedSymbolId`: nullable until chosen/resolved
- `status`: `pending | resolved | drifted | broken`

### ImportBinding
- `targetFilePath`
- `moduleSpecifier`
- `importClause` (shape depends on language)
- `symbolId`

## Event Loop
1. File/content event arrives (editor change, save, external refresh).
2. Domain parses affected files and refreshes symbol index.
3. Domain reconciles:
- visible ports
- connection states
- import binding validity
4. UI receives state diff:
- create/update/remove ports
- highlight drift/unresolved connections
5. User action (connect/select symbol) triggers patch plan.
6. Adapter applies patch edits to model/files.
7. Domain reparses and confirms convergence.

## Connection Flow (Target UX)
1. User draws connection from source node to target node.
2. Domain creates `pending` connection and unresolved import placeholder (v1).
3. UI highlights insertion and prompts for symbol selection.
4. If exactly one valid export candidate exists, domain may auto-resolve.
5. Otherwise picker selection resolves connection and finalizes import clause.

## Why Not Comments as Primary Truth
- Comments can drift from real exports/imports.
- Enforcement burden is high and blocks normal coding flow.
- Refactors break metadata-first approaches silently.

Comments remain useful for:
- port labels
- grouping in picker (`API`, `helper`, `hook`)
- optional inline docs

## Failure Modes and Handling
- Symbol removed: mark connection `broken`, show quick-fix picker.
- Symbol renamed: attempt remap by symbol identity, else `drifted`.
- Module path moved: attempt resolver remap, else unresolved import.
- Parse failure: keep last-good graph state, mark affected file `unknown`.
- Conflicting manual edits: preserve code truth, downgrade connection status and request user decision.

## Performance Constraints (Initial)
- Debounce editor change processing (for example 150-300ms).
- Parse incrementally when possible; avoid full-project reparses per keystroke.
- Prefer event-driven editor hooks; no periodic polling unless external file changes require it.
- Virtualize heavy graph rendering for dense hubs (like `app.jsx`).

## Language Scope
- Phase 1 target: JavaScript/TypeScript import/export forms.
- Later: language adapters under same domain contract.

## Phase Plan

### Phase 0: Safe Scaffold
- Connection creates unresolved import stub.
- UI highlights TODO and requires user completion/selection.
- No automatic "best guess" symbol mutation.

### Phase 1: Symbol Picker + Exact Import Generation
- Build export candidate list from source file AST/LSP.
- Auto-resolve when candidate set size is 1.
- Persist resolved binding to connection graph.

### Phase 2: Reconciliation + Drift Recovery
- React to rename/remove/move changes.
- Keep connection intent and code truth both visible.
- Provide quick fixes for broken/drifted links.

### Phase 3: Scale + Multi-Editor Readiness
- Harden adapter contract.
- Ensure Monaco-specific behavior remains adapter-local.
- Add second editor adapter only after contract is stable.

## Acceptance Criteria
- Drag-connection can produce valid unresolved syntax in target file.
- Symbol selection generates correct import statement for JS/TS cases in scope.
- Port list updates when imports/exports change.
- Existing connections transition state correctly when source symbols change.
- Domain logic can be tested without Monaco runtime.

## Open Questions
- Exact placeholder syntax strategy by language when unresolved.
- Best stable identity strategy for renamed exports across file moves.
- How aggressive auto-resolve should be when multiple candidates appear similar.

## Risks
- Overfitting first implementation to one codebase layout.
- Underestimating edge cases for mixed default/named/type imports.
- UI clutter for high-degree nodes without aggregation/filters.

## Rollout Notes
- Ship behind a feature flag.
- Collect telemetry on unresolved->resolved conversion rate and drift frequency.
- Gate expansion to more languages after JS/TS stability.

