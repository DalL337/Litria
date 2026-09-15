# ADR-027: Honest save state, retryable position outbox, LSP teardown reap, and evidence-backed capability claims

## Status

Accepted (2026-09-15 — owner ruled R1–R5 in the brief exactly as proposed,
same day as drafting; no slice started; the brief's Rulings section is the
record)

Proposed (2026-09-15 — drafted at owner direction from the two-agent
systems audit of the same day; five rulings requested in the brief (Rulings section);
formal acceptance on owner review of this document)

## Date

2026-09-15

## Context

On 2026-09-15 a second agent produced a read-only systems analysis of the
repository at `5f8d9a2` (v1.0.6) and Claude verified it claim by claim
(journal `.research/2026-09-15-codex-audition-accuracy-audit.md`). The
verification confirmed three behavior defects, one violation of an existing
architecture rule, one item of tracked engine debt, and a cluster of
documentation that asserts capabilities the code does not have:

- **Save honesty.** `persistSavedTab` mutates piece state, then attempts the
  disk write and swallows failure; the editor context marks the tab clean
  without awaiting the write; the unsaved-changes gate aborts only on an
  explicit `false`. A locked or read-only file therefore produces a green
  LED, a clean tab, and a silent divergence between editor and disk. The
  untitled Save As path already has the correct contract; the normal path
  does not. ADR-026 listed this as an open follow-up.
- **Position durability.** The piece-position outbox drains before the
  batch write and only logs a rejection. ADR-026 made the failure visible;
  nothing retries it, so a transient `db.busy` loses layout.
- **Teardown.** `docs/Orchestration.md` §1.2 rule 2 requires *signal, flush,
  wait with timeout, force kill, reap*. LSP session stop does signal, flush,
  kill; the reap call exists but is dead code.
- **Engine island.** The editor-engine guard carries two `.monaco-editor`
  DOM predicates as TEMP debt and names the capability that would retire
  them.
- **Claims without evidence.** `docs/CAPABILITIES.md` says unsaved work
  survives restarts (it does not), credits the LSP client with definitions
  that come from local providers or Monaco's TS worker, and offers no
  statement of which languages are editable versus discovered versus
  LSP-served. `README.md` says Linux has never been human-launched, which
  the 2026-07-31 Fedora parity run made imprecise. The release policy omits
  the one fact the 1.0.6 release rediscovered under pressure: the workflow
  uploads to a release it does not create.

The canonical detailed design, evidence table with line citations, slices
and rulings live in
`docs/plans/persistence/brief-honest-save-and-teardown.md`.

## Decision

### 1. Save state follows disk

A tab is marked clean only after the filesystem write manager reports
success, and the piece's `code` baseline is derived from that same result.
The normal save path adopts the contract the untitled Save As path already
has: a `savedCode` snapshot is captured before the await, the reducer
baselines to that snapshot, and keystrokes typed during the write remain
dirty. Piece state is never updated on the assumption the write will
succeed (implementation-policy Rule 7 applied to the save path).

### 2. One persistence-failure surface

Every persistence failure the user can act on, file or database, reports
through the ADR-026 notice state and pill. The write-failure observer moves
out of the database adapter into a neutral module so the file-save path can
emit without importing the adapter. `console.warn` remains the secondary
trace. The read-only workspace flag continues to describe `workspace.db`
only; it does not gate file writes.

### 3. A failed save aborts the transition

The unsaved-changes gate and the exit prompt already abort on `false`. A
failed normal save returns `false`, so project switch, close, and exit are
blocked exactly as a cancelled Save As blocks them today. There is no
automatic retry of file writes: the user retries by saving again, or
chooses Discard or Cancel with full information.

### 4. Position moves are never dropped

A failed batch position write re-queues its moves into the pending outbox
with newer-position-wins merge semantics and schedules a retry with
exponential backoff capped at 30 seconds. Retries continue while the
project is open. The existing notice fires once per rate window; the retry
loop adds no new surface. Read-only instances remain skipped at the source.

### 5. LSP teardown follows Orchestration §1.2

Session stop becomes *mark stopping, `shutdown` request with timeout, `exit`
notification, wait with timeout, kill if still running, reap*. The transport
gains a polling `wait_timeout`; `wait` ceases to be dead code and is always
called. App-exit teardown runs the same cascade with a per-session budget so
many sessions cannot stall window close. This is the enforcement of an
existing rule, not a new one.

