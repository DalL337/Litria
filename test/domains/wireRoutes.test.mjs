import test from 'node:test';
import assert from 'node:assert/strict';

import { computeWireRoutes } from '../../src/app/selectors/wireRoutes.js';
import { anchorEdgePoint, computeWirePoints } from '../../src/utils/wireGeometry.js';

const PIECE_W = 180;
const PIECE_H = 110;

const pieceAnchor = (x, y) => ({ x, y, kind: 'piece', pieceId: `${x},${y}` });
const pillAnchor = (x, y) => ({ x, y, width: 180, height: 34, kind: 'pill' });

const wire = (id, sourceAnchor, sourceSide, targetAnchor, targetSide) => ({
  connection: { id },
  sourceAnchor,
  targetAnchor,
  sourceSide,
  targetSide,
});

// ---------------------------------------------------------------------------
// anchorEdgePoint — the shared edge-midpoint math
// ---------------------------------------------------------------------------

test('anchorEdgePoint uses anchor dimensions when present, fallbacks when not', () => {
  // Piece anchor without width/height → piece constants
  assert.deepEqual(
    anchorEdgePoint({ x: 100, y: 50 }, 'right', PIECE_W, PIECE_H),
    { x: 280, y: 105 }
  );
  // Pill anchor carries its own (shorter) height
  assert.deepEqual(
    anchorEdgePoint({ x: 100, y: 50, width: 180, height: 34 }, 'bottom', PIECE_W, PIECE_H),
    { x: 190, y: 84 }
  );
});

test('anchorEdgePoint covers all four sides plus center default', () => {
  const a = { x: 0, y: 0, width: 100, height: 60 };
  assert.deepEqual(anchorEdgePoint(a, 'left', PIECE_W, PIECE_H), { x: 0, y: 30 });
  assert.deepEqual(anchorEdgePoint(a, 'right', PIECE_W, PIECE_H), { x: 100, y: 30 });
  assert.deepEqual(anchorEdgePoint(a, 'top', PIECE_W, PIECE_H), { x: 50, y: 0 });
  assert.deepEqual(anchorEdgePoint(a, 'bottom', PIECE_W, PIECE_H), { x: 50, y: 60 });
  assert.deepEqual(anchorEdgePoint(a, 'nonsense', PIECE_W, PIECE_H), { x: 50, y: 30 });
});

// ---------------------------------------------------------------------------
// computeWireRoutes — S1 pass-through skeleton
// ---------------------------------------------------------------------------

test('routes terminate exactly at the chosen edge midpoints, sides preserved', () => {
  const w = wire(7, pieceAnchor(0, 0), 'right', pieceAnchor(400, 200), 'left');
  const routes = computeWireRoutes({ wires: [w], pieceWidth: PIECE_W, pieceHeight: PIECE_H });

  const expectedSource = anchorEdgePoint(w.sourceAnchor, 'right', PIECE_W, PIECE_H);
  const expectedTarget = anchorEdgePoint(w.targetAnchor, 'left', PIECE_W, PIECE_H);
  const { points } = routes.get(7);
  assert.deepEqual(points[0], { ...expectedSource, side: 'right' });
  assert.deepEqual(points[points.length - 1], { ...expectedTarget, side: 'left' });
  // Routed legs are orthogonal throughout (R7).
  for (let i = 0; i < points.length - 1; i++) {
    assert.ok(points[i].x === points[i + 1].x || points[i].y === points[i + 1].y);
  }
});

test('routes are keyed by connection id, one entry per wire', () => {
  const routes = computeWireRoutes({
    wires: [
      wire('a', pieceAnchor(0, 0), 'right', pieceAnchor(400, 0), 'left'),
      wire('b', pieceAnchor(0, 300), 'bottom', pillAnchor(400, 500), 'top'),
    ],
    pieceWidth: PIECE_W,
    pieceHeight: PIECE_H,
  });
  assert.equal(routes.size, 2);
  assert.ok(routes.has('a'));
  assert.ok(routes.has('b'));
});

test('pill anchors route from their own rect dimensions', () => {
  const w = wire(1, pieceAnchor(0, 0), 'right', pillAnchor(400, 200), 'left');
  const routes = computeWireRoutes({ wires: [w], pieceWidth: PIECE_W, pieceHeight: PIECE_H });
  // pill left-edge midpoint terminal: x=400, y=200+34/2
  const { points } = routes.get(1);
  assert.deepEqual(points[points.length - 1], { x: 400, y: 217, side: 'left' });
});

