import test from 'node:test';
import assert from 'node:assert/strict';

import {
  distributeTerminals,
  separateCorridors,
  WIRE_TERMINAL_SPACING,
  TERMINAL_FACE_PAD,
  WIRE_CORRIDOR_SPACING,
} from '../../src/utils/wireSpacing.js';
import { anchorEdgePoint } from '../../src/utils/wireGeometry.js';

const PIECE_W = 180;
const PIECE_H = 110;

const pieceAnchor = (id, x, y) => ({ id, x, y, kind: 'piece', pieceId: id });
const wire = (id, sourceAnchor, sourceSide, targetAnchor, targetSide) => ({
  connection: { id },
  sourceAnchor,
  targetAnchor,
  sourceSide,
  targetSide,
});

// ---------------------------------------------------------------------------
// distributeTerminals (D3 — distributed stubs)
// ---------------------------------------------------------------------------

test('a lone wire on a face keeps the exact midpoint', () => {
  const w = wire(1, pieceAnchor(1, 0, 0), 'right', pieceAnchor(2, 400, 0), 'left');
  const terminals = distributeTerminals([w], PIECE_W, PIECE_H);
  assert.deepEqual(
    terminals.get(1).sourcePoint,
    anchorEdgePoint(w.sourceAnchor, 'right', PIECE_W, PIECE_H)
  );
  assert.deepEqual(
    terminals.get(1).targetPoint,
    anchorEdgePoint(w.targetAnchor, 'left', PIECE_W, PIECE_H)
  );
});

test('three wires into one face spread along it, centered on the midpoint', () => {
  const target = pieceAnchor(9, 600, 200);
  const wires = [
    wire('a', pieceAnchor(1, 0, 0), 'right', target, 'left'),
    wire('b', pieceAnchor(2, 0, 200), 'right', target, 'left'),
    wire('c', pieceAnchor(3, 0, 400), 'right', target, 'left'),
  ];
  const terminals = distributeTerminals(wires, PIECE_W, PIECE_H);
  const mid = anchorEdgePoint(target, 'left', PIECE_W, PIECE_H);
  const ys = ['a', 'b', 'c'].map((id) => terminals.get(id).targetPoint.y);

  // Ordered by source y (a above b above c), spaced by the terminal step.
  assert.deepEqual(ys, [
    mid.y - WIRE_TERMINAL_SPACING,
    mid.y,
    mid.y + WIRE_TERMINAL_SPACING,
  ]);
  // x stays on the face — the side is never re-sided.
  for (const id of ['a', 'b', 'c']) {
    assert.equal(terminals.get(id).targetPoint.x, mid.x);
  }
});

test('many wires compress the step to fit the face', () => {
  const target = pieceAnchor(9, 600, 0);
  const wires = Array.from({ length: 7 }, (_, i) =>
    wire(`w${i}`, pieceAnchor(i, 0, i * 120), 'right', target, 'left'));
  const terminals = distributeTerminals(wires, PIECE_W, PIECE_H);
  const ys = wires.map((w) => terminals.get(w.connection.id).targetPoint.y);

  const usable = PIECE_H - 2 * TERMINAL_FACE_PAD;
  const expectedStep = usable / 6; // < WIRE_TERMINAL_SPACING → compressed
  assert.ok(expectedStep < WIRE_TERMINAL_SPACING);
  for (let i = 1; i < ys.length; i++) {
    assert.ok(Math.abs(ys[i] - ys[i - 1] - expectedStep) < 1e-9);
  }
  // Whole spread stays inside the face pad.
  assert.ok(ys[0] >= 0 + TERMINAL_FACE_PAD - 1e-9);
  assert.ok(ys[ys.length - 1] <= PIECE_H - TERMINAL_FACE_PAD + 1e-9);
});

test('top/bottom faces distribute along x', () => {
  const target = pieceAnchor(9, 600, 300);
  const wires = [
    wire('a', pieceAnchor(1, 400, 0), 'bottom', target, 'top'),
    wire('b', pieceAnchor(2, 800, 0), 'bottom', target, 'top'),
  ];
  const terminals = distributeTerminals(wires, PIECE_W, PIECE_H);
  const mid = anchorEdgePoint(target, 'top', PIECE_W, PIECE_H);
  const xa = terminals.get('a').targetPoint.x;
  const xb = terminals.get('b').targetPoint.x;
  assert.equal(xb - xa, WIRE_TERMINAL_SPACING);
  assert.ok(xa < mid.x && xb > mid.x);
  assert.equal(terminals.get('a').targetPoint.y, mid.y);
});

