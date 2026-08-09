import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldTeardownOnProjectTransition } from '../../src/terminal/useTerminalLifecycle.js';

test('shouldTeardownOnProjectTransition returns true only for project switches', () => {
  assert.equal(shouldTeardownOnProjectTransition(null, null), false);
  assert.equal(shouldTeardownOnProjectTransition('a', null), false);
  assert.equal(shouldTeardownOnProjectTransition('a', 'a'), false);
  assert.equal(shouldTeardownOnProjectTransition('a', 'b'), true);
});
