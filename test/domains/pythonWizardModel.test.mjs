import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PY_ARCHETYPES,
  derivePythonNames,
  derivePythonFloor,
  pythonBlueprintFiles,
  pythonDeclaredDeps,
  resolvePythonEngine,
  buildPythonPlanPreview,
  buildPythonReviewRows,
  pickDefaultInterpreter,
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
  assert.deepEqual(derivePythonNames('My App'), { distName: 'my-app', moduleName: 'my_app' });
  assert.deepEqual(derivePythonNames('data--Cruncher!'), { distName: 'data-cruncher', moduleName: 'data_cruncher' });
  // Leading digit gets an underscore prefix (modules cannot start with one).
  assert.equal(derivePythonNames('3d-tools').moduleName, '_3d_tools');
  // Degenerate input falls back instead of producing an empty name.
  assert.deepEqual(derivePythonNames('!!!'), { distName: 'my-app', moduleName: 'my_app' });
  assert.deepEqual(derivePythonNames(''), { distName: 'my-app', moduleName: 'my_app' });
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
    const files = pythonBlueprintFiles(id, 'm');
    for (const f of ['pyproject.toml', '.python-version', '.gitignore', 'README.md']) {
      assert.ok(files.includes(f), `${id} missing ${f}`);
    }
  }
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
  assert.match(uv.map((p) => p.text).join(''), /uv venv \.venv --python C:\\Py\\python\.exe/);
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

test('isPythonWrapper matches only the python runtime id', () => {
  assert.equal(isPythonWrapper('python'), true);
  assert.equal(isPythonWrapper('web'), false);
  assert.equal(isPythonWrapper(null), false);
});
