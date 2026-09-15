# Brief — Honest save state, retryable position outbox, LSP teardown reap, and truthful capability claims

**Status:** IMPLEMENTED + OWNER LIVE-ACCEPTED 2026-09-15 — PRs #38–#42 (one per
slice, each from `main`); the four live acceptance scenarios in the Slices
table passed on the owner's machine the same day. Previously: RULED 2026-09-15 — the owner accepted all five rulings (R1–R5) as
proposed; every slice is cleared to build, none started. Drafted the same day
for owner review. Companion ADR:
`docs/adrs/027-honest-save-state-outbox-retry-and-lsp-teardown.md`
(decisions only; this brief is the canonical detailed design).

## Origin

On 2026-09-15 the owner auditioned a second agent (Codex) on a read-only
systems analysis of the repository at `5f8d9a2`, then had Claude verify it
line by line (journal `.research/2026-09-15-codex-audition-accuracy-audit.md`,
verified accuracy 96%). Between the two passes, twelve items were flagged as
needing attention. Three are real behavior defects, one is a standing
architecture-rule violation, one is tracked engine debt, and the rest are
documentation that no longer matches executable evidence. The owner's
direction: "full arc for all of the things you and Codex flagged as needing
attention and fixing."

Every item below was re-verified against the working tree at `5f8d9a2`
(v1.0.6) before this brief was written; each row cites the line that proves
it.

## Findings being fixed

| # | Finding | Evidence (all at `5f8d9a2`) | Kind |
|---|---|---|---|
| F1 | **A failed normal save marks the tab clean.** `persistSavedTab` swallows a `false`/thrown write with `console.warn`; the editor context dispatches `SAVE_TAB` synchronously without awaiting the write; the unsaved-changes gate only aborts on an explicit `false`. Disk and editor baseline diverge silently. | `src/project/useProjectPersistence.js:116-121`; `src/editor/EditorSessionContext.jsx:117-118` and `:146-147` (`SAVE_ALL`); `src/app/useUnsavedChangesGate.js:87` | Defect (data integrity) |
| F1b | **Piece state is committed before the disk write.** `persistSavedTab` sets `piece.code = workingCode` in `setPieces` *before* calling the write manager, so on failure the canvas/syntax side already believes the new text is on disk. This is implementation-policy Rule 7 ("state follows disk") in its exact signature. | `src/project/useProjectPersistence.js:97-103` above the write at `:117` | Rule violation |
| F2 | **Position outbox drops moves on a failed flush.** `flushPendingMoves` drains the pending map, then `dbBatchMovePieces(...).catch(console.warn)`. A `db.busy` or transient I/O error loses those positions until the piece is moved again. (The failure *is* visible: the ADR-026 observer in `invokeDb` fires. Nothing retries.) | `src/project/useProjectPersistence.js:409-416`; `src/project/positionOutbox.js:64` (`drainPending`) | Defect (durability) |
| F3 | **CAPABILITIES claims unsaved work survives restarts; it does not.** `workingCode` is React memory only: `pieces` has no text column, `editor_state` stores tab ids / pane ids / split ratio / timestamp, and hydration overwrites `workingCode` from disk. | `docs/CAPABILITIES.md:219`; `src-tauri/src/db/schema.rs:23-32,68-71`; `src/project/useProjectPersistence.js:275,480-490` | Doc false |
| F4 | **LSP teardown never waits or reaps.** `stop_session` sends `shutdown` (3 s), then `exit`, then `transport.kill()` unconditionally; `transport.wait()` is `#[allow(dead_code)]` "not on any current path". `docs/Orchestration.md` §1.2 rule 2 mandates *signal, flush, wait with timeout, force kill, join/reap*. App exit runs the same path for every session. | `src-tauri/src/lsp/session.rs:603-608`; `src-tauri/src/lsp/transport.rs:78-91`; `src-tauri/src/lib.rs:191-193`; `docs/Orchestration.md:34-36` | Rule violation |
| F5 | **Editor-engine TEMP debt: two `.monaco-editor` DOM predicates** outside the engine island, permitted by `TEMP_ALLOWED_DOM_COUPLING`. The guard itself names the fix: an engine-provided `containsTextFocus(el)` capability. | `scripts/editor-engine-guard.mjs:93-107`; `src/app/interactionDomain.js:14`; `src/app/useGlobalShortcuts.js:27` | Tracked debt |
| F6 | **`useNodeHealth` comment says errors/warnings come "from LSP".** Monaco's global marker bus feeds the same store (`subscribeMarkerFeed`), so the LED already reflects built-in JSON/CSS/HTML markers. CAPABILITIES §7 is already correct; the code comment is not. | `src/hooks/useNodeHealth.js:12-13`; `src/editor/monacoWorkspace.js:380-392` | Doc stale |
| F7 | **README says Linux "has not yet been launched by a human."** The owner ran the Linux parity checklist on Fedora 44 on 2026-07-31 (source-built, accepted). No *packaged* Linux artifact (AppImage/deb/rpm) has been human-launched. The sentence is wrong as written and would be wrong if simply deleted. | `README.md:47-50`; memory `project_linux_testing.md`; `docs/testing/linux-parity-checklist.md` | Doc imprecise |
| F8 | **CAPABILITIES §6 credits the LSP client with go-to-definition "out of the box" for Python and TS/JS.** Reality: Python definition comes from local intelligence (`registerDefinitionProvider` in `pythonLocalIntelligence.js`), TS/JS from Monaco's built-in TypeScript worker (open models only), and the generic `textDocument/definition` provider is explicitly deferred. | `docs/CAPABILITIES.md:161-163`; `src/editor/pythonLocalIntelligence.js:266`; `src/editor/monacoSetup.js:21,54`; `src/lsp/pythonLspProviders.js:17` | Doc imprecise |
| F9 | **No single statement of which languages are editable vs discovered vs symbol-indexed vs LSP-served.** Discovery is `js/jsx/ts/tsx/mjs/py`; the editor maps a much wider set; symbol/import parsers cover JS/TS + Python; LSP packs cover Python, TS/JS, Rust, C/C++ (Go by toolchain hint). A new agent reads "supports Rust" and assumes wires. | `src/app/useDiscoveryLifecycle.js:26`; `src/editor/editorLanguage.js:5-39`; `src/app/*Parser.js` | Doc gap |
| F10 | **Release policy does not say the GitHub release must exist before the workflow's upload step.** `release.yml` ends in `gh release upload --clobber` and never creates the release; the 1.0.6 journal rediscovered this at release time. | `.github/workflows/release.yml:187-188`; `Agents/docs/release-policy.md` (no rule); `.research/2026-09-15-release-1.0.6.md` | Policy gap |
| F11 | **Security-audit ledger row for 2026-09-14 still says "Slice 4 … awaits two owner rulings."** Both were ruled and slice 4 merged as PR #37 (v1.0.6). | `docs/security-audits/security-audit.md:1037` | Doc stale |
| F12 | **Cross-store atomicity.** File text, React state and SQLite metadata are three independent writes with no shared transaction. This is an architectural property, not a bug to fix here; F1/F1b/F2 are its concrete mitigations. Recorded so the next agent does not re-derive it. | `src/app/filesystemWriteManager.js`; `src/project/dbStorage.js`; `src/project/useProjectPersistence.js` | Accepted property (ADR-027 scope note) |

