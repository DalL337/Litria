# ADR-013: Use libgit2 via the git2 Rust Crate for Git Operations

## Status
- Proposed

## Date
- 2026-03-30

## Context
Litria needs to perform Git operations — fetch, pull, stage, branch, commit, push — from within the Tauri Rust backend. Two primary options were considered: shelling out to the system Git binary via command execution, or using a native Rust Git library.

## Decision
Litria will use the `git2` crate, which provides Rust bindings to libgit2, for all Git operations in the backend.

## Consequences

Positive:
- No dependency on the user's system having Git installed
- Consistent behavior across operating systems
- No shell injection risk — operations are performed programmatically, not via string commands
- Fits cleanly into the Tauri backend without spawning external processes
- Aligns with the lesson from ADR-010 and the Windows LSP spawn pipeline — avoid shelling out where a library binding exists
- Provides the full operation surface needed: fetch, pull, stage, branch, commit, push

Costs:
- Adds `git2` as a dependency with a native C library component (libgit2)
- Some advanced Git operations not exposed by libgit2 would require alternative approaches if needed in the future
- Team must be familiar with the `git2` API when extending Git functionality

## Alternatives Considered
- Shell out to system Git binary: Rejected — introduces dependency on system Git installation, inconsistent behavior across platforms, and potential shell injection risk. Contradicts the pattern established in ADR-010.

## Scope Notes
- This ADR covers the Git operation layer only (Rust backend)
- This ADR does not define which Git operations Litria exposes to users (see PRD-GIT-001)
- This ADR does not cover frontend Git state display (see ADR-017)

## References
- ADR-010: Cross-Platform Build, Distribution & Platform Abstraction
- PRD-GIT-001: Git Integration & Team Collaboration
- libgit2 documentation: https://libgit2.org
- git2 Rust crate: https://crates.io/crates/git2
