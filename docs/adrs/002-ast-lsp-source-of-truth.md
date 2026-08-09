# ADR-002: AST/LSP as Source of Truth

## Status
- Accepted

## Date
- 2026-02-17

## Context
Connection-driven code updates require reliable import/export understanding. A comment-first model is appealing for labeling and hygiene, but comments can be missing, stale, or incorrect after refactors.

Litria needs consistent behavior when generating imports, reconciling drift, and updating dynamic ports as code changes.

## Decision
Use AST/LSP-derived code structure as the source of truth for semantic behavior:
- symbol discovery
- import/export validity
- connection resolution
- drift/broken-state detection

Treat comments/tags as optional metadata only:
- display labels
- grouping hints (for example `API`, `helper`, `hook`)
- inline explanatory context

Comments must not be required for correctness.

## Consequences
Positive:
- Import generation remains correct even when comments are absent.
- Refactor resilience improves (rename/move/remove handled from code reality).
- Dynamic port lifecycle can track actual symbols reliably.

Costs:
- Requires parser/LSP integration and normalization logic.
- Symbol identity/remapping across edits becomes a domain responsibility.

## Alternatives Considered
- Comments as primary truth:
  - Rejected due to metadata drift risk and higher operational enforcement burden.

- Hybrid with comments overriding AST/LSP:
  - Rejected because metadata should not override executable truth.

## Scope Notes
- Comments are still encouraged for UX clarity.
- Missing or malformed metadata may warn but should not block flow.
- This ADR aligns with RFC `docs/rfcs/syntax-domain-architecture.md`.