Not in this arc, recorded so they are not lost: a generic LSP
`textDocument/definition` provider (feature; needs a file-open integration
brief), macOS end-to-end package acceptance (tester-blocked), a repeat of the
Fedora parity run on a packaged artifact (owner/hardware), a fresh
dependency-audit pass (routine security pass, `project_security_audit`), and
the bundled LSP pin drift the session hook reports (release-policy work).

## Design

### 1. Honest file save (F1, F1b)

The rule: **the editor baseline moves only after the write manager reports
success, and piece state is derived from the same result.** The untitled
Save As path already does exactly this (`EditorSessionContext.jsx:105-115`,
`useUntitledSaveAs.js:19-21`: resolves `false` on cancel or failed write,
tab stays dirty); the normal path is brought to the same contract.

`useProjectPersistence.persistSavedTab(tab)`:

1. Resolve `rootPath` / `relativePath` as today. No root or no path:
   return `false` with a `file.save.no_target` failure (today it silently
   returns `undefined` after having already mutated pieces).
2. Call `writeProjectFile(rootPath, relativePath, snapshot)` where
   `snapshot = tab.workingCode ?? ''` is captured **once** before the await.
3. On `true`: `setPieces` sets `{ code: snapshot, workingCode: snapshot }`
   for the matching piece (the update that today happens first moves here).
   Return `true`.
4. On `false` / throw: leave pieces untouched; report the failure (§2);
   return `false`. `console.warn` remains as the secondary trace.

`persistSavedTabs(tabs)` runs the same per tab, sequentially as today, and
returns an array of `{ tabId, saved, savedCode }` so the context can mark
each success individually. A mid-sequence failure must not leave earlier
successes dirty or later failures clean.

