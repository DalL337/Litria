# ADR-017: Checkbox Filters in Stage and Bucket Modal Filter Both File List and Tree

## Status
- Proposed

## Date
- 2026-03-30

## Context
The Stage and Bucket modal presents a two-pane layout — a file tree on the left and the active bucket on the right. Users need to distinguish between untracked files (new files Git does not yet know about) and modified files (existing files that have changed). The team needed to decide how these filters behave.

## Decision
Untracked and Modified checkboxes in the Stage and Bucket modal filter both the displayed file list and the mini file tree simultaneously. When only Untracked is checked, the tree surfaces only new files. When only Modified is checked, the tree surfaces only changed tracked files. Both checked shows everything eligible.

## Consequences

Positive:
- Filtering both panes simultaneously keeps the UI coherent — what you see in the tree matches what you can add
- Reduces noise, especially in large projects where only a subset of files are relevant to a given bucket
- Gives users surgical control over commit contents without requiring Git knowledge
- Untracked versus modified is a meaningful distinction that maps to real Git state without requiring users to understand that state deeply

Costs:
- The Tauri backend must provide real-time file status (tracked, untracked, modified, clean) to the frontend
- Filter state must reset cleanly when the modal is closed and reopened
- The file tree component must support dynamic filtering without jarring re-renders

## Alternatives Considered
- Filters apply to file list only, tree always shows everything: Rejected — creates incoherence between the two panes. Users would see files in the tree that don't appear in the list, causing confusion.
- No filters, show all eligible files always: Rejected — too noisy for large projects. Users would need to visually scan hundreds of files to find the ones they want.

## Scope Notes
- This ADR covers filter behavior in the Stage and Bucket modal only
- This ADR does not define `.gitignore` handling (open question in PRD-GIT-001)
- This ADR does not define the visual design of the filter checkboxes

## References
- ADR-014: Buckets as Litria-Native Abstraction Over Git Workflow
- PRD-GIT-001: Git Integration & Team Collaboration
