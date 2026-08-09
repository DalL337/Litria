import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isTsFilename,
  isTsLspEvent,
  shouldTeardownTsOnProjectTransition
} from '../../src/app/useTsLspLifecycle.js';

test('isTsFilename matches TS/JS source extensions only', () => {
  assert.equal(isTsFilename('index.ts'), true);
  assert.equal(isTsFilename('App.TSX'), true);
  assert.equal(isTsFilename('util.mjs'), true);
  assert.equal(isTsFilename('legacy.cjs'), true);
  assert.equal(isTsFilename('main.py'), false);
  assert.equal(isTsFilename('README.md'), false);
  assert.equal(isTsFilename(''), false);
});

test('shouldTeardownTsOnProjectTransition returns true when project changes or closes', () => {
  assert.equal(shouldTeardownTsOnProjectTransition(null, null), false);
  assert.equal(shouldTeardownTsOnProjectTransition('a', 'a'), false);
  assert.equal(shouldTeardownTsOnProjectTransition('a', 'b'), true);
  assert.equal(shouldTeardownTsOnProjectTransition('a', null), true);
});

test('isTsLspEvent accepts only typescript-session payloads (cross-language crash filter)', () => {
  assert.equal(isTsLspEvent({ languageId: 'typescript' }), true);
  assert.equal(isTsLspEvent({ languageId: 'python' }), false);
  assert.equal(isTsLspEvent({ languageId: 'rust' }), false);
  assert.equal(isTsLspEvent({ languageId: 'cpp' }), false);
  assert.equal(isTsLspEvent({}), false);
  assert.equal(isTsLspEvent(null), false);
  assert.equal(isTsLspEvent(undefined), false);
});
