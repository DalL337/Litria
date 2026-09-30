# Adversarial Check Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Load **before calling a
slice done or opening its PR** when the slice creates or changes an
enforcement point (Rule 1). It is the author's own attack on their code, run
before a peer reviewer sees it.

Added 2026-09-30 from Project API build plan P1 (PR #86). The reader was
described as "bounded" and "policy-checked". It passed 396 tests and four
planted-mistake checks. A second agent's peer review still found two
high-severity disclosure bypasses and three medium defects. Four were
reproduced at runtime; one was confirmed by inspection (Learned Flaws below).
Planted mistakes only test the mistakes an author already imagined. This
policy is the missing step: deliberately look for the ones they did not, and
report exactly what the evidence proves.

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
  full procedure.
- **A list, not an essay.** Record each attack considered with a one-line
  verdict. Five to fifteen lines is typical. No subagents by default.
- **Evidence scales with severity.** A plausible bypass of a disclosure,
  write or execution control goes through the whole of Rule 3: reproduced,
  fixed, then verified. A low-impact concern gets a note and stays
  `suspected` (Rule 5).
- **Stay inside the slice.** Do not re-audit enforcement code the slice did
  not touch. A pre-existing hole found in passing is reported to the owner
  separately (security-policy Rule 3), not fixed silently mid-slice.

## Rule 3 — The Procedure

The same steps every time, so either agent can repeat the pass and check the
other's work:

1. **State the promised guarantee.** Write one sentence per guarantee the
   enforcement point makes. For example: "a denied path is never disclosed";
   "memory is bounded by the hard cap"; "a reply never describes another
   project". A guarantee that cannot be stated cannot be tested. Take the
   wording from the design brief when it has one.
2. **Test its boundaries.** Use Rule 4's questions to list the inputs and
   states at each edge of the guarantee: exactly at a limit, one over it,
   multibyte and escaped text, empty input, every alias of a name, and each
   platform's difference. Cover each with a test, or with a one-line verdict
   explaining why it cannot apply.
3. **Exercise the race windows deliberately.** For every gap between a check
   and a use, add a test seam at that exact window and make the change
   *there*: swap a file for a link, delete it, grow it, switch the
   workspace. A test of state that already exists before the check says
   nothing about state that changes after it.
4. **Demonstrate failure before the fix.** Run the reproduction against the
   unfixed code, and record the observed failure: the output, and the
   environment (OS, kernel, commit). A plausible bypass is not fixed until
   this step has been done, or recorded as impractical (Rule 5).
5. **Demonstrate success afterwards.** Run the same reproduction, unchanged,
   against the fix, on every platform where the window exists. Use CI for
   platforms that cannot be run locally; a Linux container is a fast local
   stand-in when CI is slow. A different test that happens to pass is not
   this step.

## Rule 4 — The Questions

Walk each enforcement point through these questions, both for Rule 3 step 2
and for the list of attacks. Each one names the flaw that taught it.

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
7. **Attack windows need test seams.** For each plausible attack from
   questions 1–3, a hook must let a test perform it deterministically,
   inside the exact window (Rule 3 step 3). *(Flaws 1 and 2.)*

For "what other path produces this same effect?", see security-policy Rule 4.
This policy does not repeat it.

## Rule 5 — Finding Status

Every finding, whether the author's or a reviewer's, carries exactly one of
these statuses. The status says what the evidence proves, and nothing more:

| Status | Meaning | Evidence required to enter it |
|---|---|---|
| **Suspected** | Believed from reading code, documentation or specifications. Nothing has been run. | The claim, plus what would reproduce it. |
| **Reproduced** | The failure was demonstrated against the unfixed code (Rule 3 step 4). | A test or script that someone else can rerun, the observed output, and the environment. |
| **Verified fixed** | The same reproduction passes against the fix (Rule 3 step 5). | Each platform where the window exists is named, with the run that proves it: a local command, a CI job, or a container run. |

Rules for keeping both agents honest:

- **A peer reviewer's source-inspection finding starts as `suspected`.** It
  is the recipient's job to reproduce it before it is fixed, or to say why
  that is impractical.
- **Qualify any status reached without a run.** Some properties cannot be
  observed cheaply at runtime, such as peak allocation. A finding confirmed
  only by reading the code is written `suspected, confirmed by inspection`,
  with the citation. It is not called `reproduced`.
- **Status is per platform when the window differs by platform.** For
  example: "verified fixed on Windows and Linux; macOS awaiting CI". A fix
  that has not run on a platform yet is `fixed, unverified` there.
- **Nothing is silently dropped.** A finding that does not reproduce stays
  `suspected` with the attempt recorded, or is withdrawn by whoever raised
  it, with the reason. Absence of reproduction is not proof of safety.
- **Every report states the status.** Whenever a finding is reported
  (journal, PR, chat), its status is stated. "Fixed" on its own is not a
  status.

## Rule 6 — Recording

- **Where it goes.** Log the pass in the slice's research journal. The log
  covers each enforcement point's guarantees (Rule 3 step 1), the attacks
  considered with a one-line verdict each, and every finding with its status
  and evidence. Put a short summary in the PR description, with the status
  of each finding.
- **Planted mistakes are complementary.** They prove the tests catch the
  mistakes the author imagined. This pass looks for the ones the author did
  not.
- **Peer review is still welcome.** A second agent's review remains
  valuable. The pass exists so the reviewer finds less. When a reviewer does
  find a flaw that this pass should have caught, add it below with its
  provenance and status, and sharpen the question that missed it.

## Learned Flaws

Each entry comes from a real finding and records its final status.

1. **The authorized path was not the opened file** (2026-09-30, PR #86,
   high). The Project API reader canonicalized and authorized a path, then
   opened that path separately. A parent directory swapped for a junction in
   between made it read `.git/config`, and a file outside the project. The
   fix authorizes the opened handle's own path, as the OS reports it.
   *Status: reproduced on Windows (a junction-swap test against the unfixed
   code returned the secret); verified fixed on Windows (local run) and on
   Linux and macOS (CI).*
2. **The handle's path was ambiguous once the file was deleted**
   (2026-09-30, PR #86, high). This was the second-order flaw in fix 1. On
   Linux, `/proc/self/fd` reports an unlinked file as `<path> (deleted)`,
   which matches no deny rule, while the handle still reads the contents. On
   Windows, a file removed under POSIX delete semantics moves to
   `\$Extend\$Deleted\…`, which is inside a project stored at a drive root.
   The fix refuses any path taken from a handle whose file has no name left.
   *Status: the reviewer raised it as suspected. It was reproduced on Linux
   6.6 in a container: the unmodified reader returned a swapped-in and then
   unlinked `.env`. It is verified fixed on Linux (container and CI) and
   macOS (CI). On Windows, the deletion case passes, and a direct test of the
   handle check passes. The drive-root variant itself remains suspected: it
   was reasoned from POSIX delete semantics and not reproduced.*
3. **A reused helper trimmed the name** (2026-09-30, PR #86, medium). The
   typed resolver reused a legacy validator that trims whitespace. A request
   for `" notes.txt"` read `notes.txt`, and `" .env"` answered differently
   depending on whether `.env` existed, which revealed its existence.
   *Status: reproduced on Windows; verified fixed on Windows (local run)
   and on Linux and macOS (CI).*
4. **Memory grew with the input, not the output** (2026-09-30, PR #86,
   medium). Line slicing collected every line into a vector: 16 bytes per
   line, so about 128 MiB for an 8 MiB file of newlines. The fix walks lines
   by iterator. *Status: suspected, confirmed by inspection (the per-line
   vector, and the size of a slice reference). The fix's correctness is
   verified by a test with a million short lines; the memory bound itself was
   never measured.*
5. **A limit had an exception** (2026-09-30, PR #86, medium). Slicing
   deliberately returned one character even when it did not fit. That broke
   the per-document budget (4 bytes against 3) and the response total
   (262,147 bytes against 262,144). The fix makes budgets strict and sets a
   minimum per-document budget that holds the largest UTF-8 character.
   *Status: reproduced on Windows; verified fixed on Windows (local run)
   and on Linux and macOS (CI).*
