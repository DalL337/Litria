# Product Requirements Document: Git Integration & Team Collaboration

**PRD-GIT-001 | Version 1.0 | March 30, 2026**

| Field | Value |
|---|---|
| Document ID | PRD-GIT-001 |
| Version | 1.0 |
| Date | March 30, 2026 |
| Status | Proposed — idea stage, not scheduled for implementation |
| Project | Litria |
| Component | Git integration, team collaboration workflow |
| Tech Stack | Tauri (Rust backend via `git2` crate), React (modals, menus, status indicators) |
| Prerequisites | ADR-012, ADR-013, ADR-014, ADR-015, ADR-016, ADR-017 |

---

## 1. Purpose and Scope

### 1.1 Purpose

Provide a fully UI-driven Git workflow within Litria that allows individual users and teams to connect to an external Git server, pull project changes, organize work into named Buckets, and push clean commits — without opening a terminal or knowing Git syntax.

Litria does not host, manage, or operate any Git infrastructure. It connects to a standing Git server provided and managed by the team, organization, or administrator. Litria's responsibility begins and ends at the read/write handshake.

### 1.2 Problems Solved

1. **Terminal dependency for collaboration**: The existing workflow requires users to leave Litria and operate Git through a terminal — directly contradicting Litria's core philosophy of making every terminal action available through UI and UX.
2. **Beginner friction**: Litria's primary audience has little to no familiarity with Git concepts, branching strategies, or commit hygiene. The mental model is "which command do I use again?" — even for experienced developers.
3. **No collaboration path**: There is currently no way to collaborate on projects, track changes, or synchronize work across machines and team members from within Litria.

### 1.3 Scope

- Repository connection modal (cloud and LAN Git servers)
- Service-delegated authentication (OAuth, PAT — Litria brokers login, service owns auth)
- Connection status indicator
- Incoming commit notification and pull workflow
- Commit and Push flow (lightweight, direct to current branch)
- Stage and Bucket flow (named file groups mapped to branch/commit/push)
- Editor drawer bucket icon with file-state gating
- Tools > Git menu structure

### 1.4 Out of Scope

- Litria will not host, spin up, or manage any Git server infrastructure
- Litria will not implement its own version control system
- Litria will not manage user access, permissions, or repository administration
- Merge conflict resolution UI (v1 detects and surfaces — resolution deferred)
- Pull request creation or review
- Branch visualization or Git graph
- Repository browsing or search
- Git blame or annotation views
- Rebase, cherry-pick, stash, or advanced Git operations (terminal drawer remains available)

---

## 2. Background

### 2.1 Current State

Litria has no Git integration. Users who need version control or collaboration must leave Litria and use a terminal or external Git client. This is acceptable for power users but creates a wall for beginners.

### 2.2 Design Philosophy

Every IDE treats Git as a terminal-first experience — or builds a UI still organized around Git's mental model (staging area, branch tree, diff viewer, commit graph). The user still has to think in Git to use it. Litria flips this: organize around the *work*, let Git be the plumbing underneath. Users think in terms of "this group of files is my commit" — not `git add`, `git checkout -b`, `git commit -m`, `git push`.

### 2.3 Connector Model

Litria is a connector, not an infrastructure platform. It reads from and writes to a Git server that already exists — whether cloud-hosted (GitHub, GitLab, Codeberg, Bitbucket) or self-hosted on a LAN (Gitea, Forgejo, or similar). Litria treats both identically. This keeps Litria lightweight, focused, and aligned with its local-first philosophy.

### 2.4 Dependencies and Constraints

- A standing Git server must be provided and managed externally
- The `git2` Rust crate (libgit2 bindings) for all Git operations in the Tauri backend
- Litria user profile system for storing connection configuration
- Editor drawer component for housing the bucket icon state
- Platform-native auth flows per service (OAuth device flow for GitHub, PAT for self-hosted)

---

## 3. Users

### 3.1 Team Member

The day-to-day user. Opens Litria, pulls latest changes, does their work, and pushes when done. Likely unfamiliar with Git internals. Needs the workflow to feel natural and guided.

### 3.2 Team Lead / Admin

Responsible for setting up the repository connection inside Litria. Technically capable. Sets the repo URL and authenticates once. Team members inherit the configuration.

### 3.3 Power User

Comfortable with Git and the terminal. Uses Litria's UI for convenience but may drop into the terminal drawer for advanced operations. Not blocked by Litria's abstraction layer.

---

## 4. User Stories

### US-1: See incoming changes on open
**As a** team member, **I want to** see new commits when I open Litria, **so that** I know if there is work to pull before I start.

### US-2: Pull latest with one action
**As a** team member, **I want to** pull the latest project state with one action, **so that** I am always working from the current version.

### US-3: Group related files into a bucket
**As a** team member, **I want to** group related files into a named bucket, **so that** my commits are clean and intentional.

### US-4: Auto-suggested branch name
**As a** team member, **I want** Litria to suggest a branch name for my bucket, **so that** I do not have to think about Git branch conventions.

### US-5: One-time team setup
**As a** team lead, **I want to** connect Litria to our repository once, **so that** my team can collaborate without each member needing to configure Git manually.

