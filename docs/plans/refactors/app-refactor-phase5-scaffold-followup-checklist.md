# App Refactor Phase 5 Scaffold Follow-up Checklist

**Status: COMPLETE** -- Scaffold core done. Remaining work (interaction refactor: left-click drag to move, right-click create, canvas persistence mirroring, isolated hide icon) tracked separately. Closed 2026-03-07.

## Purpose
Track deferred scaffold issues discovered during Phase 5 persistence validation without blocking forward progress.

## Context
- Source phase: `docs/plans/app-refactor-phase5-persistence-checklist.md`
- Reason for split: persistence core is validated; scaffold-specific regressions need focused follow-up.

## In Scope
- Scaffold apply piece spawn completeness.
- Filename header consistency on scaffold-created pieces.
- Disk sync behavior tied to scaffold-generated state.

## Out of Scope
- New scaffold feature design.
- Extension-host scaffold generation changes.
- Non-scaffold editor UX updates.

## Tasks
- [ ] Reproduce partial piece spawn from scaffold-create flow with deterministic steps.
- [ ] Add characterization test for expected scaffold piece count vs created piece count.
- [ ] Trace and fix missing spawn path in scaffold apply pipeline.
- [ ] Reproduce missing filename comment-header injection on scaffold-created pieces.
- [ ] Define expected header behavior by file type and codify with tests.
- [ ] Fix header injection consistency in scaffold-created piece initialization.
- [ ] Verify scaffold tree and disk sync remain correct after scaffold apply + reopen.

## Validation Gates
- [ ] Scaffold apply creates all expected pieces from plan.
- [ ] Scaffold-created pieces have consistent filename header behavior per spec.
- [ ] Reopen roundtrip preserves scaffold piece set and metadata.
- [ ] Disk scaffold tree matches piece/map state after apply and reopen.

## Exit Criteria
- [ ] All follow-up validation gates pass.
- [ ] Deferred Phase 5 scaffold notes are resolved and cross-referenced closed.
- [ ] Phase 5 persistence checklist can be marked fully complete.

## Evidence
- Issue reproduction notes: `_____`
- Test run output: `_____`
- Manual validation notes: `_____`

## Notes
- This checklist is a targeted follow-up track. Work on Phase 6 can proceed in parallel unless a blocker appears.
