import test from 'node:test';
import assert from 'node:assert/strict';

import {
  reloadReportMessage,
  shouldTeardownOnProjectTransition
} from '../../src/terminal/useTerminalLifecycle.js';

test('shouldTeardownOnProjectTransition returns true only for project switches', () => {
  assert.equal(shouldTeardownOnProjectTransition(null, null), false);
  assert.equal(shouldTeardownOnProjectTransition('a', null), false);
  assert.equal(shouldTeardownOnProjectTransition('a', 'a'), false);
  assert.equal(shouldTeardownOnProjectTransition('a', 'b'), true);
});

test('a reload that ended sessions is reported once, in plain words', () => {
  assert.equal(reloadReportMessage(0), null);
  assert.equal(reloadReportMessage(undefined), null);
  assert.equal(reloadReportMessage(1), 'The window reloaded, so its terminal session ended.');
  assert.equal(reloadReportMessage(3), 'The window reloaded, so its 3 terminal sessions ended.');
});
