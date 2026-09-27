// Scaled-bounds consistency (brief-structural-grid Slice 1): a scaled node's
// snap edges, adjacency, seam terminal, wire anchor and routing obstacle all
// read the same rectangle — base size times the node's scale, growing right
// and down from its corner. Scale-one behavior is covered unchanged by the
// existing snapSeam, wireNudge, wireRoutes and workspaceSelectors suites.
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';

import {
  boundsOfRects,
  pieceRect,
  pieceScale,
  pieceSize,
  rectsOverlap,
} from '../../src/utils/spatialGeometry2d.js';
import useSnap from '../../src/behaviors/useSnap.js';
import useAdjacency from '../../src/behaviors/useAdjacency.js';
import { computeBirthNudge, WIRE_NUDGE_SEAM } from '../../src/utils/wireNudge.js';
import { buildWireObstacles } from '../../src/app/selectors/wireRoutes.js';
import { buildRenderableWires } from '../../src/app/selectors/workspaceSelectors.js';

const W = 180;
const H = 110;

// Hooks here only use useCallback; run them with a minimal dispatcher.
const withHookShim = (fn) => {
  const container = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE
    ?? React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
  const prev = container.H;
  container.H = { useCallback: (cb) => cb };
  try {
    return fn();
  } finally {
    container.H = prev;
  }
};

test('pieceScale falls back to 1 for missing or unusable values', () => {
  assert.equal(pieceScale({}), 1);
  assert.equal(pieceScale({ scale: 0 }), 1);
  assert.equal(pieceScale({ scale: -2 }), 1);
  assert.equal(pieceScale({ scale: Number.NaN }), 1);
  assert.equal(pieceScale(null), 1);
  assert.equal(pieceScale({ scale: 1.25 }), 1.25);
});

test('a scaled rectangle grows right and down from the stored corner', () => {
  const piece = { x: 100, y: -40, scale: 1.5 };
  assert.deepEqual(pieceSize(piece), { width: 270, height: 165 });
  assert.deepEqual(pieceRect(piece), { x: 100, y: -40, width: 270, height: 165 });
  assert.deepEqual(pieceRect(piece, W, H, { x: 0, y: 0 }), { x: 0, y: 0, width: 270, height: 165 });
});

test('touching rectangles do not overlap; shared area does', () => {
  const a = { x: 0, y: 0, width: 180, height: 110 };
  assert.equal(rectsOverlap(a, { x: 180, y: 0, width: 10, height: 10 }), false);
  assert.equal(rectsOverlap(a, { x: 179, y: 0, width: 10, height: 10 }), true);
  assert.deepEqual(boundsOfRects([a, { x: -20, y: 50, width: 10, height: 100 }]), {
    x: -20, y: 0, width: 200, height: 150,
  });
  assert.equal(boundsOfRects([]), null);
});

test('snap docks against a scaled neighbor at its scaled right edge', () => {
  const pieces = [
    { id: 1, x: 0, y: 0, scale: 1.5 },
    { id: 2, x: 900, y: 0 },
  ];
  const { checkSnap } = withHookShim(() => useSnap({
    pieces,
    piecesById: new Map(pieces.map((p) => [p.id, p])),
    selection: { isSelected: () => false },
    snapDistance: 30,
    pieceWidth: W,
    pieceHeight: H,
    connections: [],
  }));
  assert.deepEqual(checkSnap({ id: 2 }, 275, 3), { x: 270, y: 0 });
  // A scaled dragged piece docks left of a neighbor by its own width.
  assert.deepEqual(checkSnap({ id: 1, scale: 1.5 }, 900 - 270 - 8, 2), { x: 630, y: 0 });
});

test('group snap bounds include each member at its scale', () => {
  const pieces = [
    { id: 1, x: 0, y: 0, scale: 1.5 },
    { id: 2, x: 290, y: 0 },
  ];
  const { getGroupSnapDelta } = withHookShim(() => useSnap({
    pieces,
    piecesById: new Map(pieces.map((p) => [p.id, p])),
    selection: { isSelected: () => false },
    snapDistance: 30,
    pieceWidth: W,
    pieceHeight: H,
    connections: [],
  }));
  // Moving piece 2 alone: its left edge is 20 from the scaled right edge.
  assert.deepEqual(getGroupSnapDelta([2]), { dx: -20, dy: 0, dist: 20 });
});

test('adjacency recognizes flush neighbors at their scaled edges', () => {
  const { getSnapDirection } = withHookShim(() => useAdjacency());
  const big = { x: 0, y: 0, scale: 1.5 };
  assert.equal(getSnapDirection(big, { x: 270, y: 0, scale: 1.5 }), 'left');
  // Centers align: 0 + 165/2 === 27.5 + 110/2.
  assert.equal(getSnapDirection(big, { x: 270, y: 27.5 }), 'left');
  // The unscaled edge (180) is no longer mistaken for contact.
  assert.equal(getSnapDirection(big, { x: 180, y: 0, scale: 1.5 }), null);
});

test('a wire on a scaled face parts the neighbor flush against that face', () => {
  const moves = computeBirthNudge({
    sourceId: 'A',
    sourceSide: 'right',
    targetId: 'B',
    targetSide: 'left',
    pieces: [
      { id: 'A', x: 0, y: 0, scale: 1.5 },
      { id: 'C', x: 270, y: 27.5 },
      { id: 'B', x: 900, y: 27.5 },
    ],
    pieceWidth: W,
    pieceHeight: H,
  });
  assert.deepEqual(moves, [{ id: 'C', dx: WIRE_NUDGE_SEAM, dy: 0 }]);
});

test('routing obstacles and wire anchors use the scaled body', () => {
  const a = { id: 1, x: 0, y: 0, scale: 1.5, filename: 'a.js' };
  const b = { id: 2, x: 600, y: 0, filename: 'b.js' };
  const obstacles = buildWireObstacles({
    pieces: [a, b],
    hiddenPieceIds: new Set(),
    isPathHidden: () => false,
    groups: [],
    getGroupBounds: () => null,
    pieceWidth: W,
    pieceHeight: H,
  });
  const obstacleA = obstacles.find((o) => o.pieceId === 1);
  assert.equal(obstacleA.width, 270);
  assert.equal(obstacleA.height, 165);

  const wires = buildRenderableWires({
    connections: [{ id: 'c1', sourceId: 1, targetId: 2, sourceSide: 'right', targetSide: 'left' }],
    piecesById: new Map([[1, a], [2, b]]),
    groups: [],
    groupByPieceId: new Map(),
    hiddenPieceIds: new Set(),
    getGroupBounds: () => null,
    isPathHidden: () => false,
    pieceWidth: W,
    pieceHeight: H,
  });
  assert.equal(wires.length, 1);
  assert.equal(wires[0].sourceAnchor.width, 270);
  assert.equal(wires[0].sourceAnchor.height, 165);
  assert.equal(wires[0].targetAnchor.width, W);
});
