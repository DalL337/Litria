import test from 'node:test';
import assert from 'node:assert/strict';

import { worstSyntaxStatus } from '../../src/utils/wireStatus.js';

test('worstSyntaxStatus follows the ratified priority order', () => {
  assert.equal(worstSyntaxStatus(['resolved', 'pending']), 'pending');
  assert.equal(worstSyntaxStatus(['resolved', 'unused', 'pending']), 'unused');
  assert.equal(worstSyntaxStatus(['drifted', 'unused']), 'drifted');
  assert.equal(worstSyntaxStatus(['orphaned', 'drifted']), 'orphaned');
  assert.equal(worstSyntaxStatus(['resolved', 'broken', 'orphaned']), 'broken');
});

test('worstSyntaxStatus ignores null/undefined members and empty input', () => {
  assert.equal(worstSyntaxStatus([null, undefined, 'resolved']), 'resolved');
  assert.equal(worstSyntaxStatus([null, undefined]), null);
  assert.equal(worstSyntaxStatus([]), null);
  assert.equal(worstSyntaxStatus(null), null);
});

test('worstSyntaxStatus tolerates unknown status strings without promoting them', () => {
  assert.equal(worstSyntaxStatus(['mystery', 'pending']), 'pending');
  assert.equal(worstSyntaxStatus(['mystery']), null);
});
