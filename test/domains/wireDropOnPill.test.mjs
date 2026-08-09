import test from 'node:test';
import assert from 'node:assert/strict';

import { findCollapsedGroupAtPoint, resolveWireDropPreference } from '../../src/app/useWireDropOnPill.js';

// ---------------------------------------------------------------------------
// Drop-on-pill (brief-cross-group-wires S4)
// ---------------------------------------------------------------------------

const bounds = (minX, minY, maxX, maxY) => ({ minX, minY, maxX, maxY });

test('findCollapsedGroupAtPoint hits only collapsed groups whose stub contains the point', () => {
  const groups = [
    { id: 'open', isCollapsed: false },
    { id: 'far', isCollapsed: true },
    { id: 'hit', isCollapsed: true },
  ];
  const boundsById = {
    open: bounds(0, 0, 180, 80),
    far: bounds(1000, 1000, 1180, 1080),
    hit: bounds(100, 50, 280, 130),
  };
  const getGroupBounds = (g) => boundsById[g.id];

  assert.equal(findCollapsedGroupAtPoint(groups, getGroupBounds, 150, 100)?.id, 'hit');
  assert.equal(findCollapsedGroupAtPoint(groups, getGroupBounds, 50, 40), null, 'open group ignored');
  assert.equal(findCollapsedGroupAtPoint(groups, getGroupBounds, 500, 500), null, 'empty space');
});

test('findCollapsedGroupAtPoint tolerates missing bounds and empty input', () => {
  assert.equal(findCollapsedGroupAtPoint([{ id: 'g', isCollapsed: true }], () => null, 0, 0), null);
  assert.equal(findCollapsedGroupAtPoint([], () => null, 0, 0), null);
  assert.equal(findCollapsedGroupAtPoint(null, () => null, 0, 0), null);
});

test('resolveWireDropPreference resolves project → global → default', () => {
  assert.equal(resolveWireDropPreference({ wireDropOnCollapsedGroup: 'open-group' }, { wireDropOnCollapsedGroup: 'picker' }), 'open-group');
  assert.equal(resolveWireDropPreference(null, { wireDropOnCollapsedGroup: 'open-group' }), 'open-group');
  assert.equal(resolveWireDropPreference(null, null), 'picker');
  // Invalid stored values fall back to the default rather than leaking through.
  assert.equal(resolveWireDropPreference({ wireDropOnCollapsedGroup: 'bogus' }, null), 'picker');
});
