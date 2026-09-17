# ADR-028: Scaffold recipe integrity — one validated plan, an Angular CLI route, honest add-ons, and a guarded creation lifecycle

## Status

Proposed revision (2026-09-16 — owner-requested review clarifications for
content-preserving cleanup, absolute deadlines, verification-based
availability, and per-finding closure; rulings remain pending)

Proposed (2026-09-16 — drafted at owner direction from the two independent
wizard/matrix audits of the same day; owner directed that web + Angular be
kept and that every finding from both audits be fixed in one arc; eight
rulings requested in the brief §7; formal acceptance on owner review of this
document)

## Date

2026-09-16

## Context

On 2026-09-16 two agents audited the New Project wizard and its compatibility
matrix, report-only, from the same prompt. Claude's audit (journal
`.research/2026-09-16-wizard-matrix-audit.md`) and Codex's
(`docs/audits/new-project-wizard-2026-09-16.md`) were cross-checked claim by
claim; every testable Codex claim held, and each audit found things the
other missed. Their union is 37 findings across the matrix, the wizard's
state handling, and the Rust creation commands. Four of them are structural:

- **The product offers a combination it cannot build.** The matrix lists
  Angular under the Web wrapper; the pinned create-vite has no Angular
  template, and in non-interactive mode it silently substitutes
  `vanilla-ts` and exits 0. Litria reports "Scaffold complete!" on a vanilla
  project recorded as Angular. This has been true since the initial commit.
- **Nothing relates the matrix, the pins, the preview, and the runner.**
  The preview shows a `--manager` flag the runner never sends; Electron's
  unpinned framework plugins now resolve to majors that require Vite 8
  inside a Vite 5 template; shadcn-svelte receives a flag it does not have;
  Yarn receives npm syntax; add-ons execute in click order.
- **Add-ons install packages and are described as integrations.** Tailwind,
  Router, Express/Fastify, the Electron framework step, and the pytest card
  each deliver a dependency line where the card promises a working setup.
- **The wizard's lifecycle is implicit and creation trusts what it did not
  verify.** Navigation works mid-run and after creation; a failed open
  discards the created project's payload; the Python path skips the shared
  finish; retry tolerance is filename-based and follows symlinks; `uv venv`
  may download Python on the "offline" path; the interpreter guard rejects
  variants the probe offers.

ADR-021 established what Litria executes (pinned, age-gated, scripts-off,
audited, honestly labelled). It did not establish that the pinned tools,
their arguments, and the generated project work together. The
dependency-change policy (added 2026-09-16) names that gap; this ADR defines
the contract for closing it in the scaffold domain. The invariants guide
implementation; each finding still requires a linked change and evidence
that its failure case is resolved before it is closed (brief §6).

The canonical detailed design, the full findings registry with line
citations, the slices, and the rulings live in
`docs/plans/ideas/brief-scaffold-recipe-integrity.md`.

## Decision

### 1. One recipe registry is the source of truth

A single registry (`src/scaffold/recipes.json`, read by the frontend and
included into the Rust binary) owns every supported combination as a
complete recipe: route, package, pinned version, argv, template identifier,
add-on packages and configuration, manager verbs, generated-file manifest,
and last-verified evidence. The compatibility matrix, the pin registry, and
the wizard's card lists become projections of it. Nothing else in the
repository carries a version, a template name, or a support claim for a
generated project.

### 2. Preview, validation, and execution derive from one plan

`buildScaffoldPlan(state, probe)` produces the plan the wizard previews and
the payload it sends. The Rust runner re-derives the plan from the same
registry and refuses a payload whose derivation differs. Consequences: the
frontend can no longer choose which version executes; the preview cannot
show an argument that will not run; a probe result cannot be stale in the
submit path because the plan is memoized from the same inputs the preview
renders. Shared fixture cases are executed by both the JS and Rust test
suites.

### 3. Web + Angular is an Angular CLI route, pinned

