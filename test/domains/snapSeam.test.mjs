import test from 'node:test';
import assert from 'node:assert/strict';

import useSnap, { WIRE_SNAP_SEAM } from '../../src/behaviors/useSnap.js';
import { buildWireCurve } from '../../src/utils/wireGeometry.js';

const PIECE_W = 180;
const PIECE_H = 110;
const SNAP_DIST = 30;

// useSnap's checkSnap is wrapped in useCallback — stub React's hook via the
// module's import? Simpler: replicate the hook call with a shim. useCallback
// is imported from react; calling the hook outside React throws. Instead we
// exercise checkSnap through a minimal fake dispatcher.
import React from 'react';
const withHookShim = (fn) => {
  const prev = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED?.H;
  const dispatcher = { useCallback: (cb) => cb };
  const container = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
    ?? React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const key = 'H' in (container ?? {}) ? 'H' : 'ReactCurrentDispatcher';
  const slot = key === 'H' ? container : container?.[key];
  const restore = key === 'H' ? () => { container.H = prev; } : (() => {
    const old = slot.current;
    return () => { slot.current = old; };
  })();
  if (key === 'H') container.H = dispatcher; else slot.current = dispatcher;
  try {
    return fn();
  } finally {
    if (typeof restore === 'function') restore();
  }
};

const harness = ({ connections = [] } = {}) => {
  const pieces = [
    { id: 1, x: 0, y: 0 },
    { id: 2, x: 600, y: 0 },
  ];
  return withHookShim(() => useSnap({
    pieces,
    piecesById: new Map(pieces.map((p) => [p.id, p])),
    selection: { isSelected: () => false },
    snapDistance: SNAP_DIST,
    pieceWidth: PIECE_W,
    pieceHeight: PIECE_H,
    connections,
  }));
};

// Dragged piece 2 dropped just right of piece 1's right edge (approaching,
// not overlapping): flush target is x=180.
const DROP_X = PIECE_W + 10;

test('unwired snap goes flush exactly as before', () => {
  const { checkSnap } = harness();
  const snap = checkSnap({ id: 2 }, DROP_X, 4);
  assert.deepEqual(snap, { x: PIECE_W, y: 0 });
});

test('a wire between the snapping pair on the sealed faces still goes flush (contact-is-display)', () => {
  const { checkSnap } = harness({
    connections: [{ sourceId: 1, sourceSide: 'right', targetId: 2, targetSide: 'left' }],
  });
  const snap = checkSnap({ id: 2 }, DROP_X, 4);
  assert.deepEqual(snap, { x: PIECE_W, y: 0 });
});

test('a sealed face wired to a THIRD piece settles at the corridor seam', () => {
  const { checkSnap } = harness({
    connections: [{ sourceId: 1, sourceSide: 'right', targetId: 99, targetSide: 'left' }],
  });
  const snap = checkSnap({ id: 2 }, DROP_X, 4);
  assert.deepEqual(snap, { x: PIECE_W + WIRE_SNAP_SEAM, y: 0 });
});

test("the dragged piece's own sealed face counts too", () => {
  const { checkSnap } = harness({
    connections: [{ sourceId: 99, sourceSide: 'right', targetId: 2, targetSide: 'left' }],
  });
  const snap = checkSnap({ id: 2 }, DROP_X, 4);
  assert.deepEqual(snap, { x: PIECE_W + WIRE_SNAP_SEAM, y: 0 });
});

test('pushing INTO the neighbor overrides the seam — the veto goes flush', () => {
  const { checkSnap } = harness({
    connections: [{ sourceId: 1, sourceSide: 'right', targetId: 99, targetSide: 'left' }],
  });
  // Drop overlapping piece 1 (x < flush): insistent gesture.
  const snap = checkSnap({ id: 2 }, PIECE_W - 10, 4);
  assert.deepEqual(snap, { x: PIECE_W, y: 0 });
});

test('vertical snaps seam on top/bottom sealed faces', () => {
  const { checkSnap } = harness({
    connections: [{ sourceId: 1, sourceSide: 'bottom', targetId: 99, targetSide: 'top' }],
  });
  // Dragged piece 2 dropped just below piece 1: flush target y=110.
  const snap = checkSnap({ id: 2 }, 6, PIECE_H + 12);
  assert.deepEqual(snap, { x: 0, y: PIECE_H + WIRE_SNAP_SEAM });
});

// ---------------------------------------------------------------------------
// D4 fallback draws straight (no loops on inverted faces)
// ---------------------------------------------------------------------------

test('straight option draws a plain segment with linear pointAt', () => {
  const curve = buildWireCurve(
    [{ x: 0, y: 0, side: 'bottom' }, { x: 80, y: -40, side: 'top' }],
    { straight: true }
  );
  assert.equal(curve.data, 'M 0 0 L 80 -40');
  const mid = curve.pointAt(0.5);
  assert.deepEqual({ x: mid.x, y: mid.y }, { x: 40, y: -20 });
});
