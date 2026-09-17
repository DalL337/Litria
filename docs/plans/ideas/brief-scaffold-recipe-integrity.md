# Brief — Scaffold recipe integrity (New Project wizard + compatibility matrix)

Status: Draft 2026-09-16 — backlog brief for ADR-028; rulings R1–R8 requested
from the owner (§7). No slice started.
Origin: two independent report-only audits of the wizard and matrix run on
2026-09-16 with the same prompt — Claude (journal
`.research/2026-09-16-wizard-matrix-audit.md`, Steps 1–6) and Codex
(`docs/audits/new-project-wizard-2026-09-16.md`, 22 findings). Claude
cross-checked every Codex claim it could test (journal Step 4); all held.
The union of both reports is the backlog below. Nothing is fixed yet.

Owner directive (2026-09-16): keep web + Angular rather than removing it,
and fix every finding from both audits in one arc.

Review amendment (2026-09-16, owner-requested): clarify preservation during
cleanup, absolute deadlines, evidence-based availability, and per-finding
closure. The brief remains draft; this amendment does not start a slice.

Policies loaded: persistent-research, documentation, dependency-change,
security (Rule 4 chokepoint exceptions), implementation Rule 7 (state follows
disk).

## 1. Why one arc, not a patch list

The findings look like 37 separate bugs. They are four structural gaps:

1. **No single recipe.** The matrix says which cards to show, the pin
   registry says which CLI version to run, the wizard's preview builds its
   own command string, and the Rust runner builds a different one. Nothing
   checks that a matrix combination maps to a template that exists, that
   the preview matches the argv, or that an add-on's packages work with the
   template's Vite major. web + Angular, `--manager` in the preview, the
   Electron plugin mismatch, the shadcn-svelte flag, the Yarn syntax, and
   the `.python-version` drift are all the same gap.
2. **Add-ons install packages and call that support.** Tailwind, Router,
   Express/Fastify, the Electron framework step, and the pytest card all
   promise an integration and deliver a dependency line.
3. **The wizard's lifecycle is implicit.** `isScaffolding`, `pendingDone`,
   `error`, and `page` are four booleans whose combinations are guarded
   inconsistently: Alt+Left works mid-run, Cancel works after creation,
   the stepper skips validation, the Python path skips the shared finish,
   and a failed open discards the payload.
4. **Creation trusts what it did not verify.** Retry tolerance is
   filename-based and follows symlinks; `uv venv` may download Python; the
   interpreter guard rejects variants the probe offers; the posture note is
   shown to managers it does not cover; the frontend chooses the CLI version.

The arc addresses the four gaps through four invariants (ADR-028 §Decision)
that guide the fixes. An invariant does not itself close a finding: each
finding needs an implementation change and evidence that its failure case
is resolved, recorded against its ID under §6.

## 2. Findings registry (union of both audits)

Source column: **C** = Claude audit (journal Step 2–3), **X#n** = Codex
finding number. Severity is the merged rating; where the audits disagreed
the note says why. Line numbers are as of `71ddd29`.

### 2.1 Matrix and recipe accuracy

