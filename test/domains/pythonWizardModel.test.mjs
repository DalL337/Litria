import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PY_ARCHETYPES,
  derivePythonNames,
  derivePythonFloor,
  pythonBlueprintFiles,
  isValidPythonFloor,
  pythonDeclaredDeps,
  resolvePythonEngine,
  buildPythonPlanPreview,
  buildPythonReviewRows,
  pickDefaultInterpreter,
  eligibleInterpreters,
  pythonPlanProblem,
  PYTHON_KEYWORDS,
  isPythonWrapper,
} from '../../src/scaffold/pythonWizardModel.js';
import { getFrameworks, getLanguages, getAddons, isLanguageLocked } from '../../src/scaffold/compatibility-matrix.js';

// ---------------------------------------------------------------------------
// Compatibility matrix — python entries drive the cascade
// ---------------------------------------------------------------------------

test('matrix exposes the python runtime with all four archetypes', () => {
  const archetypes = getFrameworks('python');
  assert.deepEqual(archetypes, ['py-script', 'py-cli', 'py-lib', 'py-fastapi']);
  // Every matrix archetype has a presentation card, and vice versa.
  assert.deepEqual(PY_ARCHETYPES.map((a) => a.id), archetypes);
});

test('matrix locks every python archetype to the py language', () => {
  for (const id of getFrameworks('python')) {
    assert.deepEqual(getLanguages(id), ['py'], id);
    assert.equal(isLanguageLocked(id), 'py', id);
  }
});

test('matrix scopes python addons: declaration-only tools, no JS addons; py-lib omits pytest', () => {
  assert.deepEqual(getAddons('py-script'), ['pytest', 'ruff']);
  assert.deepEqual(getAddons('py-lib'), ['ruff']);
  // JS addons must never leak into python archetypes and vice versa.
  assert.ok(!getAddons('py-fastapi').includes('tailwind'));
  assert.ok(!getAddons('react').includes('pytest'));
});

// ---------------------------------------------------------------------------
// Name derivation (PEP 503 dist name / PEP 8 module name)
// ---------------------------------------------------------------------------

test('derivePythonNames normalizes project names to dist + module names', () => {
  assert.deepEqual(derivePythonNames('My App'), { distName: 'my-app', moduleName: 'my_app', problem: null });
  assert.deepEqual(derivePythonNames('data--Cruncher!'), { distName: 'data-cruncher', moduleName: 'data_cruncher', problem: null });
  // Leading digit gets an underscore prefix (modules cannot start with one).
  assert.equal(derivePythonNames('3d-tools').moduleName, '_3d_tools');
  // Degenerate input falls back instead of producing an empty name.
  assert.deepEqual(derivePythonNames('!!!'), { distName: 'my-app', moduleName: 'my_app', problem: null });
  assert.deepEqual(derivePythonNames(''), { distName: 'my-app', moduleName: 'my_app', problem: null });
});

test('derivePythonNames refuses Python keywords with a visible reason (F33)', () => {
  // ADR-028 §9: `from class import __version__` is a SyntaxError, so the
  // name is refused, not rewritten; the runner refuses the same list.
  for (const word of ['class', 'Import', 'FOR', 'lambda', 'yield', 'async']) {
    const { moduleName, problem } = derivePythonNames(word);
    assert.equal(moduleName, word.toLowerCase());
    assert.match(problem, new RegExp(`"${word.toLowerCase()}" is a Python keyword`), word);
  }
  assert.equal(derivePythonNames('none').problem, null, 'lowercase none is not the keyword None');
  assert.equal(derivePythonNames('classes').problem, null);
  // A trailing underscore is stripped by normalization, so "class_" still
  // derives "class" — the fix is a different project name, e.g. "class app".
  assert.equal(derivePythonNames('class_').moduleName, 'class');
  assert.notEqual(derivePythonNames('class_').problem, null);
  assert.deepEqual(derivePythonNames('class app'), { distName: 'class-app', moduleName: 'class_app', problem: null });
  assert.equal(PYTHON_KEYWORDS.size, 35, 'keyword.kwlist for Python 3.13');
});

test('pythonPlanProblem names every refusal the runner would make (F32, F33, F36)', () => {
  const ok = { framework: 'py-script', name: 'demo', pyRequiresFloor: '3.13', pyEnvMode: 'venv', pyExistingEnv: '' };
  assert.equal(pythonPlanProblem(ok), null);
  assert.equal(pythonPlanProblem({ ...ok, framework: null }), 'Pick a project type.');
  assert.match(pythonPlanProblem({ ...ok, name: 'import' }), /"import" is a Python keyword/);
  assert.match(pythonPlanProblem({ ...ok, pyRequiresFloor: '3.13.' }), /requires-python must look like 3\.13 .* got "3\.13\."/);
  assert.match(pythonPlanProblem({ ...ok, pyRequiresFloor: 'abc' }), /got "abc"/);
  assert.equal(pythonPlanProblem({ ...ok, pyRequiresFloor: '' }), null, 'an empty floor is omitted, not refused');
  assert.equal(pythonPlanProblem({ ...ok, pyRequiresFloor: null }), null);
  assert.equal(pythonPlanProblem({ ...ok, pyEnvMode: 'existing', pyExistingEnv: '  ' }), 'Enter the path of the existing environment.');
  assert.equal(pythonPlanProblem({ ...ok, pyEnvMode: 'existing', pyExistingEnv: 'C:\\envs\\shared' }), null);
});