The runner gains a second primary route kind, `Exec` (run a named package),
beside `Initializer` (`<pm> create <short-name>`). Web + Angular executes
`@angular/cli@<pin> new <name> --defaults --skip-git --package-manager <pm>`
through the manager's exec/dlx form. The age gate queries the real package
for `Exec` routes. This matches what create-vite's own Angular entry and
create-tauri-app's Angular template already do. Pin selection follows
ADR-021 §2 (≥24h old at pin time).

### 4. Add-ons integrate what they promise, or say that they do not

Per dependency-change policy Rule 3, every add-on recipe writes the
configuration its card promises (Tailwind plugin and stylesheet import per
framework, shadcn preconditions and variant-specific flags, Electron
renderer wiring with plugin majors compatible with the template's Vite
major, pytest smoke tests for every Python archetype). Add-ons execute in
dependency order derived from the registry, never in selection order. An
add-on that only installs a package says so on its card and review row.
Rulings R2 and R4 in the brief decide the backend and router shapes.

### 5. Manager recipes are explicit

Each package manager has its own verbs in the registry. Yarn Classic is
detected and refused visibly. The posture note (ADR-021 §5) renders the
selected manager's actual coverage, and its guarding test carries one case
per manager.

### 6. The wizard has one lifecycle state

`runState` (`idle | running | held | opening | failed`) replaces the
independent scaffolding/held/error flags. Navigation, cancel, edit, and
submit permissions are pure selectors of `runState` and page validity. A
reached step is re-validated on every jump and at submit. A held completion
retains its payload until the workspace open resolves; a failed open offers
to open again, never to re-scaffold. Every creation path ends in the shared
finish so trace-pause and log policies apply to Blank, Python, and npm
alike. Build-log issue detection uses counters that survive trace
truncation.

### 7. Creation proves ownership before it tolerates content

A new-project write begins with an ownership marker created under
`create_new`. Retry tolerance accepts only a folder whose marker exists and
whose present content matches the run's verified output manifest. The
planned file list or marker alone does not prove unchanged run output.
Added, modified, or unproven content is preserved and blocks automatic
retry and cleanup. Generated paths refuse symlinks and reparse points.
Files are written with `create_new` unless verified records prove unchanged
output from the earlier attempt. These rules re-trigger the
exception-register audit of security-policy Rule 4 for every creation path.

### 8. Subprocesses have a deadline and a cancel

Every scaffold step has an idle-output timeout and a finite absolute
elapsed-time deadline that output cannot extend. Limits are explicit per
step kind and recorded in the plan and trace. Either timeout and explicit
cancellation tear the process tree down per Orchestration §1.2, with distinct
reasons reported. Cancel is available while a run is in progress.

Cleanup follows completed teardown. Removing a partial directory requires
proof that this run created it and every remaining entry is unchanged run
output, with no unrecorded content. A marker alone never authorizes recursive
deletion. Added or modified user content, unverifiable entries, or a race
that prevents a safe check leaves the directory intact with its path and
the reason reported. Never reconstruct ownership from the current contents
at cleanup time. Retry and cleanup share this preservation contract (brief
§4.5 and R7/R8).

### 9. Python creation runs only what it showed

`uv venv` runs with downloads disabled. Interpreter eligibility is one Rust
predicate shared by discovery and creation; the wizard offers only eligible
interpreters and the guard applies in every mode that forwards one.
`pyproject.toml` is produced by the `toml` serializer; the existing
environment must exist; Python keywords are refused as module names on both
sides; an invalid `requires-python` floor is an error, not an omission.

### 10. Claims are bounded by evidence

Each recipe records last-verified date, platform, manager, and revalidation
triggers in the registry (dependency-change Rule 5), along with coverage
status and its supporting evidence. A combination is selectable only with
direct passing execution evidence or an explicit mapping to a passing
representative exercising the same relevant path. Distinct execution paths
require their own evidence; a shared framework or manager label is not an
equivalence argument (brief §6).