### US-6: Terminal remains available
**As a** power user, **I want** the terminal drawer to remain available, **so that** I can perform advanced Git operations when needed.

### US-7: No terminal required for collaboration
**As a** beginner, **I want to** never need to open a terminal to collaborate with my team.

### US-8: Service-native authentication
**As a** user, **I want to** log into my Git service through its own auth flow, **so that** Litria never stores my password and the service handles session management.

---

## 5. Product Requirements

### 5.1 Repository Connection

A modal accessible from two entry points — Project Setup and Tools in the menu bar — allows an authorized user to connect Litria to a Git repository.

**Service picker**: The user selects their Git service (GitHub, GitLab, Codeberg, Self-hosted). Litria walks them through that service's authentication flow:

| Service | Auth Flow |
|---|---|
| GitHub | OAuth device flow — Litria opens browser, user authorizes, token returned |
| GitLab | OAuth or PAT — user generates token on GitLab, pastes into Litria |
| Codeberg | PAT — user generates token on Codeberg, pastes into Litria |
| Self-hosted (Gitea, Forgejo, etc.) | Server URL + PAT — user provides endpoint and token |

Litria brokers the login. The service owns the auth. Litria holds the resulting session token in memory or delegates to the OS keychain for persistence across sessions. Litria does not store passwords.

**Additional fields**:
- Repository URL (auto-populated after auth where possible)
- Local project folder to push

**Test connection** option available before committing to the configuration.

**Connection status indicator** visible in the Litria UI at all times — subtle visual cue communicating connected, disconnected, or auth-failed state.

### 5.2 Tools > Git Menu

A Git submenu under Tools in the menu bar provides the primary access points:

- **Commit and Push** — for completed, ready-to-ship work
- **Stage and Bucket** — for organizing, grouping, branching, and pushing intentional change sets

### 5.3 Stage and Bucket

Buckets are a Litria-native concept that map to Git's staging and branching workflow. A Bucket is a named group of related files that are staged, branched, committed, and pushed together as one intentional unit.

**Two-pane layout**:
- Left pane: mini file tree mirroring the OS file explorer, filtered dynamically by file state
- Right pane: active bucket showing files added to it

**Checkbox filters**: Untracked (new files Git has not seen) and Modified (existing files that have changed). Both filter the file tree and list simultaneously.

**Adding files**: Drag and drop from the file tree into the bucket, or use the plus button. Files already in the bucket can be removed individually.

**Completing a bucket**:
1. User provides a bucket name
2. Litria auto-suggests a branch name (bucket name + username + date) — editable
3. User writes a commit message
4. User presses Continue
5. Litria executes: stage selected files > create branch > commit > push
6. User sees success or error state

### 5.4 Commit and Push

A lightweight flow for work that does not require the organizational step of bucketing. A modal collects a commit message and pushes directly to the current branch.

**Guard**: When the current branch is the default branch (e.g., `main`), Litria shows a confirmation: "You are pushing directly to the main branch. Are you sure?" This prevents accidental direct-to-main pushes from beginners who haven't learned branching yet.

### 5.5 Editor Drawer Bucket Icon

A bucket icon in the editor drawer alongside each file. Its state communicates Git status:

| Icon State | Meaning | Behavior |
|---|---|---|
| Grey / inactive | File is dirty or unsaved | Bucketing unavailable — icon is non-interactive |
| Active | File is clean and saved | Tapping opens Stage and Bucket modal with that file pre-loaded |

This gates the bucket action on file cleanliness and provides a low-friction entry point directly from the file being worked on.

### 5.6 Incoming Commit Notification

When a user opens Litria in a team environment, Litria checks the remote for new commits. If new changes exist, a notification is surfaced. The user can pull the latest changes before beginning work.

### 5.7 Pull Workflow

Pull uses a merge strategy (no history rewriting). This is the safest default for beginners. If a pull results in a merge conflict, Litria detects the conflict, aborts the merge cleanly, and shows a human-readable explanation of what happened and what options are available (ask team lead, use terminal drawer, etc.).

---

## 6. Technical Breakdown

### 6.1 Frontend Responsibilities (React)

- Repository connection modal (service picker, auth flow, test connection, save)
- Connection status indicator component (connected, disconnected, auth-failed)
- Incoming commits notification on Litria open
- Pull confirmation and progress feedback
- Tools > Git menu items and routing
- Stage and Bucket modal (two-pane layout, file tree, bucket pane, drag and drop, checkboxes, branch name field, commit message field, continue action)
- Commit and Push modal (commit message, main-branch guard, push action)
- Editor drawer bucket icon (two visual states, tap handler, pre-load file into modal)
- Success and error state feedback for all Git operations

### 6.2 Backend Responsibilities (Tauri / Rust)

- All Git operations via the `git2` crate — fetch, pull, stage, branch, commit, push
- Repository connection validation and test
- Real-time file status reporting (untracked, modified, clean, dirty) exposed to frontend
- Auth flow orchestration per service (OAuth device flow, PAT validation)
- Session token handling (in-memory or OS keychain delegation)
- Branch name suggestion generation
- Merge conflict detection and clean abort
- Error handling and structured error responses to frontend