| ID | Sev | Finding | Evidence | Source |
|---|---|---|---|---|
| F1 | High | web + Angular silently scaffolds `vanilla-ts` and reports success | `compatibility-matrix.js:25` lists angular under web; `scaffold_runner.rs:1059` emits `--template angular` for every wrapper; create-vite@9.1.1 tarball has no `template-angular` (its Angular entry is `custom-angular`, a delegation to `npm exec @angular/cli@latest new`); in non-TTY mode an unknown template becomes `vanilla-ts` and exits 0 (dist/index.js: `if(!h) if(l){…} else h='vanilla-ts'`); runner spawns with `stdin(null)` + `CI=true`. Codex rated Medium ("invalid template") — it missed the silent fallback. | C, X#5 |
| F2 | High | Electron + React / Svelte install plugins that peer on Vite 8 into a Vite 5 template | Forge 7.11.2 `vite-typescript` template pins `vite ^5.0.12`; unpinned installs at `scaffold_runner.rs:1139-1150` resolve `@vitejs/plugin-react@6.1.1` (peer `^8.0.0`) and `@sveltejs/vite-plugin-svelte@7.3.0` (peer `^8.0.0-beta.7 \|\| ^8.0.0`). Vue and Solid plugins still accept Vite 5. Verified 2026-09-16 via `npm view`. | X#2 |
| F3 | Medium | Svelte + shadcn passes `-y` to a CLI that has no such flag | `scaffold_runner.rs:1210` sends `init -y` to every variant; `shadcn-svelte@1.4.1` `init` options are `--preset, -c, -o/--overwrite, --no-deps, --skip-preflight, --reinstall, --base-color, --css, --components-alias, --lib-alias, --utils-alias` (tarball inspected). Commander fails on unknown options. | X#6 |
| F4 | Medium | Yarn receives npm syntax | `make_install_step` (`scaffold_runner.rs:1261-1287`) always emits `install [-D] <pkgs>`; Yarn requires `add`. Yarn Classic (1.22.22 is still `yarn@latest` on the registry) has no `dlx` either. | X#7 |
| F5 | Medium | Add-ons and framework steps are install-only but advertised as integrations | Tailwind: installs `tailwindcss @tailwindcss/vite`, no plugin registration, no CSS import (`:1170-1176`); for Angular the Vite plugin is the wrong package (Angular needs `@tailwindcss/postcss`). Electron framework: packages only, no renderer entry or plugin config (`:1134-1162`). Express/Fastify: package only, no server file or script (`:1235-1259`). Router: package only. | C, X#8 |
| F6 | Medium | Add-on execution follows click order, not dependency order | `wizardReducer` `TOGGLE_ADDON` (`NewProjectWizard.jsx:189-194`) appends the dependency after the dependent; runner iterates `config.addons` in order (`:1118`). shadcn init runs before Tailwind install. | X#9 |
| F7 | Medium (unverified) | React + shadcn `init -y` likely fails preflight on a bare create-vite project (no `@` alias in tsconfig) | Not executed live by either audit. Must be exercised in S3 per dependency-change policy Rule 4. | C |
| F8 | Low | Matrix rationale "Svelte omits router (built-in routing)" conflates Svelte with SvelteKit | `compatibility-matrix.js:36`; create-vite `svelte-ts` is standalone Svelte. | C, X#21 |
| F9 | Low | Pins 2–3 months behind the registry with no refresh trigger | 2026-09-16: create-tauri-app 4.6.2→4.7.4, create-vite 9.1.1→9.2.1, shadcn 4.13.0→4.21.0, shadcn-svelte 1.4.1→1.7.0, shadcn-vue 2.7.4→2.8.2; create-electron-app 7.11.2 current. Recorded publish dates verified accurate. Codex declined to count this as a defect; kept here because dependency-change policy Rule 5 requires a revalidation trigger, which does not exist. | C |
| F10 | Low | Dangling doc pointer and repeated false claim | `compatibility-matrix.js:13,21` cite a docs/capabilities.md "excluded combinations / community alternatives" section that does not exist; `docs/capabilities.md:391-393` repeats "Vite × Angular". | C |
| F11 | Low | pytest card promises "Test scaffold" but tests are generated only for Library | `NewProjectWizard.jsx:107`; `python_scaffold.rs:332-350`. | X#20 |
| F12 | Low | Python preview always lists `.python-version`; runner writes it only with a valid floor | `pythonWizardModel.js:81`; `python_scaffold.rs:336`. | X#22 |
| F13 | Low | Duplicated sources of truth | `COMPAT.backends` unused (wizard has `BACKENDS`); `buildCommandPreview` duplicates runner argv logic; Tauri/Web preview branches are twins; `THEMES` list hardcoded beside `BUILTIN_THEME_IDS`; `toErrorMessage` duplicated in LaunchScreen. | C, X#22 |

### 2.2 Wizard state, preview, and lifecycle

| ID | Sev | Finding | Evidence | Source |
|---|---|---|---|---|
| F14 | Medium | Preview shows flags the runner never sends | `NewProjectWizard.jsx:270-273, 280-283` render `--manager <pm>` for Electron/Web; `build_primary_args` (`scaffold_runner.rs:518-551`) passes `--manager` only for Tauri and adds `--yes` the Tauri preview omits. | C |
| F15 | Medium | `handleDone` reads `pyProbe.uvAvailable` (`:659`) but omits `pyProbe` from its deps (`:725`) | A probe finishing with zero interpreters dispatches nothing, so the callback keeps a stale engine decision while the preview shows the fresh one. | C, X#18 |
| F16 | Medium | Python path calls `onDone` directly (`:668`), bypassing `finishRun` | `tracePause` and `autoSendLogs` are ignored for Python; non-fatal env failures vanish when the workspace opens. | C, X#13 |
| F17 | Medium | `handleContinue` (`:544-554`) clears `pendingDone` before awaiting `onDone` | On rejection the project exists on disk but only "Create Project" (→ target exists) and "Create as Blank" (→ not empty) are offered. | C, X#12 |
| F18 | Medium | Held completion is not frozen | Cancel/Escape prompt "Discard this project?" after creation; stepper (`:871`) and Back (`:1595`) stay enabled with `pendingDone` set, so review rows can diverge from the created project. | C, X#11 |
| F19 | Medium | Reached steps bypass re-validation | `goToPage` (`:457`) and the Create button (`:1617`) never re-run `canAdvance` for earlier pages; clearing the name or changing the wrapper after reaching Create leaves Create enabled → runner receives `framework: null` and fails on deserialization. | X#10 |
| F20 | Medium | Navigation possible during a run | Alt+Left → `goBack()` (`:800-804, 470`) has no `isScaffolding` guard; earlier-page controls stay editable. | X#11 |
| F21 | Low | No same-value guard in `SET_WRAPPER` / `SET_FRAMEWORK` / `SET_LANG` (`:172-178`) | Re-clicking the selected card wipes downstream choices. | C |
| F22 | Low | Dead `locked` theme handling (`:1245-1250`); `THEMES` not derived from presets | A fifth preset would seed a theme with no selectable card. | C |
| F23 | Low | Silent catches | Probe (`:445`) and folder picker (`:504`) swallow errors; `handleBlankFallback` (`:745`) skips `autoSendLogs` on failure unlike `handleDone`. | C |
| F24 | Medium | `hasIssues()` scans only the capped trace | `buildLogDomain.js:61,121`: one warning followed by 5000 records flips `hasIssues` to false, so "pause on warnings" can skip a run that warned. | X#17 |
| F25 | Low | Existing-environment path input is only rendered inside the Advanced fold and only when interpreters were found (`:1200-1208`) | The mode select offers "Existing environment…" without opening the fold. | C |
| F26 | Low | `aria-modal` dialog without a focus trap | Tab leaves the modal. | C |

