# App Refactor Enforcement Model (Solo)

## Purpose
Define the merge gates that enforce the orchestration model as Litria evolves.

## Core Rule
Architecture is enforced by automation first, document second.

## Required Commands Before Merge
Run all of the following locally:

```bash
npm run check:architecture
npm run build
```

Optional combined command:

```bash
npm run check
```

## Automated Guardrails

1. Architecture Guard (`scripts/architecture-guard.mjs`)
- Blocks forbidden imports of `src/App.jsx` from other modules.
- Blocks domain-layer imports of UI layers (`src/components`, `src/drawers`).
- Blocks forbidden `ProjectDomain` dependencies on UI/interaction/editor/history layers.

2. App Shell Guard (`scripts/app-shell-guard.mjs`)
- Protects `src/App.jsx` from gaining new domain-coupled imports.
- Uses a transition allowlist for currently-existing imports.
- Forces new logic to be added in domains, not in `App.jsx`.

3. CI Workflow
- Runs architecture checks and build on pull requests and pushes to `main`.

## Solo PR Checklist (Mandatory)
- [ ] I identified the owning domain for this change.
- [ ] I did not add forbidden dependency edges.
- [ ] If domain API changed, I updated docs and tests.
- [ ] `npm run check:architecture` passes.
- [ ] `npm run build` passes.
- [ ] Relevant phase checklist in `docs/plans/` is updated.

## Operating Policy

1. One responsibility per PR
- Keep each PR narrow to one domain concern where possible.

2. No bypasses
- If a guard fails, fix architecture or explicitly revise the guard with justification in the PR description.

3. Track phase progress
- Use phase checklist files as merge evidence.

4. Tighten over time
- Remove entries from `scripts/app-shell-guard.mjs` allowlist as responsibilities leave `App.jsx`.

## Escalation Rule
If a required feature appears to need a forbidden dependency, stop and update `docs/Orchestration.md` with the architectural decision before implementing.
