# ADR-001: Editor-Agnostic Syntax Core

## Status
- Accepted

## Date
- 2026-02-17

## Context
Litria is introducing connection-driven code updates (for example, wiring modules to create imports). If semantic logic is implemented directly inside Monaco listeners/components, behavior becomes editor-coupled and difficult to port, test, and evolve.

The product direction also expects dynamic symbol-backed ports and reconciliation against real code state, which requires stable domain logic independent of editor UI concerns.

## Decision
Adopt an editor-agnostic `syntax-domain` as the core owner of:
- parsing and symbol discovery
- connection intent and code-truth reconciliation
- patch planning for import/syntax updates
- connection state transitions (`pending`, `resolved`, `drifted`, `broken`)

Monaco-specific logic moves to an adapter layer that only:
- converts editor events into domain commands
- applies returned edits/decorations/prompts
- handles editor lifecycle concerns

## Consequences
Positive:
- Core import/connection behavior can be tested without Monaco runtime.
- Future editor swap (or multi-editor support) is feasible via adapter replacement.
- Domain rules stay consistent across UI surfaces.

Costs:
- Requires explicit adapter contract and message boundaries.
- Adds initial structural overhead versus direct Monaco-first implementation.

## Alternatives Considered
- Monaco-first architecture (semantic logic in editor layer):
  - Rejected due to tight coupling, lower testability, and higher future migration cost.

## Scope Notes
- This ADR does not define the full adapter API surface.
- This ADR does not mandate immediate support for additional editors.
- This ADR aligns with RFC `docs/rfcs/syntax-domain-architecture.md`.