### 2.3 Creation safety, execution, and Python

| ID | Sev | Finding | Evidence | Source |
|---|---|---|---|---|
| F27 | High | Retry tolerance is filename-based and follows symlinks | `blank_project.rs:200-218` accepts a folder holding only README/.gitignore/.editorconfig; `python_scaffold.rs:506-528` accepts whole `src`/`tests`/`.venv` trees; subsequent `fs::write` overwrites and follows symlinks. | X#1 |
| F28 | Medium | "Offline" Python creation can download Python | `python_scaffold.rs:364-380` runs `uv venv .venv` without `--no-python-downloads`; uv fetches a managed interpreter when none matches. | X#3 |
| F29 | Medium | Posture note overstates per-manager coverage | `SCAFFOLD_POSTURE_NOTE` shown for every manager; `apply_scripts_off` (`:1297`) and `run_dependency_audit` (`:942`) are npm-only. | X#4 |
| F30 | Medium | No subprocess deadline or cancel | `run_step_command` (`:1317`) and `run_env_command` (`python_scaffold.rs:388`) wait indefinitely; Cancel is disabled while running. | X#14 |
| F31 | Medium | Interpreter guard rejects variants the probe offers | `is_allowed_interpreter` (`python_scaffold.rs:112-131`) accepts only `python[digits.]`; `python_probe.rs:244-280` reports `python3.13t.exe` (free-threaded) and pypy. Creation fails after the user picked an offered interpreter. | X#15 |
| F32 | Medium | Existing-env path corrupted / unescaped in TOML | `split_env_path` (`python_scaffold.rs:240-248`) strips `'` from the parent; basename goes into a basic string unescaped; existence never checked. `toml` 0.8 is already a runtime dependency (`Cargo.toml:32`). | C, X#16 |
| F33 | Low | Python keywords accepted as module names | `derivePythonNames('class')` → `class`; `is_valid_module_name` accepts it; Library writes `from class import __version__`. | X#19 |
| F34 | Low | Frontend chooses the executed CLI version | `validate_pinned_specs` (`:622-668`) checks name and exactness only; a compromised webview can select an older release. | C |
| F35 | Low | Interpreter path forwarded unvalidated in `direct`/`existing` modes | Guard runs only when `envMode == venv` (`python_scaffold.rs:478-487`); wizard sends `pyInterpreter` in every mode. | C |
| F36 | Low | Invalid `requires-python` floor silently dropped | `is_valid_floor` filter at `python_scaffold.rs:178,336` omits instead of refusing. | C |

### 2.4 Verification gaps

| ID | Sev | Finding | Evidence | Source |
|---|---|---|---|---|
| F37 | Medium | No test relates the matrix to real templates; no component-level wizard test | `test/domains/*` cover pure modules and CSS text contracts only; the Angular gap survived since the initial commit. | C |

## 3. Keeping web + Angular (owner directive)

Angular is not a Vite template and never was. create-vite's own Angular
entry delegates to the Angular CLI, and create-tauri-app's `angular`
template drives the Angular CLI too. Litria does the same, pinned:

- **Route kind.** The runner gains a second primary route: `Exec` (run a
  real package by name) beside `Initializer` (`<pm> create <short-name>`).
  web + Angular selects `Exec("@angular/cli")`. The age gate queries the
  real package for `Exec` routes — the addon path already does this
  (`scaffold_runner.rs:823-825`); `initializer_package` would otherwise
  expand `@angular/cli` to the nonexistent `@angular/create-cli`.
- **Command.** `<pm> exec --yes -- @angular/cli@<pin> new <name> --defaults
  --skip-git --package-manager <pm>` (pnpm/yarn use their `dlx` form, the
  same split the shadcn step makes). `--defaults` answers every prompt;
  `CI=true` is already set. Flags verified against
  `@schematics/angular@22.1.7` `ng-new/schema.json` (properties include
  `packageManager`, `skipGit`, `skipInstall`, `aiConfig`, `routing`,
  `style`, `ssr`, `zoneless`, `standalone`).
- **Pin.** `@angular/cli@22.1.7` (published 2026-09-02) passes the 24h gate;
  22.1.8 was modified 2026-09-16 and would not, today.

