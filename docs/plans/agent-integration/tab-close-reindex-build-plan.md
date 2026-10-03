# Tab close keeps the file indexed: build plan

Status: Proposed, 2026-10-02. The owner chose this as the first unattended
build-and-review trial: one agent builds the whole checklist below, a second
agent reviews the result once, and nothing merges without the owner.
Revised 2026-10-03: the first review reproduced three races the asynchronous
close introduced (F1–F3, below). They were fixed by hand on the same branch,
tasks 4 and 5 were added, and the whole branch goes to a second review.

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
  file the index does not hold.
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

## Blockers

None recorded.
