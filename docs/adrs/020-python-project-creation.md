# ADR-020: Python Project Creation — Offline Blueprint Scaffolds & Interpreter Binding

## Status
- Implemented — 2026-07-28 status correction: all slices were delivered 2026-07-12 via PRs #121–#127 (designed, shipped, and owner-verified the same day this ADR was accepted); this ledger was never flipped. Residual polish items live in the PR bodies.
- Accepted — 2026-07-12 (design settled same day: design brief + owner decisions, empirical verification of the two flagged assumptions). Delivery slices 0–4 below; implementation begins with Slice 0.

## Date
- 2026-07-12

## Context

The New Project wizard scaffolds exactly one ecosystem: JS/TS via npm `create-*` CLIs through bundled Node (`scaffold_runner.rs`, ADR-012). Python has no creation path — despite Litria already bundling pyright (ADR-004), running a Python LSP lifecycle, shipping Python local intelligence, and carrying a dead pre-ADR-012 Python registry entry (`scaffoldDomain.js:22-36`) that documents the old intent. A user starting a Python project today gets Blank and inherits everything that makes Python hard alone: which interpreter, what a venv is, why pyright can't see installed packages.

Investigation (2026-07-12, full detail in the design brief) found the gaps concrete:

1. `.venv` is **not** in the project-tree scan ignores (`project_tree.rs` ignores `__pycache__` only) — one venv floods the scaffold drawer with thousands of entries.
2. Pyright is never told about an interpreter: the pack sends `initializationOptions: {}`, server-initiated `workspace/configuration` requests are ignored, and no config file is read or written. Venv-installed packages report as unresolvable.
3. No probe exists for `py`, `uv`, `pip`, or conda; Python detection is a fragile `python --version` string-prefix check.
4. The visible terminal allowlists shells only and strips `VIRTUAL_ENV`/`PYTHONPATH`; the blank `.gitignore` has no Python entries; edge discovery is JS/TS-only; `.pyi` maps to plaintext.
5. The stack choice is dropped at bootstrap (`db_bootstrap_project` receives only name+path), and no `[environment]` writer exists for `litria.toml`.

Three external facts shape the answer. First, the npm scaffold path is launch-paused over supply-chain trust, and PyPI now has worm-class incidents of its own (Shai-Hulud copycat, LiteLLM/TeamPCP, TrapDoor) — so a Python path must not extend the exposure. Second, the 2026 ecosystem has converged: `pyproject.toml` (PEP 621) is universal, `.python-version` is the cross-tool pin, uv is the fastest-adopted tool in the PSF survey's history, Windows is mid-migration from the deprecated classic installer to the PEP 773 Python Install Manager, and both PyCharm 2025.3 and VS Code's python-envs GA landed on the same wizard shape: project-local env auto-created, uv-accelerated when detected, manager choice demoted out of the main path. Third, ADR-005 (Accepted + Extended) already locked the governing taxonomy: toolchains are detected and hinted, never installed; project dependencies install only through the project's own package manager in the visible terminal, user-initiated; the wizard is a named trigger of the capability reconciler.

Three audiences must be served by one flow: beginners (don't know what a venv is and shouldn't need to), returning casuals (name → Enter → working project), and pros (specific interpreter, uv vs stdlib, src vs flat, pytest/ruff from day one — overrides, not lectures).

## Decision

Python becomes a first-class runtime in the existing wizard, delivered by an **offline blueprint scaffold**, a **structured interpreter probe**, **file-based pyright binding**, and **visible-terminal dependency installs**. The canonical detailed design is `docs/plans/ideas/brief-python-project-creation.md`; this ADR records the normative decisions.

### 1. Creation is offline (the posture)

Litria writes every file itself from **Litria-owned blueprints** — no `uv init`, no cookiecutter, no network, no third-party code execution at creation time. The environment is created with local tools only (`<interpreter> -m venv` is stdlib; `uv venv` executes a local binary offline). Dependencies are *declared* in `pyproject.toml` at creation and *installed* later, visibly (§6). Python is therefore the first scaffold path that is clean under the scaffold-launch pause rather than gated by it.

### 2. Toolchain honesty holds (ADR-005, unchanged)

Litria never installs a Python interpreter. Missing-Python states show per-platform install hints (PyManager/winget, python.org, `uv python install` when uv is present) and may pre-type the command into the visible terminal for the user to run. **Creation never blocks on toolchain state**: with no usable interpreter, the wizard still creates files-only and defers environment creation to a first-open offer — the ADR-005 reconciler's project-open trigger, arrived early.

