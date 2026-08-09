import test from 'node:test';
import assert from 'node:assert/strict';

import { chevronPoints } from '../../src/utils/wireChevronGeometry.js';

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

test('chevronPoints: apex is swept forward along the tangent, wings back', () => {
  // Point at (100, 100), tangent +x, half-size 10.
  const pts = chevronPoints({ x: 100, y: 100, tangent: { x: 1, y: 0 } }, 10);
  const [w1x, w1y, apx, apy, w2x, w2y] = pts;

  // Apex leads in +x; both wings trail in -x (apex is "ahead" of the wings).
  assert.ok(apx > w1x && apx > w2x, `apex ${apx} should lead wings ${w1x}/${w2x}`);
  assert.ok(approx(apx, 110) && approx(apy, 100));

  // Wings straddle the tangent symmetrically (one +y, one -y), same x.
  assert.ok(approx(w1x, 90) && approx(w2x, 90));
  assert.ok(approx(w1y, 110) && approx(w2y, 90));
});

test('chevronPoints: orients to a vertical tangent (points +y)', () => {
  const [w1x, w1y, apx, apy, w2x, w2y] = chevronPoints(
    { x: 0, y: 0, tangent: { x: 0, y: 1 } },
    10,
  );
  // Apex leads in +y; wings trail in -y and straddle in x.
  assert.ok(apy > w1y && apy > w2y);
  assert.ok(approx(apx, 0) && approx(apy, 10));
  assert.ok(approx(w1y, -10) && approx(w2y, -10));
  assert.ok(approx(w1x, -10) && approx(w2x, 10));
});
