# Release Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Load for release work:
version bumps, bundling, release builds. Moved here from AGENTS.md §8
(2026-07-13).

## Rule 1 — Versioning Scheme

One version string kept in sync across three files, updated in the same
commit on every bump:

- `version` in `tauri.conf.json`
- `version` in `package.json`
- `version` in `src-tauri/Cargo.toml`

Format: `major.minor.patch-N` where `N` is the numeric MVP iteration
(e.g. `1.0.0-8`). Valid semver, MSI-compatible — Tauri derives the Windows
product version from it directly; no separate `productVersion` override.

Version bumps land last: merge code branches first, push docs/plans, bump
after release scope is locked (see AGENTS.md git policy §7.5).

## Rule 2 — Release Sequence and Artifacts

- **Bundled runtimes are a pre-release step:** `npm run bundle` stages Node,
  language servers, and the sideloaded Microsoft ConPTY pair
  (`bundle:conpty`) that the terminal requires on Win10. `npm run
  build:release` = bundle + build. `npm run bundle:check` verifies staging.
- **Sourcemaps:** `npm run build` extracts maps out of `dist/` into
  `release-sourcemaps/<version>/`. The crash-log system (B5) depends on these
  archives for symbolication — keep them per released version.

## Rule 3 — Release-Build Gotcha (burned a real session)

A plain `cargo build --release` produces a binary that loads the dev URL
(`localhost:1420`) and shows an Edge error page when no dev server is running.
The correct release binary comes from:

```
npm run tauri -- build --no-bundle
```
