import test from 'node:test';
import assert from 'node:assert/strict';

import { isUntitledSession, UNTITLED_FILENAME } from '../../src/project/untitledSession.js';

// ---------------------------------------------------------------------------
// isUntitledSession — true only for the launcher "New File" shape:
// single-file mode (manifestPath === null) with no materialized root.
// ---------------------------------------------------------------------------

test('isUntitledSession is true for a new-file instance (flag set, null manifest, empty root)', () => {
  assert.equal(isUntitledSession({
    instanceId: 'x',
    name: UNTITLED_FILENAME,
    rootPath: '',
    manifestPath: null,
    isUntitled: true
  }), true);
});

test('isUntitledSession is false once the root has materialized (post Save As)', () => {
  assert.equal(isUntitledSession({
    instanceId: 'x',
    name: 'todo.md',
    rootPath: 'C:\\projects\\notes',
    manifestPath: null,
    isUntitled: false
  }), false);
});

test('isUntitledSession is false for the "Open File" single-file mode (root = file dir)', () => {
  assert.equal(isUntitledSession({
    instanceId: 'x',
    name: 'readme.md',
    rootPath: '/home/dan/docs',
    manifestPath: null,
    isUntitled: false
  }), false);
});

test('isUntitledSession requires the explicit flag — an Open File session with an empty root is NOT untitled', () => {
  // Open File on a separator-less path yields rootPath '' with manifestPath
  // null; without the flag requirement its saves would be hijacked by the
  // Save As gate instead of writing back to the opened file.
  assert.equal(isUntitledSession({
    instanceId: 'x',
    name: 'bare-filename.md',
    rootPath: '',
    manifestPath: null,
    isUntitled: false
  }), false);
});

test('isUntitledSession is false for a full project (workspace DB manifest)', () => {
  assert.equal(isUntitledSession({
    instanceId: 'x',
    name: 'litria',
    rootPath: 'C:\\projects\\litria',
    manifestPath: 'C:/projects/litria/.litria/workspace.db'
  }), false);
});

test('isUntitledSession is false when manifestPath is undefined (not the single-file shape)', () => {
  assert.equal(isUntitledSession({
    instanceId: 'x',
    name: 'weird',
    rootPath: ''
  }), false);
});

test('isUntitledSession is false for null/undefined instances', () => {
  assert.equal(isUntitledSession(null), false);
  assert.equal(isUntitledSession(undefined), false);
});
