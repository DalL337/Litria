# ADR-014: Buckets as Litria-Native Abstraction Over Git Staging and Branching

## Status
- Proposed

## Date
- 2026-03-30

## Context
Standard Git workflow requires users to understand staging, branching, committing, and pushing as distinct, sequential operations with their own syntax and mental model. Litria's target users — particularly beginners — have little to no familiarity with this model. The team needed to decide how to surface Git's power without exposing its complexity.

## Decision
Litria introduces Buckets as a first-class product concept. A Bucket is a named group of related files that maps internally to a Git staging set, a new branch, a commit, and a push — executed as one guided flow. The user thinks in terms of work, not Git operations.

## Consequences

Positive:
- Users get a natural mental model — grouping related work together — without requiring Git knowledge
- Encourages clean commit hygiene by design rather than by instruction
- Branch naming is auto-suggested but editable, removing a common point of friction
- The underlying Git operations are standard — Buckets are purely a UX abstraction
- Aligns with Litria's north star: everything available in the terminal, available through the UI

Costs:
- Litria owns the Bucket concept and its UX — documentation and onboarding must explain it clearly
- Users coming from a Git background may need a brief mapping between Bucket concepts and Git terminology
- The Bucket flow covers the primary use case — complex workflows like rebasing or cherry-picking remain in the terminal drawer

## Alternatives Considered
- Expose standard Git UI (staging area, branch picker, commit dialog): Rejected — still requires users to think in Git. Does not solve the mental model problem for beginners.
- Expose full Git UI inside Litria (rebase, cherry-pick, blame, graph, stash): Rejected for v1 — significant scope and complexity that most Litria users do not need. Terminal drawer remains available for power users.

## Scope Notes
- This ADR covers the Bucket concept and its mapping to Git operations
- This ADR does not define the Bucket modal UI layout (see PRD-GIT-001 Section 5.3)
- This ADR does not cover the editor drawer bucket icon behavior (see ADR-015)

## References
- ADR-015: File State Drives Bucket Icon in Editor Drawer
- PRD-GIT-001: Git Integration & Team Collaboration
- RFC: `docs/ideas/githandling/git-integration-rfc.md`
