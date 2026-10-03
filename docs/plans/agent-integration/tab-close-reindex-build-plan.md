# Tab close keeps the file indexed: build plan

Status: Delivered, 2026-10-03, on branch `fix/tab-close-reindex`, after four
reviews; the fourth approved with no findings. Proposed 2026-10-02. The owner
chose this as the first unattended
build-and-review trial: one agent builds the whole checklist below, a second
agent reviews the result once, and nothing merges without the owner.
Revised 2026-10-03: the first review reproduced three races the asynchronous
close introduced (F1–F3, below). They were fixed by hand on the same branch,
tasks 4 and 5 were added, and the whole branch goes to a second review.
Revised again 2026-10-03: the second review showed that the text comparison
used for F1–F3 missed changes whose text came back identical. A revision
kept by the domain replaced it (task 6), and the branch goes to a third
review.
Revised a third time 2026-10-03: the third review showed the revision fence
dropped a case the per-path tickets had covered, two closes with no reopen
between them. A close now stamps a new revision before its read (task 7),
and the branch goes to a fourth review.

Origin: found in P4b and recorded as the first P4c item in the
[Project API build plan](project-api-build-plan.md) ("Closing a tab drops its
file from the index"). This document owns the delivery checklist only; it
decides nothing beyond the fix described there.

## Goal

Closing an editor tab must not drop a file that is still on disk from the
syntax index. Today `onFileClosed` in `src/lsp/syntaxAdapter.js` calls
`syntaxDomain.commands.unregisterFile`, so until discovery runs again the
file's outgoing edges are marked broken and the P4c graph query would report
the file as not parsed. The index should follow disk, not open tabs
([implementation policy](../../../Agents/docs/implementation-policy.md),
Rule 7 "State Follows Disk").

## Tasks

- [x] Reproduce: a new domain test shows that closing the tab of a file still on disk drops it from the syntax index and marks its outgoing edges broken. It fails on the current code.
- [x] Fix: `onFileClosed` re-indexes the file from its disk contents, so the reproduction test passes; discarded unsaved edits, a file missing from disk, and a reopen during the disk read each have a passing test.
- [x] Record evidence under Evidence below; check:architecture, test:domains, build, and cargo test all pass.
- [x] A close's late disk read changes nothing once the file's index entry has changed: a project reset or reload, a rename, a delete, a write, or a newer open or close of the same file (first review F1–F3).
- [x] A close never adds a file the index does not hold, and the project-switch case is tested through the real lifecycle hook.
- [x] The late read is fenced by a revision of the file's index entry kept by the domain, so changes whose text comes back identical, and changes made through a replacement adapter, also win (second review).
- [x] Of two closes of the same path with no reopen between them, the newer close's read wins whichever read finishes first, through the same adapter or a replacement (third review).

## Requirements

- After a close, the index holds the file's **disk** text, read through the
  adapter's injected `readProjectFile` (see `getAuthoritativeText`). Unsaved
  edits discarded by the close must not survive in the index.
- If the file cannot be read (missing from disk, read error), keep today's
  behavior: unregister it.
- A reopen that happens while the disk read is still in flight wins: the
  stale disk text must not overwrite the reopened model's text.
- *(Added 2026-10-03, first review.)* More generally, anything that changes
  the file's index entry while the read is in flight wins over it, whether the
  read succeeded or failed: a project reset or reload (F1), a newer close of
  the same file (F2), a rename or delete (F3), or a write. A close never adds a
  file the index does not hold. *(Second review:)* this includes changes whose
  text comes back identical, and changes made through a replacement adapter
  after a project switch.
- The call site (`src/editor/monacoWorkspace.js`) calls `onFileClosed`
  synchronously and ignores the result. An asynchronous re-index must not
  produce unhandled rejections. Returning a promise for tests to await is fine.
- Do not change `syntaxDomain.commands.unregisterFile`; moves rely on its
  current semantics. The fix belongs in the adapter's close handler.
- Out of scope: LSP `didClose`, diagnostics, discovery, and anything in the
  graph query itself.

## Tests

- New file `test/domains/syntaxAdapterClose.test.mjs`. Build the adapter the
  way `test/domains/syntaxAdapterDisconnect.test.mjs` does (`setupAdapter`
  with an in-memory disk map and a real `createSyntaxDomain()`).
- The reproduction must fail before the fix. Say so under Evidence.

## Acceptance

All tasks checked, the four checks passing, and the evidence below filled in.

## Evidence

> **Note on commit hashes (2026-10-03):** the hashes below name commits on the
> run's local branch. PR #107 replayed them onto `main` as `63a793f` (was
> `2d52f7f`), `2027010` (was `640d4bd`), `c4dbbf7` (was `90c1f71`) and
> `d2614f4` (was `489cd9c`, the commit the fourth review approved). The code
> is identical.

