# Live durability defects: workspace epoch fencing and write truthfulness

**Status:** Canonical detailed design. Rulings requested (see §7); decision record is
[ADR-032](../../adrs/032-workspace-epoch-fencing-and-write-truthfulness.md).
**Date:** 2026-09-19.
**Provenance:** The [agent-integration adversarial review](../ideas/brief-project-api-mcp.md#12-adversarial-design-review--2026-09-19)
(R1–R3) flagged three defects as prerequisites for *agent writes*. This brief re-verified
them against the current tree and establishes that all three bite **today, with no agent
involved**, and that two were mis-sized in that review — one understated, one overstated.
**Verification:** Source inspection on 2026-09-19 against `docs/agent-integration-design`
at `ef4c2a3`. D1 additionally probed against the real hook the same day (see the erratum in
§D1); D2–D5 remain source-inspection only. Every claim below carries a `file:line`. **Nothing here was reproduced at
runtime** — each slice in §6 carries its repro as an acceptance gate, not as evidence
already obtained.

## 1. Why this is a separate arc

ADR-026 made workspace persistence durable and gave failed writes one visible surface.
ADR-027 made the editor's save path honest. Both arcs shipped and were owner-verified.

The defects below sit in the gaps those arcs did not reach: the **project-switch boundary**
(ADR-026 hardened the database, not the handoff between two of them) and the **non-editor
writers** (ADR-027 made `persistSavedTab` honest and left the canvas and syntax writers
alone). They are ordinary-use bugs on `main` at v1.0.8. Filing them against a possible
future agent integration would leave them unfixed for as long as that work stays over the
horizon.

## 2. The five defects

| # | Defect | Verified at | Severity |
|---|---|---|---|
| D1 | Project A's piece moves are written into project B on switch | `db/mod.rs:173,227`; `useProjectLaunch.js:259-293`; `useProjectPersistence.js:527-537` | **High** — silent cross-project corruption; window characterized 2026-09-19, see erratum in §D1 |
| D2 | `replace_file`'s fallback can destroy both the old file and the new content | `write_ops.rs:53-72`, `:167-169` | **High** — total document loss |
| D3 | Closed-file syntax writes report success without checking the write | `syntaxAdapter.js:132-136` | **High** — silent, no notice, no undo |
| D4 | Delete-undo's filesystem restore ignores its result | `filesystemWriteManager.js:694,701` | Medium — undo appears to have worked |
| D5 | FSM returns `{success:true}` over fire-and-forget database writes | `filesystemWriteManager.js:321`, 15 sites | Medium — canvas and database diverge |

### D1 — the workspace database has no identity

`PROJECT_DB` is one process-wide slot (`src-tauri/src/db/mod.rs:173`) and
`with_workspace_db` (`:227-239`) takes no workspace argument. Every `db_*` command resolves
to *whatever connection is open right now*. Nothing in a queued or in-flight write records
which project it was issued for.

`useProjectPersistence.js:84` declares `activeInstanceIdRef` and `:172` assigns it. **It is
never read.** A grep of the file returns exactly one hit. The fence was started and never
wired.

The consequence is not a narrow race. It is deterministic ordering:

```
handleOpenProjectInstance(B):
  1. await teardownActiveProject()  →  await dbCloseProject()      PROJECT_DB = None
  2. await dbOpenProject(B)                                        PROJECT_DB = B
  3. setProjectInstance(B)  →  React commit  →  A's effect cleanup runs HERE
        └─ void flushPendingMoves({ allowRetry: false })
             └─ dbBatchMovePieces(A's pending moves)  →  lands in B
```

> **Erratum (2026-09-19, Layer 1 probe):** the ordering claim below is confirmed — React
> effect cleanup for the outgoing instance does run after `dbOpenProject(B)`, and A's
> payload demonstrably reaches B. **"Deterministic ordering, not a race" is wrong**, and the
> severity in §2 is corrected from Critical to High. The corruption additionally requires
> the position outbox to be non-empty when teardown completes. A sweep of the delay between
> the last piece move and `dbCloseProject` puts the boundary exactly at
> `POSITION_FLUSH_DEBOUNCE_MS = 300` (`positionOutbox.js:20`): at 0/100/150/250/290ms the
> flush reaches **B**; at 310/350/1200ms the debounce has already flushed safely into **A**
> and the outbox is empty. At 250ms the failure is indirect and worse — the debounce fires
> inside the closed window, the write throws, the moves are requeued, and the cleanup flush
> retries them into B. Because `teardownActiveProject` runs terminal and LSP teardown before
> `dbCloseProject`, the window is open mainly when neither has work pending: open a folder,
> drag a piece, switch immediately. The defect class is unchanged — the other ~52 unawaited
> writes have no debounce protecting them at all. Method and full sweep:
> `.research/2026-09-19-live-durability-defects.md` §Step 8.

Step 3 is `useProjectPersistence.js:527-537`. The flush is fire-and-forget (`void`), has no
project-identity guard (`flushPendingMoves`, `:435-480`), and runs **after** B is open — so
it is not racing the teardown, it is ordered behind it.

Two source comments assert the opposite and are inaccurate for this path:

- `useProjectLaunch.js:286-288` — "Any in-flight debounced writes from useProjectPersistence
  will fail harmlessly (the DB is gone)." They do not fail; B is open by then.
- `useProjectPersistence.js:527-529` — "best-effort — the workspace DB is still the outgoing
  project's at cleanup time." It is not; it is the incoming project's.

Piece IDs are per-workspace autoincrement and overlap — the same file says so at `:530`.
So A's row IDs almost always exist in B, and B's pieces silently inherit A's coordinates.
The ADR-026 failure notice cannot fire, because **the write succeeds**.

The carrier set is not just the position outbox. A sweep for unawaited persistence writes
returns **53 `catch(() => {})` sites across 19 files** — `filesystemWriteManager.js` (15),
`useThemeActions.js` (6), `useGroupMenuActions.js` (5), `groupStructureOps.js` (5),
`useScaffoldActions.js` (4), and more. Any of them in flight across a switch lands in the
wrong workspace. That scale is the argument against per-call-site fixes.

### D2 — the atomic writer's fallback is destructive

`replace_file` (`src-tauri/src/write_ops.rs:53-72`):

```rust
match fs::rename(temp_path, target) {
    Ok(()) => Ok(()),
    Err(first_error) => {
        if target.exists() {
            fs::remove_file(target)?;          // original is now gone
            fs::rename(temp_path, target)?;    // if THIS fails …
            Ok(())
        } else { Err(...) }
    }
}
```

The review stopped at "the original can already be gone." It is worse. When the second
rename fails, `replace_file` returns `Err`, so the caller's cleanup runs
(`write_ops.rs:167-169`):

```rust
if write_result.is_err() && temp_path.exists() {
    let _ = fs::remove_file(&temp_path);       // new content is now gone too
}
```

**Both versions are destroyed.** This is not a rollback to the previous revision; it is
total loss of the document. No backup exists on this path: `backup_path` is `Option`, and
only `atomic_write_string_with_backup` supplies one — `write_project_file`
(`project_ops.rs:18-25`) passes `None`.

Blast radius is the ordinary save path, not manifests. `write_project_file` is the general
project-file writer, reached from `useProjectPersistence.persistSavedTab` (Ctrl+S),
`useUntitledSaveAs`, `usePieceUiActions` (new piece), FSM `writeFile`/`moveOrWriteFile`, and
`syntaxAdapter.writeResultText`.

On Windows, Rust's `fs::rename` uses `MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`, so the
first rename normally overwrites and the fallback never runs. The window opens when the
first rename fails against an existing target — a file locked by antivirus, a sync client,
or another process — and then `remove_file` succeeds while the retry fails. Narrow, but it
is the exact shape a transient Windows lock produces, and the existing tests do not cover
it: `atomic_write_string_retry_succeeds_after_simulated_interruption` injects its failure
*before* `replace_file` is reached.

### D3 — closed-file syntax writes always claim success

`src/lsp/syntaxAdapter.js:132-136`:

```js
if (writeProjectFile) {
  await writeProjectFile(projectRoot, absToRel(absPath), newText);  // result discarded
  syntaxDomain.commands.notifyFileChanged(absPath, newText);
  return true;
}
```

`writeProjectFile` resolves `false` on failure rather than throwing (`storage.js:116-130`),
so a failed write is indistinguishable from a successful one here.

This is the canvas-wire import-stub path, which by design writes to **closed** files. On
failure the wire appears on the canvas, the syntax domain is told the file changed, and the
file on disk never received the import. There is no compensating notice: file writes do not
flow through `emitPersistenceWriteFailure` — only `db_*` commands do (`dbStorage.js:41-53`),
plus the two explicit call sites in `useProjectPersistence`. And per existing project
doctrine, canvas writes to closed files have no undo.

### D4 — delete-undo does not check whether it restored anything

`filesystemWriteManager.js:694` and `:701` build the undo/redo `extraActions` for a deleted
file:

```js
writeProjectFile(currentRoot, capturedPath, capturedContent).then(() => bumpScaffoldRefresh());
```

No result check. Because `writeProjectFile` resolves `false` instead of throwing, the
`.then` always runs. The canvas piece returns, the scaffold refreshes, and the file may
still be absent from disk. The user is told nothing.

### D5 — the FSM's success value is not a claim about persistence

`ok()` is `{ success: true }` (`filesystemWriteManager.js:321-323`), returned after
fire-and-forget `dbUpdatePiece(...).catch(() => {})` and siblings (15 sites in that file
alone: `:426, :441, :448, :466, :531, :568, :573, :645, :723, :738, :746, :794, :801`, …).

This one is **substantially narrower than the review implies**, and the brief records the
correction: ADR-026 decision 3 already routes every mutating `db_*` command through
`invokeDb` and emits `emitPersistenceWriteFailure`, which `usePersistenceNotices` surfaces
as a rate-limited canvas notice. The user *is* told a write failed.

What remains is real but different: the operation's **return value** is still a lie, so no
caller can branch on it, and in-memory state diverges from the database. The canvas shows
the piece at its new path; the database kept the old one; the change silently reverts on
reopen. The notice says "a write failed"; it does not say "this move will not survive."

Two further corrections to the review, for the record:

- **FSM file writes are already honest.** `writeFile` (`:856`) and `moveOrWriteFile`
  (`:519`) both check the writer boolean and return `fail(...)`.
- **The editor save path is already honest.** `persistSavedTab`
  (`useProjectPersistence.js:101-138`) checks the result, consults the typed storage error
  and emits on failure — that is ADR-027 working as designed.

## 3. What the fix has to be shaped like

**The fence must be authoritative in Rust.** A JavaScript-side check is necessary but not
sufficient: D1 fires from inside a React cleanup closure whose notion of "the current
project" is itself stale. Only the process that owns the connection can decide whether a
request belongs to the workspace now open.

**The stamp belongs at the existing chokepoint.** `invokeDb` (`dbStorage.js:41-53`) is
already the single funnel every `db_*` call passes through — that is precisely why ADR-026
was able to install the failure observer in one place. Stamping a workspace epoch there
fences all 53 unawaited sites without editing a single call site. Per-call-site fixes would
be 53 edits and would regress the moment the 54th is written.

**`replace_file` must never reach a state with no readable version.** The fix is not to
retry harder; it is to never delete the target before the replacement is in place, and to
preserve the temp file when replacement fails so the content can be recovered.

**Honest writers are a return-value contract, not a notification.** D3 and D4 are not fixed
by adding a toast. They are fixed by propagating the boolean that already exists.

## 4. Proposed mechanisms

### 4.1 Workspace epoch (D1)

`open_workspace_db` mints a monotonic epoch token and stores it beside the connection:
`Mutex<Option<(WorkspaceEpoch, Connection)>>`. `close_workspace_db` clears both.
`with_workspace_db` gains an `expected: WorkspaceEpoch` parameter and returns a distinct
`DbError::WorkspaceChanged` when it does not match the open one.

The epoch is returned to JavaScript by `db_open_project`, held in one module-level slot in
`dbStorage.js`, and attached by `invokeDb` to every mutating command. A command arriving
with a stale or absent epoch is rejected before it touches the connection.

Rejection is **not** a persistence failure in the ADR-026 sense — it is a correctly fenced
write for a workspace that is no longer open, and it must not raise the failure notice.
It needs its own code (`db.workspace_changed`) and should be silent to the user and visible
in breadcrumbs.

Open ruling: whether reads are fenced too. Recommended **yes for symmetry**, since a stale
read feeding a stale write is the same bug one step earlier, but reads are lower risk and
could ship in a second step if the diff proves large.

### 4.2 Non-destructive replacement (D2)

Two changes, both inside `write_ops.rs`:

1. Remove the delete-then-rename fallback. When the first rename fails against an existing
   target, return the error. On Windows the first rename already replaces, so the fallback
   is not load-bearing for the ordinary path; on Unix `rename(2)` replaces atomically. If
   qualification shows a platform genuinely needs a second step, it must be a
   *non-destructive* one (rename the target aside, move the replacement in, then remove the
   aside copy) so no moment exists with neither version present.
2. On replacement failure, **keep the temp file** and report its path in the error. The
   current cleanup (`:167-169`) is correct when the failure happened *before* replacement
   was attempted, and destructive when it happened during it. The two cases must be
   distinguished.

Whether to promote `backup_path` from opt-in to default on `write_project_file` is a
separate call — it doubles write I/O on every save and needs its own retention story. **Not
recommended** as part of this arc; noted so the option is not lost.

### 4.3 Honest writers (D3, D4)

`writeResultText` returns the writer's result instead of `true`, and does **not** call
`notifyFileChanged` when the write failed — telling the syntax domain a file changed when it
did not is the second half of the bug. Its caller `_applyEdits` already counts successes, so
the count becomes truthful for free.

The delete-undo `extraActions` check their results and surface a failed restore through the
same channel ADR-027 established.

### 4.4 Truthful FSM outcomes (D5)

`ok()` grows an explicit shape distinguishing what was confirmed — the filesystem effect,
which is awaited today — from what was dispatched but not awaited. The minimum viable
version is a flag on the result rather than a full per-effect receipt; a full receipt model
is agent-era work and should not be pulled forward.

The unawaited database writes themselves stay unawaited: awaiting them on the interaction
path would put a SQLite round trip inside a canvas drag. The fix is to stop *claiming* they
completed, not to make them synchronous.

## 5. A guard, not a promise

Per repository doctrine, an architecture rule that is not enforced is a plan. The proposed
guard: no `db_*` write may reach `invoke` except through `invokeDb`, and the epoch stamp is
applied there unconditionally. That is a small static check over `src/project/dbStorage.js`
plus a ban on direct `invoke('db_…')` elsewhere, and it is what keeps the 54th call site
fenced for free.

## 6. Slices

Ordered by severity and independence. Each slice's acceptance is a **reproduction first**,
then the fix, then the repro failing to reproduce.

| Slice | Scope | Repro that must exist first | Acceptance |
|---|---|---|---|
| **S1** | Workspace epoch fence (D1) | Move a piece, switch projects inside the debounce window, reopen A and B; B's pieces show A's coordinates | Same sequence leaves B untouched; rejected writes carry `db.workspace_changed` and raise no user notice; `activeInstanceIdRef` is removed or wired |
| **S2** | Non-destructive replacement (D2) | Unit test injecting a rename failure against an existing target inside `replace_file` — the branch the current suite never enters | Old content survives every injected failure; temp preserved and named in the error when replacement fails mid-way; no path leaves zero readable versions |
| **S3** | Honest writers (D3, D4) | Force `write_project_file` to fail (read-only file) with the target closed, then drag a wire to it; then delete a piece and undo | Wire creation reports failure and does not notify syntax; failed undo restore is surfaced |
| **S4** | Truthful FSM outcomes (D5) | Force a `db_*` write to fail during a piece move; reopen the project | Result distinguishes confirmed filesystem effect from dispatched persistence; divergence is visible rather than silent |
| **S5** | Guard + docs | — | Guard fails on a direct `invoke('db_…')`; `Orchestration.md` records the epoch contract; the three inaccurate source comments are corrected |

### Delivery record (2026-09-19)

All five delivered the same day. Order was S2 first — the probe in §D1's erratum
demoted D1 from Critical to High, which put D2's total document loss ahead of it.

| Slice | PR | Note |
|---|---|---|
| S2 | #57 | Repro entered a branch the suite had never reached; the failing assertion printed the predicted "both the previous revision and the replacement content were destroyed". |
| S1 | #58 | The regression test refuted decision 2 as written — see the erratum on that decision. `activeInstanceIdRef` removed; three inaccurate source comments corrected. |
| S3 | #59 | Two earlier drafts of the probes passed **vacuously** and were replaced. Two existing test stubs were found to be modelling a failing writer. |
| S4 | #60 | The `ok()` sites are classified by a flag set next to each dispatch, not by hand: one site sits after a conditional `dbDeleteGroup` and a static reading would have been wrong. |
| S5 | #61 | Both guard failure modes exercised before wiring it in. Seven guards now. |

What the reproduction gate actually bought, since this was its first sustained use:
it corrected D1's severity before any code was written, then caught a fix that would
have shipped green and unfenced, then caught three probes of my own that could not
fail. Every one of those would have passed a review of the design.

Still owed: owner live acceptance and a release build. Decision 4's expected behavior
change — replacement failures that the old fallback swallowed now surfacing as save
errors — has not been exercised on a real Windows machine.

S1 and S2 are independent and can run in parallel. S3 and S4 both touch write-result
plumbing and should be sequential. S5 lands last so the guard codifies what shipped.

Sizing is deliberately not given. The repository's estimation history is that slice counts
survive and hour counts do not.

## 7. Rulings requested

1. **R-A — Scope.** Fix all five in one arc, or ship S1+S2 (the two data-loss defects) and
   defer S3–S5? *Recommendation: one arc, S1/S2 first, so the guard in S5 lands over the
   finished shape.*
2. **R-B — Read fencing.** Does the epoch fence reads as well as writes?
   *Recommendation: yes, same slice, unless the diff argues otherwise.*
3. **R-C — Backups.** Leave `backup_path` opt-in on `write_project_file`?
   *Recommendation: yes — doubling save I/O needs its own case.*
4. **R-D — Multi-process.** The review also recommended one writable owner per workspace
   enforced across processes. Two Litria instances on the same folder is a real
   configuration and `PROJECT_DB` is per-process, so the epoch fence does nothing about it.
   *Recommendation: out of scope here; record it as a known limit and treat it as its own
   investigation.*
5. **R-E — Disclosure.** v1.0.8 is public with D2 present. Does the fix ship quietly in the
   next release, or does it warrant a note in the release entry?
   *Recommendation: a plain line in the release notes — the project's honesty posture is
   its own argument, and the window is narrow enough that the note costs nothing.*

## 8. What this brief does not claim

No defect here was reproduced at runtime; all five are source-order and source-inspection
findings, and S1–S4 each carry their repro as the first acceptance gate specifically so the
fix is never accepted on the strength of this document alone. Severity ordering is a
judgement about blast radius, not a measured frequency — in particular D2's window is
unproven and may be rare enough never to have been hit. No claim is made that this is the
complete set of durability defects on `main`; it is the set reachable from R1–R3 plus the
sweep in §2.

Citation check, 2026-09-19: all 19 `file:line` references in this brief were re-resolved
against the working tree after drafting and corrected where they had drifted; every
relative link and heading anchor in this brief and in ADR-032 resolves. The investigation
journal is `.research/2026-09-19-live-durability-defects.md` (gitignored by design).
