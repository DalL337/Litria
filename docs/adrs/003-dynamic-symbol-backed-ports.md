# ADR-003: Dynamic Symbol-Backed Ports

## Status
- Accepted

## Date
- 2026-02-17

## Context
Connection UX in Litria needs to reflect real code state. Static, template-defined ports are predictable but quickly become brittle for file-first workflows where imports/exports evolve continuously.

The system must support:
- ports appearing/disappearing as symbols change
- stable connections across edits/refactors
- clear unresolved/drifted states instead of silent breakage

## Decision
Ports are runtime-generated from AST/LSP-derived symbol state (not hardcoded templates).

Port identity must be symbol-backed and stable:
- `portId` derives from symbol/file identity
- labels are display metadata only and may change without breaking connections

Port lifecycle is reconciliation-driven:
- add ports when new valid symbols/import slots appear
- update ports when symbol metadata changes
- mark removed symbols as unresolved/broken connection states before cleanup

## Consequences
Positive:
- Graph reflects actual code truth.
- Refactors are survivable when symbol identity can be remapped.
- Reduced edge-case burden from maintaining static port templates.

Costs:
- Requires robust reconciliation logic and stable identity strategy.
- Dense nodes need aggregation/virtualization to avoid visual overload.

## Alternatives Considered
- Fixed template ports:
  - Rejected for high mismatch risk with real code and high maintenance cost.

- Label-based identity (for example comment labels as IDs):
  - Rejected because labels are mutable metadata and not semantic identity.

## Scope Notes
- Display labels may come from comments/tags but do not define existence.
- When symbols disappear, UI should surface drift/broken states and recovery actions.
- This ADR aligns with RFC `docs/rfcs/syntax-domain-architecture.md`.

