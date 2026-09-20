# ADR-032: Workspace epoch fencing and write truthfulness

## Status

Amended (2026-09-19 — Layer 1 probe executed against the real
`useProjectPersistence` hook before acceptance. D1's ordering claim is confirmed and its
severity is corrected from Critical to High: the corruption is timing-dependent on a
~300ms window, not unconditional. See the erratum in Context and the
[brief's D1 erratum](../plans/persistence/brief-live-durability-defects.md#d1--the-workspace-database-has-no-identity).
Ruling R-A's slice ORDER is reopened as a result — D1 no longer obviously outranks D2.)

Rulings accepted (2026-09-19 — owner ruled R-A one arc, R-B fence reads, R-C backups stay
opt-in, R-D multi-process out of scope, R-E disclose in release notes; and accepted all
eight decisions below as written. Rotating `.bak` generations raised under R-C and
redirected to a future local-file-history brief rather than this arc.)

Proposed (2026-09-19 — drafted at owner direction from a re-verification of R1–R3 in the
agent-integration adversarial review, which established that all three describe live
behavior on `main` at v1.0.8 rather than prerequisites for agent writes. Five rulings are
requested in the brief's [Rulings section](../plans/persistence/brief-live-durability-defects.md#7-rulings-requested);
formal acceptance on owner review of this document. No slice started; no code changed.)

## Date

2026-09-19

## Context

ADR-026 made the workspace database durable and gave failed persistence writes one visible
surface. ADR-027 made the editor's save path honest. Both shipped and were owner-verified,
in v1.0.6 and v1.0.7 respectively.

The [agent-integration adversarial review](../plans/ideas/brief-project-api-mcp.md#12-adversarial-design-review--2026-09-19)
recorded three findings — R1, R2 and R3 — as prerequisites to be resolved *before agent
writes*. Re-verification against the current tree establishes that they are not gated on
that work: all three are reachable today through ordinary use, and the agent framing would
have left them unfixed for as long as agent integration stays over the horizon.

The re-verification also resized two of them. R2 is worse than reported: the destructive
fallback in `replace_file`, combined with the caller's temp-file cleanup, can destroy the
old file *and* the new content, so the failure mode is total document loss rather than a
rollback. R3 is narrower than reported: ADR-026's failure observer and ADR-027's honest
save already cover two of its three cited mechanisms, leaving the syntax adapter, the
delete-undo restore, and state/database divergence.

> **Erratum (2026-09-19):** a probe of the real hook confirmed the ordering — cleanup does
> run after `dbOpenProject(B)`, and A's payload reaches B — but refuted "not a race". The
> outbox must still be pending when teardown completes; past `POSITION_FLUSH_DEBOUNCE_MS`
> (300ms) the debounce has already flushed safely into A. D1 is High, not Critical, and the
> paragraph below should be read with that correction. The defect class is untouched: the
> other unawaited writes have no debounce protecting them.

R1 was understated in a different way. It is not an agent-era race. On the project-switch
path the outgoing project's position flush is ordered strictly *after* the incoming
project's database is opened, so project A's piece moves are written into project B's
workspace as a matter of sequencing, not timing. Two source comments assert the opposite.
Because the write succeeds, ADR-026's failure notice cannot fire.

The defects sit in the gaps the two prior arcs did not reach: the **project-switch
boundary**, which ADR-026 did not cover because it hardened a database rather than the
handoff between two of them, and the **non-editor writers**, which ADR-027 did not cover
because it scoped itself to the editor's save path.

The [live durability defects brief](../plans/persistence/brief-live-durability-defects.md)
is the **canonical detailed design**: it carries the five defects (D1–D5) with `file:line`
evidence, the mechanisms, the slice plan and the requested rulings.

## Decision

### 1. The workspace database gains an identity, and Rust owns it

`open_workspace_db` mints a monotonic workspace epoch and holds it beside the connection.
`with_workspace_db` takes the epoch the caller believes is current and refuses to execute
against a different one.

The fence is authoritative in Rust because the failure originates in JavaScript closures
whose own notion of the current project is stale. A JavaScript-side check is a useful early
rejection; it is not the boundary of record.

### 2. The epoch is stamped at the existing chokepoint, not at call sites

`invokeDb` in `src/project/dbStorage.js` is already the single funnel every `db_*` command
passes through — the property ADR-026 decision 3 relied on to install the failure observer
in one place. The epoch stamp is applied there, unconditionally.

A sweep of the current tree finds 53 unawaited persistence writes across 19 files. Fencing
them individually would be 53 edits and would regress at the 54th. Fencing them at the
chokepoint is one edit that covers every present and future site.

### 3. A fenced write is not a failed write

A command rejected for a stale epoch is correct behavior for a workspace that is no longer
open. It carries its own code, is invisible to the user, and must not raise the ADR-026
persistence-failure notice. Conflating the two would train users to ignore a notice that
exists to be believed.

### 4. No write path may leave zero readable versions

The destructive delete-then-rename fallback in `replace_file` is removed. Any replacement
step that a platform genuinely requires must be non-destructive, preserving the previous
version until the replacement is in place.

Temp-file cleanup distinguishes a failure that occurred *before* replacement was attempted,
where removing the temp is correct, from one that occurred *during* it, where the temp is
the only surviving copy of the user's content and is preserved and named in the error.

### 5. Writers report what happened

A writer's return value is a claim about the write. `writeResultText` in the syntax adapter
returns its writer's result rather than an unconditional `true`, and does not notify the
syntax domain of a change that did not occur. The delete-undo restore actions check their
results and surface a failed restore.

Notification is not a substitute for a return value: a toast tells the user something
failed, while a return value lets the caller stop.

### 6. The filesystem write manager distinguishes confirmed from dispatched

The manager's success value separates effects it awaited — the filesystem operation — from
persistence writes it dispatched without awaiting. The unawaited writes stay unawaited:
awaiting them would place a SQLite round trip inside a canvas drag. What changes is the
claim, not the concurrency.

A full per-effect receipt model is agent-era work and is deliberately not pulled forward.

### 7. The chokepoint is enforced by a guard

Guards are the enforcement of record. A guard rejects any direct `invoke` of a `db_*`
command outside `invokeDb`, which is what keeps the epoch stamp universal without relying
on reviewers to notice a bypass.

### 8. Each fix is accepted on a reproduction, not on this document

No defect recorded here was reproduced at runtime when this ADR was drafted; all five were
source-inspection findings. D1's gate was discharged the same day and immediately corrected
the record — which is the argument for the rule, not an exception to it. D2–D5 remain
undischarged.
Every slice's first acceptance gate is a reproduction of the defect, and the fix is accepted
only when that reproduction stops reproducing. Severity ordering is a judgement about blast
radius, not a measured frequency.

## Consequences

### Positive

- Cross-project corruption becomes structurally impossible rather than avoided by
  convention, and the guarantee survives every future unawaited write.
- No code path can reach a state where neither the previous nor the replacement content is
  readable.
- The honesty posture ADR-027 established for the editor extends to the canvas, syntax and
  undo writers, which is where the project's own doctrine says recovery is thinnest.
- Two defects that would otherwise have waited on agent integration are closed on their own
  schedule.

### Costs and limits

- Every `db_*` command signature gains an epoch parameter; the diff is wide even though it
  is shallow, and it touches the Rust command surface as well as the JavaScript wrappers.
- The epoch fences one process. Two Litria instances opened on the same workspace folder
  remain unguarded, because `PROJECT_DB` is per-process. This ADR does not close that.
- Removing the `replace_file` fallback may surface replacement failures that the fallback
  previously papered over, as errors rather than as silent successes. That is the intended
  trade, and it will look like a regression in any case where the fallback was quietly
  working.
- Distinguishing confirmed from dispatched effects changes a return shape that call sites
  currently treat as a boolean.
- v1.0.8 is public with these defects present. The fix ships after them, not before.

## Alternatives Considered

1. **Fix the 53 call sites individually.** Rejected. It is the same number of edits as the
   number of sites, it protects nothing written afterwards, and the chokepoint that makes
   the cheap fix possible already exists and is already load-bearing for ADR-026.
2. **Fence in JavaScript only.** Rejected as the boundary of record. The stale notion of
   "current project" that causes D1 lives in JavaScript; asking that layer to detect its own
   staleness is the assumption that produced the bug. Retained as an early rejection in
   front of the authoritative check.
3. **Await every persistence write.** Rejected. It puts a SQLite round trip inside canvas
   interaction and trades a correctness bug for a latency one. The defect is the claim, not
   the asynchrony.
4. **Await the position flush before closing the outgoing database.** Rejected as the
   primary fix, though it would close D1's specific trigger. It addresses one carrier out of
   53 and leaves the underlying "no identity" defect in place.
5. **Make backups mandatory on every project-file write.** Not adopted. It doubles write
   I/O on every save and needs its own retention and cleanup story; the non-destructive
   replacement in decision 4 removes the loss window without that cost.
6. **Carry these as implementation gates on the agent-integration arc.** Rejected — the
   framing that produced the problem. The defects are live in ordinary use and their fix
   has no dependency on a runtime selection that is explicitly deferred.
7. **Build the full per-effect receipt model now.** Deferred. ADR-031's brief owns that
   contract; pulling it forward would import an agent-era design into a bug fix.

## Scope Notes

This ADR changes the workspace database command surface and the write-result contracts of
the syntax adapter and filesystem write manager. It introduces no new domain. The
[Domain Register](../Orchestration.md#2-domain-register) remains authoritative, and
decision 7's guard must be registered with the other guards when it lands.

ADR-031 and its brief are unaffected. Their R1–R3 references remain valid as the origin of
these findings; this ADR does not supersede that document, and resolving D1–D5 does not
discharge the agent-integration gates that cite them — those gates concern agent-initiated
writes, which remain out of scope here.

Numbering note: 031 is held by the agent-integration decision, which by owner direction
lives under `docs/plans/agent-integration/` rather than in this directory.

## Implementation Follow-ups

Slices, their reproductions and their acceptance criteria are owned by the
[brief's slice table](../plans/persistence/brief-live-durability-defects.md#6-slices) (S1
epoch fence, S2 non-destructive replacement, S3 honest writers, S4 truthful manager
outcomes, S5 guard and documentation). S1 and S2 are independent; S3 and S4 share
write-result plumbing and are sequential; S5 lands last so the guard codifies what shipped.

Three source comments assert behavior this ADR contradicts and are corrected in S5:
`useProjectLaunch.js:286-288`, and `useProjectPersistence.js:527-529` and its neighbouring
claim about piece-ID overlap. The unread `activeInstanceIdRef`
(`useProjectPersistence.js:84,172`) is removed or wired in S1.

Multi-process workspace ownership (ruling R-D) is recorded as a known limit and is its own
investigation, not a follow-up of this arc.
