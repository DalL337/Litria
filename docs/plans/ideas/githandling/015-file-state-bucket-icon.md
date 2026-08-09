# ADR-015: File State Drives Bucket Icon Availability in the Editor Drawer

## Status
- Proposed

## Date
- 2026-03-30

## Context
The team needed to decide how to signal to users which files are eligible for bucketing and when. Presenting the bucketing action on all files regardless of state could lead to errors — committing unsaved or dirty files produces unreliable results.

## Decision
The bucket icon in the editor drawer will reflect file state. A grey, inactive icon indicates the file is dirty or unsaved and bucketing is unavailable. An active bucket icon indicates the file is clean and saved and bucketing is available. Tapping the active icon launches the Stage and Bucket modal with that file pre-loaded.

## Consequences

Positive:
- The icon communicates state without text, tooltips, or interruptions
- Gating the bucket action on file cleanliness prevents users from accidentally committing unsaved work
- Pre-loading the tapped file into the modal reduces friction and makes the workflow feel intentional
- Consistent with Litria's philosophy of teaching through interaction rather than alongside it

Costs:
- The editor drawer component must maintain awareness of file save state and Git status
- The bucket icon requires two distinct visual states that are clearly distinguishable
- The Tauri backend must expose file and Git status to the frontend in real time

## Alternatives Considered
- Always-active icon with validation on tap: Rejected — delays the error feedback. Users would tap, see an error, then have to save and try again. The grey state teaches the prerequisite (save your file) before the user even tries.
- No icon, menu-only access: Rejected — removes the contextual entry point from the file being worked on. Adds friction by requiring navigation to the Tools menu.

## Scope Notes
- This ADR covers the bucket icon's state behavior in the editor drawer only
- This ADR does not define the icon's visual design or specific styling tokens
- This ADR does not cover the Stage and Bucket modal itself (see ADR-014, PRD-GIT-001)

## References
- ADR-014: Buckets as Litria-Native Abstraction Over Git Workflow
- PRD-GIT-001: Git Integration & Team Collaboration
