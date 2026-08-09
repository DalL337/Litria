# Brief: Python Project Creation Flow — Launcher → Wizard → First Open

> **Status**: Design brief — open questions resolved by owner 2026-07-12 (see
> Decisions); promoted to **ADR-020** (`docs/adrs/020-python-project-creation.md`,
> Proposed) same day. This brief remains the detailed design; the ADR is the
> normative decision record.
> **Author**: DalL337 + Claude
> **Date**: 2026-07-12
> **Investigated against**: wizard/scaffold code as of `53c2d39` (PR #120), ADR-005
> (Accepted + Extended), ADR-012, ADR-016, ADR-019; Python ecosystem research
> 2026-07 (uv 0.11.x, PyCharm 2025.3, VS Code python-envs GA, PEP 773 PyManager).

## Problem

The New Project wizard scaffolds exactly one ecosystem: JS/TS via npm
`create-*` CLIs through bundled Node (`scaffold_runner.rs`). Python — the
language Litria already bundles a server for (pyright), has LSP lifecycle and
local intelligence for, and once sketched a registry entry for
(`scaffoldDomain.js:22-36`, dead pre-ADR-012 code) — has no creation path.
A user starting a Python project today gets the Blank template and is on their
own for everything that actually makes Python projects hard: which interpreter,
what a venv is, why pyright can't see their packages.

Three audiences, three failure modes to avoid:

- **Beginners** don't know what a venv is and shouldn't need to. Their
  classic failure loop — Store-stub `python`, pip installing into the wrong
  interpreter, activation confusion — is precisely what an IDE can absorb.
- **Casual/returning users** want name → Enter → working project in under
  fifteen seconds, no questions they have to think about.
- **Pros** have opinions: a specific interpreter, uv vs stdlib, src vs flat
  layout, pytest/ruff from day one. They need overrides, not lectures.

## Why Python is the right *next* scaffold (posture)

The npm scaffold path is launch-paused ([[project_scaffold_launch_pause]] —
supply-chain trust, not tech). PyPI has the same class of problem now
(Shai-Hulud copycat typosquats, LiteLLM/TeamPCP CI-token compromise, TrapDoor
cross-registry worm). The design answer is the same one ADR-005 already
locked: **creation is offline**. Litria writes every file itself and creates
the environment with local tools only — zero network, zero third-party code
execution at creation time. Dependencies are *declared* in `pyproject.toml`
at creation and *installed* later via the project's own package manager in
the **visible terminal**, user-initiated (ADR-005 class 3, verbatim). Python
can therefore ship as the first scaffold path that is clean under the pause
posture rather than gated by it.

## Design principles (all inherited, none new)

1. **Offline creation** — no network, no `uv init`/cookiecutter execution for
   templates; Litria owns its blueprints. Local env creation only
   (`python -m venv` is stdlib; `uv venv` executes a local binary, no network).
2. **Toolchain honesty** (ADR-005) — Litria detects Pythons and hints at
   install commands; it never installs an interpreter itself. The most it does
   is pre-type a command into the visible terminal for the user to run.
3. **Deps via visible terminal only** (ADR-005 class 3) — never through the
   headless scaffold channel.
4. **Never block creation on toolchain state** — a missing interpreter defers
   env creation to first open (the ADR-005 reconciler's project-open trigger);
   it does not stop the wizard.
5. **Defaults answer every question; every default is inspectable** — the
   beginner path never *requires* a choice beyond name + template; each
   defaulted choice is visible with an always-visible caption (ADR-019 style,
   no hover-only tooltips) so the wizard teaches without gating.
6. **Wizard seeds, Preferences owns** (ADR-019) — anything the wizard
   remembers (last interpreter, env engine) is re-editable later.

## The flow

### Launcher (unchanged)

`LaunchScreen` → Project button → wizard with existing seeds
(`defaultProjectLocation`, `defaultBaseTheme`, `energyLevel`). Python adds no
launcher surface. Open-existing-folder stays wizard-free (ADR-016) and
benefits from Slices 0/1/4 below — probes and pyright binding work the same
on opened folders as created ones.

### Page 0 — Identity (one addition)

Name + folder as today. When a Python archetype that produces an importable
package is selected later (Library/CLI), the Capstone shows the derived module
name (`My App` → dist name `my-app`, module `my_app`, PEP 8/503
normalization). No new input; derivation only.

### Page 1 — Stack Picker (the main new surface)

**`python` becomes a first-class runtime card** in the existing cascade
(ADR-005 §6 names the wizard the highest-traffic "trying a new language"
moment). The matrix stays the single source of truth:

```js
// compatibility-matrix.js
runtimes: {
  …,
  python: { frameworks: ['py-script', 'py-cli', 'py-lib', 'py-fastapi'] },
},
frameworks: {
  …,
  'py-script':  { languages: ['py'], addons: ['pytest', 'ruff'] },
  'py-cli':     { languages: ['py'], addons: ['pytest', 'ruff'] },
  'py-lib':     { languages: ['py'], addons: ['ruff'] },        // pytest built-in
  'py-fastapi': { languages: ['py'], addons: ['pytest', 'ruff'] },
},
```

The "framework" tier is relabeled **"Project type"** when the runtime is
Python (per-runtime section header — small wizard change). Language is locked
to Python (existing `isLanguageLocked` mechanism). The npm `manager` row is
hidden for Python and replaced by the environment strip below. Backend tier
does not render (matches Tauri/Electron behavior).

**Archetypes** (each card = one sentence of caption, mapped to the 2026
ecosystem consensus — uv's own init taxonomy plus the two most common
dependency-seeded starts):

| Card | Layout | Ships | Declared deps |
|---|---|---|---|
| **Script** *(default, auto-selected)* | flat | `main.py` (small, runnable, meaningful), `pyproject.toml` (no build-system) | none |
| **CLI app** | flat | `main.py` using **argparse** (stdlib — beginners get a dep-free runnable CLI) | none |
| **Library** | src layout | `src/<module>/__init__.py` + `py.typed`, `tests/test_<module>.py`, `[build-system]` hatchling | dev: `pytest` |
| **FastAPI service** | flat app | `main.py` hello service | `fastapi`, `uvicorn` |

Addons: **pytest** (adds `tests/` + dev-dep), **ruff** (adds `[tool.ruff]`
defaults to pyproject). Both are *file/declaration* addons — nothing installs.
Data/notebook archetype deferred (no notebook surface in Litria).

**Environment strip** (Python-only, replaces the manager row; the PyCharm
2025.3 / VS Code Quick-Create consensus shape — one visible line, expandable):

```
Environment   Python 3.13.5 (py launcher) ▾     .venv in project ▾
              "A virtual environment keeps this project's packages
               separate from your computer's Python — recommended."
```

- **Interpreter dropdown**: populated by the new probe (below); best-detected
  preselected (highest stable CPython; uv-managed counts). `Browse…` row for
  a custom path (pro escape hatch). Last-used remembered
  (remember-folder precedent, `lastProjectDir.js` style).
- **Env mode dropdown**: `.venv in project (recommended)` /
  `use interpreter directly (no environment)` / `existing environment…`
  (browse to a venv). Beginners never open it.
- **Engine** (inside expandable detail, not a top-level question): `Auto`
  (uv if detected, else stdlib venv) / `uv` / `python -m venv`. Auto is the
  VS Code `alwaysUseUv` behavior; the Capstone preview always shows which
  engine resolved.

**Empty state — no Python found**: the strip becomes an honest guidance card:
per-platform hints (Windows: PyManager via winget / python.org — the classic
installer is deprecated since 3.14; or `uv python install 3.13` when uv is
detected), a **"type it in the terminal for me"** affordance (pre-fills the
visible terminal, user presses Enter — Litria still installs nothing), and a
re-probe button. **Creation stays enabled**: proceeding creates files-only and
defers env creation to first open (Principle 4). Windows Store stub is
detected and named explicitly ("this `python` is a Store shortcut, not an
installation") instead of masquerading as a real interpreter.

### Page 2 — Shape the workspace (zero changes)

`WizardStylePreview` and all page-2 state are stack-agnostic (verified).

### Page 3 — Capstone

Review rows gain Interpreter / Environment / Project type entries. The
command preview keeps its "what you see is what runs" contract — for Python
it is a **plan**, not one CLI line:

```
write   pyproject.toml  .python-version  .gitignore  README.md  main.py
run     C:\…\python.exe -m venv .venv          (offline, ~5s)
note    # deps declared, not installed — installer offered in the terminal after open
```

The `requires-python` floor appears as an **editable review row** (owner
decision) — pre-filled from the chosen interpreter's minor, overridable
without leaving the page.

Create streams the same `ScaffoldEvent` channel as npm scaffolds:
`Writing project files… → Creating environment (.venv)… → Done`. File writes
are instant; venv is seconds (stdlib `-m venv` with pip bootstrap measured
**9.4s** on the Win10 dev machine — the progress line matters; sub-second
under uv). Failure of the env step
is **non-fatal** (project opens files-only, env pill on open); failure of
file-writing falls back to "Create as Blank instead" exactly like today.

### What gets written (the blueprint)

Common to every archetype:

- **`pyproject.toml`** — PEP 621 `[project]` (`name`, `version = "0.1.0"`,
  `requires-python = ">=3.X"` floored to the chosen interpreter's minor —
  floor-from-creation, same rule as the environment-bootstrap design), plus:
  - **`[tool.pyright]` with `venvPath = "."`, `venv = ".venv"`** — this is
    the pyright *binding fix*: pyright discovers `pyproject.toml` at
    `rootUri` natively, so venv-installed packages resolve with **zero LSP
    protocol changes** (today `initializationOptions` is `{}` and
    server-initiated `workspace/configuration` is ignored — file-based config
    sidesteps both). Only written when env mode is `.venv`.
  - `[tool.ruff]` when the ruff addon is on; `[dependency-groups]` dev =
    pytest when selected; `[build-system]` hatchling for Library only
    (declared-only — nothing executes at creation; hatchling over `uv_build`
    so the project builds regardless of engine choice).
- **`.python-version`** — chosen minor (e.g. `3.13`); the cross-tool pin
  (uv/pyenv/PyCharm/VS Code all read it).
- **`.gitignore`** — Python canon: `.venv/`, `__pycache__/`, `*.py[cod]`,
  `dist/`, `*.egg-info/`, `.pytest_cache/`, `.ruff_cache/`, `.mypy_cache/`,
  `.coverage`, `.env` (+ `.litria/`, appended by bootstrap as today).
- **`README.md`** with the run command for the chosen archetype.
- **`litria.toml`** gains its first `[environment]` section (the
  environment-bootstrap direction's first writer, and the ADR-005
  reconciler's "desired capabilities" input):

  ```toml
  [environment]
  python = ">=3.13"
  ```

  Machine-local facts (the resolved interpreter's absolute path) do NOT go in
  `litria.toml` (team-shared declaration file, stays sparse — ADR-019
  boundary). The binding lives in `.litria/workspace.db` `editor_state`
  (`env.python.interpreter`), re-validated by probe on open.

No `git init` in v1 (Litria has no git integration yet; `.gitignore` is
written so day-one `git init` by the user is clean).

### First open (where the loop closes)

1. `db_bootstrap_project` is called with the stack threaded through
   (today `language`/`framework` are silently dropped — that seam opens).
2. Created files seed canvas pieces (same mechanism as Blank's `seedFiles`) —
   the project opens with `main.py` / `pyproject.toml` / `tests/` on the
   canvas, not an empty void.
3. Pyright activates via the existing `usePythonLspLifecycle` and self-binds
   through `[tool.pyright]`.
4. **Deps pill** (no modal, ADR-005 A3 consent shape): for archetypes with
   declared deps — *"Install dependencies — runs `uv sync` in the
   terminal"* (or the `.venv` pip form when no uv). Click = user initiation:
   the terminal drawer opens and the command runs **visibly**. The same pill
   shape serves "create the environment now" when env was deferred, and it is
   the identical pipeline the reconciler will later run on any opened folder.
5. **First-run hint**: a one-time status-line affordance with the archetype's
   run command (`uv run main.py` / `.venv\Scripts\python main.py`) — the
   beginner's actual next question, answered without a tutorial.

## New machinery required (and what it deliberately reuses)

**New: interpreter probe module** (`src-tauri/src/python_probe.rs` or a
`toolchain/` sibling — first concrete instance of ADR-005's "structured
probes"). Windows: **uv enumeration when uv is on PATH** (verified 2026-07-12
on uv 0.8.0: `uv python list --only-installed --output-format json` returns
`{ key, version, version_parts, path, implementation, variant, arch }` —
non-null `path` = installed, and it discovers *system* interpreters too, not
just uv-managed ones, so on uv machines it is near-complete by itself; prefer
`variant: "default"` over `freethreaded` for the default pick) → PEP 514
registry (HKCU+HKLM) → `py list --format=json` (PyManager) falling back to
`py -0p` (legacy launcher — verified working on the dev machine) → PATH.
PEP 514 registration of uv-managed CPythons is treated as a bonus, not
load-bearing, since uv's own JSON covers them. Store-stub detection
(WindowsApps alias) as a first-class *excluded* result; "not found" is a
result, not an error; per-probe timeouts (environment-bootstrap gotchas).
macOS/Linux: PATH `python3`, pyenv, Homebrew, uv. Returns
`{ path, version, source, arch }[]` deduplicated by resolved path. Replaces
the fragile string-prefix version check for Python and feeds
`languageSupportDomain` diagnostics.

**New: `python_scaffold.rs`** — a blueprint executor, *not* new arms in the
npm-shaped `build_primary_args`. It reuses `ScaffoldStep`/`run_step_command`
(generic) and the `Channel<ScaffoldEvent>` streaming, but its input is a
declarative blueprint (files + pyproject fragments + env request), which is
exactly the shape ADR-005's future registry `scaffold` blocks and template
packs want. Wizard-side, archetype cards carry the blueprint reference the
way `flagConfig` carries flags today (ADR-012's idiom, second dialect).

**Reused untouched**: wizard chrome, page 2, `WizardStylePreview`, Channel
event plumbing, Capstone progress UI, blank-fallback, seed-pieces path,
`languageSupportDomain` activation machinery, terminal `terminal_spawn` +
`terminal_input` injection.

## Ground-prep fixes (prerequisites, standalone value today)

These bite *any* Python folder, opened or created, and should ship first:

1. **Scan ignores** (`project_tree.rs:32-47`): add `.venv`, `venv`,
   `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `.eggs`,
   `.ipynb_checkpoints`. Without this, one venv floods the scaffold drawer
   with thousands of entries (only `__pycache__` is ignored today).
2. **Blank/common `.gitignore`** gains the Python canon entries.
3. **`.pyi` → `python`** in `editorLanguage.js` (currently plaintext,
   inconsistent with `usePythonLspLifecycle`).
4. (Opportunistic) bundled pyright refresh — pin is 1.1.390; drift check
   shows 1.1.411 current. Existing pre-beta follow-up, listed here because
   the Python flow makes it user-visible.

## Slices

- **Slice 0 — Ground prep** (above; no wizard surface, ship immediately).
- **Slice 1 — Interpreter probe**: Rust probe module + Tauri command +
  `languageSupportDomain` wiring (better Python diagnostics on day one, even
  before the wizard changes).
- **Slice 2 — Wizard surface**: matrix entries, archetype/env-strip UI,
  per-runtime tier labels, command-plan preview, review rows, config payload.
- **Slice 3 — Creation backend**: `python_scaffold.rs` blueprint executor,
  venv step, `[environment]` writer, thread `language` through
  `db_bootstrap_project`, interpreter binding into `editor_state`.
- **Slice 4 — First-open affordances**: seed pieces for created files, deps
  pill → visible terminal, deferred-env pill, first-run hint; E2E verify
  pyright resolves a venv-installed package via `[tool.pyright]`.
- **Follow-ups (not v1)**: Python import discovery for canvas edges
  (`discoveryEngine` is JS/TS-only — Python projects get pieces but no
  auto-wires until this lands); conda/existing-env discovery breadth;
  data/notebook archetype; `[environment]` reconciliation on open for
  non-created projects (the full bootstrap system).

## Time-respect budget (the acceptance test)

- **Beginner**: type name → Next → click Python (Script pre-selected, env
  strip pre-resolved) → Next → Next → Create. **One typed field, five
  clicks**, ~10 seconds of wall time, and the result runs. Every skipped
  decision is visible with a caption, none demanded.
- **Pro**: same path plus optional interpreter/env/engine overrides inline on
  page 1 — no separate "advanced mode", no second dialog.
- **Nobody** is ever blocked by a missing interpreter, asked to activate a
  venv, or subjected to a hidden install.

## Decisions (owner, 2026-07-12)

1. **Deps pill semantics**: click = **run visibly**. One click; the pill
   itself names the exact command, the terminal shows the execution.
2. **uv enumeration**: **verified and adopted.** `uv python list
   --only-installed --output-format json` works with zero ceremony even on
   uv 0.8.0 (a year old at verification) — rich JSON, installed-vs-
   downloadable distinguished by `path`, system interpreters included. It is
   a primary probe source when uv is present; PEP 514 registration of
   uv-managed pythons is not relied upon.
3. **Ruff addon**: **opt-in card**, not default-on.
4. **`requires-python` floor**: **shown as an editable review row on
   Capstone**, pre-filled from the chosen interpreter's minor.
5. **Venv creation identity**: **always the concrete resolved interpreter
   path**, never `py`/`python` shims. Verified empirically 2026-07-12:
   direct-path `-m venv` on the launcher-reported 3.13.5 produced a correct
   env whose `pyvenv.cfg` records the exact home/executable/command; no
   PyManager/launcher quirk. Creation took 9.4s (stdlib, with pip bootstrap)
   on the Win10 dev machine — hence the streamed progress line.
