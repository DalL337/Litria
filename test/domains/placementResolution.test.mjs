import test from 'node:test';
import assert from 'node:assert/strict';

import {
  guideLinesFor,
  nearestGuide,
  partOverlappedNeighbors,
  resolvePlacement,
  staticObstacles,
} from '../../src/app/placementResolution.js';
import { DEFAULT_GRID_DEFINITION, deriveGridSteps } from '../../src/utils/gridGeometry.js';

const steps = deriveGridSteps(DEFAULT_GRID_DEFINITION); // 100 / 20 / 10

// The playground's sample layout (docs/prototypes/prototype-structural-grid.html).
const layout = () => [
  { id: 'main', x: 0, y: 0 },
  { id: 'utils', x: 200, y: 0 },
  { id: 'format', x: 400, y: 0 },
  { id: 'api', x: 0, y: 200 },
  { id: 'config', x: 180, y: 200 },
  { id: 'db', x: -300, y: 100 },
  { id: 'cache', x: -300, y: 300 },
  { id: 'legacy', x: 613, y: 247 },
];

function drop(pieces, moves, options = {}) {
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const members = Object.entries(moves).map(([id, position]) => ({ piece: byId.get(id), position }));
  const obstacles = staticObstacles({ pieces, movingIds: Object.keys(moves), hiddenPieceIds: options.hidden });
  return resolvePlacement({ members, obstacles, steps, ...options });
}

test('Strict lands a nudged node on the nearest free major intersection', () => {
  const result = drop(layout(), { legacy: { x: 635, y: 229 } }, { mode: 'strict' });
  assert.equal(result.reason, 'major');
  assert.deepEqual(result.positions.get('legacy'), { x: 600, y: 200 });
  assert.equal(result.level, 'major');
});

test('Strict never docks flush: a drop onto a neighbor takes the nearest free major point', () => {
  // cache dropped onto db (db at (-300, 100) is the obstacle).
  const result = drop(layout(), { cache: { x: -300, y: 130 } }, { mode: 'strict', dockAnchor: { x: -300, y: 210 } });
  assert.equal(result.reason, 'major', 'the dock anchor is ignored in Strict');
  const landed = result.positions.get('cache');
  assert.ok(landed.x % 100 === 0 && landed.y % 100 === 0, 'on a major intersection');
  assert.notDeepEqual(landed, { x: -300, y: 100 }, 'never on top of db');
});

test('Flex keeps today\'s docking first', () => {
  const result = drop(layout(), { format: { x: 383, y: 6 } }, { mode: 'flex', dockAnchor: { x: 380, y: 0 } });
  assert.equal(result.reason, 'dock');
  assert.deepEqual(result.positions.get('format'), { x: 380, y: 0 });
});

test('Flex without a dock or guide settles on the finest lattice point', () => {
  const result = drop(layout(), { api: { x: -233, y: 447 } }, { mode: 'flex' });
  assert.equal(result.reason, 'fine');
  assert.deepEqual(result.positions.get('api'), { x: -230, y: 450 });
  assert.equal(result.level, 'sub');
});

test('a smart guide grabs the nearest face before the lattice rounds', () => {
  // legacy raw (603, 206): db's bottom edge (210) is 4 away, api's top (200) 6.
  const result = drop(layout(), { legacy: { x: 603, y: 206 } }, { mode: 'flex', guideTolerance: 6 });
  assert.equal(result.reason, 'guide');
  assert.deepEqual(result.positions.get('legacy'), { x: 600, y: 210 });
  const off = drop(layout(), { legacy: { x: 603, y: 207 } }, { mode: 'flex', guideTolerance: 0 });
  assert.equal(off.reason, 'fine');
  assert.deepEqual(off.positions.get('legacy'), { x: 600, y: 210 });
});

test('guides align with a scaled neighbor even off the lattice', () => {
  const pieces = [...layout(), { id: 'big', x: -700, y: 100, scale: 1.25 }];
  // big's bottom is 100 + 137.5 = 237.5; legacy's bottom (y + 110) within 6.
  const result = drop(pieces, { legacy: { x: 603, y: 124 } }, { mode: 'flex', guideTolerance: 6 });
  assert.equal(result.reason, 'guide');
  assert.equal(result.positions.get('legacy').y, 127.5);
  assert.equal(result.level, 'off-grid');
});

test('a guide landing that would overlap falls through to a free lattice point', () => {
  // Aligning utils' left edge with main (x = 0) at y = 20 would sit on main.
  const result = drop(layout(), { utils: { x: 3, y: 20 } }, { mode: 'flex', guideTolerance: 6 });
  assert.notEqual(result.reason, 'blocked');
  const landed = result.positions.get('utils');
  const overlapsMain = landed.x < 180 && landed.x + 180 > 0 && landed.y < 110 && landed.y + 110 > 0;
  assert.equal(overlapsMain, false);
});

test('a multi-selection moves rigidly by its bounds corner', () => {
  const result = drop(layout(), {
    db: { x: -297, y: 404 },
    cache: { x: -297, y: 604 },
  }, { mode: 'strict' });
  const db = result.positions.get('db');
  const cache = result.positions.get('cache');
  assert.equal(cache.y - db.y, 200, 'offsets kept');
  assert.ok(db.x % 100 === 0 && db.y % 100 === 0, 'the set corner is on a major intersection');
});