> **Erratum (2026-09-16, S2 implementation):** 22.1.7 cannot run through
> Litria's bundled runtime. Every `@angular/cli` 22.x declares
> `engines.node: ^22.22.3 || ^24.15.0 || >=26.0.0` and the bundled Node is
> 24.14.0 (`src-tauri/src/lsp/packs/versions.rs` `NODE_VERSION`); the trial
> run exited 3 with "requires a minimum Node.js version of v24.15.0". Per
> dependency-change policy Rule 2 the pin is **`@angular/cli@21.2.24`**
> (published 2026-09-10, `engines.node: ^20.19.0 || ^22.12.0 || >=24.0.0`),
> verified on a fixture: `ng new --defaults --skip-git --package-manager npm`
> then `ng build` both succeed on Node 24.14.0. Bumping the bundled Node to
> ≥ 24.15 (release policy, `scripts/node-hashes.json`) is what unlocks 22.x;
> that is a separate, reviewed change with its own revalidation trigger.
- **Installs.** The CLI's internal install inherits the npm scripts-off
  environment (`npm_config_ignore_scripts=true` is set on every step's env
  for npm). `--skip-install` is not used: a project with no `node_modules`
  would push the install to first open, which the npm consent pill does not
  model for Angular.
- **Add-ons.** Tailwind for Angular is the PostCSS route (`tailwindcss
  @tailwindcss/postcss postcss`, `.postcssrc.json`, `@import "tailwindcss"`
  in `src/styles.css`). Router stays excluded (built in). shadcn stays
  excluded (no Angular CLI).
- **Consequence to state.** Web + Angular projects have no `vite.config`;
  any future feature that assumes Vite on the web wrapper checks the
  framework first. Tauri + Angular already has this property.

Rejected: AnalogJS (a different meta-framework); passing create-vite's
`custom-angular` value (unpinned `@latest`, skips the age gate, violates
ADR-021 §1).

## 4. Proposed design

### 4.1 One recipe registry, one plan

A single JSON registry (`src/scaffold/recipes.json`, read by JS via import
and by Rust via `include_str!`) owns, per (wrapper, framework, language):

- primary route (`initializer` | `exec`), package, pinned version, argv
  template, template identifier;
- add-on recipes: packages with pinned versions, prerequisite order,
  configuration files to write, per-framework variants;
- manager recipes: `create`/`exec`/`add` verbs, `--` separator rule,
  supported major floor;
- generated-file manifest (what the preview lists, what the runner writes);
- last-verified date, platform, and revalidation triggers (dependency
  policy Rule 5), plus the coverage status and evidence reference that
  control availability under §6.

`buildScaffoldPlan(state, probe)` in JS derives the plan the preview
renders and the payload the runner receives. Rust re-derives the argv from
the same registry and **refuses** a payload whose plan hash differs from
its own derivation — the frontend can no longer choose a version (F34) or
show a command that will not run (F14). The compatibility matrix becomes a
projection of the registry, and `COMPAT.backends`, `BACKENDS`,
`buildCommandPreview`'s twin branches, and the Rust `expected_create_cli`
table collapse into it (F13).

Shared-case tests: a `test/fixtures/scaffold-plans/*.json` set of
(state → expected argv, files) is run by the JS test and by a Rust test.
A template-existence test checks every initializer route's template
against a checked-in manifest of the pinned tarball's `template-*`
directories, refreshed by the pin-bump procedure (F1, F37).

### 4.2 Add-ons are integrations or they say they are not

Per dependency-change policy Rule 3, each add-on recipe either wires the
promised behavior or its card and review row say "adds the dependency
only". Proposed (rulings R2–R4 decide the open ones):

- **Tailwind** — wired for every framework: Vite plugin registration in
  `vite.config.*` plus `@import "tailwindcss"` in the entry stylesheet;
  Angular uses the PostCSS route; Electron Forge uses `vite.renderer.config.*`.
- **shadcn** — preconditions written before init (tsconfig `@` alias,
  Tailwind wired first), variant-specific non-interactive flags
  (`shadcn-svelte init --preset … --no-deps …`, no `-y`), execution order
  topological (F3, F6, F7).
- **Electron framework** — pinned plugin majors compatible with Forge's
  Vite 5 template (`@vitejs/plugin-react@4.7.0` peer `^4.2||^5||^6||^7`;
  `@sveltejs/vite-plugin-svelte@3.1.2` peer `^5`), renderer entry and
  plugin config written (F2, F5).
- **Router** — install plus the framework's minimal wiring where it is
  mechanical (React `BrowserRouter` root, Vue `createRouter` with one
  route, Solid `Router` root) — or "adds the dependency only" (R4).
- **Express / Fastify** — `server/index.{ts,js}` with one route and a
  `dev:server` script, or removed from the matrix until wired (R2).
- **pytest** — a smoke test for every archetype, not only Library (F11).
- **`.python-version`** — preview and runner share the manifest rule (F12).

### 4.3 Manager recipes

Yarn Berry gets `add`/`dlx`; Yarn Classic is detected (`yarn --version`
major 1) and refused visibly with the upgrade hint (R3). The posture note
is rendered from the selected manager's coverage: npm (scripts off + audit),
pnpm (native scripts-off + minimumReleaseAge, no audit), yarn (neither) —
and the ADR-021 §5 posture-note test grows one case per manager (F4, F29).

