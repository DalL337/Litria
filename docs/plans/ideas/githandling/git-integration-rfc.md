# RFC: Git Integration & Team Collaboration Workflow

**Status:** Proposed — Open for Review (idea-stage; zero implementation as of 2026-06-09)
**Date:** 2026-03-30
**Relates to:** the git-integration ADRs 012–017 in *this* `docs/ideas/githandling/` folder, PRD-GIT-001

> ⚠️ **Numbering collision.** The 012–017 numbers used by the git-integration ADRs in this folder are provisional and **conflict with accepted ADRs in `docs/adrs/`** — 012 (Widget/Scaffold Builder), 014 (Glass Material System), 015 (SQLite Persistence), and 016 (Open-Any-Folder), which are all implemented. These idea-stage docs must be **renumbered to the next free ADR numbers when promoted** out of `docs/ideas/`. Until then, "ADR-0xx" in this folder refers only to the local git-integration set, not the canonical ADR series.

---

## 1. Problem

Litria has no Git integration. Users who need version control or collaboration must leave Litria and use a terminal or external Git client. This directly contradicts Litria's north star of lowering the barrier to entry in software development.

Every IDE treats Git as a terminal-first experience — or builds a UI that's still organized around Git's mental model (staging area, branch tree, diff viewer). The user still has to think in Git to use it. The mental model is "which command do I use again?" — even for experienced developers.

---

## 2. Design Overview

A thin, focused abstraction that wraps Git's core team workflow in Litria-native concepts and surfaces it entirely through UI. Git does what it does well. Litria makes it invisible to the user who does not want to see it.