**Fix.** `onFileClosed` in `src/lsp/syntaxAdapter.js` is now async. It clears
the model registry synchronously (so the file immediately reads as closed),
then reads the file through the injected `readProjectFile` via `absToRel`. If
the read yields text it re-indexes with `syntaxDomain.commands.registerFile`
(disk text, so discarded unsaved edits do not survive); if the read returns
`null`/throws it falls back to today's `unregisterFile`. After awaiting the
read it re-checks `modelRegistry.has(filePath)` and bails if the file was
reopened in the meantime, so the stale disk text never overwrites the
reopened model. `unregisterFile` is unchanged. The call site
(`src/editor/monacoWorkspace.js:220`) still calls it synchronously and ignores
the returned promise; all read-error paths are caught, so there is no
unhandled rejection.

**Tests.** New file `test/domains/syntaxAdapterClose.test.mjs`, built with the
same `setupAdapter` shape as `syntaxAdapterDisconnect.test.mjs` (in-memory disk
map, real `createSyntaxDomain()`):
- `closing the tab of a file still on disk keeps it indexed and its edge not broken` — the reproduction.
- `a close discards unsaved edits — the index holds disk text, not the buffer`.
- `a file missing from disk is unregistered on close`.
- `a reopen during the disk read wins: stale disk text does not overwrite the model` (uses a gated `readProjectFile`).

**Failing-first.** Running `npm run test:domains` against the pre-fix
`onFileClosed` (temporarily reverted to `unregisterFile` + `modelRegistry.delete`),
the two new content-preserving tests fail as expected:
```
✖ closing the tab of a file still on disk keeps it indexed and its edge not broken
✖ a close discards unsaved edits — the index holds disk text, not the buffer
ℹ fail 2
```
(The missing-from-disk and reopen tests pass under old code too — old behavior
already unregistered or let the synchronous reopen win.) After restoring the
fix, all four pass.

**Checks (all pass, 2026-10-02).**
- `npm run check:architecture` → Architecture guard passed; App shell, Protected zone, Domain contract (16 domains), Settings-key, Editor engine, DB chokepoint guards all passed.
- `npm run test:domains` → tests 1429, pass 1429, fail 0.
- `npm run build` → `✓ built in 52.01s`.
- `cargo test --manifest-path src-tauri/Cargo.toml` → 525 passed; 0 failed (plus ignored/doc/empty suites green).

> **Erratum (2026-10-03, first review):** the `modelRegistry.has(filePath)`
> re-check described under Fix guarded only a reopen with a model. The review
> reproduced three sequences it let through; the race fixes below replace it.

### Race fixes (2026-10-03)

**Review findings, each reproduced before fixing** with the reviewer's
script against commit `2d52f7f`: F1, a project reset during the read
re-registered the previous project's file; F2, after close → reopen → close
the first read overwrote the second (with stale text, or unregistered a file
still on disk when the stale read failed); F3, a rename or delete during the
read restored the old path.

**Fix.** `onFileClosed` applies its disk read only if nothing changed the
file's index entry meanwhile:
- a per-path ticket that every open, close and rename through the adapter
  advances (F2, adapter renames);
- the index's text for the file, compared before and after the read through
  a new read-only selector, `syntaxDomain.selectors.getFileText` (F1 reset,
  F3 delete and filesystem rename, writes, same-root reloads).

A close returns at once when the index holds no text for the file, so a tab
closed after a project reset cannot add the previous project's file.
`unregisterFile` is unchanged.

**Tests.** Eight added to `test/domains/syntaxAdapterClose.test.mjs`, each
holding every disk read on its own gate: reset during the read; close after
a reset; an older close losing to a newer one with stale text and with a
stale failure; reopen without a model; rename; delete; a write; a same-root
reload. One added to `test/domains/syntaxDomainProjectSwitch.test.mjs`
through the real `useSyntaxDomainLifecycle` hook: a tab closed just before a
project switch does not re-index the old project into the new one.