### 4.4 Wizard lifecycle state machine

`runState: 'idle' | 'running' | 'held' | 'opening' | 'failed'` replaces the
`isScaffolding`/`pendingDone`/`error` triple. Guards derive from it in one
selector (`wizardNavigation.js`, pure, tested):

- `canNavigate(runState)` — false for `running`, `held`, `opening`; covers
  stepper, Back, Alt+arrows, review-row edits, and card clicks (F18, F20).
- `canCancel(runState)` — `running` → cancel IPC (S7); `held` → "Close
  without opening" wording, never "Discard" (F18).
- `canSubmit(state, runState)` — re-runs `canAdvance` for every page and
  requires a plan (F19).
- `goToPage` re-validates the target's prerequisites and clamps to the
  first invalid page (F19).
- `held` retains the payload until `onDone` resolves; a rejection moves to
  `failed` with an "Open workspace again" action and no re-scaffold (F17).
- Every creation path (Blank, Python, npm) ends in `finishRun` (F16).
- The plan is derived from `state` + `probe` inside a `useMemo` and passed
  to the submit handler, so no callback can hold a stale probe (F15).
- Reducer cases return `state` unchanged on same-value sets (F21); `THEMES`
  is derived from `BUILTIN_THEME_PRESETS` (F22); catches log through the
  crash/error capture surface (F23); the existing-environment input
  renders beside its select (F25); the dialog traps focus (F26).
- `buildLogDomain` keeps `issueCount` and `failedSteps` counters that
  survive trace truncation (F24).

### 4.5 Creation safety and process control

- **Ownership before tolerance.** A new-project write begins by creating
  `.litria/scaffold-attempt.json` (`create_new`, refuses to overwrite)
  recording the run id and the file manifest. The run records verified
  output paths and their content hashes as output is produced; the planned
  file list alone is not proof of what was written. Retry tolerance requires
  the marker and unchanged, recorded content for every present entry. Added,
  modified, or unproven content refuses with the existing `not_empty` code.
  Generated paths refuse symlinks and reparse points on the way down; files
  are written with `create_new` unless verified records prove unchanged
  output from the earlier attempt (F27, R8).
- **Deadline and cancel.** Each step has both an idle-output timeout and a
  finite absolute elapsed-time deadline measured from its start with a
  monotonic clock. Output may reset the idle timer, never the absolute
  deadline. Limits are explicit per step kind, recorded in the plan and
  trace, and tested. Either expiry reports `StepFailed` with a distinct
  reason and tears down the process tree per Orchestration §1.2 (signal,
  wait, force, reap); `cancel_scaffold` uses the same teardown. Cancel is
  enabled while `running` (F30).
- **Preservation before cleanup.** After teardown completes, cancellation
  or timeout may remove the partial directory only if this run created it
  and every remaining entry is proven unchanged run output. A marker alone
  never authorizes recursive deletion. Do not remove a pre-existing target
  directory or bless current contents by re-hashing them into the manifest
  during cleanup. If any entry was added, modified, is unrecorded, cannot be
  checked, or resolves through a symlink/reparse point, leave the directory
  intact and report its path and the reason. Verification and deletion must
  prevent concurrent replacement from invalidating that proof; if the
  implementation cannot guarantee this, retain the directory. Retry uses
  the same preservation rule (F27, R7/R8).
- **Python.** `uv venv --no-python-downloads` (F28); interpreter
  eligibility is one Rust predicate used by the probe (returns `eligible`
  + reason) and by creation, and the wizard hides ineligible entries (F31);
  the guard runs in every mode that forwards an interpreter (F35);
  `pyproject.toml` is serialized with the `toml` crate and the existing
  environment directory must exist (F32); keywords are refused in
  `derivePythonNames` and `is_valid_module_name` with a visible message
  (F33); an invalid floor is an error, not an omission (F36).

### 4.6 Documentation and pins

- `docs/capabilities.md` gains the "excluded combinations" section the
  matrix cites, states the add-on coverage per framework, and drops the
  Vite × Angular wording in favor of "Angular via the Angular CLI" (F10).
- Matrix comments say Svelte, not SvelteKit (F8).
- Pins refresh in S8 under the 24h rule; the registry records per-recipe
  last-verified date and revalidation triggers (F9, dependency policy
  Rule 5); the release policy gains "refresh recipe evidence before
  tagging".

## 5. Slices

Each slice is one PR, verified per verification-policy plus
dependency-change Rule 4 for recipe changes. Order matters: S1 is the
substrate every later slice writes into.

### S1 — Recipe registry and shared plan (F1 partial, F13, F14, F34, F37)

- Goal: one registry, one plan builder, preview = argv = runner.
- Tasks: `recipes.json`; `buildScaffoldPlan`; Rust `include_str!` +
  derivation + hash check; matrix becomes a projection; delete duplicated
  constants and preview branches; `THEMES` from presets; registry coverage
  statuses and matching UI/runner availability checks (§6).
