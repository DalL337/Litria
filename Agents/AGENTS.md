# AGENTS.md

## 1. Purpose and Sources of Truth

This file defines repository-specific operating rules for coding agents working
on Litria. It is the first thing an agent reads; everything here is either a
policy to follow or a pointer to the document that owns the details.

Sources of truth, in order of authority:

- **Guards** (`scripts/*-guard.mjs`) — the enforced floor. When prose and a
  guard disagree, the guard wins and the prose gets fixed.
- **`docs/Orchestration.md`** — the living architecture reference: domain
  register, dependency rules, domain contract, shell contract.
- **`docs/ui-governance.md`** + ADR-008 — UI technology and styling contract.
- This file — repository-wide process policy and the entry point for agent
  governance: the policy dispatch table (§2), the suite's provenance and
  housekeeping rule (§3), the architecture quick-rules, and the git policy.
  Task-scoped execution detail lives in the policy suite, loaded per-task.
- **`Agents/docs/*`** — scoped agent-governance procedures. They are mandatory
  when the dispatch table (§2) matches the task, and they own the execution
  details within their defined scope.

## 2. Policy Dispatch — load only what the task needs

Read the work request, match it against this table, and load ONLY the
policies the task actually needs — never the whole suite. A policy loads
BEFORE the work it governs begins. Failure to load a matching policy is an
execution error.

| When the task involves… | Load and follow |
|---|---|
| Research, investigation, debugging, architecture discovery, repository exploration, documentation review, root-cause analysis | `docs/persistent-research-policy.md` — **before the first tool call** (journal-first) |
| Writing or changing code (any language) | `docs/implementation-policy.md` |
| Preparing any PR, completing a milestone/slice, changing a domain API or architecture boundary | `docs/verification-policy.md` |
| Creating or updating repo documents (ADRs, plans, briefs, notes) | `docs/documentation-policy.md` |
| Release work: version bumps, bundling, release builds | `docs/release-policy.md` |
| Security-relevant work: new execution/network surface, dependency changes, supply-chain features, audit passes | `docs/security-policy.md` |

Reserved scopes — files exist but are empty; rules accumulate as lessons are
learned. An empty policy means no rules exist yet for that scope: proceed on
general judgment and AGENTS.md, and when a lesson emerges, codify it there
(with provenance) rather than growing this file:

`planning` · `review` · `test-authoring` · `dependency-change` · `migration`
· `handoff` · `failure-and-recovery`

A task matching multiple rows loads multiple policies (e.g. a code slice that
ends in a PR loads implementation + verification; an investigation that
produces an ADR loads research + documentation).

## 3. Provenance

This suite was not written up front. Every rule in it was extracted from a
real session on this repository — a bug that shipped, a check that was
skipped, a loophole an audit found — and codified where the next agent would
look for it. Rules carry the date and the incident that produced them on
purpose: a rule whose origin you can read is a rule you can argue with when
it stops fitting.

The suite is published as-is, in the shape it grew into. It is repository-
specific by design; the transferable part is the method, not the specifics.