`EditorSessionContext`:

- `saveTab`: capture `savedCode = tab.workingCode ?? ''`, then
  `await onSaveTab(tab)`; dispatch `SAVE_TAB { tabId, savedCode }` only on
  `true`. Returns the boolean. The reducer already handles `savedCode`
  (`editorSessionDomain.js:423-429`) so keystrokes typed during the write
  stay dirty, the same diff rule the untitled path uses.
- `saveAllTabs`: per-tab dispatch from the result array; returns
  `allSaved`. The `SAVE_ALL` reducer action becomes unreachable from the
  context and is removed (implementation-policy Rule 8: grep it dead; its
  test rows move to per-tab assertions).
- `persistenceRef.current.onSaveTab` absent (no project configured): the
  existing `?? null` path keeps today's behavior for the no-project case;
  nothing there claims a disk write happened.

Gate and close guard need no change: `useUnsavedChangesGate.js:87` already
resolves `result !== false`, and the exit prompt shares that contract. A
failed save therefore **aborts the transition exactly like a cancelled Save
As** (ruling R1): the user sees the notice, the tab stays dirty, and they
choose Save again / Discard / Cancel. No automatic retry of file writes. A
retry loop against a locked or read-only file is the "hidden restart loop"
the crash-capture section already forbids for servers.

### 2. One persistence-failure surface (F1, reuse of ADR-026 slice 4)

ADR-026 slice 4 built the surface: `persistenceNotices.js` (pure state,
10 s rate window), `usePersistenceNotices.js` (binds to the project
lifecycle), `PersistencePill.jsx` (canvas top-center). Today its only source
is `dbStorage.onPersistenceWriteFailure`, fired for mutating DB commands.

Change: the observer moves out of the DB adapter into a neutral
`src/project/persistenceFailures.js` (emit + subscribe, no other
dependencies); `dbStorage.js` re-exports `onPersistenceWriteFailure` for
its existing callers and emits through the shared module. File-save failure
emits `{ command: 'file.save', error }` where `error` is the typed storage
error from `getLastProjectStorageError()` (`storage.js:96`) when the manager
returned `false`, or the manager's own `{ code, error }` for `fs.*` refusals
(reserved name, no root).

`describeWriteFailure` gains the `file.save` shape. Draft copy (ruling R3):

> **Couldn't save "<relative path>": <reason>. Your edits are still in the
> editor.**

Read-only instances: a file write is *not* gated by `canPersist`. That flag
describes `workspace.db`, and a read-only database says nothing about the
source folder. If the folder is also read-only the write fails and the
notice says so; that is the honest outcome.

Tests: `persistenceNotices.test.mjs` gains `file.save` describe/reduce rows;
a new `saveOutcome.test.mjs` covers the pure helper that turns a manager
result into `{ saved, failure }` (extracted so the hook body stays thin);
`editorSessionDomain.test.mjs` asserts that `SAVE_TAB` with a stale
`savedCode` leaves later keystrokes dirty and that no action marks a tab
clean without `savedCode` from the normal path.

### 3. Position outbox that never drops (F2)

`positionOutbox.js` gains two pure functions:

- `requeueFailed(pending, failedMoves)`: merges the drained batch back
  into the pending map with **newer-position-wins** semantics. A move that
  arrived while the failed flush was in flight supersedes the failed one for
  the same piece id (`mergeIntoPending` already has this shape; requeue
  delegates to it with the failed batch as the *older* side).
- `computeRetryDelay(attempt)`: `min(2 s × 2^attempt, 30 s)` (ruling R4).

`flushPendingMoves` in `useProjectPersistence`:

```
moves = drainPending(pending)
dbBatchMovePieces(moves)
  .then(() => { attempt = 0 })
  .catch(err => {
    requeueFailed(pending, moves)
    attempt += 1
    schedule(flush, computeRetryDelay(attempt))
  })
```

The notice already fires from `invokeDb` for `db_batch_move_pieces`; the
retry adds nothing to the surface and the 10 s window keeps it quiet.
Retries continue while the project is open (moves are never dropped); a
project switch or window close attempts one final flush as today. Read-only
instances are already skipped by `canPersist`, so the retry loop never runs
against a known-read-only database.

Tests (`positionOutbox.test.mjs`): requeue keeps the failed positions;
a newer move for the same piece wins over the requeued one; delay schedule;
`attempt` resets on success. Fault injection for the hook is covered by a
node test that stubs `dbBatchMovePieces` to reject once then resolve, and
asserts the second call carries the original moves.

### 4. LSP teardown reap (F4)