- Tests: shared plan fixtures run from JS and Rust; template-existence
  manifest test; direct, equivalent, unverified, and failing coverage cases
  agree between UI and runner; posture-note test unchanged.
- Acceptance: every current combination produces byte-identical argv from
  JS preview and Rust runner; web + Angular is absent from the manifest
  test's initializer set and blocked in the registry until S2.

### S2 — Angular CLI route (F1)

- Goal: web + Angular scaffolds a real Angular project.
- Tasks: `Exec` route; `@angular/cli` pin; age gate per route; Angular
  PostCSS Tailwind variant; preview label.
- Tests: plan fixtures for web+angular × npm/pnpm/yarn; age-gate unit test
  for `Exec` package naming.
- Acceptance (Rule 4): disposable-fixture scaffold on Windows with npm,
  `ng build` succeeds, files match the manifest; pnpm and Yarn paths each
  exercised or recorded as unverified and disabled under §6. npm evidence
  alone does not enable another manager.

### S3 — Add-on integrity (F2, F3, F5, F6, F7, F11, F12)

- Goal: every add-on wires what its card promises, in dependency order.
- Tasks: topological ordering; Tailwind wiring per framework; shadcn
  preconditions + variant flags; Electron plugin pins + renderer wiring;
  backend server files (per R2); router wiring (per R4); pytest smoke
  tests for all archetypes; `.python-version` manifest rule; card copy.
- Tests: plan fixtures per add-on × framework; generated-file snapshot
  tests for config files.
- Acceptance (Rule 4): representative scaffold per distinct path (React +
  Tailwind + shadcn on Vite; Svelte + shadcn; Electron + React; Web + Vue
  + Router + Express) with `build` succeeding; coverage map for
  combinations sharing a path with the equivalence rationale required by
  §6; uncovered paths named and disabled.

### S4 — Package-manager recipes (F4, F29)

- Goal: Yarn and pnpm run commands their CLI accepts; the posture note
  tells the truth per manager.
- Tasks: `add`/`dlx` verbs; Yarn Classic detection and visible refusal;
  per-manager posture note + test cases.
- Acceptance: pnpm and Yarn Berry scaffolds exercised for one recipe each;
  Yarn 1 refusal shown in the trace with the upgrade hint. Additional
  recipes remain disabled unless directly verified or covered by a
  documented equivalence under §6.

### S5 — Wizard lifecycle (F15–F26)

- Goal: one `runState`, guards derived from it, payload never lost.
- Tasks: state machine + selectors; `finishRun` for Python; open-retry
  action; re-validation on jump/submit; reducer no-op guards; probe in the
  memoized plan; logged catches; existing-env input placement; focus trap;
  `buildLogDomain` counters.
- Tests: `wizardNavigation` selector tests for every (runState, action)
  pair; `buildLogDomain` truncation test; a component-level test of the
  wizard (jsdom) covering held → open failure → retry.
- Acceptance: owner live pass of held completion, Alt+Left during a run,
  invalidation after reaching Create, Python warning retained.

### S6 — Python hardening (F28, F31–F33, F35, F36)

- Goal: creation runs only what the wizard showed, on the interpreter it
  offered, and writes valid TOML.
- Tasks: `--no-python-downloads`; shared eligibility predicate + probe
  flag; guard in every mode; `toml` serializer + env existence; keyword
  refusal both sides; floor validation error.
- Tests: Rust unit tests per predicate; JS `derivePythonNames` keyword
  cases; a pyproject round-trip parse test with a quoted POSIX path.
- Acceptance: offline fixture scaffold with `uv` present and no matching
  interpreter fails visibly without a download.

### S7 — Creation safety and process control (F27, F30)

- Goal: creation never overwrites what it did not create; a stuck step is
  recoverable.
- Tasks: ownership marker + hash-verified retry; `symlink_metadata`
  refusal; `create_new` writes; idle timeout and absolute deadline;
  `cancel_scaffold` IPC with process-tree teardown; wizard Cancel during
  `running`; preservation checks for retry and cleanup (R7/R8).
- Tests: Rust tests with a pre-seeded README, a symlinked `src`, and a
  marker-proven retry; cancellation/timeout preserve a file added or edited
  after creation, a replaced path, and unrecorded partial output; unchanged
  proven output can be cleaned up. A silent child hits the idle timeout;
  a child emitting output continuously hits the absolute deadline. Both
  cases and explicit cancellation verify descendants are terminated and
  reaped before cleanup.
- Acceptance: security-policy Rule 4 register audit — every creation path
  (Blank, Python, npm, Angular) lists the ownership, content-preservation,
  and symlink checks it carries; every subprocess path names both limits.

### S8 — Verification, pins, and docs (F8, F9, F10)

- Goal: evidence recorded and claims bounded (dependency policy Rule 6).
- Tasks: pin refresh under the 24h rule; per-recipe last-verified table in
  the registry; `docs/capabilities.md` excluded-combinations section and
  per-framework add-on coverage; matrix comment fixes; release-policy
  addendum; release notes.