### 6. Text-focus detection is an engine capability

`containsTextFocus(el)` is a registered engine capability behind a neutral
module: the engine registers its implementation at mount, consumers call
the neutral function, and the default implementation covers content-editable
and form controls. The two TEMP debt entries in the editor-engine guard are
deleted; the guard's debt report must print zero.

### 7. Capability claims require executable evidence

`docs/CAPABILITIES.md` states only what code and tests demonstrate. The
"unsaved work survives restarts" claim is removed and replaced with the
actual contract (gated exits; crash loses unsaved edits; saved files are
safe). Definitions are attributed to their real providers. A language tier
table (editable, discovered/wired, symbol-indexed, LSP-served) is added
using pointers to the owning code constants rather than copied lists. A
durable draft store is not a capability until it exists (brief, ruling R2).

### 8. Public platform statements are precise

`README.md` distinguishes a source-built parity pass from a packaged
artifact launched by a human, and says which of the two Linux has. Historic
`RELEASE_NOTES.md` entries are not rewritten; the next release entry carries
the corrected line.

### 9. Release policy records the upload precondition

`Agents/docs/release-policy.md` gains a rule, with provenance, that the
GitHub release object must exist before the workflow's upload step runs,
because `release.yml` only uploads.

## Consequences

Positive:

- A green LED and a clean tab mean the text is on disk. The first-hour
  basic "I pressed save and it saved" is defended by code, not by hope.
- Layout survives transient database contention without user action.
- No orphaned language-server processes after stop or app exit; the
  teardown rule is enforced where it was written down.
- The editor-engine guard reaches zero TEMP debt for the first time since
  it was added.
- Public documentation and the capability register stop promising what the
  program cannot do, which is the bar the beta-flip rule set.

Costs:

- Save becomes asynchronous on the normal path; callers that relied on the
  synchronous `SAVE_TAB` dispatch (none found; the gate already awaits)
  must await the returned promise.
- The `SAVE_ALL` reducer action is removed; per-tab dispatch replaces it.
- A retry loop lives in the persistence hook; it is bounded by project
  lifetime and the notice window, but it is one more timer to reason about.
- Teardown adds up to 1.5 seconds per session on stop and a bounded budget
  on exit.

## Alternatives Considered

- **Auto-retry file writes.** Rejected: a retry loop against a locked or
  read-only file is the hidden restart loop the crash-capture design
  forbids; the user must decide.
- **Durable draft store now** (SQLite `drafts` table or `.litria/drafts/`).
  Deferred to a separate brief pending ruling R2: it needs a conflict rule
  against the disk file and a recovery UI, and shipping the doc correction
  first is the honest move regardless.
- **Bounded outbox retries with drop.** Rejected: dropping a move is the
  defect being fixed; bounding by project lifetime already ends the loop.
- **Kill without wait, keep `wait` dead.** Rejected: contradicts the
  written teardown rule and leaves zombies on Unix.
- **Allow consumers to import `monacoWorkspace` for the focus predicate.**
  Rejected: violates editor-engine guard rule 2; the neutral registry keeps
  Monaco sealed.
- **Leave README as is.** Rejected: the sentence is false for the source
  build and deleting it would be false for the packaged build.

## Scope Notes

- **Cross-store atomicity is accepted.** File text, React state and SQLite
  metadata remain three independent writes with no shared transaction.
  Decisions 1–4 are the mitigations; a transactional persistence contract
  belongs to the deferred ADR-026 "Pass 7" brief.
- Generic LSP `textDocument/definition` is a feature, not part of this
  arc; decision 7 only makes the documentation truthful about it.
- macOS package acceptance, a packaged-Linux human launch, dependency
  re-audit and bundled LSP pin bumps are separate owners' work.

## Implementation Follow-ups

- Slice order per the brief: 5 (docs) first, then 1, 2, 3, 4; each of 1–4
  is one PR. Slice 1 adds the ADR-026 addendum closing its "failed FILE
  saves" follow-up.
- Rulings R1–R5 were all accepted 2026-09-15; nothing gates the slices now.
  R2 (no durable draft store in this arc) means the CAPABILITIES correction
  in slice 5 stands on its own; a draft-store brief is written only on
  owner request.
