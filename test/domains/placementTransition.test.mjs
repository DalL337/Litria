import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createPlacementTransition,
  easeProgress,
  piecesAt,
  positionsAt,
  transitionDone,
} from '../../src/utils/placementTransition.js';

const from = new Map([[1, { x: 650, y: 290 }], [2, { x: 0, y: 0 }]]);
const to = new Map([[1, { x: 600, y: 300 }], [2, { x: 0, y: 0 }]]);

test('a transition slides only the nodes that moved', () => {
  const t = createPlacementTransition({ from, to, start: 1000, durationMs: 200 });
  assert.deepEqual([...t.moves.keys()], [1]);
});

test('reduced motion, a zero duration or no movement never starts a slide', () => {
  assert.equal(createPlacementTransition({ from, to, start: 0, durationMs: 200, reduceMotion: true }), null);
  assert.equal(createPlacementTransition({ from, to, start: 0, durationMs: 0 }), null);
  assert.equal(createPlacementTransition({ from: to, to, start: 0, durationMs: 200 }), null);
});

test('positions run from the release point to the committed corner, eased', () => {
  const t = createPlacementTransition({ from, to, start: 1000, durationMs: 200, easing: 'linear' });
  assert.deepEqual(positionsAt(t, 1000).get(1), { x: 650, y: 290 });
  assert.deepEqual(positionsAt(t, 1100).get(1), { x: 625, y: 295 });
  assert.equal(transitionDone(t, 1199), false);
  assert.equal(transitionDone(t, 1200), true);
  const cubic = createPlacementTransition({ from, to, start: 0, durationMs: 100, easing: 'cubic' });
  assert.ok(positionsAt(cubic, 50).get(1).x < 625, 'ease-out is past halfway at half time');
});

test('drawn pieces: settled state with in-flight nodes interpolated; finished = state', () => {
  const pieces = [{ id: 1, x: 600, y: 300 }, { id: 2, x: 0, y: 0 }];
  const t = createPlacementTransition({ from, to, start: 0, durationMs: 100, easing: 'linear' });
  assert.deepEqual(piecesAt(pieces, t, 50)[0], { id: 1, x: 625, y: 295 });
  assert.equal(piecesAt(pieces, t, 100), pieces, 'a finished slide draws authoritative state');
  assert.equal(piecesAt(pieces, null, 0), pieces);
});

test('unknown easings fall back to cubic; progress is clamped', () => {
  assert.equal(easeProgress('bogus', 0.5), easeProgress('cubic', 0.5));
  assert.equal(easeProgress('linear', 2), 1);
  assert.equal(easeProgress('linear', -1), 0);
});
