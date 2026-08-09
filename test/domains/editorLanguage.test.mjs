import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getLanguageFromFilename,
  getLspLanguageIdFromFilename,
  getManagedSessionLanguageFromFilename,
} from '../../src/editor/editorLanguage.js';

test('editor language resolver maps JS variants to javascript', () => {
  assert.equal(getLanguageFromFilename('src/index.js'), 'javascript');
  assert.equal(getLanguageFromFilename('src/index.jsx'), 'javascript');
  assert.equal(getLanguageFromFilename('src/index.mjs'), 'javascript');
  assert.equal(getLanguageFromFilename('src/index.cjs'), 'javascript');
});

test('editor language resolver maps TS variants to typescript', () => {
  assert.equal(getLanguageFromFilename('src/index.ts'), 'typescript');
  assert.equal(getLanguageFromFilename('src/index.tsx'), 'typescript');
  assert.equal(getLanguageFromFilename('src/index.mts'), 'typescript');
  assert.equal(getLanguageFromFilename('src/index.cts'), 'typescript');
});

test('editor language resolver falls back to plaintext for unknown files', () => {
  assert.equal(getLanguageFromFilename('src/readme.unknown'), 'plaintext');
  assert.equal(getLanguageFromFilename(''), 'plaintext');
});

test('editor language resolver maps Python sources AND stubs to python', () => {
  // .pyi previously fell through to plaintext while usePythonLspLifecycle
  // treated it as Python — the lifecycle would start pyright for a file
  // Monaco rendered as plain text (ADR-020 Slice 0 consistency fix).
  assert.equal(getLanguageFromFilename('src/app.py'), 'python');
  assert.equal(getLanguageFromFilename('typings/requests.pyi'), 'python');
  assert.equal(getLspLanguageIdFromFilename('src/app.py'), 'python');
  assert.equal(getLspLanguageIdFromFilename('typings/requests.pyi'), 'python');
});

// ---------------------------------------------------------------------------
// LSP language id mapping
// ---------------------------------------------------------------------------

test('LSP language id resolver promotes .tsx and .jsx to the *react variants', () => {
  // The whole reason this function exists separately from getLanguageFromFilename:
  // the LSP spec requires typescriptreact/javascriptreact for JSX files,
  // even though Monaco's language registry uses the bare typescript/javascript ids.
  assert.equal(getLspLanguageIdFromFilename('src/App.tsx'), 'typescriptreact');
  assert.equal(getLspLanguageIdFromFilename('src/App.jsx'), 'javascriptreact');
});

test('LSP language id resolver keeps non-JSX TS variants on typescript', () => {
  assert.equal(getLspLanguageIdFromFilename('src/index.ts'), 'typescript');
  assert.equal(getLspLanguageIdFromFilename('src/index.mts'), 'typescript');
  assert.equal(getLspLanguageIdFromFilename('src/index.cts'), 'typescript');
});

test('LSP language id resolver keeps non-JSX JS variants on javascript', () => {
  assert.equal(getLspLanguageIdFromFilename('src/index.js'), 'javascript');
  assert.equal(getLspLanguageIdFromFilename('src/index.mjs'), 'javascript');
  assert.equal(getLspLanguageIdFromFilename('src/index.cjs'), 'javascript');
});

test('LSP language id resolver agrees with Monaco resolver on non-divergent extensions', () => {
  // For everything that does not have a JSX-vs-non-JSX distinction, the two
  // resolvers must return the same id. This is a safety net against drift.
  for (const filename of [
    'src/index.ts',
    'src/index.mts',
    'src/index.cts',
    'src/index.js',
    'src/index.mjs',
    'src/index.cjs',
    'package.json',
    'styles.css',
    'index.html',
    'README.md',
    'app.py',
    'stubs.pyi',
    'main.rs',
    'util.c',
    'util.h',
    'view.cpp',
    'view.hpp',
    'view.cc',
    'view.cxx',
    'unknown.zzz',
    '',
  ]) {
    assert.equal(
      getLspLanguageIdFromFilename(filename),
      getLanguageFromFilename(filename),
      `mismatch for ${JSON.stringify(filename)}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Managed languages (ADR-005 Slice 6)
// ---------------------------------------------------------------------------

test('editor language resolver maps C-family extensions to Monaco c/cpp ids', () => {
  assert.equal(getLanguageFromFilename('lib/util.c'), 'c');
  // .h follows the VSCode default (C++).
  assert.equal(getLanguageFromFilename('lib/util.h'), 'cpp');
  assert.equal(getLanguageFromFilename('app/view.cpp'), 'cpp');
  assert.equal(getLanguageFromFilename('app/view.hpp'), 'cpp');
  assert.equal(getLanguageFromFilename('app/view.cc'), 'cpp');
  assert.equal(getLanguageFromFilename('app/view.cxx'), 'cpp');
});

test('managed session resolver keys every C-family extension to the single cpp session', () => {
  // One clangd session (registry language 'cpp') serves both Monaco 'c' and
  // 'cpp' models — the session key must not follow the Monaco split.
  for (const filename of ['util.c', 'util.h', 'view.cpp', 'view.hpp', 'view.cc', 'view.cxx']) {
    assert.equal(getManagedSessionLanguageFromFilename(filename), 'cpp', filename);
  }
  assert.equal(getManagedSessionLanguageFromFilename('main.rs'), 'rust');
  assert.equal(getManagedSessionLanguageFromFilename('app.py'), null);
  assert.equal(getManagedSessionLanguageFromFilename('index.ts'), null);
  assert.equal(getManagedSessionLanguageFromFilename(''), null);
});

test('editor language resolver maps Go across all three resolvers (ADR-005 Slice 6.5)', () => {
  assert.equal(getLanguageFromFilename('cmd/main.go'), 'go');
  assert.equal(getLspLanguageIdFromFilename('cmd/main.go'), 'go');
  assert.equal(getManagedSessionLanguageFromFilename('cmd/main.go'), 'go');
});