Unverified or failing combinations are disabled with a reason for the
affected platform and manager, and the runner enforces the same restriction.
Reporting a path as unverified does not authorize offering it. Revalidation
triggers invalidate affected coverage until refreshed; release preparation
refreshes evidence for advertised combinations. `docs/capabilities.md`
carries the excluded-combinations section the matrix cites and states these
support limits and per-framework add-on coverage; it does not describe
Angular as a Vite template.

## Consequences

Positive:

- Every selectable combination has direct fixture evidence or an explicit,
  justified mapping to passing evidence for an equivalent execution path.
  Unverified and failing combinations remain disabled with a reason.
- The preview is literally what runs; the trace shows the same argv.
- Angular is supported on Web and Tauri through the same upstream tool,
  pinned and age-gated like everything else.
- Add-on cards stop overstating; the ones that integrate are testable via
  generated-file snapshots.
- A stuck or wrong run is recoverable from the wizard without killing the
  app; a created project is never lost to a failed open.
- Creation cannot overwrite user content or follow a planted symlink.

Costs:

- The registry is a new artifact with its own refresh discipline; pin bumps
  now touch one file but require re-running fixture scaffolds for the
  affected recipes.
- Web + Angular projects are Angular CLI projects, not Vite projects; any
  Vite assumption on the Web wrapper must check the framework.
- Yarn Classic users are refused rather than half-supported.
- Unavailable test environments leave their affected combinations disabled;
  support can only expand as the required evidence becomes available.
- Cancellation may retain a partial directory when unchanged ownership
  cannot be proved; preserving user content takes priority over cleanup.
- The arc is eight slices; several need network fixtures and the owner's
  live pass. Nothing in it ships partially: a slice that lands without its
  Rule 4 evidence is not done.

## Alternatives Considered

- **Remove web + Angular.** Rejected by owner directive; the Angular CLI
  route is what the upstream ecosystem uses and costs one route kind.
- **AnalogJS for Angular-on-Vite.** Rejected: a different meta-framework,
  not the Angular users expect.
- **Pass create-vite's `custom-angular` value.** Rejected: delegates to
  `@angular/cli@latest`, unpinned and outside the age gate (ADR-021 §1).
- **Keep separate matrix, pins, and preview and add cross-checking tests.**
  Rejected: tests would guard drift between four copies rather than remove
  the copies; the `--manager` and `.python-version` drifts show the pattern
  recurs.
- **Rust-only pins with the frontend blind.** Rejected: the preview and
  the JS tests need the data; a shared registry with a Rust re-derivation
  gives the same trust boundary without a second copy.
- **Patch each finding independently.** Rejected: the 37 findings are four
  structural gaps; per-bug patches would re-create them.

## Scope Notes

- ADR-021 remains the security posture for what executes; this ADR is the
  compatibility and lifecycle contract on top of it. Where they touch (the
  posture note, the age gate for `Exec` routes) this ADR extends, not
  replaces.
- ADR-020 (Python creation) is extended by §9; its offline promise becomes
  enforced rather than assumed.
- ADR-019 ownership (wizard seeds, Preferences owns) is untouched.
- The bundled npm 12 watch item (ADR-021 §6) is unchanged.

## Implementation Follow-ups

- Brief §5 slices S1–S8, in order; S1 is the substrate.
- Each finding's disposition links the implementation and verification of
  its original failure case. An invariant, merged slice, or temporary
  support restriction alone does not count as a verified fix (brief §6).
- Rulings R1–R8 (brief §7) are owner decisions; the proposed answers are
  the default if the owner accepts the brief as written.
- Release policy addendum: "refresh recipe evidence for advertised
  combinations before tagging" (dependency-change Rule 5).
- Security-policy Rule 4 register audit after §7 lands: every creation path
  lists the ownership, content-preservation, and symlink checks it carries.