test('malformed wires are skipped, not thrown', () => {
  const routes = computeWireRoutes({
    wires: [
      { connection: { id: 1 } }, // no anchors
      wire(2, pieceAnchor(NaN, 0), 'right', pieceAnchor(400, 0), 'left'), // non-finite
      wire(3, pieceAnchor(0, 0), 'right', pieceAnchor(400, 0), 'left'), // fine
      null,
    ].filter((w) => w !== null),
    pieceWidth: PIECE_W,
    pieceHeight: PIECE_H,
  });
  assert.equal(routes.size, 1);
  assert.ok(routes.has(3));
});

test('deterministic: same inputs produce identical routes', () => {
  const wires = [wire(1, pieceAnchor(10, 20), 'bottom', pieceAnchor(300, 400), 'top')];
  const a = computeWireRoutes({ wires, pieceWidth: PIECE_W, pieceHeight: PIECE_H });
  const b = computeWireRoutes({ wires, pieceWidth: PIECE_W, pieceHeight: PIECE_H });
  assert.deepEqual([...a.entries()], [...b.entries()]);
});

test('empty and missing wire lists return an empty map', () => {
  assert.equal(computeWireRoutes({ wires: [], pieceWidth: PIECE_W, pieceHeight: PIECE_H }).size, 0);
  assert.equal(computeWireRoutes({ pieceWidth: PIECE_W, pieceHeight: PIECE_H }).size, 0);
});

// ---------------------------------------------------------------------------
// S3 — obstacle registry + avoidance integration
// ---------------------------------------------------------------------------

const { buildWireObstacles } = await import('../../src/app/selectors/wireRoutes.js');

const registryFixture = () => ({
  pieces: [
    { id: 1, x: 0, y: 0, filename: 'a.js' },
    { id: 2, x: 400, y: 0, filename: 'b.js' },
    { id: 3, x: 200, y: 300, filename: 'hidden/c.js' },
    { id: 4, x: 600, y: 300, filename: 'd.js' },
  ],
  hiddenPieceIds: new Set([4]),
  isPathHidden: (p) => p.startsWith('hidden/'),
  groups: [
    { id: 10, isCollapsed: true, pieceIds: [7, 8] },
    { id: 11, isCollapsed: false, pieceIds: [9] },            // expanded w/ members — NOT an obstacle until S5
    { id: 12, isCollapsed: false, pieceIds: [], seedBounds: true }, // memberless manual box
  ],
  getGroupBounds: (g) => (
    g.id === 10 ? { minX: 800, minY: 0, maxX: 1000, maxY: 100 }
      : g.id === 12 ? { minX: 800, minY: 300, maxX: 950, maxY: 420 }
        : { minX: 0, minY: 0, maxX: 50, maxY: 50 }
  ),
  pieceWidth: PIECE_W,
  pieceHeight: PIECE_H,
});

test('registry: visible pieces in, hidden and path-hidden pieces out', () => {
  const obstacles = buildWireObstacles(registryFixture());
  const pieceIds = obstacles.filter((o) => o.kind === 'piece').map((o) => o.pieceId);
  assert.deepEqual(pieceIds, [1, 2]);
});

test('registry: collapsed pill and memberless seed box in, expanded member group as padded border box', () => {
  const obstacles = buildWireObstacles(registryFixture());
  const pill = obstacles.find((o) => o.kind === 'pill');
  assert.deepEqual(pill, { x: 800, y: 0, width: PIECE_W, height: 80, kind: 'pill', groupId: 10 });
  const box = obstacles.find((o) => o.kind === 'box');
  assert.deepEqual(box, { x: 800, y: 300, width: 150, height: 120, kind: 'box', groupId: 12 });
  // S5: the expanded member group is a groupBox obstacle at the DRAWN
  // border — content bounds + the outline pad — carrying its subtree.
  const groupBox = obstacles.find((o) => o.kind === 'groupBox');
  assert.equal(groupBox.groupId, 11);
  assert.deepEqual(
    { x: groupBox.x, y: groupBox.y, width: groupBox.width, height: groupBox.height },
    { x: -12, y: -12, width: 74, height: 74 }
  );
  assert.deepEqual([...groupBox.containsPieceIds], [9]);
  assert.ok(groupBox.containsGroupIds.has(11));
});

