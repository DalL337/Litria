# App Refactor Phase 1 Domain Mapping Checklist

**Status: COMPLETE (superseded)** -- Domain ownership was established organically during Phases 2-6. All domains are wired and working. Closed 2026-03-07.

## Purpose
Phase 1 locks domain ownership and dependency boundaries before extraction work.

## In Scope
- Domain inventory and ownership map.
- Allowed and forbidden dependency matrix.
- Initial enforcement plan (lint and architecture tests).

## Tasks
- [ ] Confirm final domain list from `docs/Orchestration.md`.
- [ ] Map each existing `App.jsx` responsibility to one owning domain.
- [ ] Mark ambiguous responsibilities and assign an owner.
- [ ] Document allowed dependencies between domains.
- [ ] Document forbidden dependencies between domains.
- [ ] Define module location conventions for each domain.
- [ ] Define API file conventions (`api.ts`, selectors, commands, tests).
- [ ] Add dependency rule TODOs to engineering backlog.

## PR Slices
1. `docs`: publish ownership and dependency matrix.
2. `tooling`: add initial lint/import rule scaffolding.
3. `tests`: add architecture test placeholder(s) and CI hook TODO.

## Validation Gates
- [ ] Architecture map approved by at least one reviewer.
- [ ] No unowned responsibility remains in the map.
- [ ] Allowed/forbidden dependency list is complete.

## Exit Criteria
- [ ] Domain inventory and ownership map merged.
- [ ] Dependency rules documented and ready for enforcement.

## Evidence
- PR(s): `_____`
- Reviewer sign-off: `_____`
- Follow-up issues created: `_____`