`transport.rs`:

- `wait_timeout(&self, timeout: Duration) -> Option<ExitStatus>`: polls
  `child.try_wait()` every 25 ms up to `timeout`; returns `Some(status)` on
  exit, `None` on timeout. Lock held only per poll (Orchestration §1.2
  rule 3: never hold the child lock across the wait).
- `wait()` loses `#[allow(dead_code)]` and becomes the reap call; `kill()`
  unchanged.

`session.rs::stop_session` becomes the §1.2 cascade:

1. `mark_stopping()` (signal intent; already present).
2. `shutdown` request, 3 s (flush; already present).
3. `exit` notification.
4. `wait_timeout(1_500 ms)`; on `None`, `kill()`.
5. `wait()`: reap unconditionally (a killed child is still a zombie until
   waited on Unix; on Windows it closes the handle).

`teardown_all_sessions` (app exit): same cascade per session but with a
**shared budget**: `shutdown` timeout 500 ms and `wait_timeout` 500 ms per
session, so ten sessions cannot hold the window-close for 45 s. The
terminal manager's `teardown_all_sessions` runs first today and is
untouched.

Crash-detection interaction: the read loop already treats EOF after
`mark_stopping()` as graceful (`transport.rs:428-430`), so the added wait
does not create a false crash event.

Tests (Rust, `#[cfg(test)]` in `transport.rs`, platform-conditional per
implementation-policy Rule 2): a cooperative child (`cmd /C exit 0` /
`sh -c 'exit 0'`) returns `Some` from `wait_timeout` without `kill`; a
stubborn child (`cmd /C ping -n 30 127.0.0.1` / `sh -c 'sleep 30'`) times
out, is killed, and `wait()` returns a status, proving the reap. `cargo
build` must be warning-free without the `allow`.

### 5. Engine capability `containsTextFocus` (F5)

New neutral module `src/editor/engineCapabilities.js` (NOT in
`ENGINE_FILES`; it names no engine vocabulary):

```
registerEngineCapabilities({ containsTextFocus })   // engine calls at mount
containsTextFocus(el)                                // consumers call
```

Default implementation before any engine registers: `el.isContentEditable`
or `INPUT|TEXTAREA|SELECT`, the portable half of today's predicate.
`EditorMonaco.jsx` (engine file) registers
`el => Boolean(el?.closest?.('.monaco-editor'))` on mount and unregisters on
unmount. `interactionDomain.isEditableTarget` and
`useGlobalShortcuts.isInMonaco` call `containsTextFocus(document.activeElement)`;
both `TEMP_ALLOWED_DOM_COUPLING` entries are deleted so the guard's debt
report prints zero. Guard rule 2 is respected because consumers import the
neutral module, not `monacoSetup`/`monacoWorkspace`.

Tests: `engineCapabilities.test.mjs` (default predicate; registration
overrides; unregister restores); guard run shows `TEMP debt (0)`.

### 6. Truthful capability claims and policy gaps (F3, F6–F11)

Docs-only slice; every edit is a dated correction, never a silent rewrite.

- `docs/CAPABILITIES.md` §8: replace the "Crash-safe: working copies
  persist; unsaved work survives restarts" bullet with the true contract:
  *unsaved edits live in the editor session; deliberate exits and project
  switches are gated (Save / Discard / Cancel); a process crash loses
  unsaved edits, and the crash screen's "files already saved are safe" is
  the exact promise.* Whether a durable draft store should exist is ruling
  R2; until it ships, the doc may not claim it.
- `docs/CAPABILITIES.md` §6: definitions attributed correctly (Python local
  intelligence; Monaco TS worker for open TS/JS models; LSP definition
  deferred) and a **language tier table** added: Editable (pointer:
  `editorLanguage.js`) · Discovered/wired (pointer: `DISCOVERY_EXTENSIONS`)
  · Symbol/import-indexed (JS/TS, Python) · LSP-served (Python, TS/JS
  bundled; Rust, C/C++ managed; Go by hint). Pointers, not copied lists
  (documentation-policy Rule 4).
- `src/hooks/useNodeHealth.js` comment: "errors from the diagnostic store
  (LSP + Monaco built-in markers)".
- `README.md:47-50`: *"**Linux**: the source build passed the Linux parity
  checklist on Fedora 44 (2026-07-31); the packaged AppImage/deb/rpm have
  not yet been launched by a human."* (ruling R5 on wording). Historical
  `RELEASE_NOTES.md` entries stay as written; the next release entry carries
  the corrected platform line.
