# ADR-021: Scaffold Security Gate — npm Un-Pause Behind Verified Controls

## Status
- Implemented — 2026-07-28 status correction: slices delivered 2026-07-13 via PRs #128–#133; this ledger was never flipped. Still open: the owner's end-to-end npm scaffold acceptance pass (a verification step, not a delivery gap).
- Accepted — 2026-07-13 (owner approved same day it was proposed; npm scaffolding un-paused by owner decision 2026-07-13. Delivery slices 1–5 below; implementation begins with Slice 1.)

## Date
- 2026-07-13

## Context

npm scaffolding has been launch-paused since 2026-05-15 over supply-chain trust
(the pause that ADR-020 §1 built the Python path to be clean under). The pause
was conditioned on post-mortem visibility for the spring worm campaign. That
condition is now met, and the verified picture reshapes the decision:

1. **Compromise windows are burst-shaped and precisely mapped.** TanStack's
   official post-mortem (tanstack.com/blog/npm-supply-chain-compromise-postmortem)
   documents all 84 malicious versions across 42 packages published in a
   six-minute window (2026-05-11), detected publicly within ~20 minutes. Every
   subsequent verified wave is equally bounded. No evidence of deep-historical
   seeding exists — the fear that motivated "wait and see" did not materialize.
2. **But the campaign cadence never stopped**: Red Hat's npm namespace
   (RHSB-2026-006, Jun 1), the binding.gyp/implicit-node-gyp worm (Jun 3,
   57 packages — code execution at install with *no* lifecycle-script entry),
   the Mastra wave (Jun 17, 144 packages, state-actor attributed), jscrambler
   8.14.0 (Jul 11 — flagged by scanners in six minutes yet still installable).
   Waiting for a quiet ecosystem has no exit condition.
3. **The platform hardened structurally.** npm v12 shipped 2026-07-08 blocking
   by default every install-time vector the verified waves used: dependency
   lifecycle scripts, implicit node-gyp builds, git dependencies, remote-URL
   dependencies (github.blog changelog 2026-06-09 / 2026-07-08). Staged
   publishing and the 2FA-bypass-token deprecation close the stolen-token
   publish path through Jan 2027.
4. **Four facts constrain the design.** (a) npm has **no native
   minimumReleaseAge**; the release-age cooldown exists only in pnpm and Bun.
   (b) Litria's bundled runtime is Node 24.14.0 → npm 11.x, pre-v12 semantics;
   pnpm/yarn are optional user globals (`scaffold_runner.rs` resolve order).
   (c) Detection is minutes-fast but registry removal is unreliable —
   compromised versions stay installable, so **version pinning alone can
   freeze a poisoned version**. (d) Valid provenance appeared on compromised
   packages (published through legitimate hijacked pipelines), so provenance
   is not a usable safety signal.
5. **Current behavior is the anti-pattern**: `scaffold_runner.rs` executes
   `<pm> create <package>@latest` — unpinned, no age check, no advisory check,
   lifecycle scripts on.

## Decision

npm scaffolding un-pauses behind a four-part gate. The governing posture:
**pin what we execute, age-gate what we pin, run installs scripts-off and
visible, and never claim more safety than we provide.**

### 1. Pinned create-CLI versions (no `@latest`)

- A new `src/scaffold/create-cli-versions.js` is the single source of truth
  mapping each create-CLI (`create-tauri-app`, `create-electron-app`,
  `create-vite`) to an exact version — and likewise the addon init CLIs the
  runner executes via `dlx` (`shadcn`, `shadcn-svelte`, `shadcn-vue`; found
  running `@latest` during Slice 1 — "pin what we execute" covers them too). It lives beside `compatibility-matrix.js`
  and is covered by the node test suite (shape + no-range/no-latest asserts).
- The wizard's command preview renders the pinned spec — the "what you see is
  what runs" contract stays literal.
- `ScaffoldConfig` carries the exact `name@x.y.z` spec; `scaffold_runner.rs`
  **rejects** any spec that is bare, ranged, or `latest` (enforced floor,
  Rust-side test — guards culture, prose is not the enforcement).
- Version bumps are ordinary reviewed changes, which makes every bump pass
  human eyes plus the age gate below.

### 2. Litria-native release-age gate (≥24h)