// ---------------------------------------------------------------------------
// separateCorridors (R3/R5)
// ---------------------------------------------------------------------------

const routeOf = (points, routed = true) => ({ points, routed });

test('two wires sharing a corridor leg separate by the corridor step', () => {
  const routes = new Map([
    ['A', routeOf([
      { x: 0, y: 50, side: 'right' }, { x: 20, y: 50 }, { x: 20, y: 100 },
      { x: 300, y: 100 }, { x: 300, y: 50 }, { x: 320, y: 50, side: 'left' },
    ])],
    ['B', routeOf([
      { x: 0, y: 150, side: 'right' }, { x: 20, y: 150 }, { x: 20, y: 100 },
      { x: 300, y: 100 }, { x: 300, y: 150 }, { x: 320, y: 150, side: 'left' },
    ])],
  ]);
  const out = separateCorridors(routes, []);
  const yA = out.get('A').points[2].y;
  const yB = out.get('B').points[2].y;
  assert.equal(yB - yA, WIRE_CORRIDOR_SPACING);
  // Centered on the shared line.
  assert.equal((yA + yB) / 2, 100);
  // Legs stayed horizontal (both endpoints moved together).
  assert.equal(out.get('A').points[2].y, out.get('A').points[3].y);
});

test('terminal points and launch legs never move', () => {
  const routes = new Map([
    ['A', routeOf([
      { x: 0, y: 50, side: 'right' }, { x: 20, y: 50 }, { x: 20, y: 100 },
      { x: 300, y: 100 }, { x: 300, y: 50 }, { x: 320, y: 50, side: 'left' },
    ])],
    ['B', routeOf([
      { x: 0, y: 150, side: 'right' }, { x: 20, y: 150 }, { x: 20, y: 100 },
      { x: 300, y: 100 }, { x: 300, y: 150 }, { x: 320, y: 150, side: 'left' },
    ])],
  ]);
  const out = separateCorridors(routes, []);
  for (const id of ['A', 'B']) {
    assert.deepEqual(out.get(id).points[0], routes.get(id).points[0]);
    assert.deepEqual(out.get(id).points[5], routes.get(id).points[5]);
  }
});

test('an offset that would enter an obstacle is dropped for that wire', () => {
  const routes = new Map([
    ['A', routeOf([
      { x: 0, y: 50, side: 'right' }, { x: 20, y: 50 }, { x: 20, y: 100 },
      { x: 300, y: 100 }, { x: 300, y: 50 }, { x: 320, y: 50, side: 'left' },
    ])],
    ['B', routeOf([
      { x: 0, y: 150, side: 'right' }, { x: 20, y: 150 }, { x: 20, y: 100 },
      { x: 300, y: 100 }, { x: 300, y: 150 }, { x: 320, y: 150, side: 'left' },
    ])],
  ]);
  // A wall right above the corridor: A's upward offset would land inside it.
  const obstacle = { x: 100, y: 60, width: 100, height: 30 };
  const out = separateCorridors(routes, [obstacle]);
  assert.equal(out.get('A').points[2].y, 100); // dropped — stays on the line
  assert.equal(out.get('B').points[2].y, 100 + WIRE_CORRIDOR_SPACING / 2);
});

test('deterministic: repeated runs agree', () => {
  const build = () => new Map([
    ['A', routeOf([
      { x: 0, y: 50, side: 'right' }, { x: 20, y: 50 }, { x: 20, y: 100 },
      { x: 300, y: 100 }, { x: 300, y: 50 }, { x: 320, y: 50, side: 'left' },
    ])],
    ['B', routeOf([
      { x: 0, y: 150, side: 'right' }, { x: 20, y: 150 }, { x: 20, y: 100 },
      { x: 300, y: 100 }, { x: 300, y: 150 }, { x: 320, y: 150, side: 'left' },
    ])],
  ]);
  const a = separateCorridors(build(), []);
  const b = separateCorridors(build(), []);
  assert.deepEqual(
    [...a.entries()].map(([id, r]) => [id, r.points]),
    [...b.entries()].map(([id, r]) => [id, r.points])
  );
});

test('unrouted fallback wires are left untouched', () => {
  const routes = new Map([
    ['A', routeOf([{ x: 0, y: 0, side: 'right' }, { x: 300, y: 100, side: 'left' }], false)],
  ]);
  const out = separateCorridors(routes, []);
  assert.deepEqual(out.get('A'), routes.get('A'));
});
