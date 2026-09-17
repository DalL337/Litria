// ---------------------------------------------------------------------------
// Python wizard model (ADR-020 Slice 2) — pure data + derivation helpers for
// the New Project wizard's Python path. No React, no IPC: everything here is
// unit-testable, and the wizard renders/forwards what this module derives.
//
// The real blueprint (file contents, pyproject fragments) is owned by the
// Rust side (python_scaffold.rs, Slice 3); the file lists here are the
// honest *display* of that blueprint for the plan preview and review card.
// ---------------------------------------------------------------------------

export const PYTHON_WRAPPER_ID = 'python';

export function isPythonWrapper(wrapperId) {
  return wrapperId === PYTHON_WRAPPER_ID;
}

// Archetype cards — rendered by the wizard's framework card row (the matrix
// filter selects these when the runtime is python; section label becomes
// "Project Type"). Captions are always visible (ADR-019 style).
export const PY_ARCHETYPES = [
  // `icon` is a key into src/components/wizardIcons.js (Lucide glyphs, no
  // brand marks); `ink` tints the glyph, `bg` the tile behind it.
  { id: 'py-script', name: 'Script', icon: 'file-code', ink: '#7cb4e8', bg: 'rgba(53,114,165,0.12)', desc: 'A runnable main.py — the simplest start' },
  { id: 'py-cli', name: 'CLI App', icon: 'square-terminal', ink: '#ffd43b', bg: 'rgba(255,212,59,0.10)', desc: 'Command-line tool — argparse, stdlib only' },
  { id: 'py-lib', name: 'Library', icon: 'package', ink: '#c4a6ff', bg: 'rgba(163,113,247,0.12)', desc: 'Importable package — src layout, pytest-ready' },
  { id: 'py-fastapi', name: 'FastAPI', icon: 'server', ink: '#34d399', bg: 'rgba(5,150,105,0.12)', desc: 'Web API service — deps declared, not installed' },
];

// Environment mode options. `.venv` is the recommended default; the caption
// under the strip explains why in plain English.
export const PY_ENV_MODES = [
  { id: 'venv', name: '.venv in project (recommended)' },
  { id: 'direct', name: 'Use interpreter directly — no environment' },
  { id: 'existing', name: 'Existing environment…' },
];

// Environment creation engine. Auto = uv when detected, stdlib otherwise —
// the VS Code python-envs behavior; the plan preview always shows which one
// resolved (ADR-020 owner decision).
export const PY_ENGINES = [
  { id: 'auto', name: 'Auto' },
  { id: 'uv', name: 'uv' },
  { id: 'venv', name: 'python -m venv' },
];

export const PY_ENV_CAPTION =
  'A virtual environment keeps this project’s packages separate from your '
  + 'computer’s Python — recommended.';

/**
 * Derive Python-legal names from the project name.
 * distName: PEP 503-style normalized distribution name (hyphens).
 * moduleName: PEP 8 importable module name (lowercase, underscores; a
 * leading digit gets an underscore prefix; empty input falls back safely).
 */
export function derivePythonNames(projectName) {
  const raw = (projectName ?? '').trim().toLowerCase();
  const collapsed = raw
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const distName = collapsed || 'my-app';
  let moduleName = distName.replace(/-/g, '_');
  if (/^[0-9]/.test(moduleName)) moduleName = `_${moduleName}`;
  // ADR-028 §9 (F33): a keyword cannot be imported, so it is refused with a
  // visible reason (the plan is unselectable) instead of rewritten — the
  // runner refuses the same names (python_scaffold.rs PYTHON_KEYWORDS).
  const problem = PYTHON_KEYWORDS.has(moduleName)
    ? `"${moduleName}" is a Python keyword and cannot be imported — choose another project name.`
    : null;
  return { distName, moduleName, problem };
}

/** Python's hard keywords (`keyword.kwlist`, 3.13). Lowercase module names
 *  can only collide with the lowercase ones, but the list stays complete so
 *  it mirrors the Rust side exactly. */
export const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class',
  'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global',
  'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return',
  'try', 'while', 'with', 'yield',
]);

/**
 * Why the Python plan cannot be created as it stands, or null. One place for
 * every input refusal the runner would make (ADR-028 §9): the Create button
 * carries this reason, so nothing is refused after the fact that the wizard
 * could have said up front.
 */
