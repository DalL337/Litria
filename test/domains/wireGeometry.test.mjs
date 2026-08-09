import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeWirePoints,
  buildWireCurve,
  WIRE_LAUNCH_FRACTION,
  WIRE_LAUNCH_MIN,
  WIRE_LAUNCH_MAX,
  WIRE_FILLET_RADIUS,
} from '../../src/utils/wireGeometry.js';

// Parse the deterministic "M x y C c1x c1y c2x c2y ex ey" data string into numbers.
function parsePath(data) {
  const n = data.match(/-?\d+(?:\.\d+)?/g).map(Number);
  return {
    start: { x: n[0], y: n[1] },
    c1: { x: n[2], y: n[3] },
    c2: { x: n[4], y: n[5] },
    end: { x: n[6], y: n[7] },
  };
}

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------------------------------------------------------------------------
// computeWirePoints — the geometry seam (today: exactly [start, end])
// ---------------------------------------------------------------------------

test('computeWirePoints returns [start, end] carrying each chosen side', () => {
  const pts = computeWirePoints({ x: 0, y: 0 }, 'right', { x: 100, y: 40 }, 'left');
  assert.deepEqual(pts, [
    { x: 0, y: 0, side: 'right' },
    { x: 100, y: 40, side: 'left' },
  ]);
});

// ---------------------------------------------------------------------------
// buildWireCurve — the drawing seam
// ---------------------------------------------------------------------------

test('buildWireCurve returns null for fewer than two points', () => {
  assert.equal(buildWireCurve(null), null);
  assert.equal(buildWireCurve([]), null);
  assert.equal(buildWireCurve([{ x: 0, y: 0, side: 'right' }]), null);
});

test('buildWireCurve emits a single cubic M…C… path', () => {
  const curve = buildWireCurve(computeWirePoints({ x: 0, y: 0 }, 'right', { x: 300, y: 0 }, 'left'));
  assert.match(curve.data, /^M -?\d/);
  assert.match(curve.data, / C /);
});

test('pointAt(0) is the start and pointAt(1) is the end (exact)', () => {
  const curve = buildWireCurve(computeWirePoints({ x: 10, y: 20 }, 'right', { x: 310, y: 220 }, 'left'));
  const a = curve.pointAt(0);
  const b = curve.pointAt(1);
  assert.ok(approx(a.x, 10) && approx(a.y, 20));
  assert.ok(approx(b.x, 310) && approx(b.y, 220));
});

test('tangent leaves the source outward and arrives at the target inward (normal-launch)', () => {
  // source right (+x normal), target bottom (+y normal).
  const curve = buildWireCurve(computeWirePoints({ x: 0, y: 0 }, 'right', { x: 200, y: 200 }, 'bottom'));
  const t0 = curve.pointAt(0).tangent;   // leaves source along +startNormal (+x)
  const t1 = curve.pointAt(1).tangent;   // travel direction ARRIVING into target is -endNormal (-y)
  assert.ok(approx(t0.x, 1) && approx(t0.y, 0), `t0=${JSON.stringify(t0)}`);
  assert.ok(approx(t1.x, 0) && approx(t1.y, -1), `t1=${JSON.stringify(t1)}`);
});

test('control-point offset scales with anchor distance between the clamps', () => {
  // Horizontal right->left wire of length D: c1 = start + (offset, 0), so c1.x = offset.
  const mid = buildWireCurve(computeWirePoints({ x: 0, y: 0 }, 'right', { x: 200, y: 0 }, 'left'));
  const { c1 } = parsePath(mid.data);
  assert.ok(approx(c1.x, 200 * WIRE_LAUNCH_FRACTION), `expected ${200 * WIRE_LAUNCH_FRACTION}, got ${c1.x}`);
});

test('control-point offset clamps to the min on short wires', () => {
  const shortWire = buildWireCurve(computeWirePoints({ x: 0, y: 0 }, 'right', { x: 20, y: 0 }, 'left'));
  const { c1 } = parsePath(shortWire.data);
  // 20 * 0.5 = 10 < min -> clamped up to WIRE_LAUNCH_MIN.
  assert.ok(approx(c1.x, WIRE_LAUNCH_MIN), `expected ${WIRE_LAUNCH_MIN}, got ${c1.x}`);
});

