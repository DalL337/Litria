import test from 'node:test';
import assert from 'node:assert/strict';

import {
  routeOrthogonal,
  WIRE_CLEARANCE,
} from '../../src/utils/orthogonalRouter.js';

// Segment-vs-inflated-rect interior check mirroring the router's blocking
// rule, used to assert routes actually avoid what they claim to avoid.
function pathAvoids(points, obstacles, clearance = WIRE_CLEARANCE - 0.5) {
  const rects = obstacles.map((o) => ({
    left: o.x - clearance,
    top: o.y - clearance,
    right: o.x + o.width + clearance,
    bottom: o.y + o.height + clearance,
  }));
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a.x !== b.x && a.y !== b.y) return false; // non-orthogonal leg
    for (const r of rects) {
      if (a.y === b.y) {
        const [lo, hi] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
        if (a.y > r.top && a.y < r.bottom && hi > r.left && lo < r.right) return false;
      } else {
        const [lo, hi] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
        if (a.x > r.left && a.x < r.right && hi > r.top && lo < r.bottom) return false;
      }
    }
  }
  return true;
}

const route = (overrides = {}) => routeOrthogonal({
  startPoint: { x: 180, y: 55 },
  startSide: 'right',
  endPoint: { x: 600, y: 55 },
  endSide: 'left',
  obstacles: [],
  ...overrides,
});

test('clear field: aligned anchors route straight through', () => {
  const points = route();
  assert.ok(points);
  assert.deepEqual(points[0], { x: 180, y: 55, side: 'right' });
  assert.deepEqual(points[points.length - 1], { x: 600, y: 55, side: 'left' });
  // Straight shot: every point shares y — no corners appear in a clear field.
  assert.ok(points.every((p) => p.y === 55));
});

test('route launches along the chosen face normal', () => {
  const points = route({ startSide: 'bottom', endPoint: { x: 600, y: 400 }, endSide: 'left' });
  // Second point must sit directly below the start (bottom normal).
  assert.equal(points[1].x, 180);
  assert.ok(points[1].y > 55);
});

test('an obstacle between the anchors is routed around', () => {
  const obstacle = { x: 330, y: 0, width: 180, height: 110 };
  const points = route({ obstacles: [obstacle] });
  assert.ok(points, 'route exists');
  assert.ok(points.length > 2, 'detour has corners');
  assert.ok(pathAvoids(points, [obstacle]), 'no leg crosses the inflated obstacle');
  // Endpoints still exact.
  assert.deepEqual(points[0], { x: 180, y: 55, side: 'right' });
  assert.deepEqual(points[points.length - 1], { x: 600, y: 55, side: 'left' });
});

test('routes thread the gap between two obstacles when one exists', () => {
  // Two tiles stacked with a gap between them, source/target on either side.
  const obstacles = [
    { x: 330, y: -200, width: 180, height: 110 },
    { x: 330, y: -40, width: 180, height: 110 },   // gap band y ∈ (70+c, ...) below
  ];
  const points = route({ obstacles });
  assert.ok(points);
  assert.ok(pathAvoids(points, obstacles));
});

test('walled-in target returns null (caller owns the fallback)', () => {
  const endPoint = { x: 600, y: 55 };
  const wall = 40; // thick enough that no grid line passes through
  const obstacles = [
    { x: 500, y: -100, width: wall, height: 320 },  // left wall
    { x: 700, y: -100, width: wall, height: 320 },  // right wall
    { x: 500, y: -100, width: 240, height: wall },  // top
    { x: 500, y: 180, width: 240, height: wall },   // bottom
  ];
  const points = route({ endPoint, obstacles });
  assert.equal(points, null);
});

test('deterministic: identical inputs yield identical routes', () => {
  const obstacles = [
    { x: 330, y: 0, width: 180, height: 110 },
    { x: 330, y: 160, width: 180, height: 110 },
  ];
  const a = route({ obstacles });
  const b = route({ obstacles });
  assert.deepEqual(a, b);
});

