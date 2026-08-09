import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isPythonFilename,
  isPythonLspEvent,
  shouldTeardownPythonOnProjectTransition
} from '../../src/app/usePythonLspLifecycle.js';

test('isPythonFilename matches Python source extensions only', () => {
  assert.equal(isPythonFilename('main.py'), true);
  assert.equal(isPythonFilename('types.PYI'), true);
  assert.equal(isPythonFilename('index.ts'), false);
  assert.equal(isPythonFilename('README.md'), false);
  assert.equal(isPythonFilename(''), false);
});

test('shouldTeardownPythonOnProjectTransition returns true when project changes or closes', () => {
  assert.equal(shouldTeardownPythonOnProjectTransition(null, null), false);
  assert.equal(shouldTeardownPythonOnProjectTransition('a', 'a'), false);
  assert.equal(shouldTeardownPythonOnProjectTransition('a', 'b'), true);
  assert.equal(shouldTeardownPythonOnProjectTransition('a', null), true);
});

test('isPythonLspEvent accepts only python-session payloads (cross-language crash filter)', () => {
  assert.equal(isPythonLspEvent({ languageId: 'python' }), true);
  assert.equal(isPythonLspEvent({ languageId: 'typescript' }), false);
  assert.equal(isPythonLspEvent({ languageId: 'rust' }), false);
  assert.equal(isPythonLspEvent({ languageId: 'cpp' }), false);
  assert.equal(isPythonLspEvent({}), false);
  assert.equal(isPythonLspEvent(null), false);
  assert.equal(isPythonLspEvent(undefined), false);
});
