import test from 'node:test';
import assert from 'node:assert/strict';

import { discoverProjectEdges } from '../../src/app/discoveryEngine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProject(files) {
  const filePaths = Object.keys(files);
  const readFile = (path) => files[path] ?? null;
  return { projectRoot: '/project', filePaths, readFile };
}

// ---------------------------------------------------------------------------
// Basic discovery
// ---------------------------------------------------------------------------

test('discovers edge from simple import', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/utils.js': 'export function helper() {}',
    '/project/src/app.js': "import { helper } from './utils';",
  }));

  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceFilePath, '/project/src/utils.js');
  assert.equal(edges[0].targetFilePath, '/project/src/app.js');
  assert.equal(edges[0].moduleSpecifier, './utils');
  assert.equal(edges[0].symbols.length, 1);
  assert.equal(edges[0].symbols[0].name, 'helper');
  assert.equal(edges[0].symbols[0].kind, 'named');
});

test('discovers multiple edges from same file', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/a.js': 'export const A = 1;',
    '/project/src/b.js': 'export const B = 2;',
    '/project/src/app.js': [
      "import { A } from './a';",
      "import { B } from './b';",
    ].join('\n'),
  }));

  assert.equal(edges.length, 2);
  assert.ok(edges.some((e) => e.sourceFilePath === '/project/src/a.js'));
  assert.ok(edges.some((e) => e.sourceFilePath === '/project/src/b.js'));
});

test('discovers edges between multiple files (circular)', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/a.js': "import { b } from './b';\nexport const a = 1;",
    '/project/src/b.js': "import { a } from './a';\nexport const b = 2;",
  }));

  assert.equal(edges.length, 2);
  assert.ok(edges.some((e) => e.sourceFilePath === '/project/src/b.js' && e.targetFilePath === '/project/src/a.js'));
  assert.ok(edges.some((e) => e.sourceFilePath === '/project/src/a.js' && e.targetFilePath === '/project/src/b.js'));
});

// ---------------------------------------------------------------------------
// Extension resolution
// ---------------------------------------------------------------------------

test('resolves import without extension (tries .js)', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/utils.js': 'export const X = 1;',
    '/project/src/app.js': "import { X } from './utils';",
  }));

  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceFilePath, '/project/src/utils.js');
});

test('resolves import without extension (tries .ts)', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/utils.ts': 'export const X = 1;',
    '/project/src/app.ts': "import { X } from './utils';",
  }));

  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceFilePath, '/project/src/utils.ts');
});

test('resolves import without extension (tries .tsx)', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/Widget.tsx': 'export default function Widget() {}',
    '/project/src/app.tsx': "import Widget from './Widget';",
  }));

  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceFilePath, '/project/src/Widget.tsx');
});

test('resolves directory import with index file', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/lib/index.js': 'export const lib = 1;',
    '/project/src/app.js': "import { lib } from './lib';",
  }));

  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceFilePath, '/project/src/lib/index.js');
});

test('resolves parent directory import', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/utils.js': 'export const X = 1;',
    '/project/src/sub/app.js': "import { X } from '../utils';",
  }));

  assert.equal(edges.length, 1);
  assert.equal(edges[0].sourceFilePath, '/project/src/utils.js');
});

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

test('skips unresolvable imports', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/app.js': "import { missing } from './nonexistent';",
  }));

  assert.equal(edges.length, 0);
});

test('skips bare specifiers (node_modules)', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/app.js': [
      "import React from 'react';",
      "import { helper } from './utils.js';",
    ].join('\n'),
    '/project/src/utils.js': 'export function helper() {}',
  }));

  assert.equal(edges.length, 1);
  assert.equal(edges[0].moduleSpecifier, './utils.js');
});

test('skips side-effect imports', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/setup.js': 'console.log("init");',
    '/project/src/app.js': "import './setup.js';",
  }));

  assert.equal(edges.length, 0);
});

// ---------------------------------------------------------------------------
// Multiple symbols
// ---------------------------------------------------------------------------

test('captures multiple imported symbols', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/utils.js': 'export function a() {}\nexport function b() {}',
    '/project/src/app.js': "import { a, b } from './utils';",
  }));

  assert.equal(edges.length, 1);
  assert.equal(edges[0].symbols.length, 2);
  assert.ok(edges[0].symbols.some((s) => s.name === 'a'));
  assert.ok(edges[0].symbols.some((s) => s.name === 'b'));
});

test('captures default import symbol', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/mod.js': 'export default function main() {}',
    '/project/src/app.js': "import main from './mod';",
  }));

  assert.equal(edges[0].symbols[0].kind, 'default');
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test('reports unreadable file as error', () => {
  const { edges, errors } = discoverProjectEdges({
    projectRoot: '/project',
    filePaths: ['/project/src/missing.js'],
    readFile: () => null,
  });

  assert.equal(edges.length, 0);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].includes('Could not read'));
});

test('handles empty project', () => {
  const { edges, errors } = discoverProjectEdges({
    projectRoot: '/project',
    filePaths: [],
    readFile: () => null,
  });

  assert.equal(edges.length, 0);
  assert.equal(errors.length, 0);
});

// ---------------------------------------------------------------------------
// Line tracking
// ---------------------------------------------------------------------------

test('preserves import line number', () => {
  const { edges } = discoverProjectEdges(makeProject({
    '/project/src/utils.js': 'export const X = 1;',
    '/project/src/app.js': [
      '// top comment',
      '',
      "import { X } from './utils';",
    ].join('\n'),
  }));

  assert.equal(edges[0].importLine, 2);
});