test('stub buried in a neighbor clearance zone returns null', () => {
  // An obstacle pressed against the start face swallows the launch stub.
  const obstacles = [{ x: 185, y: 0, width: 180, height: 110 }];
  const points = route({ obstacles });
  assert.equal(points, null);
});

// ---------------------------------------------------------------------------
// S6 — escalation ladder rung 2: flush clusters route around the perimeter
// ---------------------------------------------------------------------------

test('flush neighbors act as one merged obstacle — the route hugs the perimeter', () => {
  // Two tiles pressed flush (no gap): no grid corridor exists between them,
  // so a wire from left of the pair to right of it must round the outside.
  const cluster = [
    { x: 330, y: 0, width: 180, height: 110 },
    { x: 330, y: 110, width: 180, height: 110 }, // flush below the first
  ];
  const points = routeOrthogonal({
    startPoint: { x: 180, y: 110 },
    startSide: 'right',
    endPoint: { x: 660, y: 110 },
    endSide: 'left',
    obstacles: cluster,
  });
  assert.ok(points, 'route exists');
  assert.ok(pathAvoids(points, cluster), 'no leg crosses either tile or the flush seam');
  // The route never passes through the flush boundary band (y=110 inside
  // the merged silhouette x-range) — it goes over the top or under the
  // bottom of the PAIR.
  const passesSeam = points.some((p, i) => {
    const q = points[i + 1];
    if (!q || p.y !== q.y || p.y !== 110) return false;
    const [lo, hi] = p.x < q.x ? [p.x, q.x] : [q.x, p.x];
    return hi > 330 && lo < 510;
  });
  assert.equal(passesSeam, false);
});

// ---------------------------------------------------------------------------
// Own-endpoint CORE obstacles (post live-verify fix): never through a body
// ---------------------------------------------------------------------------

test('coreOnly obstacles block bodies but allow the clearance zone', () => {
  // Tight 16px gap, offset targets: the jog rides INSIDE what would be the
  // clearance zone of the core rect — legal for coreOnly, blocked for full.
  const core = { x: 80, y: 126, width: 180, height: 110, coreOnly: true };
  const points = routeOrthogonal({
    startPoint: { x: 90, y: 110 },
    startSide: 'bottom',
    endPoint: { x: 170, y: 126 },
    endSide: 'top',
    obstacles: [core],
  });
  assert.ok(points, 'route exists through the clearance zone');
  // No leg may enter the core interior (inflated by 1).
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (i === 0 || i === points.length - 2) continue; // terminal legs
    if (a.y === b.y) {
      const [lo, hi] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
      assert.ok(!(a.y > 127 && a.y < 235 && hi > 81 && lo < 259), `leg ${i} inside core`);
    }
  }
});

test('inverted faces wrap around the body instead of cutting through it', () => {
  // B overlaps upward: B.top is ABOVE the source terminal. The wire must
  // round B's outside and enter B.top from above — never cross B's body.
  const B = { x: 80, y: 70, width: 180, height: 110, coreOnly: true };
  const points = routeOrthogonal({
    startPoint: { x: 90, y: 110 },   // A.bottom terminal (A excluded, above)
    startSide: 'bottom',
    endPoint: { x: 170, y: 70 },     // B.top terminal
    endSide: 'top',
    obstacles: [B],
  });
  if (points) {
    // Interior legs stay outside B's core.
    for (let i = 1; i < points.length - 2; i++) {
      const a = points[i];
      const b = points[i + 1];
      if (a.y === b.y) {
        const [lo, hi] = a.x < b.x ? [a.x, b.x] : [b.x, a.x];
        assert.ok(!(a.y > 71 && a.y < 179 && hi > 81 && lo < 259), `leg ${i} through body`);
      } else {
        const [lo, hi] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
        assert.ok(!(a.x > 81 && a.x < 259 && hi > 71 && lo < 179), `leg ${i} through body`);
      }
    }
    // Entry into B.top arrives from ABOVE the body.
    const approach = points[points.length - 2];
    assert.ok(approach.y <= 70, `approach ${approach.y} must come from above B.top`);
  } else {
    // Null (stub buried in the core) is also acceptable — D4 fallback.
    assert.equal(points, null);
  }
});