// ---------------------------------------------------------------------------
// requires-python floor
// ---------------------------------------------------------------------------

test('derivePythonFloor keeps major.minor and strips patch/prerelease', () => {
  assert.equal(derivePythonFloor('3.13.5'), '3.13');
  assert.equal(derivePythonFloor('3.14.0b4'), '3.14');
  assert.equal(derivePythonFloor('3.9'), '3.9');
  assert.equal(derivePythonFloor(undefined), null);
  assert.equal(derivePythonFloor('garbage'), null);
});

// ---------------------------------------------------------------------------
// Blueprint display lists + declared deps
// ---------------------------------------------------------------------------

test('blueprint files: flat for script/cli/fastapi, src layout for library', () => {
  assert.ok(pythonBlueprintFiles('py-script', 'my_app').includes('main.py'));
  const lib = pythonBlueprintFiles('py-lib', 'my_app');
  assert.ok(lib.includes('src/my_app/__init__.py'));
  assert.ok(lib.includes('src/my_app/py.typed'));
  assert.ok(lib.includes('tests/test_my_app.py'));
  assert.ok(!lib.includes('main.py'));
  for (const id of ['py-script', 'py-cli', 'py-lib', 'py-fastapi']) {
    const files = pythonBlueprintFiles(id, 'm', { floor: '3.13' });
    for (const f of ['pyproject.toml', '.python-version', '.gitignore', 'README.md']) {
      assert.ok(files.includes(f), `${id} missing ${f}`);
    }
  }
});

test('blueprint files: .python-version only with a valid floor — the runner writes it only then (F12)', () => {
  assert.ok(!pythonBlueprintFiles('py-script', 'm').includes('.python-version'));
  assert.ok(!pythonBlueprintFiles('py-script', 'm', { floor: '' }).includes('.python-version'));
  assert.ok(!pythonBlueprintFiles('py-script', 'm', { floor: '3.' }).includes('.python-version'));
  assert.ok(!pythonBlueprintFiles('py-script', 'm', { floor: 'abc' }).includes('.python-version'));
  assert.ok(pythonBlueprintFiles('py-script', 'm', { floor: '3.13' }).includes('.python-version'));
  assert.equal(isValidPythonFloor('3.13'), true);
  assert.equal(isValidPythonFloor('3..13'), false);
  assert.equal(isValidPythonFloor('.13'), false);
});

test('blueprint files: pytest add-on ships a smoke test for every archetype, not only Library (F11)', () => {
  for (const id of ['py-script', 'py-cli', 'py-fastapi']) {
    assert.ok(!pythonBlueprintFiles(id, 'm').includes('tests/test_main.py'), `${id} without pytest`);
    assert.ok(pythonBlueprintFiles(id, 'm', { addons: ['pytest'] }).includes('tests/test_main.py'), `${id} with pytest`);
  }
  assert.ok(pythonBlueprintFiles('py-lib', 'm').includes('tests/test_m.py'), 'library is pytest-ready by definition');
});

test('declared deps: fastapi brings runtime deps, pytest is a dev dep, script has none', () => {
  assert.deepEqual(pythonDeclaredDeps('py-script', []), { deps: [], devDeps: [] });
  assert.deepEqual(pythonDeclaredDeps('py-fastapi', []), { deps: ['fastapi', 'uvicorn'], devDeps: [] });
  // Library is pytest-ready by definition; the addon adds it elsewhere.
  assert.deepEqual(pythonDeclaredDeps('py-lib', []).devDeps, ['pytest']);
  assert.deepEqual(pythonDeclaredDeps('py-cli', ['pytest']).devDeps, ['pytest']);
});

// ---------------------------------------------------------------------------
// Engine resolution + plan preview honesty
// ---------------------------------------------------------------------------

test('resolvePythonEngine: auto follows uv detection, explicit choices stay literal', () => {
  assert.equal(resolvePythonEngine('auto', true), 'uv');
  assert.equal(resolvePythonEngine('auto', false), 'venv');
  assert.equal(resolvePythonEngine('uv', false), 'uv');
  assert.equal(resolvePythonEngine('venv', true), 'venv');
});

