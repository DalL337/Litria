import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parsePyprojectSummary,
  decidePythonFirstOpen,
  buildPythonOfferCommand,
  buildPythonOfferMessage,
  PY_FIRST_OPEN_FLAGS,
} from '../../src/scaffold/pythonFirstOpenModel.js';

// Representative outputs of python_scaffold.rs blueprints — the common case
// this parser exists for.
const SCRIPT_PYPROJECT = `[project]
name = "demo-app"
version = "0.1.0"
description = "A Python project"
readme = "README.md"
requires-python = ">=3.13"
dependencies = []

[tool.pyright]
venvPath = "."
venv = ".venv"
`;

const FASTAPI_PYPROJECT = `[project]
name = "svc"
version = "0.1.0"
dependencies = [
    "fastapi",
    "uvicorn",
]

[dependency-groups]
dev = ["pytest"]

[tool.pyright]
venvPath = "."
venv = ".venv"
`;

const LIB_PYPROJECT = `[project]
name = "mylib"
version = "0.1.0"
dependencies = []

[dependency-groups]
dev = ["pytest"]

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.pyright]
venvPath = "."
venv = ".venv"
`;

test('parsePyprojectSummary reads deps, dev groups, pyright venv, build system', () => {
  const script = parsePyprojectSummary(SCRIPT_PYPROJECT);
  assert.deepEqual(script.deps, []);
  assert.deepEqual(script.devDeps, []);
  assert.equal(script.expectsVenv, true);
  assert.equal(script.hasBuildSystem, false);

  const fastapi = parsePyprojectSummary(FASTAPI_PYPROJECT);
  assert.deepEqual(fastapi.deps, ['fastapi', 'uvicorn']);
  assert.deepEqual(fastapi.devDeps, ['pytest']);

  const lib = parsePyprojectSummary(LIB_PYPROJECT);
  assert.equal(lib.hasBuildSystem, true);
  assert.deepEqual(lib.devDeps, ['pytest']);
});

test('parsePyprojectSummary returns null for missing/non-project files', () => {
  assert.equal(parsePyprojectSummary(null), null);
  assert.equal(parsePyprojectSummary(''), null);
  assert.equal(parsePyprojectSummary('[tool.something]\nkey = 1\n'), null);
});

test('decidePythonFirstOpen priority: env > deps > first-run, gated by flags', () => {
  const fastapi = parsePyprojectSummary(FASTAPI_PYPROJECT);
  // Env missing wins even when deps exist.
  assert.equal(decidePythonFirstOpen({ summary: fastapi, venvExists: false, flags: {} }), 'create-env');
  // Env present → deps offer.
  assert.equal(decidePythonFirstOpen({ summary: fastapi, venvExists: true, flags: {} }), 'install-deps');
  // Actioned flags silence each tier.
  assert.equal(
    decidePythonFirstOpen({ summary: fastapi, venvExists: false, flags: { 'create-env': true } }),
    null,
    'deps offer requires the env to exist'
  );
  assert.equal(
    decidePythonFirstOpen({ summary: fastapi, venvExists: true, flags: { 'install-deps': true } }),
    null
  );

  const script = parsePyprojectSummary(SCRIPT_PYPROJECT);
  assert.equal(decidePythonFirstOpen({ summary: script, venvExists: true, flags: {} }), 'first-run');
  assert.equal(
    decidePythonFirstOpen({ summary: script, venvExists: true, flags: { 'first-run': true } }),
    null
  );

  // Library: dep-having (dev pytest), so never a bare first-run hint.
  const lib = parsePyprojectSummary(LIB_PYPROJECT);
  assert.equal(decidePythonFirstOpen({ summary: lib, venvExists: true, flags: {} }), 'install-deps');

  assert.equal(decidePythonFirstOpen({ summary: null, venvExists: true, flags: {} }), null);
});

test('buildPythonOfferCommand: create-env prefers uv, falls back to interpreter, else no pill', () => {
  const summary = parsePyprojectSummary(SCRIPT_PYPROJECT);
  const uv = buildPythonOfferCommand({
    kind: 'create-env', summary, uvAvailable: true,
    interpreterPath: 'C:\\Py\\python.exe', isWindows: true,
  });
  assert.equal(uv.command, 'uv venv .venv --python "C:\\Py\\python.exe"');

  const stdlib = buildPythonOfferCommand({
    kind: 'create-env', summary, uvAvailable: false,
    interpreterPath: 'C:\\Py\\python.exe', isWindows: true,
  });
  assert.equal(stdlib.command, '& "C:\\Py\\python.exe" -m venv .venv');

  const unix = buildPythonOfferCommand({
    kind: 'create-env', summary, uvAvailable: false,
    interpreterPath: '/usr/bin/python3', isWindows: false,
  });
  assert.equal(unix.command, '"/usr/bin/python3" -m venv .venv');

  // Toolchain honesty: nothing runnable → no fabricated command.
  assert.equal(
    buildPythonOfferCommand({ kind: 'create-env', summary, uvAvailable: false, interpreterPath: null, isWindows: true }),
    null
  );
});

test('buildPythonOfferCommand: install-deps uses uv sync, pip fallback per layout', () => {
  const fastapi = parsePyprojectSummary(FASTAPI_PYPROJECT);
  assert.equal(
    buildPythonOfferCommand({ kind: 'install-deps', summary: fastapi, uvAvailable: true, interpreterPath: null, isWindows: true }).command,
    'uv sync'
  );
  assert.equal(
    buildPythonOfferCommand({ kind: 'install-deps', summary: fastapi, uvAvailable: false, interpreterPath: null, isWindows: true }).command,
    '& ".venv\\Scripts\\python.exe" -m pip install fastapi uvicorn pytest'
  );

  // Library (build system) installs editable + dev deps.
  const lib = parsePyprojectSummary(LIB_PYPROJECT);
  assert.equal(
    buildPythonOfferCommand({ kind: 'install-deps', summary: lib, uvAvailable: false, interpreterPath: null, isWindows: false }).command,
    '".venv/bin/python" -m pip install -e . pytest'
  );
});

test('buildPythonOfferCommand: first-run points at main.py through the env', () => {
  const summary = parsePyprojectSummary(SCRIPT_PYPROJECT);
  assert.equal(
    buildPythonOfferCommand({ kind: 'first-run', summary, uvAvailable: true, interpreterPath: null, isWindows: true }).command,
    'uv run main.py'
  );
  assert.equal(
    buildPythonOfferCommand({ kind: 'first-run', summary, uvAvailable: false, interpreterPath: null, isWindows: false }).command,
    '".venv/bin/python" main.py'
  );
});

test('offer messages name the exact command (pill honesty)', () => {
  assert.equal(
    buildPythonOfferMessage('install-deps', 'uv sync'),
    'Install dependencies — runs uv sync in the terminal'
  );
  assert.equal(
    buildPythonOfferMessage('create-env', 'uv venv .venv'),
    'Finish Python setup — runs uv venv .venv in the terminal'
  );
  assert.equal(
    buildPythonOfferMessage('first-run', 'python main.py'),
    'Try it — runs python main.py in the terminal'
  );
});

test('flag keys are stable editor_state identifiers', () => {
  assert.deepEqual(PY_FIRST_OPEN_FLAGS, {
    'create-env': 'hint.python.envOffered',
    'install-deps': 'hint.python.depsOffered',
    'first-run': 'hint.python.firstRunShown',
  });
});