**Failing-first.** Against commit `2d52f7f` all nine new tests fail and the
seven existing tests in both files pass (`node --test` on the two files:
pass 7, fail 9). With the fix: pass 16, fail 0. The reviewer's script prints
the expected result in all four of its cases.

**Checks (all pass, 2026-10-03).**
- `npm run check:architecture` → all seven guards passed (Domain contract: 16 domains).
- `npm run test:domains` → tests 1438, pass 1438, fail 0.
- `npm run build` → `✓ built in 36.70s`.
- `cargo test --manifest-path src-tauri/Cargo.toml` → 525 passed; 0 failed. Rust is unchanged.

> **Erratum (2026-10-03, second review):** comparing the indexed text before
> and after the read cannot see an entry that changed and came back
> identical, and the per-path ticket lived in one adapter, which a project
> switch replaces. The revision fence below replaces both.

### Revision fence (2026-10-03, second review)

**Review finding, reproduced before fixing** against commit `640d4bd`: a
reset followed by identical re-registration, a same-text write, or a delete
followed by identical recreation let the late read overwrite the entry with
stale disk text, or unregister it when the read failed (all six
combinations). Through the real lifecycle hook, A → B → A with the file
reopened in identical text did the same, because the old adapter's ticket
could not see the replacement adapter's reopen.

**Fix.** The domain stamps every change to a file's entry with a revision
from a counter that never resets: `_putText` and `_dropText` are now the only
writers of the text cache (register, write, rename, unregister, forget), and
reset clears the revisions with the rest of the index. The read-only selector
`getFileRevision` replaces `getFileText`. `onFileClosed` records the revision
when the tab closes and applies its read only if the revision is unchanged.
The adapter's tickets are gone; the adapter is 15 lines shorter.

**Tests.** Four added to `syntaxAdapterClose.test.mjs` (reset and identical
re-registration, same-text write, delete and identical recreation, rename
away and back; each with a stale late read and a failed one) and one to
`syntaxDomainProjectSwitch.test.mjs` through the real hook (A → B → A,
identical reopen, both late outcomes).

**Failing-first.** Against commit `640d4bd` the five new tests fail and the
sixteen existing tests in both files pass (`node --test`: pass 16, fail 5).
With the fix: pass 21, fail 0. The reviewer's reproduction now keeps the
current entry in all six combinations.

**Checks (all pass, 2026-10-03).**
- `npm run check:architecture` → all seven guards passed.
- `npm run test:domains` → tests 1443, pass 1443, fail 0.
- `npm run build` → `✓ built in 40.59s`.
- `cargo test --manifest-path src-tauri/Cargo.toml` → 525 passed; 0 failed. Rust is unchanged.

> **Erratum (2026-10-03, third review):** the revision fence above recorded
> the revision a close found but did not advance it, so two closes with no
> reopen between them held the same number, and the older read's re-index
> made the newer read look stale. The per-path tickets it replaced had covered
> that case; no test pinned it, because the "newer close" test reopened the
> file between the closes. Fixed below.

### Consecutive closes (2026-10-03, third review)

**Review finding, reproduced before fixing** against commit `90c1f71`: two
closes of the same path with no reopen between them, the older read finishing
first, left stale text (older read stale) or dropped the file (older read
failed), through the same adapter or a replacement one (four of four).

**Fix.** A new domain command, `stampFileRevision`, gives an indexed entry a
new revision without changing its text and returns it (null when the index
holds no text). `onFileClosed` stamps the entry instead of reading its
revision, so the newest close always holds the newest revision.

**Tests.** One added to `syntaxAdapterClose.test.mjs`, looping over the same
adapter and a replacement, both completion orders, and an older read that is
stale or fails: eight combinations, each expecting the newer close's text.

**Failing-first.** Against commit `90c1f71` the new test fails ("older read
first, older read stale") and the 21 existing tests in both files pass. With
the fix: 22 of 22. The reviewer's reproduction passes all four cases, and the
earlier reviews' reproductions still pass (four and six cases).

**Checks (all pass, 2026-10-03).**
- `npm run check:architecture` → all seven guards passed.
- `npm run test:domains` → tests 1444, pass 1444, fail 0.
- `npm run build` → `✓ built in 40.22s`.
- `cargo test --manifest-path src-tauri/Cargo.toml` → 525 passed; 0 failed. Rust is unchanged.

## Blockers

None recorded.
