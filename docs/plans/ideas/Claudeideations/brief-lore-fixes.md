# Brief: LORE hardening pass (guard tests, release pairing, CI pin, wording erratum)

> **For:** Claude Code
> **Repo:** `agent-lore` (`main` @ 993fb41, the single initial commit)
> **Scope:** Four fixes. One branch, one PR. No new policies, no restructuring.
> **Policies to load (AGENTS.md dispatch):** implementation · git · verification · documentation. This touches enforcement code, so branch + PR is required (`policies/git.md` §2, item 1).

---

## Motivation (owner, 2026-09-24)

An external review found the suite coherent and self-consistent, but surfaced
four gaps. The most important one is that the suite's only guard is barely
exercised by CI. Nothing here changes what LORE *says*. It makes the guard
trustworthy and fixes one wording contradiction.

## Ground truth (verified)

- `node suite/scripts/memory-lint.mjs suite --strict` → 0 errors, 0 warnings.
- CI (`.github/workflows/memory-lint.yml`) lints only `suite/memory/INDEX.md`,
  which contains no ledger lines, claims, releases, or strikes. **E1–E4, W1, and W2
  never execute in CI.**
- The format of a populated node exists only as prose in `policies/memory.md`
  §2/§4 and `policies/orchestration.md` §2. There is no concrete example.
- Release pairing (`memory-lint.mjs`, the `live` filter): a claim counts as
  released if **any** later `RELEASE` has the same id. There is no scope pairing.
- The workflow uses `actions/checkout@v4`, a mutable tag, and carries a
  `TODO: pin to a commit SHA`. `policies/security.md` Rule 2 requires pinned
  exact versions.
- `policies/documentation.md` Rule 5 calls agent memory and research journals
  "out-of-tree". `policies/research.md` Rule 1, the doc-kinds table, and
  `gitignore-additions.txt` all say in-tree but gitignored.

---

## Fix 1: Guard fixtures + tests (the priority)

Add fixtures **outside `suite/`**, so adopters don't copy them in:

```
test/
  fixtures/
    valid/memory/INDEX.md          ← hub linking the area node
    valid/memory/example-area.md   ← a fully populated node
    invalid/memory/INDEX.md
    invalid/memory/broken-area.md  ← triggers E2, E3, E4, W1, W2
    no-hub/memory/orphan.md        ← triggers E1 (no INDEX.md)
  memory-lint.test.mjs
```

- `valid/example-area.md` should be a **realistic** node: scope line, link
  table, status ledger (all five vocab words), one claim + matching release,
  and one strike-and-stamp deprecation with its in-slot replacement. It doubles
  as the adopter-facing example, so write it to teach. Use generic paths and
  roles only (AGENTS.md §3 housekeeping).
- `invalid/broken-area.md` should put each violation on its own line, with an
  HTML comment naming the expected code.
- `memory-lint.test.mjs` uses **`node:test` only**. The suite must stay
  zero-dependency. For each fixture, spawn the lint, then assert the exit code
  and that each expected code appears in stderr:
  - valid + `--strict` → exit 0, no codes
  - invalid → exit 1, contains E2, E3, E4, W1, W2
  - no-hub → exit 1, contains E1
- Add a CI step: `node --test test/`.
- README: in "What's in `suite/`", add one line pointing adopters to
  `test/fixtures/valid/memory/example-area.md` as a worked example.

## Fix 2: Release pairing

**Change:** a `RELEASE` consumes **exactly one** earlier, still-live claim with
the same id, namely the most recent one before it. If that id has **more than
one** live claim at the release line, also emit a new warning:

- `W3 ambiguous RELEASE: <id> holds N live claims; release consumed the most recent`

Add W3 to the header comment's code list. Add a W3 case to the invalid fixture
(two claims by one id, one release) plus a test assertion.

**Out of scope:** changing the RELEASE *format*, for example adding a
`scope:` field. That would be a policy change and is an owner decision for
later. W3 surfaces the ambiguity without breaking existing webs.

## Fix 3: Pin the CI action

- Pin `actions/checkout` to a full commit SHA with a trailing version comment,
  e.g. `uses: actions/checkout@<sha> # v5.1.0`.
- **Verify the SHA yourself** against the actions/checkout repo tags
  (`git ls-remote https://github.com/actions/checkout 'refs/tags/v5*'`). For
  reference only: on 2026-09-24 the reviewer observed `v5.1.0` →
  `fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09`. Treat that as a hypothesis
  (`policies/documentation.md` Rule 7). If you pick v4 or v5, state which and
  why in the PR.
- Remove the TODO comment.

## Fix 4: Wording erratum

In `policies/documentation.md` Rule 5, add an erratum rather than a silent
rewrite (Rule 2):

> **Erratum (2026-09-24, review):** "out-of-tree" should read "in-tree but
> gitignored". Agent memory (`/memory/`) and research journals
> (`/.research/`) live in the working tree and are excluded from commits;
> see `policies/research.md` Rule 1 and `gitignore-additions.txt`.

Then correct the sentence itself, so the erratum explains the change on the
page.

---

## Out of scope (do not do)

- License changes (MIT → MIT-0/0BSD, copyright holder line). This is an
  owner decision under discussion.
- Any change to policy *rules* beyond the Fix 4 erratum.
- Anything touching the Litria repo.

## Git

- Branch: `chore/guard-hardening` off `main`.
- Commit bucketing (`policies/git.md` §3):
  1. `test:` fixtures + `memory-lint.test.mjs`
  2. `fix(lint):` release pairing + W3 (with its fixture and test additions)
  3. `ci:` SHA pin + test step
  4. `docs:` erratum + README pointer
- After each commit, read the files-changed count (`policies/verification.md`
  Rule 3). Verify the commit identity is the noreply address
  (`policies/git.md` §5).

## Done when

- [ ] `node suite/scripts/memory-lint.mjs suite --strict` still exits 0
- [ ] `node --test test/` passes locally; paste the output in the PR
- [ ] CI green on the PR, running both the lint and the tests
- [ ] The workflow has no mutable action tags left
- [ ] Every fixture is free of personal or project data
