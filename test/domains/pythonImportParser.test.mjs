import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePythonImports } from '../../src/app/pythonImportParser.js';

test('plain imports: one statement per module, aliases bind the local name', () => {
  const stmts = parsePythonImports('import os\nimport app.models\nimport numpy as np, app.utils\n');
  assert.equal(stmts.length, 4);
  assert.deepEqual(stmts[0], {
    kind: 'import', moduleSpecifier: 'os', relativeLevel: 0,
    symbols: [{ name: 'os', alias: null, kind: 'module' }], line: 0,
  });
  assert.equal(stmts[1].moduleSpecifier, 'app.models');
  assert.equal(stmts[1].symbols[0].name, 'app'); // `import a.b` binds `a`
  assert.equal(stmts[2].moduleSpecifier, 'numpy');
  assert.deepEqual(stmts[2].symbols, [{ name: 'np', alias: 'numpy', kind: 'module' }]);
  assert.equal(stmts[3].moduleSpecifier, 'app.utils');
});

test('from imports: names, aliases, star', () => {
  const stmts = parsePythonImports(
    'from app.models import User, Role as R\nfrom helpers import *\n'
  );
  assert.equal(stmts.length, 2);
  assert.equal(stmts[0].kind, 'from');
  assert.equal(stmts[0].moduleSpecifier, 'app.models');
  assert.deepEqual(stmts[0].symbols, [
    { name: 'User', alias: null, kind: 'named' },
    { name: 'R', alias: 'Role', kind: 'named' },
  ]);
  assert.deepEqual(stmts[1].symbols, [{ name: '*', alias: null, kind: 'star' }]);
});

test('relative imports carry the dot level; pure-relative has empty specifier', () => {
  const stmts = parsePythonImports(
    'from . import sibling\nfrom .utils import helper\nfrom ..pkg.mod import Thing\n'
  );
  assert.equal(stmts[0].relativeLevel, 1);
  assert.equal(stmts[0].moduleSpecifier, '');
  assert.equal(stmts[0].symbols[0].name, 'sibling');
  assert.equal(stmts[1].relativeLevel, 1);
  assert.equal(stmts[1].moduleSpecifier, 'utils');
  assert.equal(stmts[2].relativeLevel, 2);
  assert.equal(stmts[2].moduleSpecifier, 'pkg.mod');
});

test('parenthesized multi-line and backslash continuations join into one statement', () => {
  const stmts = parsePythonImports(
    'from app.models import (\n    User,\n    Role,  # trailing comment\n)\n'
    + 'from app.utils import helper, \\\n    formatter\n'
  );
  assert.equal(stmts.length, 2);
  assert.deepEqual(stmts[0].symbols.map((s) => s.name), ['User', 'Role']);
  assert.equal(stmts[0].line, 0);
  assert.deepEqual(stmts[1].symbols.map((s) => s.name), ['helper', 'formatter']);
});

test('comments, docstrings, and __future__ produce no statements', () => {
  const stmts = parsePythonImports(
    '# import fake\n'
    + '"""\nimport also_fake\nfrom nowhere import nothing\n"""\n'
    + 'from __future__ import annotations\n'
    + 'import __future__\n'
    + 'import real\n'
  );
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0].moduleSpecifier, 'real');
});

test('single-line docstrings do not open a string block', () => {
  const stmts = parsePythonImports('"""One-line docstring."""\nimport real\n');
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0].moduleSpecifier, 'real');
});

test('indented (function-level) imports are found', () => {
  const stmts = parsePythonImports('def lazy():\n    import app.heavy\n    return app.heavy\n');
  assert.equal(stmts.length, 1);
  assert.equal(stmts[0].moduleSpecifier, 'app.heavy');
  assert.equal(stmts[0].line, 1);
});

test('unparseable clauses drop entries instead of guessing', () => {
  // `from x import (a` unterminated at EOF, and garbage entries.
  const stmts = parsePythonImports('from app import ok, 123bad\n');
  assert.equal(stmts.length, 1);
  assert.deepEqual(stmts[0].symbols.map((s) => s.name), ['ok']);
});
