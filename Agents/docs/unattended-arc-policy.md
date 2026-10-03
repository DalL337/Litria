# Unattended Arc Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Load **before writing an
arc for the owner's unattended build-and-review runner**, and again when acting
on its results.

Added 2026-10-03 from the runner's first trial, the
[tab-close build plan](../../docs/plans/agent-integration/tab-close-reindex-build-plan.md)
(PR #107). The runner ("Arc Relay") is the owner's local tool and is not part
of this repository; agent memory records where it lives and how to invoke it.
Given a committed arc checklist, it has one coding agent build the whole
checklist in an isolated worktree over a bounded number of passes, runs the
standard checks itself, has a second agent review the result once in a
separate clone, and stops. It never merges, pushes, or repairs findings.

## Rule 1 — When to Reach for It

Reach for it when all of these hold:

- the work is a written arc of concrete, checkable tasks (`- [ ]` items), and
  everything a builder would need to ask is already written down: nobody can
  answer questions during a run;
- the standard checks ([verification policy](verification-policy.md) Rule 1)
  can judge the result: domain logic, a bug fix with a reproducible failing
  test, a refactor under tests;
- an independent adversarial review is wanted, or the owner will be away
  (overnight, a long arc) and wants progress plus a review to read afterwards.

Do not use it for:

- work that needs visual verification ([implementation policy](implementation-policy.md)
  Rule 6), a live app pass, or hardware the builder does not have;
- decisions only the owner can make, or a spec still in flux;
- release work or dependency changes: their policies require evidence a single
  unattended pass is not set up to gather;
- a change you would finish before the run's setup does.

## Rule 2 — Writing the Arc

- The arc and the adversarial policy must be committed on the branch the run
  starts from, and the checkout must be clean. A docs-only arc may go straight
  to `main` (AGENTS.md §7.2); otherwise start from a worktree branch.
- Checklist item text is frozen for a run. The builder ticks boxes, or marks
  an item `[~]` and explains it under `## Blockers`.
- **Name the sequences that can go wrong, not only the goal.** The first
  trial's arc required only that "a reopen during the read wins". The builder
  delivered exactly that, and the review reproduced three races the arc never
  named: a project switch, a repeated close, and a rename or delete during the
  read. An arc that makes something asynchronous must list what may change
  while it waits.
- Cap a first or uncertain run with a low pass limit and agent timeout.

## Rule 3 — Acting on the Result

- Read the verdict at the top of the morning report, then the review. A
  successful exit means the build gates passed and the review completed, not
  that the review approved.
- Review findings arrive *suspected*
  ([adversarial check policy](adversarial-check-policy.md) statuses).
  Reproduce each one before fixing it, and turn it into a failing test first.
- Fix by hand on the run's branch, commit, and re-review **the whole arc** from
  the first run's base (the runner's review-base option), not just the newest
  commit.
- **A refactor during fix rounds must keep every earlier case pinned by a
  test.** In the trial, round 3 replaced two guards with one simpler fence and
  silently dropped a case no test pinned (two closes with no reopen between
  them); the next review caught it.
- **Agree the last round in advance.** Rounds should shrink (the trial went
  3 findings, then 1, then 1, then an approval). If the agreed last round still
  finds more than adjustments, move to an ordinary PR review with the owner
  rather than looping again.

## Rule 4 — From Run to Pull Request

- The run's `relay/<id>` branch is a local working branch. Replay its commits
  onto a branch off `main` (§7.1), reword the builder's checkpoint commits into
  house style with their provenance in the body, and confirm the replayed tree
  is identical to the reviewed commit before pushing.
- The merge gate does not change (§7.4): every required check on the head SHA,
  plus the owner's live check when the arc has one.
- Remove run worktrees only after the merge, and check them for junctions
  first: `git worktree remove --force` follows junctions and deletes what they
  point to.