- Acceptance: owner live pass; evidence table in the PR names every
  combination exercised, on what platform, every equivalence mapping, and
  every unverified or failing combination with its disabled availability.
  Each finding's disposition and remaining verification are recorded (§6).

## 6. Verification contract for the whole arc

- Unit and shared-case tests are supporting evidence only. Each distinct
  execution path claimed as supported (route/template × manager/version ×
  add-on wiring × platform × interpreter validator) gets at least one
  disposable-fixture execution with the pinned versions, recorded per
  dependency-change Rule 6.
- Record coverage per combination and supported environment in the registry:
  `verified` (direct passing execution), `covered-by-equivalence` (named
  passing representative and rationale), `unverified` (missing evidence), or
  `failing` (observed failure). Evidence identifies the recipe revision,
  resolved versions, platform, manager, and promised behavior exercised.
- A representative covers another combination only with an explicit mapping
  showing the same relevant commands, requirements, configuration, and
  behavior. A different template, manager command or supported major,
  platform-specific path, add-on integration, or interpreter validator
  requires its own execution evidence; shared labels are not equivalence.
- Only `verified` and `covered-by-equivalence` combinations are selectable
  for the user's platform and manager. Unverified or failing choices remain
  disabled with a reason; the runner enforces the same restriction. Naming
  missing evidence in a PR is not permission to offer that combination.
  Revalidation triggers invalidate affected coverage until refreshed (§4.6).
- Offline recipes (Blank, Python) are verified without enabling downloads.
- Unavailable platforms (macOS, Linux) are reported as unverified by name,
  never as passed, and their affected combinations remain disabled. A
  Windows run does not establish a distinct macOS or Linux execution path.
- The failing web + Angular case from F1 is retained as a regression check
  (registry refuses an initializer route whose template is not in the
  manifest).
- Maintain an F1–F37 disposition table in the implementation plan/PRs. To
  close a confirmed finding, link its implementation change and a check
  exercising the original failure case, with expected and observed results.
  Multiple findings may share a fix or check only when each ID's coverage
  is explicit. Open verification, temporary disabling, or an invariant's
  existence alone does not establish a repaired finding. Any accepted scope
  change is recorded as such, separately from a verified fix. Unconfirmed
  findings such as F7 first need reproduction or evidence supporting a
  not-reproduced disposition; they are not silently counted as fixed.

## 7. Rulings requested (owner)

Each has a proposed answer; accept as-is or amend.

- **R1 — Angular route.** Web + Angular via pinned `@angular/cli` `Exec`
  route (§3). *Proposed: yes.*
- **R2 — Backends.** Express/Fastify write `server/index.*` + `dev:server`
  script (wired) rather than being dropped or labelled install-only.
  *Proposed: wire; it is one file and one script per backend.*
- **R3 — Yarn Classic.** Detect and refuse visibly; support Yarn Berry
  only. *Proposed: refuse; Classic has no `dlx` and no scripts-off story.*
- **R4 — Router.** Wire the mechanical minimum per framework versus label
  "adds the dependency only". *Proposed: wire React/Vue/Solid; the root
  wrapper is mechanical and testable.*
- **R5 — Electron plugin strategy.** Pin plugin majors to Forge's Vite 5
  template rather than post-editing Forge's Vite version. *Proposed: pin
  plugins; the template's Vite is upstream's contract.*
- **R6 — Pin authority.** One JSON registry read by both sides with a Rust
  hash check, versus Rust-only pins. *Proposed: shared registry; the JS
  side needs the data for the preview and the tests.*
- **R7 — Cancel semantics.** Cancel during a run kills the tree and removes
  the partial directory only after teardown and proof that this run created
  it and every remaining entry is unchanged run output. Added, modified,
  unrecorded, or unverifiable content leaves the directory intact with an
  explanation; a marker alone is insufficient (§4.5). *Proposed: yes.*
- **R8 — Retry tolerance.** Replace filename-based tolerance with the
  ownership marker + verified output manifest; a nonempty folder without
  that proof, or with added or modified content, is `not_empty`. Retry never
  overwrites user changes (§4.5). *Proposed: yes; the marker is written
  first, under `create_new`, and content is verified before reuse.*

## 8. Out of scope

- Bundled npm 12 watch item (ADR-021 §6) — unchanged.
- First-open consent pill for Angular projects — the npm pill already
  models scripts-off installs; Angular projects go through it unchanged.
- Preferences ownership of wizard seeds (ADR-019) — untouched.

## 9. Disposition table (§6 closure contract; recorded 2026-09-17)

Slices landed as stacked PRs: S1 #45, S2 #46, S3 #47, S4 #48, S5 #49,
S6 #50, S7 #51, S8 #52. "Check" names the test or evidence that exercises
the original failure case; each PR body carries the expected/observed
detail. Owner live passes are listed per slice in the PR bodies and remain
the open verification for every row.

