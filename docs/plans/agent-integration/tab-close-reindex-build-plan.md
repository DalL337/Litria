# Tab close keeps the file indexed: build plan

Status: Proposed, 2026-10-02. The owner chose this as the first unattended
build-and-review trial: one agent builds the whole checklist below, a second
agent reviews the result once, and nothing merges without the owner.

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

## Requirements

- After a close, the index holds the file's **disk** text, read through the
  adapter's injected `readProjectFile` (see `getAuthoritativeText`). Unsaved
  edits discarded by the close must not survive in the index.
- If the file cannot be read (missing from disk, read error), keep today's
  behavior: unregister it.
- A reopen that happens while the disk read is still in flight wins: the
  stale disk text must not overwrite the reopened model's text.
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

All three tasks checked, the four checks passing, and the evidence below
filled in.

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

## Blockers

None recorded.
