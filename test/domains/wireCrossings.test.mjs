import test from 'node:test';
import assert from 'node:assert/strict';

import { computeWireHops, WIRE_HOP_RADIUS } from '../../src/utils/wireCrossings.js';
import { buildWireCurve } from '../../src/utils/wireGeometry.js';
import {
  resolveWireAppearance,
  WIRE_UNROUTED_DIM_OPACITY,
  WIRE_FOCUS_DIM_OPACITY,
} from '../../src/utils/wireAppearance.js';

const route = (points, routed = true) => ({ points, routed });

// A horizontal quiet wire at y=100 crossed by a vertical loud wire at x=200.
const crossingRoutes = () => new Map([
  ['quiet', route([
    { x: 0, y: 100, side: 'right' }, { x: 400, y: 100, side: 'left' },
    { x: 400, y: 100 }, // padded so length>2 (routed polyline shape)
  ])],
  ['loud', route([
    { x: 200, y: 0, side: 'bottom' }, { x: 200, y: 300, side: 'top' },
    { x: 200, y: 300 },
  ])],
]);

test('a quiet wire hops a loud wire at their crossing', () => {
  const hops = computeWireHops(crossingRoutes(), new Set(['loud']));
  assert.deepEqual(hops.get('quiet'), [{ x: 200, y: 100, axis: 'h' }]);
  assert.ok(!hops.has('loud'));
});

test('symmetric crossings stay plain — both quiet or both loud', () => {
  assert.equal(computeWireHops(crossingRoutes(), new Set()).size, 0);
  assert.equal(computeWireHops(crossingRoutes(), new Set(['quiet', 'loud'])).size, 0);
});

test('ownership follows route-time loudness, whichever wire is loud', () => {
  const hops = computeWireHops(crossingRoutes(), new Set(['quiet']));
  // Now the vertical wire is the quiet one and hops the horizontal.
  assert.deepEqual(hops.get('loud'), [{ x: 200, y: 100, axis: 'v' }]);
  assert.ok(!hops.has('quiet'));
});

test('T-touches and joints are not crossings', () => {
  const routes = new Map([
    ['quiet', route([
      { x: 0, y: 100, side: 'right' }, { x: 200, y: 100 }, { x: 200, y: 300, side: 'top' },
    ])],
    // Loud wire's leg ENDS on the quiet wire's line — a touch, not a cross.
    ['loud', route([
      { x: 200, y: 0, side: 'bottom' }, { x: 200, y: 100, side: 'top' }, { x: 210, y: 100 },
    ])],
  ]);
  const hops = computeWireHops(routes, new Set(['loud']));
  assert.equal(hops.size, 0);
});

test('unrouted fallback wires never hop or get hopped', () => {
  const routes = crossingRoutes();
  routes.set('quiet', { ...routes.get('quiet'), routed: false });
  const hops = computeWireHops(routes, new Set(['loud']));
  assert.equal(hops.size, 0);
});

// ---------------------------------------------------------------------------
// Hop rendering (draw job)
// ---------------------------------------------------------------------------

test('the draw job bridges a hop with a quad bump and keeps endpoints exact', () => {
  const curve = buildWireCurve(
    [{ x: 0, y: 100, side: 'right' }, { x: 200, y: 100 }, { x: 400, y: 100 }, { x: 400, y: 300, side: 'top' }],
    { hops: [{ x: 200, y: 100, axis: 'h' }] }
  );
  // Bump: line to (200-r), quad through apex above the line, line onward.
  assert.match(curve.data, new RegExp(`L ${200 - WIRE_HOP_RADIUS} 100`));
  assert.match(curve.data, new RegExp(`Q 200 ${100 - 2 * WIRE_HOP_RADIUS} ${200 + WIRE_HOP_RADIUS} 100`));
  const start = curve.pointAt(0);
  const end = curve.pointAt(1);
  assert.ok(Math.abs(start.x - 0) < 1e-9);
  assert.ok(Math.abs(end.y - 300) < 1e-9);
});

test('vertical hops bulge right', () => {
  const curve = buildWireCurve(
    [{ x: 100, y: 0, side: 'bottom' }, { x: 100, y: 200 }, { x: 100, y: 400 }, { x: 300, y: 400, side: 'left' }],
    { hops: [{ x: 100, y: 200, axis: 'v' }] }
  );
  assert.match(curve.data, new RegExp(`Q ${100 + 2 * WIRE_HOP_RADIUS} 200 100 ${200 + WIRE_HOP_RADIUS}`));
});

// ---------------------------------------------------------------------------
// D4 — unroutable fallback appearance
// ---------------------------------------------------------------------------

test('an unrouted wire de-emphasizes at rest', () => {
  const a = resolveWireAppearance({ syntaxStatus: 'resolved', isUnrouted: true });
  assert.equal(a.opacity, WIRE_UNROUTED_DIM_OPACITY);
});

test('attention restores an unrouted wire to full presence', () => {
  const hovered = resolveWireAppearance({ syntaxStatus: 'resolved', isUnrouted: true, isHovered: true });
  assert.equal(hovered.opacity, 1);
  const selected = resolveWireAppearance({ syntaxStatus: 'resolved', isUnrouted: true, isSelected: true });
  assert.equal(selected.opacity, 1);
});

test('unrouted and focus-swap dims compose multiplicatively', () => {
  const a = resolveWireAppearance({ syntaxStatus: 'resolved', isUnrouted: true, isFocusDimmed: true });
  assert.ok(Math.abs(a.opacity - WIRE_UNROUTED_DIM_OPACITY * WIRE_FOCUS_DIM_OPACITY) < 1e-12);
});

test('a straight 2-point route still bridges its hops', () => {
  const curve = buildWireCurve(
    [{ x: 0, y: 100, side: 'right' }, { x: 400, y: 100, side: 'left' }],
    { hops: [{ x: 200, y: 100, axis: 'h' }] }
  );
  assert.match(curve.data, /Q 200 88 206 100/);
  assert.ok(!/ C /.test(curve.data)); // polyline path, not the cubic
});
