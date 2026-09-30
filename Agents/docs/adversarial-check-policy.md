# Adversarial Check Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Load **before calling a
slice done or opening its PR** when the slice creates or changes an
enforcement point (Rule 1). It is the author's own attack on their code, run
before a peer reviewer sees it.

Added 2026-09-30 from Project API build plan P1 (PR #86). The reader was
described as "bounded" and "policy-checked". It passed 396 tests and four
planted-mistake checks. A second agent's peer review still found two
high-severity disclosure bypasses and three medium defects, and every one
reproduced (Learned Flaws below). Planted mistakes only test the mistakes an
author already imagined. This policy is the missing step: deliberately look
for the ones they did not.

## Rule 1 — When It Applies, and When It Does Not

**Applies** to code whose failure mode is *something is allowed that should
have been refused*:

- access and disclosure decisions (policies, grants, path guards, permission
  checks);
- trust-boundary input handling: parsing, validation, size and work limits on
  input from an external principal, another process or the webview;
- check-then-act filesystem code: anything that checks a path, name or ID and
  then reads, writes, moves, deletes or runs it;
- concurrency fences: epoch checks, locks, "only if still current" logic;
- anything [security-policy](security-policy.md) Rule 1 makes a security
  review mandatory for.

**Does not apply** to UI, styling, docs, tests, refactors that leave every
enforcement point unchanged, or bug fixes outside enforcement code.
Dependency changes have [their own policy](dependency-change-policy.md).

When unsure, ask what happens if the change is wrong. If the answer is that
something gets through that shouldn't, the policy applies. If the answer is
that something looks or behaves wrong, it does not.

## Rule 2 — Budget

The check must stay cheap enough to be done every time it applies:

- **One pass per enforcement point per slice**, not per commit. Re-run only
  for an enforcement point whose code changed.
- **Scale to the change.** A small fix to an existing check needs only the
  questions that touch the changed lines. A new enforcement point gets the
  full set.
- **A list, not an essay.** Record each attack considered with a one-line
  verdict. Five to fifteen lines is typical. No subagents by default.
- **Evidence scales with severity.** A plausible bypass of a disclosure,
  write or execution control gets a reproduction test, written to fail first.
  A low-impact concern gets a note and moves on.
- **Stay inside the slice.** Do not re-audit enforcement code the slice did
  not touch. A pre-existing hole found in passing is reported to the owner
  separately (security-policy Rule 3), not fixed silently mid-slice.

## Rule 3 — The Pass

Walk each enforcement point through these questions. Each one names the
flaw that taught it.

1. **Check versus use.** Is the object that is checked the same object that
   is used? If a path, name or ID is checked and then resolved again to act
   on it, list what can change in between: the file swapped for a link, a
   parent directory swapped, a deletion, a rename, a re-creation, a
   workspace switch, state being rehydrated. Authorize the object actually
   used: the opened handle, the captured snapshot, the epoch-bound state.
   *(Flaws 1 and 2.)*
2. **Identity and aliasing.** Can two inputs reach one object (case,
   trailing dots or spaces, links, hard links, alternate data streams, device
   names)? Can one input reach a different object than intended? Read every
   reused helper's normalization (trimming, case folding, separators) before
   relying on it. *(Flaw 3.)*
3. **Bounds on what is consumed.** Is each limit enforced on what is
   actually read, allocated and emitted? That includes encoded size and
   escaping, memory proportional to input (a vector per line, per match or
   per entry), totals across items, and concurrent callers. Is it enforced
   strictly, with no "just one more character"? *(Flaws 4 and 5.)*
4. **Oracles.** Does any answer, error, count or timing class differ
   depending on whether something withheld exists? Does any message echo the
   caller's input, or expose internals such as absolute paths? *(Flaw 3.)*
5. **Fail direction.** When an OS query fails, returns something
   unexpected, or the platform is unsupported, does the code refuse or allow?
   It must refuse. *(Flaw 2.)*
6. **Platform variance.** What does each supported OS do differently at
   this point: Linux `/proc` markers, Windows junctions, POSIX delete and
   drive roots, macOS firmlinks? Which of these did a test actually run, and
   on which OS? *(Flaw 2.)*
7. **Attack windows need test seams.** A test of state that is present
   *before* the check says nothing about state that changes *after* it. For
   each plausible attack from questions 1–3, add a hook that lets a test
   perform it deterministically, inside the exact window. *(Flaws 1 and 2.)*

For "what other path produces this same effect?", see security-policy Rule 4.
This policy does not repeat it.

## Rule 4 — Recording

- **Where it goes.** Log the pass in the slice's research journal: the
  enforcement points, the questions asked, the verdicts, and the tests
  added. Put a short summary in the PR description.
- **Planted mistakes are complementary.** They prove the tests catch the
  mistakes the author imagined. This pass looks for the ones the author did
  not.
- **Peer review is still welcome.** A second agent's review remains
  valuable. The pass exists so the reviewer finds less. When a reviewer does
  find a flaw that this pass should have caught, add it below with its
  provenance and sharpen the question that missed it.

## Learned Flaws

Each entry comes from a real finding, verified by reproduction before it was
fixed.

1. **The authorized path was not the opened file** (2026-09-30, PR #86,
   high). The Project API reader canonicalized and authorized a path, then
   opened that path separately. A parent directory swapped for a junction in
   between made it read `.git/config`, and a file outside the project. This
   was reproduced on Windows. The fix authorizes the opened handle's own
   path, as the OS reports it.
2. **The handle's path was ambiguous once the file was deleted**
   (2026-09-30, PR #86, high). This was the second-order flaw in fix 1. On
   Linux, `/proc/self/fd` reports an unlinked file as `<path> (deleted)`,
   which matches no deny rule, while the handle still reads the contents.
   This was reproduced on Linux 6.6, with `.env` as the target. On Windows, a
   file removed under POSIX delete semantics moves to `\$Extend\$Deleted\…`,
   which is inside a project stored at a drive root. The fix refuses any path
   taken from a handle whose file has no name left.
3. **A reused helper trimmed the name** (2026-09-30, PR #86, medium). The
   typed resolver reused a legacy validator that trims whitespace. A request
   for `" notes.txt"` read `notes.txt`, and `" .env"` answered differently
   depending on whether `.env` existed, which revealed its existence.
4. **Memory grew with the input, not the output** (2026-09-30, PR #86,
   medium). Line slicing collected every line into a vector: 16 bytes per
   line, so about 128 MiB for an 8 MiB file of newlines. The fix walks lines
   by iterator.
5. **A limit had an exception** (2026-09-30, PR #86, medium). Slicing
   deliberately returned one character even when it did not fit. That broke
   the per-document budget (4 bytes against 3) and the response total
   (262,147 bytes against 262,144). The fix makes budgets strict and sets a
   minimum per-document budget that holds the largest UTF-8 character.
