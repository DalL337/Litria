// Track T slice T3b: a piece whose file another program deleted shows it on
// its LED ('missing'), unless it has unsaved changes (blue says more there).
import test from 'node:test';
import assert from 'node:assert/strict';

import { computeNodeHealth } from '../../src/hooks/useNodeHealth.js';

test('a missing file is its own health state, below unsaved changes', () => {
  const piece = { id: 1, filename: 'src/gone.ts', code: 'export {};\n', diskMissing: true };
  assert.equal(computeNodeHealth(piece, false, '/proj'), 'missing');
  assert.equal(computeNodeHealth(piece, true, '/proj'), 'blue', 'unsaved changes still say so');
  assert.equal(computeNodeHealth({ ...piece, diskMissing: false }, false, '/proj'), 'green');
  assert.equal(computeNodeHealth({ ...piece, code: '', diskMissing: true }, false, '/proj'), 'missing', 'not mistaken for an empty file');
});