export function pythonPlanProblem(state) {
  if (!state.framework) return 'Pick a project type.';
  const { problem } = derivePythonNames(state.name);
  if (problem) return problem;
  const floor = state.pyRequiresFloor?.trim();
  if (floor && !isValidPythonFloor(floor)) {
    return `requires-python must look like 3.13 (digits and dots), got "${floor}".`;
  }
  if (state.pyEnvMode === 'existing' && !(state.pyExistingEnv ?? '').trim()) {
    return 'Enter the path of the existing environment.';
  }
  return null;
}

/**
 * requires-python floor from an interpreter version: "3.13.5" -> "3.13".
 * Prerelease markers are stripped ("3.14.0b4" -> "3.14"). Null when the
 * version is unknown — creation then omits requires-python rather than
 * guessing.
 */
export function derivePythonFloor(version) {
  if (typeof version !== 'string') return null;
  const match = version.trim().match(/^(\d+)\.(\d+)/);
  return match ? `${match[1]}.${match[2]}` : null;
}

/**
 * Display file list per archetype — mirrors python_scaffold.rs blueprint_files
 * (ADR-028 §4, F12): `.python-version` only when a valid requires-python
 * floor exists (the runner writes it only then), and a pytest smoke test for
 * every archetype that declares pytest (F11), not only Library.
 */
export function pythonBlueprintFiles(archetypeId, moduleName, { addons = [], floor = null } = {}) {
  const files = ['pyproject.toml'];
  if (isValidPythonFloor(floor)) files.push('.python-version');
  files.push('.gitignore', 'README.md');
  const wantsPytest = archetypeId === 'py-lib' || addons.includes('pytest');
  switch (archetypeId) {
    case 'py-lib':
      files.push(`src/${moduleName}/__init__.py`, `src/${moduleName}/py.typed`, `tests/test_${moduleName}.py`);
      break;
    case 'py-cli':
    case 'py-fastapi':
    case 'py-script':
    default:
      files.push('main.py');
      if (wantsPytest) files.push('tests/test_main.py');
  }
  return files;
}

/** Same rule as python_scaffold.rs `is_valid_floor`: digits and dots, no
 *  leading dot, no trailing dot, no empty segment. */
export function isValidPythonFloor(floor) {
  if (typeof floor !== 'string' || floor === '') return false;
  return /^[0-9]+(\.[0-9]+)*$/.test(floor);
}

/** Declared (never installed at creation) dependencies per archetype/addons. */
export function pythonDeclaredDeps(archetypeId, addons = []) {
  const deps = [];
  const devDeps = [];
  if (archetypeId === 'py-fastapi') deps.push('fastapi', 'uvicorn');
  if (archetypeId === 'py-lib' || addons.includes('pytest')) devDeps.push('pytest');
  return { deps, devDeps };
}

/**
 * Which engine actually runs for the chosen setting. Forced 'uv' stays uv
 * even when undetected (the preview stays literal; creation surfaces the
 * failure) — only 'auto' resolves by detection.
 */
export function resolvePythonEngine(engine, uvAvailable) {
  if (engine === 'uv') return 'uv';
  if (engine === 'venv') return 'venv';
  return uvAvailable ? 'uv' : 'venv';
}

function shortInterpreterLabel(interpreter) {
  if (!interpreter) return null;
  const version = interpreter.version ? `Python ${interpreter.version}` : 'Python';
  const variant = interpreter.variant === 'freethreaded' ? ' (free-threaded)' : '';
  return `${version}${variant}`;
}

/**
 * Plan preview parts for the wizard's command-preview box — a plan, not one
 * CLI line (write / run / note), keeping the "what you see is what runs"
 * contract honest for an offline scaffold.
 * `probe` = { interpreters, uvAvailable } (already-normalized shapes fine).
 */