### 6.3 Data Flow

The frontend collects user intent through UI interactions. It passes that intent to the Tauri backend via commands. The backend executes the corresponding Git operations and returns a structured result. The frontend renders success or error feedback based on that result. No Git operations occur in the frontend.

---

## 7. Implementation Phases

### Phase 1 — Connection and Pull

Repository connection modal, service picker, auth flow orchestration, credential delegation, user profile integration, fetch and pull operations, incoming commit notification, connection status indicator.

### Phase 2 — Commit and Push

Basic Commit and Push flow via Tools > Git. Commit message modal, main-branch guard confirmation, push to current branch, success and error feedback.

### Phase 3 — Stage and Bucket

Full bucket modal, two-pane file explorer, drag and drop, checkbox filters, auto-suggested branch naming, staged branch commit push flow, editor drawer bucket icon.

### Phase 4 — Polish and Edge Cases

Conflict handling improvements, offline behavior, branch convention settings, multiple remote consideration, user feedback integration.

---

## 8. Success Metrics

| Metric | Target |
|---|---|
| Full pull > work > push cycle without terminal | 100% of standard workflows |
| Repository connection setup time | < 2 minutes for an authorized user |
| Bucket creation and push time | < 1 minute for a clean file set |
| Git syntax knowledge required | Zero for any standard team workflow |
| Power user friction from UI abstraction | None — terminal drawer remains available |

---

## 9. Acceptance Criteria

### 9.1 Functional

| # | Criterion | Validation |
|---|---|---|
| F1 | Service picker shows supported services | Open connection modal. Verify GitHub, GitLab, Codeberg, Self-hosted options present |
| F2 | Auth flow completes per service | Select each service. Verify correct auth flow launches and completes |
| F3 | Test connection validates before saving | Enter credentials. Click Test Connection. Verify success/failure feedback |
| F4 | Connection status indicator reflects state | Connect, disconnect network, reconnect. Verify indicator updates |
| F5 | Incoming commits surfaced on open | Push from another client. Open Litria. Verify notification appears |
| F6 | Pull applies remote changes | Pull after notification. Verify local files updated |
| F7 | Commit and Push sends to current branch | Modify file, commit and push. Verify remote receives commit |
| F8 | Main-branch guard fires on default branch | On `main`, use Commit and Push. Verify confirmation dialog appears |
| F9 | Bucket groups files correctly | Add 3 files to bucket. Verify only those 3 are staged |
| F10 | Branch auto-naming works | Create bucket named "auth-fix". Verify suggested branch contains name, user, date |
| F11 | Bucket executes stage > branch > commit > push | Complete bucket flow. Verify new branch with commit appears on remote |
| F12 | Editor drawer icon reflects file state | Modify file (grey icon). Save file (active icon). Verify state transitions |
| F13 | Editor drawer icon pre-loads file into bucket | Tap active icon. Verify Stage and Bucket modal opens with that file in the bucket |
| F14 | Untracked filter shows only new files | Check Untracked only. Verify tree shows only files Git has not seen |
| F15 | Modified filter shows only changed files | Check Modified only. Verify tree shows only tracked files with changes |
| F16 | Merge conflict detected and aborted cleanly | Create conflicting changes. Pull. Verify conflict notification, no corrupted state |

### 9.2 Performance

| # | Criterion | Target |
|---|---|---|
| R1 | Connection modal opens | < 100ms |
| R2 | File status refresh in bucket modal | < 200ms for typical project (< 500 files) |
| R3 | Bucket push completes (stage + branch + commit + push) | < 5s for typical bucket (< 20 files) on LAN |
| R4 | No UI freeze during Git operations | All Git ops async via Tauri commands |

---

## 10. Open Questions

1. **Conflict handling depth** — V1 detects and aborts. Should v2 include a basic conflict resolution UI, or is the terminal drawer sufficient for the foreseeable future?
2. **Branch naming conventions** — Should teams be able to define a branch naming template in Litria settings that overrides the default suggestion?
3. **Multiple remotes** — V1 assumes a single configured remote per project. Is this sufficient for all expected team configurations?
4. **Offline behavior** — When Litria cannot reach the remote, bucketing and local commits could still work. Pull and push would fail. How should the UI communicate this state?
5. **Profile sync** — If Litria profiles sync across machines, are there security implications to syncing auth tokens?
6. **`.gitignore` handling** — Should Litria auto-generate a `.gitignore` based on project type? Should the bucket modal file tree respect existing ignore rules?

---

## References

- ADR-012: Litria Connects to Standing Git Servers — Connector Only
- ADR-013: Use libgit2 via the git2 Rust Crate
- ADR-014: Buckets as Litria-Native Abstraction Over Git Workflow
- ADR-015: File State Drives Bucket Icon in Editor Drawer
- ADR-016: Authentication Delegated to Git Service
- ADR-017: Checkbox Filters in Stage and Bucket Modal
- RFC: `docs/ideas/githandling/git-integration-rfc.md`
- libgit2 documentation: https://libgit2.org
- git2 Rust crate: https://crates.io/crates/git2