| ID | Disposition | Fix (slice) | Check |
|---|---|---|---|
| F1 | Closed | S1 registry + template manifests; S2 Angular CLI exec route | `scaffoldRecipes.test.mjs` F1 regression (both sides); web/angular/ts fixture: create + `ng build` |
| F2 | Closed | S3 Electron framework recipes pin Vite-5 plugin majors | electron × react/svelte/vue/solid renderer `vite build` evidence |
| F3 | Closed | S3 shadcn-svelte real flags | electron/tauri/web svelte + shadcn evidence |
| F4 | Closed | S4 manager verbs (`add`/`dlx`), Yarn Classic floor | Rust `resolve_global_pm_with_floor` tests; pnpm/Yarn evidence |
| F5 | Closed | S3 add-ons as registry step lists (config + wiring) | `scaffoldSteps.test.mjs` + step-cases fixture; add-on evidence builds |
| F6 | Closed | S1/S3 `orderAddons` from `addonOrder` | `scaffoldSteps.test.mjs`; Rust `order_addons` |
| F7 | Reproduced, closed | S3 alias merged into tsconfig before `shadcn init` | first S3 probe failed the alias preflight; recipe evidence now verified |
| F8 | Closed | S1 removed the matrix tables (comment gone); S8 `docs/capabilities.md` states standalone Svelte, no SvelteKit | doc review |
| F9 | Closed | S8 pins refreshed under the 24h rule; `evidence.pins` per entry; runtime + test trigger | `every offered coverage entry was recorded against the current pins` (JS + Rust) |
| F10 | Closed | S8 `docs/capabilities.md` excluded-combinations section; "Angular via the Angular CLI" | doc review |
| F11 | Closed | S3 pytest smoke test for every archetype | Rust `pytest_addon_ships_a_smoke_test_for_every_archetype` |
| F12 | Closed | S3 `.python-version` display rule = runner rule | `pythonWizardModel.test.mjs` F12 case |
| F13 | Closed | S1 single registry; projections only | architecture: `compatibility-matrix.js` carries no data |
| F14 | Closed | S1 preview = argv = runner | `scaffoldPlan.test.mjs` F14; Rust `validate_plan` |
| F15 | Closed | S1 memoized plan from the same inputs | S5 component test reads `plan` only |
| F16 | Closed | S5 Python → `finishRun` | `wizardLifecycle.test.mjs` text contract |
| F17 | Closed | S5 payload retained until open resolves | `wizardComponent.test.mjs` failed open → open again |
| F18 | Closed | S5 held/opening states freeze navigation, Cancel reworded | component test |
| F19 | Closed | S5 `resolveJump` + `canSubmit` re-validate | component test (runtime changed after Create) |
| F20 | Closed | S5 `goToPage` refuses while running | `wizardLifecycle.test.mjs` |
| F21 | Closed | S5 reducer same-value guards | text contract |
| F22 | Closed | S1 themes derived from presets | `wizardComponent`/lifecycle contracts |
| F23 | Closed | S5 `captureError` on probe/picker; fallback honours autoSendLogs | text contract |
| F24 | Closed | S5 issue counters in `buildLogDomain` | `wizardLifecycle.test.mjs` truncation case |
| F25 | Closed | S5 existing-env input beside its select | text contract |
| F26 | Closed | S5 Tab focus trap | text contract |
| F27 | Closed | S7 ownership marker + manifest; `create_new`; link refusal; preservation-checked retry/cleanup | Rust `creation_ownership` tests (pre-seeded README, linked `src`, proven retry, preserved content) |
| F28 | Closed | S6 `uv venv --no-python-downloads` (creation, preview, first-open pill) | live uv `--python 3.99` refusal, no download |
| F29 | Closed | S4 posture note per manager from registry fields | `createCliVersions.test.mjs` per manager |
| F30 | Closed | S7 idle + deadline per step kind; `cancel_scaffold`; process-tree teardown | Rust `process_control` tests (node families); component Cancel test |
| F31 | Closed | S6 one `interpreter_eligibility` predicate; wizard hides ineligible | Rust probe/scaffold tests; `pickDefaultInterpreter` test |
| F32 | Closed | S6 serde model + `toml` serializer; env must exist | TOML round-trip tests (Windows + quoted POSIX path) |
| F33 | Closed | S6 keyword refusal both sides | `derivePythonNames` keyword tests; Rust `validate_config` |
| F34 | Closed | S1 `validate_plan` refuses versions the registry did not derive | Rust plan-mismatch tests |
| F35 | Closed | S6 guard in every environment mode | Rust `validate_guards_the_interpreter_in_every_mode` |
| F36 | Closed | S6 invalid floor is a reason / an error | `pythonPlanProblem` + Rust floor tests |
| F37 | Closed | S1 manifest test (matrix ↔ real templates); S5 component-level wizard tests | `scaffoldRecipes.test.mjs`; `wizardComponent.test.mjs` |

Accepted scope notes (recorded separately from fixes): create-tauri-app is
held at 4.6.2 and @angular/cli at 21.2.24 until the bundled Node reaches
24.15 (registry `$comment`s name the trigger); Yarn with shadcn/router and
Yarn with Angular remain `failing` with their reasons; macOS and Linux
coverage remains unverified and disabled by name.