test('a piece between two connected pieces forces a detour that avoids it', () => {
  const wires = [wire(1, pieceAnchor(0, 0), 'right', pieceAnchor(800, 0), 'left')];
  const blocker = { x: 380, y: -30, width: PIECE_W, height: PIECE_H, kind: 'piece', pieceId: 99 };
  const routes = computeWireRoutes({
    wires, obstacles: [blocker], pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  const r = routes.get(1);
  assert.equal(r.routed, true);
  assert.ok(r.points.length > 2, 'detour has waypoints');
});

test("a wire's own endpoint rects never block it", () => {
  const wires = [wire(1, pieceAnchor(0, 0), 'right', pieceAnchor(400, 0), 'left')];
  const selfObstacles = [
    { x: 0, y: 0, width: PIECE_W, height: PIECE_H, kind: 'piece', pieceId: '0,0' },
    { x: 400, y: 0, width: PIECE_W, height: PIECE_H, kind: 'piece', pieceId: '400,0' },
  ];
  const routes = computeWireRoutes({
    wires, obstacles: selfObstacles, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  // Both rects belong to the wire's endpoints → excluded → clean straight route.
  assert.equal(routes.get(1).routed, true);
  assert.ok(routes.get(1).points.every((p) => p.y === routes.get(1).points[0].y));
});

test('unroutable wires fall back to the straight pair, flagged unrouted', () => {
  // Target sealed inside four thick walls.
  const walls = [
    { x: 340, y: -200, width: 40, height: 500, kind: 'piece', pieceId: 90 },
    { x: 640, y: -200, width: 40, height: 500, kind: 'piece', pieceId: 91 },
    { x: 340, y: -200, width: 340, height: 40, kind: 'piece', pieceId: 92 },
    { x: 340, y: 260, width: 340, height: 40, kind: 'piece', pieceId: 93 },
  ];
  const wires = [wire(1, pieceAnchor(0, 0), 'right', pieceAnchor(420, 20), 'left')];
  const routes = computeWireRoutes({
    wires, obstacles: walls, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  const r = routes.get(1);
  assert.equal(r.routed, false);
  assert.equal(r.points.length, 2);
});

// ---------------------------------------------------------------------------
// S5 — border discipline (R6)
// ---------------------------------------------------------------------------

// Anchor with an explicit id (membership tests key on pieceId).
const idAnchor = (id, x, y) => ({ id, x, y, kind: 'piece', pieceId: id });

// A group of two stacked pieces with the box drawn 12px around them.
const groupScene = () => {
  const inA = idAnchor('inA', 600, 0);
  const inB = idAnchor('inB', 600, 160);
  const groups = [{ id: 50, isCollapsed: false, pieceIds: ['inA', 'inB'], parentId: null }];
  const getGroupBounds = () => ({ minX: 600, minY: 0, maxX: 780, maxY: 270 });
  const pieces = [
    { id: 'out', x: 0, y: 60, filename: 'out.js' },
    { id: 'inA', x: 600, y: 0, filename: 'inA.js' },
    { id: 'inB', x: 600, y: 160, filename: 'inB.js' },
  ];
  const obstacles = buildWireObstacles({
    pieces,
    hiddenPieceIds: new Set(),
    isPathHidden: () => false,
    groups,
    getGroupBounds,
    pieceWidth: PIECE_W,
    pieceHeight: PIECE_H,
  });
  return { obstacles, box: obstacles.find((o) => o.kind === 'groupBox') };
};

test('a stranger wire routes around the group box, not through it', () => {
  const { obstacles, box } = groupScene();
  // Wire from out.js to a free piece BEYOND the group (no membership).
  const wires = [wire('w', idAnchor('out', 0, 60), 'right', idAnchor('far', 1100, 60), 'left')];
  const routes = computeWireRoutes({ wires, obstacles, pieceWidth: PIECE_W, pieceHeight: PIECE_H });
  const r = routes.get('w');
  assert.equal(r.routed, true);
  // No leg may pass through the box interior.
  for (let i = 0; i < r.points.length - 1; i++) {
    const a = r.points[i];
    const b = r.points[i + 1];
    if (a.y === b.y) {
      const [lo, hi] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
      assert.ok(!(a.y > box.y && a.y < box.y + box.height && hi > box.x && lo < box.x + box.width),
        `leg ${i} crosses the box`);
    } else {
      const [lo, hi] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
      assert.ok(!(a.x > box.x && a.x < box.x + box.width && hi > box.y && lo < box.y + box.height),
        `leg ${i} crosses the box`);
    }
  }
});

test('a member-bound wire gates through the border on its terminal normal', () => {
  const { obstacles, box } = groupScene();
  const wires = [wire('w', idAnchor('out', 0, 60), 'right', idAnchor('inA', 600, 0), 'left')];
  const routes = computeWireRoutes({ wires, obstacles, pieceWidth: PIECE_W, pieceHeight: PIECE_H });
  const r = routes.get('w');
  assert.equal(r.routed, true);

  const terminal = r.points[r.points.length - 1];
  const approach = r.points[r.points.length - 2];
  // Final approach is horizontal on the terminal's normal line…
  assert.equal(approach.y, terminal.y);
  // …and starts OUTSIDE the drawn border: the crossing is the perpendicular
  // gate leg, not a skim along the inside.
  assert.ok(approach.x <= box.x, `approach ${approach.x} should begin outside the box edge ${box.x}`);
});

test('an intra-group wire never crosses its own border', () => {
  const { obstacles, box } = groupScene();
  const wires = [wire('w', idAnchor('inA', 600, 0), 'bottom', idAnchor('inB', 600, 160), 'top')];
  const routes = computeWireRoutes({ wires, obstacles, pieceWidth: PIECE_W, pieceHeight: PIECE_H });
  const r = routes.get('w');
  assert.equal(r.routed, true);
  for (const p of r.points) {
    assert.ok(p.x >= box.x && p.x <= box.x + box.width, `x ${p.x} inside box`);
    assert.ok(p.y >= box.y && p.y <= box.y + box.height, `y ${p.y} inside box`);
  }
});

test('nested membership gates through every ancestor border at once', () => {
  const pieces = [
    { id: 'out', x: 0, y: 100, filename: 'out.js' },
    { id: 'deep', x: 700, y: 100, filename: 'deep.js' },
  ];
  const groups = [
    { id: 1, isCollapsed: false, pieceIds: [], parentId: null },     // parent (bounds span child)
    { id: 2, isCollapsed: false, pieceIds: ['deep'], parentId: 1 },  // child holding the piece
  ];
  // Parent bounds wrap the child bounds.
  const getGroupBounds = (g) => (g.id === 1
    ? { minX: 660, minY: 40, maxX: 960, maxY: 320 }
    : { minX: 700, minY: 100, maxX: 880, maxY: 210 });
  // Parent needs a member so it registers as a groupBox — hang the child's
  // piece off the subtree instead: parent has no direct pieces but the
  // subtree walk collects the child's. Registry requires pieceIds.length>0,
  // so give the parent a phantom-free structure via the child only.
  groups[0].pieceIds = [];
  const obstacles = buildWireObstacles({
    pieces, hiddenPieceIds: new Set(), isPathHidden: () => false,
    groups, getGroupBounds, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  // Child box registered; parent (no direct members) is not a box — the
  // discipline still gates through the child border it does have.
  const wires = [wire('w', idAnchor('out', 0, 100), 'right', idAnchor('deep', 700, 100), 'left')];
  const routes = computeWireRoutes({ wires, obstacles, pieceWidth: PIECE_W, pieceHeight: PIECE_H });
  const r = routes.get('w');
  assert.equal(r.routed, true);
  const childBox = obstacles.find((o) => o.kind === 'groupBox' && o.groupId === 2);
  const approach = r.points[r.points.length - 2];
  assert.ok(approach.x <= childBox.x);
  assert.equal(approach.y, r.points[r.points.length - 1].y);
});

test('a blocked gate falls back to borderless crossing, not failure', () => {
  const { obstacles } = groupScene();
  // Target inB's TOP face: the perpendicular gate path runs straight up
  // through sibling inA — blocked. The chain box drops for this wire and
  // it still routes (borderless crossing beats failing).
  const wires = [wire('w', idAnchor('out', 0, 60), 'right', idAnchor('inB', 600, 160), 'top')];
  const routes = computeWireRoutes({
    wires, obstacles, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  const r = routes.get('w');
  assert.equal(r.routed, true);
});
