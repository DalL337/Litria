import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeWireRoutes,
  buildDragWireRoutes,
} from '../../src/app/selectors/wireRoutes.js';

const PIECE_W = 180;
const PIECE_H = 110;

const idAnchor = (id, x, y) => ({ id, x, y, kind: 'piece', pieceId: id });
const wire = (id, sourceAnchor, sourceSide, targetAnchor, targetSide) => ({
  connection: { id },
  sourceAnchor,
  targetAnchor,
  sourceSide,
  targetSide,
});
const pieceObstacle = (id, x, y, w = PIECE_W, h = PIECE_H) =>
  ({ x, y, width: w, height: h, kind: 'piece', pieceId: id });

// ---------------------------------------------------------------------------
// S7 — previous-route stability bias
// ---------------------------------------------------------------------------

test('an unrelated obstacle change never flaps an untouched wire', () => {
  const wires = [wire('w', idAnchor('a', 0, 0), 'right', idAnchor('b', 800, 0), 'left')];
  const blocker = pieceObstacle('blk', 380, -30, PIECE_W, PIECE_H);
  const first = computeWireRoutes({
    wires, obstacles: [blocker], pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });

  // A distant obstacle appears — the wire's own corridor is untouched, but
  // the induced GRID changes; without the bias the route could reshape.
  const distant = pieceObstacle('far', 300, 900, PIECE_W, PIECE_H);
  const second = computeWireRoutes({
    wires, obstacles: [blocker, distant], pieceWidth: PIECE_W, pieceHeight: PIECE_H,
    previousRoutes: first,
  });
  assert.deepEqual(second.get('w').points, first.get('w').points);
});

test('an obstacle parked on the old corridor forces a reroute', () => {
  const wires = [wire('w', idAnchor('a', 0, 0), 'right', idAnchor('b', 800, 0), 'left')];
  const first = computeWireRoutes({
    wires, obstacles: [], pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  // Straight route along y=55; drop a tile right on it.
  const squatter = pieceObstacle('sq', 380, 0, PIECE_W, PIECE_H);
  const second = computeWireRoutes({
    wires, obstacles: [squatter], pieceWidth: PIECE_W, pieceHeight: PIECE_H,
    previousRoutes: first,
  });
  assert.notDeepEqual(second.get('w').points, first.get('w').points);
  assert.equal(second.get('w').routed, true);
});

test('a moved terminal invalidates the previous route', () => {
  const before = [wire('w', idAnchor('a', 0, 0), 'right', idAnchor('b', 800, 0), 'left')];
  const first = computeWireRoutes({
    wires: before, obstacles: [], pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  const after = [wire('w', idAnchor('a', 0, 0), 'right', idAnchor('b', 800, 240), 'left')];
  const second = computeWireRoutes({
    wires: after, obstacles: [], pieceWidth: PIECE_W, pieceHeight: PIECE_H,
    previousRoutes: first,
  });
  const end = second.get('w').points.at(-1);
  assert.equal(end.y, 240 + PIECE_H / 2);
});

test('reused routes shed stale hops and re-derive from current loudness', () => {
  const wires = [
    wire('h', idAnchor('a', 0, 0), 'right', idAnchor('b', 800, 0), 'left'),
    wire('v', idAnchor('c', 300, -300), 'bottom', idAnchor('d', 300, 300), 'top'),
  ];
  const base = { wires, obstacles: [], pieceWidth: PIECE_W, pieceHeight: PIECE_H };
  const first = computeWireRoutes({ ...base, loudConnectionIds: new Set(['v']) });
  assert.ok(first.get('h').hops?.length > 0, 'quiet wire hops while v is loud');

  const second = computeWireRoutes({
    ...base, loudConnectionIds: new Set(), previousRoutes: first,
  });
  assert.deepEqual(second.get('h').points, first.get('h').points); // reused
  assert.equal(second.get('h').hops, undefined); // hops re-derived: none now
});

// ---------------------------------------------------------------------------
// S7 — D6 drag overlay
// ---------------------------------------------------------------------------

test('drag overlay: unmoved wires keep their settled route by identity', () => {
  const wires = [wire('w', idAnchor('a', 0, 0), 'right', idAnchor('b', 800, 0), 'left')];
  const settled = computeWireRoutes({
    wires, obstacles: [], pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  const overlay = buildDragWireRoutes({
    wires, settledRoutes: settled, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  assert.equal(overlay.get('w'), settled.get('w')); // same object — zero work
});

test('drag overlay: a wire whose anchor moved follows with a cheap pair', () => {
  const wires = [wire('w', idAnchor('a', 0, 0), 'right', idAnchor('b', 800, 0), 'left')];
  const settled = computeWireRoutes({
    wires, obstacles: [], pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  const dragged = [wire('w', idAnchor('a', 40, 60), 'right', idAnchor('b', 800, 0), 'left')];
  const overlay = buildDragWireRoutes({
    wires: dragged, settledRoutes: settled, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  const r = overlay.get('w');
  assert.equal(r.drag, true);
  assert.equal(r.routed, true); // following the hand, not failing — no D4 dim
  assert.equal(r.points.length, 2); // the cheap direct pair
  assert.deepEqual(r.points[0], { x: 40 + PIECE_W, y: 60 + PIECE_H / 2, side: 'right' });
});

// ---------------------------------------------------------------------------
// G6 — measurement (ADR-025 follow-up): routing cost at canvas scale
// ---------------------------------------------------------------------------

test('G6: a 64-piece / 80-wire canvas routes within the frame-friendly budget', (t) => {
  // Synthetic canvas: 8×8 grid of pieces, 80 deterministic wires.
  const pieces = [];
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      pieces.push(idAnchor(`p${r}-${c}`, c * 280, r * 190));
    }
  }
  const obstacles = pieces.map((p) => pieceObstacle(p.id, p.x, p.y));
  const wires = [];
  for (let i = 0; i < 80; i++) {
    const src = pieces[(i * 7) % 64];
    const tgt = pieces[(i * 13 + 21) % 64];
    if (src === tgt) continue;
    wires.push(wire(`w${i}`, src, 'right', tgt, 'left'));
  }

  const t0 = performance.now();
  const routes = computeWireRoutes({
    wires, obstacles, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  const cold = performance.now() - t0;

  const t1 = performance.now();
  computeWireRoutes({
    wires, obstacles, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
    previousRoutes: routes,
  });
  const warm = performance.now() - t1;

  t.diagnostic(`G6 cold full-route: ${cold.toFixed(1)}ms for ${wires.length} wires / ${obstacles.length} obstacles`);
  t.diagnostic(`G6 warm (stability-bias) re-route: ${warm.toFixed(1)}ms`);
  assert.ok(routes.size > 70, 'routes computed');
  // Budget: cold pass is a structural-change event (not per-frame); the
  // warm pass is what a typical settled update costs.
  assert.ok(cold < 1000, `cold ${cold}ms`);
  assert.ok(warm < 100, `warm ${warm}ms`);
});