const BASE_STATE = {
  name: 'demo',
  folder: 'C:\\proj',
  wrapper: 'python',
  framework: 'py-script',
  addons: [],
  pyInterpreter: 'C:\\Py\\python.exe',
  pyEnvMode: 'venv',
  pyEnvEngine: 'auto',
  pyExistingEnv: '',
  pyRequiresFloor: '3.13',
};
const BASE_PROBE = {
  interpreters: [{ path: 'C:\\Py\\python.exe', version: '3.13.5', source: 'uv', variant: 'default' }],
  excluded: [],
  uvAvailable: false,
};

test('plan preview shows the exact venv command for the resolved engine', () => {
  const stdlib = buildPythonPlanPreview(BASE_STATE, BASE_PROBE);
  const stdlibText = stdlib.map((p) => p.text).join('');
  assert.match(stdlibText, /C:\\Py\\python\.exe -m venv \.venv/);
  assert.match(stdlibText, /zero dependencies/);

  const uv = buildPythonPlanPreview(BASE_STATE, { ...BASE_PROBE, uvAvailable: true });
  // F28: the preview shows the exact flags creation runs — downloads off.
  assert.match(uv.map((p) => p.text).join(''), /uv venv --no-python-downloads \.venv --python C:\\Py\\python\.exe/);
});

test('plan preview defers the environment when no interpreter exists', () => {
  const state = { ...BASE_STATE, pyInterpreter: null };
  const probe = { interpreters: [], excluded: [], uvAvailable: false };
  const text = buildPythonPlanPreview(state, probe).map((p) => p.text).join('');
  assert.match(text, /environment deferred to first open/);
  assert.ok(!text.includes('-m venv'), 'must not show a venv command it cannot run');
});

test('plan preview names declared deps and the visible-terminal handoff', () => {
  const state = { ...BASE_STATE, framework: 'py-fastapi', addons: ['pytest'] };
  const text = buildPythonPlanPreview(state, BASE_PROBE).map((p) => p.text).join('');
  assert.match(text, /deps declared, not installed: fastapi, uvicorn, pytest \(dev\)/);
  assert.match(text, /installer offered in the terminal after open/);
});

// ---------------------------------------------------------------------------
// Review rows
// ---------------------------------------------------------------------------

test('review rows describe interpreter, environment, and tools honestly', () => {
  const rows = Object.fromEntries(buildPythonReviewRows(BASE_STATE, BASE_PROBE));
  assert.equal(rows['Project Type'], 'Script');
  assert.equal(rows.Language, 'Python');
  assert.match(rows.Interpreter, /Python 3\.13\.5 — C:\\Py\\python\.exe/);
  assert.match(rows.Environment, /\.venv in project \(via python -m venv\)/);
  assert.equal(rows.Tools, 'None');
});

test('review rows surface the files-only fallback and module naming for libraries', () => {
  const state = { ...BASE_STATE, name: 'My Lib', framework: 'py-lib', pyInterpreter: null };
  const rows = Object.fromEntries(
    buildPythonReviewRows(state, { interpreters: [], excluded: [], uvAvailable: true })
  );
  assert.match(rows.Interpreter, /None found — files only/);
  assert.equal(rows['Package · Module'], 'my-lib · my_lib');
  assert.match(rows.Environment, /via uv/);
  assert.match(rows.Tools, /pytest \(declared\)/);
});

// ---------------------------------------------------------------------------
// Default interpreter pick
// ---------------------------------------------------------------------------

test('pickDefaultInterpreter prefers a still-present remembered path, else the first entry', () => {
  const list = [{ path: 'A' }, { path: 'B' }];
  assert.equal(pickDefaultInterpreter(list, 'B'), 'B');
  assert.equal(pickDefaultInterpreter(list, 'gone'), 'A');
  assert.equal(pickDefaultInterpreter(list, undefined), 'A');
  assert.equal(pickDefaultInterpreter([], 'B'), null);
});

test('pickDefaultInterpreter and eligibleInterpreters skip entries the probe marked ineligible (F31)', () => {
  const list = [
    { path: 'A', eligible: false, ineligibleReason: 'not found on disk' },
    { path: 'B', eligible: true },
    { path: 'C' },
  ];
  assert.deepEqual(eligibleInterpreters(list).map((i) => i.path), ['B', 'C'], 'absent flag means eligible (older reports)');
  assert.equal(pickDefaultInterpreter(list, 'A'), 'B', 'a remembered but ineligible path is not restored');
  assert.equal(pickDefaultInterpreter(list, 'C'), 'C');
  assert.equal(pickDefaultInterpreter([{ path: 'A', eligible: false }], undefined), null);
  assert.deepEqual(eligibleInterpreters(null), []);
});

test('isPythonWrapper matches only the python runtime id', () => {
  assert.equal(isPythonWrapper('python'), true);
  assert.equal(isPythonWrapper('web'), false);
  assert.equal(isPythonWrapper(null), false);
});