test('negative coordinates resolve deterministically', () => {
  const pieces = [{ id: 'a', x: 0, y: 0 }];
  const first = drop(pieces, { a: { x: -150, y: -150 } }, { mode: 'strict' });
  const second = drop(pieces, { a: { x: -150, y: -150 } }, { mode: 'strict' });
  assert.deepEqual(first.positions.get('a'), second.positions.get('a'));
  assert.deepEqual(first.positions.get('a'), { x: -200, y: -200 }, 'symmetric rounding away from zero');
  const zero = drop(pieces, { a: { x: -4, y: -4 } }, { mode: 'flex' });
  assert.ok(Object.is(zero.positions.get('a').x, 0));
});

test('a crowded neighborhood reports blocked instead of overlapping', () => {
  // Fill every major slot near the origin.
  const pieces = [];
  for (let i = -8; i <= 8; i++) {
    for (let j = -8; j <= 8; j++) pieces.push({ id: `n${i}_${j}`, x: i * 200, y: j * 200, scale: 1.2 });
  }
  pieces.push({ id: 'me', x: 5000, y: 5000 });
  const result = drop(pieces, { me: { x: 10, y: 10 } }, { mode: 'strict' });
  assert.equal(result.reason, 'blocked');
  assert.equal(result.positions, null);
});

test('hidden nodes are neither obstacles nor guide targets', () => {
  const pieces = [{ id: 'hidden', x: 0, y: 0 }, { id: 'me', x: 500, y: 500 }];
  const result = drop(pieces, { me: { x: 2, y: 3 } }, { mode: 'flex', guideTolerance: 6, hidden: new Set(['hidden']) });
  assert.equal(result.reason, 'fine');
  assert.deepEqual(result.positions.get('me'), { x: 0, y: 0 });
});

test('group drags skip occupancy and take the nearest lattice point', () => {
  const pieces = layout();
  const byId = new Map(pieces.map((p) => [p.id, p]));
  const members = [{ piece: byId.get('api'), position: { x: 20, y: 20 } }];
  const result = resolvePlacement({ members, obstacles: staticObstacles({ pieces, movingIds: ['api'] }), steps, mode: 'strict', occupancy: false });
  assert.deepEqual(result.positions.get('api'), { x: 0, y: 0 }, 'lands on main without a search');
});

test('guide lines: one per axis, spanning the nodes on the line; no seam line', () => {
  const obstacles = staticObstacles({ pieces: layout(), movingIds: ['format'] });
  // format docked flush right of utils at (380, 0).
  const lines = guideLinesFor({ x: 380, y: 0, width: 180, height: 110 }, obstacles);
  assert.deepEqual(lines, [{ axis: 'y', value: 0, lo: 0, hi: 560 }]);
});

test('nearestGuide prefers same-side edges on exact ties', () => {
  const obstacles = [{ x: 0, y: 0, width: 180, height: 110 }];
  const guide = nearestGuide({ x: 0, y: 300, width: 180, height: 110 }, 'x', obstacles, 0);
  assert.equal(guide.rank, 0);
  assert.equal(guide.value, 0);
});

test('a grown node parts the neighbor it now overlaps to the next major line (Strict)', () => {
  const pieces = [{ id: 'A', x: 0, y: 0, scale: 1.25 }, { id: 'B', x: 200, y: 0 }, { id: 'C', x: 0, y: 400 }];
  const moves = partOverlappedNeighbors({ pieces, pusherIds: ['A'], steps, mode: 'strict' });
  // A reaches x = 225; B moves right to the next major line, 300 — not flush.
  assert.deepEqual(moves, [{ id: 'B', dx: 100, dy: 0 }]);
});

test('Flex parts to the finest step, and pushes follow the shallowest overlap', () => {
  const pieces = [{ id: 'A', x: 0, y: 0, scale: 1.5 }, { id: 'B', x: 0, y: 150 }];
  // A is 270 x 165: B overlaps it 15 deep vertically, 180 horizontally.
  const moves = partOverlappedNeighbors({ pieces, pusherIds: ['A'], steps, mode: 'flex' });
  assert.deepEqual(moves, [{ id: 'B', dx: 0, dy: 20 }]);
});

test('parting cascades through a chain but stays bounded and skips hidden nodes', () => {
  const pieces = [
    { id: 'A', x: 0, y: 0, scale: 1.5 },
    { id: 'B', x: 200, y: 0 },
    { id: 'C', x: 380, y: 0 },
    { id: 'H', x: 100, y: 0 },
  ];
  const moves = partOverlappedNeighbors({ pieces, pusherIds: ['A'], steps, mode: 'strict', hiddenPieceIds: new Set(['H']) });
  const byId = Object.fromEntries(moves.map((m) => [m.id, m]));
  assert.equal(byId.B.dx, 100, 'B → 300');
  assert.equal(byId.C.dx, 120, 'C was reached by B (300 + 180 = 480) → 500');
  assert.equal(byId.H, undefined);
});

test('nothing overlapping, nothing parted', () => {
  assert.equal(partOverlappedNeighbors({ pieces: [{ id: 'A', x: 0, y: 0 }, { id: 'B', x: 400, y: 0 }], pusherIds: ['A'], steps, mode: 'strict' }), null);
});