- `Agents/docs/release-policy.md`: new rule with provenance (2026-09-15
  release journal): *the GitHub release object must exist before the
  workflow's upload step runs; create it immediately after pushing the tag;
  `release.yml` only uploads.*
- `docs/security-audits/security-audit.md:1037`: dated addendum on the row:
  slice 4 ruled and merged (PR #37, v1.0.6).
- ADR-026 §Implementation Follow-ups: the "failed FILE saves still
  console.warn-only" item points here (ADR-027 slice 1).

## Slices

Verification per `Agents/docs/verification-policy.md` Rule 1 on every slice;
slice 3 additionally `cargo build` zero warnings + `cargo test`; slices 1
and 5 include a screenshot of the pill (implementation-policy Rule 6) since
a new notice shape renders there.

| # | Slice | Findings | Files | Tests | Acceptance |
|---|---|---|---|---|---|
| 1 | Honest file save + shared failure surface | F1, F1b | `useProjectPersistence.js`, `EditorSessionContext.jsx`, `editorSessionDomain.js`, `persistenceFailures.js` (new), `persistenceNotices.js`, `dbStorage.js`, `usePersistenceNotices.js` | reducer rows; `saveOutcome.test.mjs`; notice rows | Make a file read-only on disk, edit, Ctrl+S: tab stays blue, pill shows the file notice, project switch prompts again; restore permission, Ctrl+S: green |
| 2 | Outbox retry | F2 | `positionOutbox.js`, `useProjectPersistence.js` | `positionOutbox.test.mjs` (+4) | Lock `workspace.db` with a second process (or chmod), drag a node, release the lock within 30 s: position persists on reopen |
| 3 | LSP teardown reap | F4 | `transport.rs`, `session.rs` | 2 Rust tests, both platforms conditional | `cargo build` zero warnings; stop a session with a live pyright: no orphan process in the OS process list; app exit with three sessions returns within the budget |
| 4 | `containsTextFocus` capability | F5 | `engineCapabilities.js` (new), `EditorMonaco.jsx`, `interactionDomain.js`, `useGlobalShortcuts.js`, `editor-engine-guard.mjs` | `engineCapabilities.test.mjs` | Guard prints `TEMP debt (0)`; bare-letter shortcuts still suppressed inside the editor, still fire on the canvas |
| 5 | Truthful docs + policy | F3, F6–F11 | `CAPABILITIES.md`, `README.md`, `useNodeHealth.js`, `release-policy.md`, `security-audit.md`, ADR-026 follow-ups | none (docs) | Zero hits for "unsaved work survives restarts"; CAPABILITIES tier table present; release-policy rule present |

Order: 5 (no code, unblocks the public docs immediately), then 1, 2, 3, 4.
Slices 1–4 are independent of each other and each is one PR. Slice 1
carries the ADR-026 follow-up, so ADR-026 gets its addendum in that PR.

## Rulings requested

**Owner rulings (2026-09-15, all five RULED as proposed — "R1. agreed, R2
agreed, R3. agreed, R4 agreed, R5 agreed"):** the *Proposed answer* column is
now the ruling. R2 means the durable draft store stays out of this arc and
gets its own brief only if the owner asks for one. No implementation was
started at ruling time.

| # | Question | Ruling (proposed answer, accepted) |
|---|---|---|
| R1 | After a failed normal save: keep dirty + notice + the gate aborts the transition (like a cancelled Save As)? Or auto-retry? | **Keep dirty + notice + abort.** No automatic file-write retries. |
| R2 | Should a durable draft store (unsaved text surviving a crash) exist? | **Not in this arc.** Correct the claim now; if wanted, a separate brief (SQLite `drafts` table or `.litria/drafts/`; both need a conflict rule against the disk file). |
| R3 | Notice copy for a failed file save | *Couldn't save "<path>": <reason>. Your edits are still in the editor.* (plain text; the path is wrapped in double quotes, matching the write manager's existing messages — re-stated 2026-09-15 after the first render showed literal backticks) |
| R4 | Outbox retry: bounded or unbounded while the project is open? | **Unbounded, backoff capped at 30 s; moves are never dropped.** |
| R5 | README Linux wording | The sentence in Design §6 above. |

## Deferred / not in scope

- Generic LSP `textDocument/definition` (feature brief; F8 is doc-only here).
- Durable draft store (R2).
- Cross-store transactionality (F12): accepted property; the persistence
  contract brief (ADR-026 "Pass 7") is where it would be revisited.
- macOS package acceptance, packaged-Linux human launch, dependency re-audit,
  bundled LSP pin bumps: separate owners, listed in Origin.
