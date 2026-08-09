# Release Policy

Scoped agent-governance procedure (AGENTS.md §1/§2). Load for release work:
version bumps, bundling, release builds. Moved here from AGENTS.md §8
(2026-07-13).

## Rule 1 — Versioning Scheme

One version string kept in sync across **six** locations, updated in the same
commit on every bump:

- `version` in `package.json`
- `version` in `package-lock.json` — **two occurrences** (root and `packages[""]`)
- `version` in `src-tauri/tauri.conf.json`
- `version` in `src-tauri/Cargo.toml`
- `version` in `src-tauri/Cargo.lock` (the `litria` package entry)
- the `**Version**:` banner in `docs/CAPABILITIES.md`

> Corrected 2026-08-09: this rule previously named only the three hand-edited
> files. The lockfiles and the CAPABILITIES banner carry the version too, and a
> bump that follows the old list literally ships with three locations stale.
> Verify with a repo-wide search for the OLD version string before committing —
> zero hits outside `.research/` is the gate.

Format: `major.minor.patch-N` where `N` is the numeric MVP iteration
(e.g. `1.0.0-8`). Valid semver, MSI-compatible — Tauri derives the Windows
product version from it directly; no separate `productVersion` override.

**Bare `1.0.0` was reserved for the square-one public flip** (owner ruling
2026-08-01: the version milestone and the identity firewall land together) and
was spent on that flip, 2026-08-09. The `-N` suffix resumes for iterations after
a release: the next development series is `1.0.1-1`, `1.0.1-2`, … with the bare
patch/minor reserved for what actually ships.

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
