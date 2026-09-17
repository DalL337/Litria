# New Project Wizard and Framework Dependency Matrix Audit

Date: 2026-09-16  
Status: Report only; findings have not been remediated.

## Scope and method

Reviewed the frontend New Project wizard, its compatibility matrix and CLI pin registry, and their direct calls, including navigation and Python models, previews, build-log handling, creation callbacks, and the Rust Blank, Python, and npm scaffold entry points and execution helpers.

The review covered security, input and path validation, command execution, dependencies, error handling, matrix accuracy, wizard state, and structure. No code was modified during the audit, and no prior audit reports were consulted. This document records the findings from that audit.

Validation performed:

- All 62 focused tests passed across `wizardNavigation`, `wizardAdvancedFolds`, `pythonWizardModel`, `createCliVersions`, `creationErrors`, `wizardPreviewColors`, `wizardIcons`, and `wizardLayoutContract`.
- Read-only, in-memory reproductions confirmed add-on ordering, navigation after invalidation, navigation during scaffolding, lost completion payloads, warning loss after trace truncation, and Python keyword derivation.
- Public npm metadata confirmed that all six pinned CLI versions exist and their recorded publication dates are correct. Published package source was inspected in memory to check template contents, CLI options, and framework-plugin compatibility.
- A fresh `npm audit --omit=dev --json` reported zero known vulnerabilities in the application's locked production dependencies. This does not cover future generated projects or a complete resolved dependency tree for every third-party scaffold CLI.
- No end-to-end scaffolds were executed. Findings based on command construction and published package source are distinguished from the in-memory reproductions below.

## Summary

| Severity | Findings |
| --- | ---: |
| Critical | 0 |
| High | 2 |
| Medium | 16 |
| Low | 4 |
| **Total** | **22** |

All five requested categories contained findings. No critical issue or direct shell-string injection was confirmed. No significant errors were found in the six CLI version pins or their recorded publication dates; being older than the latest release is not itself treated as a defect.

## Findings

### 1. Existing files can be overwritten without establishing ownership