test('control-point offset clamps to the max on long wires', () => {
  const longWire = buildWireCurve(computeWirePoints({ x: 0, y: 0 }, 'right', { x: 2000, y: 0 }, 'left'));
  const { c1 } = parsePath(longWire.data);
  // 2000 * 0.5 = 1000 > max -> clamped down to WIRE_LAUNCH_MAX.
  assert.ok(approx(c1.x, WIRE_LAUNCH_MAX), `expected ${WIRE_LAUNCH_MAX}, got ${c1.x}`);
});

// ---------------------------------------------------------------------------
// buildWireCurve — routed polylines (3+ points, ADR-025 S2)
// ---------------------------------------------------------------------------

test('polyline path uses line segments and quadratic fillets, not a cubic', () => {
  const curve = buildWireCurve([
    { x: 0, y: 0, side: 'right' },
    { x: 100, y: 0 },
    { x: 100, y: 100, side: 'left' },
  ]);
  assert.match(curve.data, /^M 0 0/);
  assert.match(curve.data, / L /);
  assert.match(curve.data, / Q /);
  assert.ok(!/ C /.test(curve.data));
});

test('polyline endpoints are exact', () => {
  const curve = buildWireCurve([
    { x: 10, y: 20 }, { x: 200, y: 20 }, { x: 200, y: 300 }, { x: 400, y: 300 },
  ]);
  const a = curve.pointAt(0);
  const b = curve.pointAt(1);
  assert.ok(approx(a.x, 10) && approx(a.y, 20));
  assert.ok(approx(b.x, 400) && approx(b.y, 300));
});

test('fillet pulls the corner off the vertex by the fillet radius', () => {
  const curve = buildWireCurve([
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
  ]);
  // The path should reach (100 - r, 0) then quad through the vertex.
  assert.match(curve.data, new RegExp(`L ${100 - WIRE_FILLET_RADIUS} 0 `));
  assert.match(curve.data, new RegExp(`Q 100 0 100 ${WIRE_FILLET_RADIUS}`));
});

test('fillet radius clamps to half the shortest adjacent leg', () => {
  // 10px legs → fillet r = 5, not 12
  const curve = buildWireCurve([
    { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
  ]);
  assert.match(curve.data, /L 5 0 /);
  assert.match(curve.data, /Q 10 0 10 5/);
});

test('pointAt is arc-length uniform: equal t steps cover equal distances', () => {
  const curve = buildWireCurve([
    { x: 0, y: 0 }, { x: 300, y: 0 }, { x: 300, y: 300 },
  ]);
  const STEPS = 40;
  const dists = [];
  let prev = curve.pointAt(0);
  for (let i = 1; i <= STEPS; i++) {
    const p = curve.pointAt(i / STEPS);
    dists.push(Math.hypot(p.x - prev.x, p.y - prev.y));
    prev = p;
  }
  const min = Math.min(...dists);
  const max = Math.max(...dists);
  // Chord lengths through the fillet dip slightly below leg chords; a 15%
  // band still catches any parameterization that is not arc-length.
  assert.ok((max - min) / max < 0.15, `spread ${(max - min) / max}`);
});

test('tangents follow the segment directions through an L corner', () => {
  const curve = buildWireCurve([
    { x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 200 },
  ]);
  const early = curve.pointAt(0.1);
  assert.ok(approx(early.tangent.x, 1, 1e-6) && approx(early.tangent.y, 0, 1e-6));
  const late = curve.pointAt(0.9);
  assert.ok(approx(late.tangent.x, 0, 1e-6) && approx(late.tangent.y, 1, 1e-6));
});

test('collinear interior vertices pass straight through without fillets', () => {
  const curve = buildWireCurve([
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 },
  ]);
  assert.ok(!/ Q /.test(curve.data));
  const mid = curve.pointAt(0.5);
  assert.ok(approx(mid.x, 100) && approx(mid.y, 0));
});

test('consecutive duplicate points are deduped, degenerate lists rejected', () => {
  const curve = buildWireCurve([
    { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 },
  ]);
  assert.ok(curve); // still a valid L route
  const end = curve.pointAt(1);
  assert.ok(approx(end.x, 100) && approx(end.y, 100));
});