- Before executing the create-CLI, the runner queries the npm registry
  metadata (`time` field) for the pinned version's publish timestamp. Younger
  than 24 hours → the scaffold refuses with a plain-language event on the
  existing `ScaffoldEvent` channel ("this version is N hours old; Litria
  waits 24h so the ecosystem's scanners run first").
- Litria-native because npm has no cooldown to delegate to (Context §4a) and
  pnpm cannot be required (not bundled). When the user's chosen PM is pnpm,
  the scaffolded project additionally gets `minimumReleaseAge` written into
  its pnpm config — full-tree cooldown on that path, native.
- Registry metadata unreachable → **fail-open with a visible warning** (the
  create itself needs the registry anyway; a hard-closed gate would only add
  a second failure mode to the same outage).
- Honesty bound: this gates the create-CLI package itself (and every future
  bump). Transitive project dependencies are not age-gated on the npm path —
  they are covered by §3 and §4, and the posture note (§5) says so.

### 3. Scripts-off, terminal-visible installs

- All scaffold-time installs on the npm path run `--ignore-scripts`, in the
  visible terminal (ADR-005 class taxonomy: dependencies never install through
  a hidden manager; the Python path's visible `uv sync` is the precedent).
  On npm 11.x this is an explicit flag; when a future bundled-Node bump
  carries npm 12 it becomes the native default and the flag is redundant but
  harmless.
- Projects that need lifecycle scripts get a **consent pill** (ADR-005 A3
  shape, no modal): it names the exact re-enable command and click = run
  visibly. Default stays off; enabling is one explicit, observable action.
- This closes every executed-at-install vector from the verified waves,
  including the implicit node-gyp path (blocked by `--ignore-scripts`;
  residually, a fetched-but-unbuilt package could execute on a later manual
  `npm rebuild` — the pill copy names this instead of hiding it).
- pnpm path: scripts-off is pnpm's own default (v10+); Litria does not
  re-enable it.

### 4. Advisory check at scaffold time

- After the lockfile exists, the runner executes `npm audit` in the visible
  terminal. Findings do not roll back the scaffold (the files are inert;
  nothing has executed) but surface prominently in the capstone summary.
- Offline or audit-endpoint failure → fail-open with a visible warning.
- Rationale: detection ≠ removal (Context §4c). Pinning freezes versions;
  the advisory check is what notices if a frozen version later turns out to
  be poisoned.

### 5. Honest posture surface

The wizard's npm cards carry a short posture note stating exactly what the
gate does: pinned tools, 24-hour age gate on them, scripts off by default,
audit on create. **Forbidden claims** (each is false and each appeared in the
wild as false comfort): "npm enforces release cooldowns", "provenance means
safe", "pinned means safe". The note may say what is *not* covered
(transitive dep age on npm) in one clause — honesty is part of the gate.

### 6. Watch item: bundled npm 12

When a bundled-Node bump ships npm 12, the explicit `--ignore-scripts` flags
become native defaults and §3's flag plumbing can simplify. The gate is
designed so that bump changes nothing user-visible.

## Consequences

- Every install-time execution vector used by every verified 2026 wave
  (preinstall / postinstall / prepare / implicit node-gyp / git & remote deps)
  is blocked or human-gated at scaffold time.
- Residual, stated openly: the pinned create-CLI itself executes by design
  (that is what scaffolding is) — pin + age gate + audit + review-on-bump is
  the containment, not a guarantee; transitive dep age is ungated on npm;
  a later manual `npm rebuild` can execute previously fetched build hooks.
- Version bumps gain deliberate friction (review + 24h). That friction is the
  point; it is bounded and predictable.
- The npm scaffold path becomes consistent with the Python path's posture
  (offline-first where possible, visible execution where not, consent pills
  for anything that runs third-party code).

## Delivery Slices

1. **Pin registry** — `create-cli-versions.js`, wizard preview, runner
   rejection of non-exact specs, tests both sides.
2. **Age gate** — registry `time` query pre-exec, refuse/warn events,
   pnpm-config write-through.
3. **Scripts-off installs** — `--ignore-scripts` plumbing, consent pill,
   terminal visibility.
4. **Advisory check** — `npm audit` step, capstone surfacing, fail-open path.
5. **Posture surface** — wizard note with the allowed/forbidden claim list.

Slices are independent branches off `main` (AGENTS.md §7.1); each lands with
the standard checks (§6.1).
