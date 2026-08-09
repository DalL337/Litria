# Verification Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Load when preparing any
PR, completing a milestone/slice, or changing domain APIs or architecture
boundaries. Moved here from AGENTS.md §6 (2026-07-13).

## Rule 1 — The Standard Checks

- `npm run check:architecture` — all **five** guards: architecture (domain/UI
  import boundaries), app-shell (composition manifest), protected-zone
  (ADR-008), domain-contract (`create*Domain`/`use*Domain` + `commands`),
  settings-key (ADR-019: preference keys only via `PREF_KEYS` + registry
  shape invariants; added 2026-08-01).
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

## Rule 3 — Verify the Commit, Not Just the Tree (added 2026-07-13)

After committing, check the files-changed count in the commit output matches
intent before pushing. `git commit -m "..." <path>` commits ONLY that
pathspec and silently drops the rest of the staged index (the #135/#136
split); a commit made on the wrong branch lands on it silently (the slice-5
local-main incident). Both are caught in seconds by reading the commit
summary line and `git status` — do it every time.
