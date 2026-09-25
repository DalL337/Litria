# Verification Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Load when preparing any
PR, completing a milestone/slice, or changing domain APIs or architecture
boundaries. Moved here from AGENTS.md §6 (2026-07-13).

## Rule 1 — The Standard Checks

- `npm run check:architecture` — all **seven** guards: architecture (domain/UI
  import boundaries), app-shell (composition manifest), protected-zone
  (ADR-008), domain-contract (`create*Domain`/`use*Domain` + `commands`),
  settings-key (ADR-019: preference keys only via `PREF_KEYS` + registry
  shape invariants; added 2026-08-01), editor-engine (Monaco sealed inside
  `ENGINE_FILES`; prints the editor-engine contract and its TEMP debt;
  added 2026-08-30), db-chokepoint (ADR-032: `db_*` commands reach Tauri only
  through `dbStorage.invokeDb`, so every one of them carries a workspace
  epoch; added 2026-09-19).
- `npm run test:domains` — the full node test suite (`test/domains/*.test.mjs`
  is the entire suite; there are no test files outside it).
- `npm run build` — vite production build (also extracts sourcemaps; see
  release-policy.md).
- `cargo build` must produce **zero warnings** and `cargo test` must pass
  whenever Rust changed (standard since the 2026-07-13 warning sweep).

`npm run check` = architecture guards + build in one command.

## Rule 2 — When to Run Them

Run the checks whenever any of the following is true:
- A milestone or refactor slice is completed.
- A new domain is added.
- Any code change affects an existing domain API, command, selector, or
  behavior.
- Any architecture boundary/import rule is changed.
- Any PR is being prepared for merge.

Record pass/fail evidence in the related plan/checklist doc when applicable.

**Docs-only exemption (added 2026-09-25).** A change where every file is
under `docs/` or `Agents/`, or is the root `README.md`, skips the standard
checks. This overrides the "any PR" bullet above: the exemption holds even
when the change goes through a PR. Such changes may go straight to `main`
(AGENTS.md §7.2).

The exemption is safe because no guard, test, or build step reads those
paths, so the checks cannot see the change. This was verified on 2026-09-25
by searching `scripts/`, `test/`, `.github/workflows/` and the Vite config.

Still required for docs-only changes:
- Rule 3: check the files-changed count after committing.
- The repository is public, so read what you publish for personal or account
  data before pushing (AGENTS.md §3 housekeeping, §7.6 identity).

> Origin: PR #74 (docs only) ran the full local trio plus the CI `guard` job,
> and the results showed nothing. The owner ruled a policy note rather than a
> CI path filter, so `architecture-guard.yml` still runs on every PR and every
> push to `main`; this exemption removes the agent-side ceremony only. If a
> guard, test, or build step ever starts reading one of these paths (for
> example, a guard that parses the domain register in `docs/Orchestration.md`),
> narrow or remove the exemption in the same change.

## Rule 3 — Verify the Commit, Not Just the Tree (added 2026-07-13)

After committing, check the files-changed count in the commit output matches
intent before pushing. `git commit -m "..." <path>` commits ONLY that
pathspec and silently drops the rest of the staged index (the #135/#136
split); a commit made on the wrong branch lands on it silently (the slice-5
local-main incident). Both are caught in seconds by reading the commit
summary line and `git status` — do it every time.

## Rule 4 — Dependency and Recipe Compatibility (added 2026-09-16)

When a change affects dependencies, external tool invocation, generated-project
recipes, or supported combinations, apply
[Dependency Change Policy](dependency-change-policy.md) in addition to the
standard checks. Its Rules 4–6 own execution coverage, upstream revalidation,
and evidence requirements.

A passing Litria build or domain test suite does not prove that a generated
project installs, builds, or provides its advertised integration. The
verification record must identify affected recipes, their actual outcomes,
and unverified paths. Source-text assertions and command-builder unit tests
do not substitute for the required recipe execution evidence.