- **Category:** Security / path handling
- **Severity:** High
- **Files and lines:** [src-tauri/src/blank_project.rs:209](../../src-tauri/src/blank_project.rs#L209), [src-tauri/src/python_scaffold.rs:506](../../src-tauri/src/python_scaffold.rs#L506)
- **What's wrong:** Creation treats familiar filenames as proof that a directory belongs to an earlier scaffold attempt, allowing unrelated files to be overwritten.
- **Evidence:** Existing directories are accepted based solely on filenames. Blank accepts an existing `README.md`; Python accepts whole `src` and `tests` directories. Subsequent `fs::write` calls overwrite matching files and follow symlinks, potentially writing outside the intended project when a preexisting path contains such a link.
- **Suggested fix:** Require explicit ownership for retries, preserve modified files, and reject symlinks/reparse points along generated paths. Prefer exclusive creation for new files.

### 2. Electron installs incompatible framework plugins

- **Category:** Matrix / version compatibility
- **Severity:** High
- **File and line:** [src-tauri/src/scaffold_runner.rs:1139](../../src-tauri/src/scaffold_runner.rs#L1139)
- **What's wrong:** The pinned Electron template and unversioned framework-plugin installations resolve incompatible Vite majors.
- **Evidence:** Forge's pinned template declares Vite `^5.0.12`, while the runner installs unversioned framework plugins. At audit time, `@vitejs/plugin-react@6.1.1` and `@sveltejs/vite-plugin-svelte@7.3.0` require Vite 8. This was checked against published package source and npm metadata, without running a scaffold. Sources: [Forge template](https://raw.githubusercontent.com/electron/forge/v7.11.2/packages/template/vite-typescript/tmpl/package.json), [React plugin requirements](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react/package.json), [Svelte plugin requirements](https://raw.githubusercontent.com/sveltejs/vite-plugin-svelte/main/packages/vite-plugin-svelte/package.json).
- **Suggested fix:** Maintain tested template/framework/plugin version combinations and install compatible versions explicitly.

### 3. Offline Python creation can download Python

- **Category:** Security / command execution
- **Severity:** Medium
- **Files and lines:** [src-tauri/src/python_scaffold.rs:368](../../src-tauri/src/python_scaffold.rs#L368), [src/scaffold/pythonWizardModel.js:156](../../src/scaffold/pythonWizardModel.js#L156)
- **What's wrong:** The environment command does not enforce the wizard's offline promise.
- **Evidence:** The runner executes `uv venv .venv` without `--offline` or `--no-python-downloads`, including when no interpreter was found. uv automatically downloads missing interpreters. Source: [uv documentation](https://docs.astral.sh/uv/guides/install-python/).
- **Suggested fix:** Enforce offline/no-download flags and defer environment creation when no suitable local interpreter exists.

### 4. Displayed protections exceed actual package-manager coverage

- **Category:** Security / dependencies
- **Severity:** Medium
- **Files and lines:** [src/scaffold/create-cli-versions.js:57](../../src/scaffold/create-cli-versions.js#L57), [src-tauri/src/scaffold_runner.rs:1297](../../src-tauri/src/scaffold_runner.rs#L1297), [src-tauri/src/scaffold_runner.rs:942](../../src-tauri/src/scaffold_runner.rs#L942)
- **What's wrong:** The security message promises safeguards that the selected package manager may not receive.
- **Evidence:** Every manager receives the "dependency scripts off" and "npm audit at create" message, but both safeguards are enforced only for npm. Globally installed manager versions are unrestricted; Yarn Classic can execute lifecycle scripts. Source: [Yarn Classic options](https://classic.yarnpkg.com/en/docs/cli/install).
- **Suggested fix:** Enforce equivalent controls for supported manager versions and display manager-specific coverage.

### 5. Web + Angular invokes an invalid template

- **Category:** Matrix compatibility
- **Severity:** Medium
- **Files and lines:** [src/scaffold/compatibility-matrix.js:25](../../src/scaffold/compatibility-matrix.js#L25), [src-tauri/src/scaffold_runner.rs:543](../../src-tauri/src/scaffold_runner.rs#L543)
- **What's wrong:** The matrix exposes a combination that the generated CLI arguments cannot scaffold.
- **Evidence:** The combination generates `create-vite@9.1.1 ... --template angular`. The inspected published package defines `custom-angular`, an Angular CLI delegation, rather than an `angular` template. Source: [Supported Vite templates](https://vite.dev/guide/).
- **Suggested fix:** Add a pinned, noninteractive Angular CLI implementation or remove this combination until supported.

### 6. Svelte's shadcn initialization receives an unsupported flag

- **Category:** Matrix / CLI compatibility
- **Severity:** Medium
- **File and line:** [src-tauri/src/scaffold_runner.rs:1200](../../src-tauri/src/scaffold_runner.rs#L1200)
- **What's wrong:** The runner assumes all shadcn variants support the same initialization flags.
- **Evidence:** Every shadcn variant receives `init -y`. Inspection of pinned `shadcn-svelte@1.4.1` confirms its `init` command has no `-y/--yes` option and requires configuration inputs. Source: [CLI reference](https://www.shadcn-svelte.com/docs/cli).
- **Suggested fix:** Build variant-specific arguments and supply all required noninteractive configuration.

### 7. Yarn dependency additions use npm syntax

- **Category:** Command construction / compatibility
- **Severity:** Medium
- **File and line:** [src-tauri/src/scaffold_runner.rs:1269](../../src-tauri/src/scaffold_runner.rs#L1269)
- **What's wrong:** Dependency-install commands are not adapted to the selected package manager.
- **Evidence:** Framework, backend, and add-on installation always uses `install [-D] <packages>`. Yarn requires `add`; Yarn Classic also lacks the separately generated `dlx` command. Source: [Yarn add](https://yarnpkg.com/cli/add).
- **Suggested fix:** Use manager-specific command builders and explicitly validate supported Yarn versions.

### 8. Advertised integrations only install packages

- **Category:** Matrix accuracy / scaffold functionality
- **Severity:** Medium
- **Files and lines:** [src-tauri/src/scaffold_runner.rs:1161](../../src-tauri/src/scaffold_runner.rs#L1161), [src-tauri/src/scaffold_runner.rs:1172](../../src-tauri/src/scaffold_runner.rs#L1172), [src-tauri/src/scaffold_runner.rs:1241](../../src-tauri/src/scaffold_runner.rs#L1241)
- **What's wrong:** Selecting an integration does not produce the configured application that its description implies.
- **Evidence:** Electron framework selection never configures the renderer or creates framework components. Tailwind-only selection adds packages without configuring its plugin or importing its CSS. Express/Fastify selection creates no server or launch script. Tailwind explicitly requires those configuration steps. Source: [Tailwind installation](https://tailwindcss.com/docs/installation/using-vite).
- **Suggested fix:** Implement the corresponding configuration and starter files, or label these choices as dependency installation only.

### 9. shadcn runs before its dependency

- **Category:** State / dependency ordering
- **Severity:** Medium
- **Files and lines:** [src/components/NewProjectWizard.jsx:189](../../src/components/NewProjectWizard.jsx#L189), [src-tauri/src/scaffold_runner.rs:1118](../../src-tauri/src/scaffold_runner.rs#L1118)
- **What's wrong:** Auto-enabling a prerequisite does not ensure that it executes first.
- **Evidence:** Selecting shadcn first produces `['shadcn', 'tailwind']`; the runner executes that order. Reproduced directly from the reducer. Initialization therefore precedes its declared prerequisite.
- **Suggested fix:** Topologically order add-on prerequisites in the execution plan, independently of click order.

### 10. Reached steps bypass newly invalidated inputs

- **Category:** Wizard state / validation
- **Severity:** Medium
- **Files and lines:** [src/components/NewProjectWizard.jsx:457](../../src/components/NewProjectWizard.jsx#L457), [src/components/NewProjectWizard.jsx:871](../../src/components/NewProjectWizard.jsx#L871), [src/components/NewProjectWizard.jsx:1617](../../src/components/NewProjectWizard.jsx#L1617)
- **What's wrong:** The stepper treats previously visited pages as permanently valid, and submission does not revalidate the complete configuration.
- **Evidence:** Reach Create, return to Stack, and change runtime: framework/language reset, but Create remains jumpable and its button remains enabled. Clearing the name/location behaves similarly. Reproduced with the navigation model.
- **Suggested fix:** Validate prerequisite steps on every forward jump and validate the complete configuration before submission.

### 11. Navigation remains possible during creation or held completion

- **Category:** Wizard state / logic
- **Severity:** Medium
- **Files and lines:** [src/components/NewProjectWizard.jsx:798](../../src/components/NewProjectWizard.jsx#L798), [src/components/NewProjectWizard.jsx:871](../../src/components/NewProjectWizard.jsx#L871), [src/components/NewProjectWizard.jsx:1595](../../src/components/NewProjectWizard.jsx#L1595)
- **What's wrong:** Navigation and editing are not consistently guarded by the creation lifecycle.
- **Evidence:** Alt+Left calls `goBack()` while scaffolding; reproduced from the actual handler. Earlier-page controls remain editable. After completion, Back and the stepper also remain enabled despite `pendingDone`, allowing displayed choices to diverge from the created project.
- **Suggested fix:** Centralize navigation/edit guards for running, completed, and opening states.

### 12. Failed workspace opening loses the successful creation result

- **Category:** Error handling / recovery
- **Severity:** Medium
- **File and line:** [src/components/NewProjectWizard.jsx:544](../../src/components/NewProjectWizard.jsx#L544)
- **What's wrong:** A failed handoff discards the information needed to retry opening an already-created project.
- **Evidence:** `handleContinue` clears `pendingDone` before awaiting `onDone`. A rejection leaves only "Create Project"; retrying npm creation then encounters the already-existing directory. Reproduced with a rejecting callback.
- **Suggested fix:** Retain the payload until opening succeeds and offer an opening retry without rerunning scaffolding.

### 13. Python bypasses completion and log policies

- **Category:** Error handling / wizard logic
- **Severity:** Medium
- **File and line:** [src/components/NewProjectWizard.jsx:668](../../src/components/NewProjectWizard.jsx#L668)
- **What's wrong:** Python does not use the shared completion path used by Blank and npm scaffolds.
- **Evidence:** Python directly awaits `onDone` instead of `finishRun`. Consequently, successful Python runs ignore `tracePause` and automatic log saving; nonfatal environment failures disappear when the workspace opens, and returned errors are discarded.
- **Suggested fix:** Route Python through the shared completion handler and retain its environment outcome/errors.

### 14. Stalled subprocesses can indefinitely lock creation

- **Category:** Error handling / unhandled edge cases
- **Severity:** Medium
- **Files and lines:** [src-tauri/src/scaffold_runner.rs:1317](../../src-tauri/src/scaffold_runner.rs#L1317), [src-tauri/src/python_scaffold.rs:388](../../src-tauri/src/python_scaffold.rs#L388)
- **What's wrong:** Creation has no reliable recovery path for a subprocess that never finishes.
- **Evidence:** Both runners wait for output closure and process exit without a deadline or cancellation mechanism. The wizard disables Cancel while running.
- **Suggested fix:** Add execution deadlines, cancellation IPC, process-tree termination, and recoverable timeout reporting.

### 15. Offered Python interpreters are rejected during creation

- **Category:** Python compatibility / validation
- **Severity:** Medium
- **Files and lines:** [src/components/NewProjectWizard.jsx:1073](../../src/components/NewProjectWizard.jsx#L1073), [src-tauri/src/python_scaffold.rs:112](../../src-tauri/src/python_scaffold.rs#L112)
- **What's wrong:** Discovery and execution disagree on which interpreter variants are supported.
- **Evidence:** Discovery exposes alternative implementations and free-threaded variants, but creation accepts only `python`, `pythonw`, or `python` followed by digits/dots. Names such as `python3.13t.exe` and `pypy.exe` fail validation before any project files are written.
- **Suggested fix:** Share interpreter eligibility rules between discovery and execution, using validated discovered identities.

### 16. Existing-environment paths are corrupted or serialized unsafely

- **Category:** Input validation / path handling
- **Severity:** Medium
- **File and line:** [src-tauri/src/python_scaffold.rs:240](../../src-tauri/src/python_scaffold.rs#L240)
- **What's wrong:** Environment paths are transformed instead of preserved, and their TOML representation is not correctly escaped.
- **Evidence:** `split_env_path` removes apostrophes from the parent: `C:\Users\O'Neil\env` becomes a different path. The environment basename is inserted into a double-quoted TOML string without escaping; legal POSIX names containing quotes break the configuration. Existence is not checked.
- **Suggested fix:** Validate the environment directory and use a TOML serializer that preserves and escapes the actual path.

### 17. Trace truncation forgets earlier warnings

- **Category:** Error handling / reporting
- **Severity:** Medium
- **Files and lines:** [src/app/buildLogDomain.js:61](../../src/app/buildLogDomain.js#L61), [src/app/buildLogDomain.js:121](../../src/app/buildLogDomain.js#L121)
- **What's wrong:** Whether a run had issues depends on which log records remain in the bounded buffer.
- **Evidence:** `hasIssues()` examines only retained records. One warning followed by 5,000 output records changes it from true to false; reproduced. "Pause on warnings" can therefore skip a run that had warnings or failed steps.
- **Suggested fix:** Maintain persistent issue counts/flags independently of the bounded trace.

### 18. Python execution can use stale probe results

- **Category:** Wizard state / logic
- **Severity:** Medium
- **Files and lines:** [src/components/NewProjectWizard.jsx:659](../../src/components/NewProjectWizard.jsx#L659), [src/components/NewProjectWizard.jsx:725](../../src/components/NewProjectWizard.jsx#L725)
- **What's wrong:** The submission callback can retain an outdated environment-engine decision.
- **Evidence:** `handleDone` reads `pyProbe.uvAvailable` but omits it from its callback dependencies. If a probe finishes with uv available and no interpreters, no interpreter dispatch refreshes the callback: the preview can show uv while submission still resolves to stdlib venv.
- **Suggested fix:** Include the probe dependency or derive one current execution plan shared by preview and submission.

### 19. Python keywords become unusable module names

- **Category:** Input validation / Python edge cases
- **Severity:** Low
- **Files and lines:** [src/scaffold/pythonWizardModel.js:55](../../src/scaffold/pythonWizardModel.js#L55), [src-tauri/src/python_scaffold.rs:320](../../src-tauri/src/python_scaffold.rs#L320)
- **What's wrong:** Identifier character checks do not exclude Python's reserved keywords.
- **Evidence:** `derivePythonNames('class')` returns module `class`, which the backend accepts. Library scaffolding then writes `from class import __version__`, an invalid Python statement. Source: [Python keywords](https://docs.python.org/3/reference/lexical_analysis.html#keywords).
- **Suggested fix:** Reject or deterministically rename reserved keywords in both validation layers.

### 20. pytest promises a test scaffold but creates none

- **Category:** Matrix accuracy / add-on behavior
- **Severity:** Low
- **Files and lines:** [src/components/NewProjectWizard.jsx:107](../../src/components/NewProjectWizard.jsx#L107), [src-tauri/src/python_scaffold.rs:332](../../src-tauri/src/python_scaffold.rs#L332)
- **What's wrong:** The pytest add-on's description promises files that are not generated.
- **Evidence:** The card advertises "Test scaffold + dev dependency." Selecting pytest for Script, CLI, or FastAPI only adds the dependency; test files are generated exclusively for Library.
- **Suggested fix:** Generate appropriate smoke tests for these archetypes or correct the advertised behavior.

### 21. Standalone Svelte is incorrectly described as having built-in routing

- **Category:** Matrix accuracy / compatibility claims
- **Severity:** Low
- **File and line:** [src/scaffold/compatibility-matrix.js:36](../../src/scaffold/compatibility-matrix.js#L36)
- **What's wrong:** The matrix's rationale conflates Svelte with SvelteKit.
- **Evidence:** The matrix excludes a router because of "built-in routing," but the runner selects standalone `svelte`/`svelte-ts` templates. The inspected pinned template contains neither SvelteKit nor a router.
- **Suggested fix:** Distinguish Svelte from SvelteKit and describe or implement routing support accordingly.

### 22. Multiple sources of truth already disagree

- **Category:** Structure / duplication
- **Severity:** Low
- **Files and lines:** [src/scaffold/compatibility-matrix.js:64](../../src/scaffold/compatibility-matrix.js#L64), [src/components/NewProjectWizard.jsx:95](../../src/components/NewProjectWizard.jsx#L95), [src/scaffold/pythonWizardModel.js:81](../../src/scaffold/pythonWizardModel.js#L81), [src-tauri/src/python_scaffold.rs:336](../../src-tauri/src/python_scaffold.rs#L336)
- **What's wrong:** Choice data, previews, and execution maintain separate representations of the same scaffold behavior.
- **Evidence:** `COMPAT.backends` is unused; the wizard maintains its own backend list. Python previews always list `.python-version`, while execution writes it only when a valid floor exists. Preview command construction also duplicates runner logic.
- **Suggested fix:** Define a validated scaffold plan containing supported choices, ordered operations, and generated files; render previews and execute from that plan.