### 3. A structured interpreter probe (first concrete ADR-005 probe)

A new Rust probe module enumerates installed Pythons and returns structured results (`{ path, version, source, arch }[]`, deduplicated by resolved path; "not found" is a result, not an error; per-probe timeouts). Windows order: **uv enumeration when uv is on PATH** (`uv python list --only-installed --output-format json` — verified on uv 0.8.0: rich JSON, `path` non-null = installed, discovers *system* interpreters too, so it is near-complete by itself on uv machines) → PEP 514 registry (HKCU+HKLM) → `py list --format=json` (PyManager) falling back to `py -0p` (legacy launcher) → PATH. The Microsoft Store stub is detected and surfaced as a first-class *excluded* result, named for what it is. macOS/Linux: PATH `python3`, pyenv, Homebrew, uv. PEP 514 registration of uv-managed CPythons is a bonus, not load-bearing. The probe replaces the string-prefix version check for Python and feeds `languageSupportDomain` diagnostics — it is the "structured probes" leg of ADR-005's reconciler, built for its highest-value language first.

### 4. Wizard surface: one wizard, archetypes, an environment strip

- `python` is a **runtime card** in the existing cascade; `compatibility-matrix.js` stays the single source of truth. The framework tier relabels to **"Project type"** for Python (per-runtime tier labels).
- **Archetypes**: Script (default, auto-selected; flat, dep-free), CLI app (argparse — stdlib, dep-free), Library (src layout, `py.typed`, hatchling build backend, pytest dev-dep), FastAPI service (declared deps `fastapi`/`uvicorn`). Addons: pytest, ruff — both file/declaration-only; **ruff is opt-in** (owner decision).
- The npm `manager` row is replaced for Python by an **environment strip**: interpreter dropdown (probe-fed, best stable CPython preselected, `Browse…` escape hatch, last-used remembered), env mode (`.venv in project` recommended / use interpreter directly / existing environment…), and engine inside the expandable detail (`Auto` = uv if detected else stdlib / `uv` / `python -m venv`). One visible line with an always-visible plain-English caption (ADR-019 style); beginners never expand it.
- Capstone keeps the "what you see is what runs" contract as a **plan** (write-lines, the exact venv command, a note that deps are declared-not-installed). The `requires-python` floor is an **editable review row**, pre-filled from the chosen interpreter's minor (owner decision). Progress streams the existing `ScaffoldEvent` channel; env-step failure is non-fatal (files-only open + first-open offer); file-write failure falls back to "Create as Blank instead" as today.

### 5. What creation writes (and where truth lives)

