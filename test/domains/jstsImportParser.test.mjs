import test from 'node:test';
import assert from 'node:assert/strict';

import { parseJsTsImports } from '../../src/app/jstsImportParser.js';

const FP = '/test/file.ts';

// ---------------------------------------------------------------------------
// Named imports
// ---------------------------------------------------------------------------

test('parses named import', () => {
  const text = "import { foo, bar } from './utils';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].moduleSpecifier, './utils');
  assert.equal(imports[0].symbols.length, 2);
  assert.equal(imports[0].symbols[0].name, 'foo');
  assert.equal(imports[0].symbols[0].kind, 'named');
  assert.equal(imports[0].symbols[1].name, 'bar');
  assert.equal(imports[0].line, 0);
  assert.equal(imports[0].isSideEffect, false);
});

test('parses named import with alias', () => {
  const text = "import { foo as myFoo } from './mod';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports[0].symbols[0].name, 'myFoo');
  assert.equal(imports[0].symbols[0].alias, 'foo');
  assert.equal(imports[0].symbols[0].kind, 'named');
});

// ---------------------------------------------------------------------------
// Default imports
// ---------------------------------------------------------------------------

test('parses default import', () => {
  const text = "import Foo from './foo';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].symbols.length, 1);
  assert.equal(imports[0].symbols[0].name, 'Foo');
  assert.equal(imports[0].symbols[0].kind, 'default');
});

test('parses default + named import', () => {
  const text = "import Default, { helper } from './mod';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports[0].symbols.length, 2);
  assert.equal(imports[0].symbols[0].name, 'Default');
  assert.equal(imports[0].symbols[0].kind, 'default');
  assert.equal(imports[0].symbols[1].name, 'helper');
  assert.equal(imports[0].symbols[1].kind, 'named');
});

// ---------------------------------------------------------------------------
// Namespace imports
// ---------------------------------------------------------------------------

test('parses namespace import', () => {
  const text = "import * as Utils from './utils';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports[0].symbols.length, 1);
  assert.equal(imports[0].symbols[0].name, 'Utils');
  assert.equal(imports[0].symbols[0].kind, 'namespace');
});

test('parses default + namespace import', () => {
  const text = "import Def, * as NS from './mod';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports[0].symbols.length, 2);
  assert.equal(imports[0].symbols[0].kind, 'default');
  assert.equal(imports[0].symbols[1].kind, 'namespace');
});

// ---------------------------------------------------------------------------
// Type imports
// ---------------------------------------------------------------------------

test('parses type-only import', () => {
  const text = "import type { Config } from './types';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports[0].isTypeOnly, true);
  assert.equal(imports[0].symbols[0].name, 'Config');
  assert.equal(imports[0].symbols[0].kind, 'type');
});

test('parses inline type import', () => {
  const text = "import { type Config, helper } from './mod';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports[0].isTypeOnly, false);
  const configSym = imports[0].symbols.find((s) => s.name === 'Config');
  const helperSym = imports[0].symbols.find((s) => s.name === 'helper');
  assert.equal(configSym.kind, 'type');
  assert.equal(helperSym.kind, 'named');
});

// ---------------------------------------------------------------------------
// Side-effect imports
// ---------------------------------------------------------------------------

test('parses side-effect import', () => {
  const text = "import './setup';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].isSideEffect, true);
  assert.equal(imports[0].symbols.length, 0);
  assert.equal(imports[0].moduleSpecifier, './setup');
});

// ---------------------------------------------------------------------------
// Multi-line imports
// ---------------------------------------------------------------------------

test('parses multi-line import', () => {
  const text = [
    'import {',
    '  alpha,',
    '  beta,',
    "} from '../lib';",
  ].join('\n');
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].symbols.length, 2);
  assert.equal(imports[0].symbols[0].name, 'alpha');
  assert.equal(imports[0].symbols[1].name, 'beta');
  assert.equal(imports[0].line, 0);
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test('skips bare specifiers (node_modules)', () => {
  const text = [
    "import React from 'react';",
    "import { useState } from 'react';",
    "import { helper } from './utils';",
  ].join('\n');
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].moduleSpecifier, './utils');
});

test('skips dynamic import()', () => {
  const text = "const mod = import('./lazy');";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports.length, 0);
});

test('skips imports inside comments', () => {
  const text = [
    "// import { foo } from './foo';",
    "/* import { bar } from './bar'; */",
    "import { real } from './real';",
  ].join('\n');
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].symbols[0].name, 'real');
});

// ---------------------------------------------------------------------------
// Multiple imports
// ---------------------------------------------------------------------------

test('parses multiple imports from different files', () => {
  const text = [
    "import { a } from './a';",
    "import { b } from './b';",
    "import { c } from './c';",
  ].join('\n');
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports.length, 3);
  assert.equal(imports[0].moduleSpecifier, './a');
  assert.equal(imports[1].moduleSpecifier, './b');
  assert.equal(imports[2].moduleSpecifier, './c');
});

// ---------------------------------------------------------------------------
// Line numbers
// ---------------------------------------------------------------------------

test('line numbers are 0-indexed', () => {
  const text = [
    '// comment',
    "import { foo } from './foo';",
    '',
    "import { bar } from './bar';",
  ].join('\n');
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports[0].line, 1);
  assert.equal(imports[1].line, 3);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test('handles double-quote specifiers', () => {
  const text = 'import { foo } from "./utils";';
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports[0].moduleSpecifier, './utils');
});

test('handles imports without semicolons', () => {
  const text = "import { foo } from './utils'";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].moduleSpecifier, './utils');
});

test('handles empty file', () => {
  assert.deepEqual(parseJsTsImports('', FP), []);
});

test('handles parent directory specifier', () => {
  const text = "import { foo } from '../lib/utils';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports[0].moduleSpecifier, '../lib/utils');
});

test('handles absolute specifier', () => {
  const text = "import { foo } from '/root/lib/utils';";
  const imports = parseJsTsImports(text, FP);
  assert.equal(imports.length, 1);
  assert.equal(imports[0].moduleSpecifier, '/root/lib/utils');
});