> Housekeeping rule for agents: keep this suite free of personal or account
> data — names, email addresses, account IDs, local machine paths, or
> third-party identities. Rules describe *behavior* and cite roles ("the
> owner") and artifacts (PR numbers, guard scripts, ADRs). Concrete identity
> values live in local git config and agent memory, never in these files.

## 4. Architecture Rules

### 4.1 Domain Placement (required)

For any newly proposed feature, behavior, hook, helper, or utility:
- Evaluate placement against the **Domain Register** in
  `docs/Orchestration.md` §2.
- Prefer the existing owning domain when a clear fit exists.
- If no suitable domain exists, propose a new domain before implementation.
- When a new domain is accepted, add it to the Domain Register and confirm
  the guard scan globs cover its directory.

### 4.2 App Shell Contract

`App.jsx` is a composition shell. Anything living there must pass the
four-rule test (authoritative copy: `docs/Orchestration.md` §1.3):

1. **Imports.**
2. **Hook invocations** (`src/app/use*` or `src/behaviors/use*`).
3. **Truly cross-cutting wiring** with no natural domain owner.
4. **Composition** that would force a bad abstraction to extract.

The enforced import surface is the **shell composition manifest** in
`scripts/app-shell-guard.mjs` (ratified 2026-07-10). When the guard rejects a
new import, the default response is **extract**, not amend the manifest;
additions require a one-line rationale comment. The guard checks imports
only — inline logic growth must be caught in review with the four-rule test.
Line count is a symptom, not the invariant.

## 5. Engineering Rules — moved

Moved to `docs/implementation-policy.md` (2026-07-13). Load it whenever
writing or changing code (§2).

## 6. Verification Policy — moved

Moved to `docs/verification-policy.md` (2026-07-13). Load it when preparing
any PR or completing a slice (§2).

## 7. Git Policy

### 7.1 Branch Lifecycle

Each coherent unit of work gets its own new branch, opened from `main`.

**A "coherent unit of work" is any one of:**
- A feature.
- A refactor or migration.
- A chore (cleanup, test infrastructure, dependency updates, CI fixes).
- A bug fix that touches multiple files or areas.
- A documentation pass that goes beyond a single targeted edit.

**Rules:**

1. **One unit, one branch.** Do not pile new unrelated work onto an existing
   branch — even if that branch is still open, even if it hasn't been merged
   yet, even if the same area of the codebase was touched recently. New work
   means a new branch.

2. **Branch from `main`, not from another feature branch.** Each new branch
   starts from a fresh clean `main`. Branching off another feature branch
   inherits its unmerged commits, which corrupts the new branch's diff and
   creates downstream merge ordering hazards.

3. **Default interpretation rule (important for agents):** When the user says
   "branch, stage, commit, push" — or any equivalent phrasing for taking new
   work to GitHub — the default interpretation is **always create a new branch
   off `main` first**. If the user intends to reuse an existing branch (e.g.
   continuing work on an in-review PR), they must state that explicitly. If
   the current branch is anything other than `main` and the user has not
   explicitly said "use the current branch," **stop and ask** before staging.

4. **Branches are short-lived.** Open PR → review → merge → delete the branch.
   Once a branch's PR has merged, that branch is done — start a new branch off
   the freshly-updated `main` for the next unit of work.

5. **Allowed exceptions** (where reusing the existing branch is correct):
   - In-review PR feedback: changes requested by reviewers go on the same
     branch as the PR they belong to.
   - Multi-commit single PRs: a coherent unit of work can have multiple
     commits per the bucketing rules below.
   - Hotfixes to a release branch (none currently exist in this repo).

**Why this rule exists:** Without it, multiple unrelated changesets accumulate
on a single branch. When the branch's PR is merged based on a snapshot, any
commits pushed *after* the snapshot become orphans that never reach `main` —
silently breaking CI on `main` because the merged code references things that
only exist on the still-active feature branch. This happened during the SQLite
cutover (the `dbStorage.js` fix landed on `feat/new-project-wizard` after
PR #35 was already merged, requiring a follow-up PR #36 to unblock `main`).
Each coherent unit on its own branch makes this class of problem structurally
impossible.

### 7.2 Branch + PR vs Direct Push

1. **Branch + PR is required for risky changes:**
   - Runtime behavior or UX changes.
   - Any file under `src/` or `src-tauri/src/`.
   - App/build config changes that can affect shipped behavior.
   - Refactors, dependency updates, or anything with regression risk.
   - Guard scripts (`scripts/*-guard.mjs`) — they are enforcement code.

2. **Direct push to `main` is allowed for low-risk changes:**
   - Docs/plans/notes only (`docs/**`).
   - Non-behavioral metadata updates.
   - Release version bump commit, after scope is finalized.

3. **If docs depend on unmerged code, keep docs with that branch.** Do not
   push docs to `main` if they describe behavior that is not merged yet.

4. **Default safety rule:** if uncertain, use a branch + PR.

### 7.3 Commit Bucketing

Group changes by intent:
- `fix/*` or `feat/*` code changes in separate commits from docs.
- Docs/plans in their own commit.
- Release/version bump in its own commit.

### 7.4 Pre-Push Checklist

- Confirm branch context (`git branch --show-current`).
- **Verify the branch is appropriate for this work.** If the current branch
  was used for a previously-merged or unrelated unit, stop and create a new
  branch off `main` per §7.1.
- Review staged files (`git status --short`).
- Ensure commit scope matches file set — and after committing, verify the
  files-changed count in the commit output (verification-policy Rule 3).
- Run relevant checks/tests for code changes (verification-policy).

### 7.5 Version Bump Order

Apply version bumps last in the sequence:
1. Merge code branches first.
2. Push docs/plans updates.
3. Bump version after release scope is locked.

### 7.6 Commit Identity

The repository has exactly one valid author/committer identity. It is pinned
per-clone in local git config — it is not recorded in this file, and an agent
must never guess it or copy it from a session banner.

- **Verify before pushing**, every clone, every time:
  `git log -1 --format="%an <%ae>"`. Session banners, environment variables,
  and the platform's "current user" are not evidence of what git will stamp.
- **Never author with a personal email address.** Use the GitHub-provided
  `users.noreply.github.com` address so private contact details never enter
  commit metadata, message trailers (`Signed-off-by`), or file contents — all
  three surfaces have to be checked, not just the first.
- **A misconfigured identity is not a cosmetic bug.** A wrong author name can
  attribute the entire codebase to an unrelated third party on the
  contributors graph. Treat identity drift on a fresh clone as a blocking
  defect: fix the config before the first commit, not after the push.
- If identity is wrong on work already committed, stop and surface it to the
  owner rather than pushing — the fix is a history rewrite, which is the
  owner's call.

## 8. Release Process — moved

Moved to `docs/release-policy.md` (2026-07-13). Load it for version bumps,
bundling, and release builds (§2).

## 9. UI Technology Policy

Full decision rubric and styling contract: `docs/ui-governance.md` (Section 10)
and ADR-008. Quick reference: **shadcn** for interactive overlays needing
focus traps / keyboard nav / ARIA; **Tailwind** for new layout and styling
shadcn internals (coexists indefinitely with existing BEM CSS — no
migration); **hand-rolled BEM** for domain components and protected zones.

**Protected zones** must never import shadcn/Radix. The authoritative file
list is `PROTECTED_FILES` in `scripts/protected-zone-guard.mjs` — defer to
it, don't restate it. All UI conforms to the `docs/ui-governance.md` styling
contract (cm design tokens, glass surfaces, LED glow spec, radius
conventions, WCAG AA contrast).

Governance: ADR-006 (Tailwind), ADR-007 (shadcn), ADR-008 (protected zones),
RFC `docs/rfcs/ui-component-layer-strategy.md`,
PRD `docs/prds/tailwind-shadcn-migration-prd.md`.

## 10. Markdown Linting — moved

Moved to `docs/documentation-policy.md` Rule 2 (2026-07-13).