```
┌──────────────────────────────────────────────────────────┐
│  User Intent (UI)                                        │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Connection Modal → Service Picker → Auth Flow      │  │
│  │ Tools > Git > Commit and Push                      │  │
│  │ Tools > Git > Stage and Bucket                     │  │
│  │ Editor Drawer > Bucket Icon                        │  │
│  └────────────────────────────────────────────────────┘  │
│                        │                                  │
│                        ▼ Tauri commands                   │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Rust Backend (git2 crate)                          │  │
│  │ fetch / pull / stage / branch / commit / push      │  │
│  │ file status reporting / auth flow orchestration    │  │
│  └────────────────────────────────────────────────────┘  │
│                        │                                  │
│                        ▼ Git protocol                     │
│  ┌────────────────────────────────────────────────────┐  │
│  │ External Git Server (not managed by Litria)            │  │
│  │ GitHub / GitLab / Codeberg / Gitea / Forgejo / ... │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Connection Model

Litria connects to any Git-compatible server. The server may be cloud-hosted or self-hosted on a LAN. Litria treats both identically — it does not know or care which it is connected to (ADR-012).

Connection is configured through a modal accessible from two entry points: Project Setup when starting a new team project, and Tools in the menu bar for updating or changing an existing connection.

**Authentication** is delegated to the Git service (ADR-016). Litria acts as a login broker:

1. User selects their Git service (GitHub, GitLab, Codeberg, Self-hosted)
2. Litria walks them through that service's auth flow (OAuth device flow, PAT, etc.)
3. The service owns the auth — Litria holds the session token in memory or delegates to OS keychain
4. Litria never stores the user's password

A **connection status indicator** lives in the Litria UI at all times — connected, disconnected, or auth-failed.

---

## 4. Team Member Workflow End to End

A team member opens Litria. If new commits exist on the remote, Litria surfaces a notification. The user pulls the latest changes (merge strategy, no history rewriting). They work — coding, testing, documenting — using Litria normally. When work is complete they access Tools > Git to either commit and push directly or create a Bucket for more intentional grouping before pushing.

At no point does the user need to open a terminal, type a Git command, or understand what is happening at the Git layer.

---

## 5. The Bucket System

A Bucket is a named collection of related files that will be staged, branched, committed, and pushed together as one unit (ADR-014). It is Litria's primary abstraction over the Git staging and branching workflow.

### 5.1 Creating a Bucket

The Stage and Bucket modal presents two panes. The left pane is a mini file explorer — a tree view of the project filtered by file state. The right pane is the active bucket, showing files added to it.

Two checkbox filters at the top: Untracked and Modified (ADR-017). Both filter the file tree and list simultaneously. Files are added by dragging from the tree into the bucket pane, or via a plus button. Files already in the bucket can be removed individually.

### 5.2 Completing a Bucket

1. User provides a bucket name
2. Litria auto-suggests a branch name (bucket name + username + date) — editable
3. User writes a commit message
4. User presses Continue
5. Litria executes without further input: stage > branch > commit > push
6. User sees success or error state

### 5.3 Editor Drawer Entry Point

A bucket icon in the editor drawer next to each file (ADR-015). Grey/inactive when the file is dirty or unsaved. Active when clean and saved. Tapping the active icon opens the Stage and Bucket modal with that file pre-loaded.

### 5.4 Commit and Push (Non-Bucket Path)

For work that doesn't need bucketing. A lightweight modal collects a commit message and pushes to the current branch. A guard warns when pushing to the default branch (e.g., `main`).

---

## 6. Technical Breakdown

### 6.1 Frontend (React)

- Repository connection modal (service picker, auth flow, test connection)
- Connection status indicator (connected, disconnected, auth-failed)
- Incoming commits notification
- Pull confirmation and progress feedback
- Tools > Git menu routing
- Stage and Bucket modal (two-pane, drag and drop, filters, branch naming, commit message)
- Commit and Push modal (commit message, main-branch guard)
- Editor drawer bucket icon (two visual states, tap handler)
- Success and error feedback for all Git operations

### 6.2 Backend (Tauri / Rust)

- All Git operations via `git2` crate (ADR-013) — fetch, pull, stage, branch, commit, push
- Auth flow orchestration per service (ADR-016)
- Repository connection validation and test
- Real-time file status reporting (untracked, modified, clean, dirty)
- Session token handling (in-memory + OS keychain delegation)
- Branch name suggestion generation
- Merge conflict detection and clean abort
- Structured error responses to frontend

### 6.3 Data Flow

Frontend collects user intent via UI. Passes intent to Tauri backend via commands. Backend executes Git operations, returns structured result. Frontend renders feedback. No Git operations occur in the frontend.

---

## 7. Implementation Phases

**Phase 1 — Connection and Pull**
Service picker, auth flow orchestration, credential delegation, connection status indicator, fetch and pull, incoming commit notification.

**Phase 2 — Commit and Push**
Commit and Push modal, main-branch guard, push to current branch, success/error feedback.

**Phase 3 — Stage and Bucket**
Full bucket modal, two-pane layout, drag and drop, checkbox filters, auto-suggested branch naming, stage > branch > commit > push flow, editor drawer bucket icon.

**Phase 4 — Polish and Edge Cases**
Conflict handling, offline behavior, branch convention settings, multiple remotes, `.gitignore` handling, user feedback integration.

---

## 8. Open Questions

1. **Conflict handling depth** — V1 detects and aborts cleanly. Should v2 include a basic conflict resolution UI, or is the terminal drawer sufficient?
2. **Branch naming conventions** — Should teams be able to define a branch naming template that overrides the default suggestion?
3. **Multiple remotes** — V1 assumes a single remote. Sufficient for all expected configurations?
4. **Offline behavior** — Bucketing and local commits could still work offline. How should the UI communicate disconnected state?
5. **`.gitignore` handling** — Should Litria auto-generate one based on project type? Should the bucket modal respect existing ignore rules?
6. **Bucket history** — Should Litria keep a lightweight history of completed buckets as a "what did I push" reference?

---

## 9. Alternatives Considered

**Litria hosts its own sync server**
Rejected. Infrastructure scope, security liability, and operational complexity fall outside Litria's product mission. Connector model is cleaner and puts responsibility where it belongs (ADR-012).

**Shell out to system Git binary**
Rejected. Dependency on system Git installation, inconsistent cross-platform behavior, shell injection risk. libgit2 via `git2` is more reliable and controllable (ADR-013).

**Expose full Git UI inside Litria**
Rejected for v1. Rebase, cherry-pick, blame, graph, stash — significant scope that most Litria users do not need. Terminal drawer remains available. Git UI surface can expand in future versions based on actual user needs.

**Litria manages credentials in user profile**
Rejected. Makes Litria responsible for token lifecycle, expiration, refresh, and cross-platform secure storage. Delegating auth to the service is simpler and more secure (ADR-016).

---

## 10. References

- ADR-012: Litria Connects to Standing Git Servers — Connector Only
- ADR-013: Use libgit2 via the git2 Rust Crate
- ADR-014: Buckets as Litria-Native Abstraction Over Git Workflow
- ADR-015: File State Drives Bucket Icon in Editor Drawer
- ADR-016: Authentication Delegated to Git Service
- ADR-017: Checkbox Filters in Stage and Bucket Modal
- PRD-GIT-001: Git Integration & Team Collaboration
- libgit2 documentation: https://libgit2.org
- git2 Rust crate: https://crates.io/crates/git2