- **`pyproject.toml`** — PEP 621 `[project]` with `requires-python` floored from the chosen interpreter (floor-from-creation, per the environment-bootstrap design); `[tool.pyright]` with `venvPath = "."` / `venv = ".venv"` when env mode is `.venv`; `[tool.ruff]` when selected; `[dependency-groups]` dev deps; `[build-system]` hatchling for Library only (declared-only — nothing executes at creation).
- **The pyright binding is file-based, zero LSP protocol changes**: pyright natively discovers `pyproject.toml [tool.pyright]` at `rootUri`, sidestepping both the empty `initializationOptions` and the ignored `workspace/configuration` requests.
- **`.python-version`** (chosen minor), Python-canon **`.gitignore`**, **`README.md`** with the archetype's run command.
- **`litria.toml` gains its first `[environment]` section** (`python = ">=3.X"`) — the environment-bootstrap direction's first writer and the reconciler's declared-desired-state input. Machine-local facts (the resolved interpreter's absolute path) do **not** enter `litria.toml` (sparse-by-rule, ADR-019 boundary); the binding lives in `.litria/workspace.db` `editor_state` (`env.python.interpreter`), re-validated by probe on open.
- No `git init` in v1 (no git integration exists; the `.gitignore` makes the user's own `git init` clean).

### 6. Environment creation and dependency installs

- Venv creation always invokes the **concrete resolved interpreter path**, never `py`/`python` shims (owner decision; verified — direct-path `-m venv` produces a correct env whose `pyvenv.cfg` records exact home/executable; stdlib creation measured 9.4s with pip bootstrap on the Win10 dev machine, hence the streamed progress line; sub-second under uv).
- Dependency install is a **first-open pill** (ADR-005 A3 consent shape, no modal) naming the exact command (`uv sync`, or the `.venv` pip form without uv). **Click = run visibly** (owner decision): the terminal drawer opens and the command executes in front of the user — one click, ADR-005 class-3 compliant, and the beginner sees the real mechanics. The same pill shape serves deferred env creation, and it is the identical pipeline the reconciler will later run on any opened folder.
- A one-time **first-run hint** (status line) shows the archetype's run command after open.

### 7. Backend: a blueprint executor, not new npm arms

A new `python_scaffold.rs` executes declarative blueprints (files + pyproject fragments + env request). It reuses the generic `ScaffoldStep`/`run_step_command` executor and `Channel<ScaffoldEvent>` streaming but does **not** extend the npm-shaped `build_primary_args`/`resolve_pm` machinery. Wizard-side, archetype cards carry a blueprint reference the way `flagConfig` carries flags today — ADR-012's declarative idiom, second dialect — and this is deliberately the shape ADR-005's future registry `scaffold` blocks and template packs want.

### 8. Ground prep ships first (standalone value)

These fix any Python folder, opened or created, independent of the wizard: scan ignores gain `.venv`, `venv`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `.eggs`, `.ipynb_checkpoints`; the common `.gitignore` gains the Python canon; `.pyi` maps to `python` in `editorLanguage.js`. (Opportunistic: refresh the stale bundled pyright pin — 1.1.390 vs 1.1.411 current — an existing pre-beta follow-up this flow makes user-visible.)

### Delivery slices

- **Slice 0 — Ground prep** (§8; no wizard surface, ship immediately).
- **Slice 1 — Interpreter probe**: Rust module + Tauri command + `languageSupportDomain` wiring.
- **Slice 2 — Wizard surface**: matrix entries, archetype cards, environment strip, per-runtime tier labels, plan preview, review rows (incl. editable `requires-python`), config payload.
- **Slice 3 — Creation backend**: `python_scaffold.rs` blueprint executor, venv step, `[environment]` writer, thread `language` through `db_bootstrap_project`, interpreter binding into `editor_state`.
- **Slice 4 — First-open affordances**: seed pieces for created files, deps/deferred-env pills → visible terminal, first-run hint; E2E acceptance: pyright resolves a venv-installed package via `[tool.pyright]`.
- **Follow-ups (explicitly not v1)**: Python import discovery for canvas edges (created projects get pieces but no auto-wires until then), conda/existing-env discovery breadth, data/notebook archetype, full `[environment]` reconciliation on open for non-created projects.

## Consequences

- **Acceptance test is a time budget**: beginner path = one typed field + five clicks, every skipped decision visible with a caption, none demanded; pro overrides inline on page 1 with no separate advanced mode; nobody is blocked by a missing interpreter, asked to activate a venv, or subjected to a hidden install.
- **The `[environment]` block goes live** with its first writer, and `db_bootstrap_project`'s dropped `language`/`framework` seam opens — both are prerequisites the environment-bootstrap system and ADR-005 reconciler inherit for free.
- **A second scaffold dialect exists**: blueprint executor beside the npm command builder. The npm path is untouched; future template packs get their intended shape early. Cost: two scaffold code paths to maintain until the registry `scaffold` blocks unify them.
- **Litria owns its Python templates** — deliberate (offline posture) but a curation duty: blueprints must track ecosystem drift (uv taxonomy, layout norms) by hand rather than delegating to upstream generators.
- **File-based pyright binding covers created projects only.** Opened Python folders without `pyproject.toml`/`pyrightconfig.json` still get an unbound pyright; the proper fix (answering `workspace/configuration`, or writing config on consent at open) is deferred to the reconciler-at-open work, not solved here.
- **Scan-ignore additions change behavior for all projects** (the ignored dirs disappear from the scaffold drawer). The list mirrors the JS-side precedent (`node_modules`, `.git`) and the risk is negligible, but it is a global change shipped in Slice 0.
- **Per-runtime tier labels** ("Framework" → "Project type") break the wizard's uniform vocabulary slightly — accepted; forcing Python archetypes to masquerade as "frameworks" would be the worse lie.
- **The dead `scaffoldDomain.js` Python registry** (pre-ADR-012) should be deleted or clearly quarantined during Slice 2 — `docs/Orchestration.md:129`'s stale claim that it is "wired in the launch flow" gets corrected in the same pass.
- **Terminal env stays strict**: no `VIRTUAL_ENV` injection into the PTY allowlist. The deps pill runs explicit commands that don't need activation (`uv sync`, `.venv\Scripts\python -m pip …`), preserving the terminal policy while keeping activation optional knowledge, not required knowledge.
- **Verification duties created**: E2E pyright-resolves-venv-package check (Slice 4 acceptance), and a macOS/Linux probe pass when hardware access allows (same hold as other cross-platform items).

## Alternatives Considered

- **Run `uv init` / cookiecutter for templates** — rejected. Third-party execution and template churn at creation time; uv becomes a requirement instead of an accelerator; breaks the offline posture that makes Python shippable under the scaffold pause.
- **Extend the npm command builder with Python arms** — rejected. Every assumption in `build_primary_args` is `<pm> create <pkg>@latest`-shaped; Python creation is file-writing plus one local command. Forcing it through would bend both paths.
- **Install declared deps headlessly during scaffold** (streamed to Capstone like npm addons) — rejected. ADR-005 class 3 is explicit: dependency installation executes arbitrary code and happens only in the visible terminal, user-initiated. The default archetype has zero deps, so most beginners never see the extra step at all.
- **Install Python for the user when missing** (PyCharm-style silent `uv python install`) — rejected. Toolchain honesty is locked (ADR-005); Litria pre-types the command into the visible terminal at most.
- **`pyrightconfig.json` instead of `[tool.pyright]`** — rejected for creation. Same function, one extra root file; pyproject is already being written. (A user-added `pyrightconfig.json` takes precedence per pyright's rules — acceptable, that's the user overriding.)
- **Push the interpreter over LSP** (`workspace/configuration` handler / initializationOptions) — deferred, not rejected. Needed eventually for opened folders without a pyproject; for created projects the file-based binding is equal function with zero protocol work.
- **Block creation until an interpreter exists** — rejected. Wastes the user's time at the exact moment they're most motivated; files-only + first-open offer matches the reconciler direction.
- **Store the resolved interpreter path in `litria.toml`** — rejected. Machine-local fact in a team-shared declaration file; violates sparse-by-rule (ADR-019 boundary). It lives in `workspace.db`.
- **A separate Python wizard / dedicated flow** — rejected. One wizard is the point (ADR-005 names it the highest-traffic "trying a new language" trigger); Python is a runtime card, not a fork.
- **Ruff on by default** — rejected by owner decision; opt-in card keeps the written tree minimal.
- **conda support in v1** — deferred. Discovery breadth follow-up; the existing-environment browse option covers the escape hatch meanwhile.

## References

- **Canonical design detail**: `docs/plans/ideas/brief-python-project-creation.md` (2026-07-12 — flow walkthrough, blueprint contents, empirical verification transcript, owner decisions)
- Governing ADRs: ADR-005 (acquisition taxonomy, toolchain honesty, reconciler, wizard trigger), ADR-012 (declarative card system — blueprint = second dialect), ADR-016 (open-any-folder — the wizard-free path this flow must out-earn), ADR-019 (wizard seeds / Preferences owns; `litria.toml` sparse-by-rule; caption style)
- Related direction docs: environment-bootstrap design (floor-from-creation, probe gotchas), scaffold launch pause (offline posture motivation)
- Code seams: `src/scaffold/compatibility-matrix.js`, `src/components/NewProjectWizard.jsx`, `src-tauri/src/scaffold_runner.rs` + `scaffold_types.rs`, `src-tauri/src/db/commands.rs` (`write_litria_toml`, `db_bootstrap_project`), `src-tauri/src/project_tree.rs` (ignores), `src-tauri/src/lsp/packs/python.rs` + `session.rs` (binding gap), `src/app/languageSupportDomain.js`, `src/app/useDiscoveryLifecycle.js` (JS/TS-only discovery), dead `src/scaffold/scaffoldDomain.js` Python entry
- Ecosystem evidence (2026-07): uv `init` taxonomy and `--only-installed` JSON enumeration; PyCharm 2025.3 uv-default wizard; VS Code python-envs GA Quick Create; PEP 773 Python Install Manager / classic-installer deprecation; PSF/JetBrains State of Python 2025; PyPI worm-class incidents (Shai-Hulud copycat, LiteLLM/TeamPCP, TrapDoor)