export function buildPythonPlanPreview(state, probe) {
  if (!state.framework) return null;
  const { moduleName } = derivePythonNames(state.name);
  const files = pythonBlueprintFiles(state.framework, moduleName, { addons: state.addons, floor: state.pyRequiresFloor?.trim() });
  const parts = [
    { type: 'key', text: 'write' },
    { type: 'val', text: ` ${files.join('  ')}` },
  ];

  const selected = state.pyInterpreter
    ? (probe?.interpreters ?? []).find((i) => i.path === state.pyInterpreter) ?? null
    : null;

  if (state.pyEnvMode === 'venv') {
    const engine = resolvePythonEngine(state.pyEnvEngine, probe?.uvAvailable === true);
    if (!selected && engine !== 'uv') {
      parts.push({ type: 'comment', text: ' # no interpreter selected — environment deferred to first open' });
    } else {
      parts.push({ type: 'key', text: '\nrun' });
      parts.push({
        type: 'val',
        // Mirrors python_scaffold.rs env_command: uv never downloads an
        // interpreter on the offline path (F28).
        text: engine === 'uv'
          ? ` uv venv --no-python-downloads .venv${selected ? ` --python ${selected.path}` : ''}`
          : ` ${selected.path} -m venv .venv`,
      });
      parts.push({ type: 'comment', text: ' # offline, local only' });
    }
  } else if (state.pyEnvMode === 'existing') {
    parts.push({ type: 'comment', text: ` # uses existing environment: ${state.pyExistingEnv || '—'}` });
  } else {
    parts.push({ type: 'comment', text: ` # no environment — runs on ${shortInterpreterLabel(selected) ?? 'the selected interpreter'} directly` });
  }

  const { deps, devDeps } = pythonDeclaredDeps(state.framework, state.addons);
  if (deps.length || devDeps.length) {
    parts.push({
      type: 'comment',
      text: `\n# deps declared, not installed: ${[...deps, ...devDeps.map((d) => `${d} (dev)`)].join(', ')} — installer offered in the terminal after open`,
    });
  } else {
    parts.push({ type: 'comment', text: '\n# zero dependencies — nothing downloads, nothing executes but Python itself' });
  }
  return parts;
}

/** Review rows for the Capstone card (requires-python renders separately as
 *  an editable row — ADR-020 owner decision — so it is not in this list). */
export function buildPythonReviewRows(state, probe) {
  const archetype = PY_ARCHETYPES.find((a) => a.id === state.framework);
  const { distName, moduleName } = derivePythonNames(state.name);
  const selected = state.pyInterpreter
    ? (probe?.interpreters ?? []).find((i) => i.path === state.pyInterpreter) ?? null
    : null;

  let envLabel;
  if (state.pyEnvMode === 'venv') {
    const engine = resolvePythonEngine(state.pyEnvEngine, probe?.uvAvailable === true);
    envLabel = `.venv in project (via ${engine === 'uv' ? 'uv' : 'python -m venv'})`;
  } else if (state.pyEnvMode === 'existing') {
    envLabel = state.pyExistingEnv || 'Existing environment — not chosen yet';
  } else {
    envLabel = 'None — interpreter used directly';
  }

  const interpreterLabel = selected
    ? `${shortInterpreterLabel(selected)} — ${selected.path}`
    : 'None found — files only, environment deferred';

  const { deps, devDeps } = pythonDeclaredDeps(state.framework, state.addons);
  const toolsLabel = [
    ...(state.addons.includes('ruff') ? ['Ruff config'] : []),
    ...(state.framework === 'py-lib' || state.addons.includes('pytest') ? ['pytest (declared)'] : []),
    ...(state.framework === 'py-fastapi' ? ['FastAPI + uvicorn (declared)'] : []),
  ].join(', ') || 'None';

  const rows = [
    ['Project', state.name.trim() || 'my-app'],
    ['Location', state.folder.trim() || '—'],
    ['Project Type', archetype?.name ?? '—'],
    ['Language', 'Python'],
    ['Interpreter', interpreterLabel],
    ['Environment', envLabel],
    ['Tools', toolsLabel],
    ['Files', pythonBlueprintFiles(state.framework, moduleName, { addons: state.addons, floor: state.pyRequiresFloor?.trim() }).join(', ')],
  ];
  if (state.framework === 'py-lib' || state.framework === 'py-cli') {
    rows.splice(3, 0, ['Package · Module', `${distName} · ${moduleName}`]);
  }
  // Deliberately silent about deps beyond Tools: the plan preview carries the
  // declared-not-installed note; the review card stays scannable.
  void deps; void devDeps;
  return rows;
}

/**
 * Choose the wizard's initially-selected interpreter: the remembered one when
 * it still exists on this machine, otherwise the probe's recommended first
 * entry, otherwise null (none found — creation proceeds files-only).
 */
export function pickDefaultInterpreter(interpreters, rememberedPath) {
  // Only what creation will accept (ADR-028 §9, F31): the probe stamps the
  // shared verdict; entries it marked ineligible are never picked.
  const usable = eligibleInterpreters(interpreters);
  if (usable.length === 0) return null;
  if (rememberedPath) {
    const remembered = usable.find((i) => i.path === rememberedPath);
    if (remembered) return remembered.path;
  }
  return usable[0].path;
}

/** The probe's entries creation will accept (`eligible` false ⇒ hidden). */
export function eligibleInterpreters(interpreters) {
  if (!Array.isArray(interpreters)) return [];
  return interpreters.filter((i) => i && typeof i.path === 'string' && i.eligible !== false);
}
