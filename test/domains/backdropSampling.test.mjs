import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBackdropSampleRect } from '../../src/utils/backdropSampling.js';

const BASE = {
  absX: 100,
  absY: 50,
  absScaleX: 1,
  absScaleY: 1,
  pixelRatio: 1,
  canvasWidth: 2000,
  canvasHeight: 1000,
  width: 180,
  height: 110,
};

const approx = (a, b, eps = 1e-9) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${a} ≈ ${b}`);

// ---------------------------------------------------------------------------
// Identity and transform handling
// ---------------------------------------------------------------------------

test('scale 1 / ratio 1: source is the piece rect, destination is full local bounds', () => {
  const r = computeBackdropSampleRect(BASE);
  assert.deepEqual(r, { sx: 100, sy: 50, sw: 180, sh: 110, dx: 0, dy: 0, dw: 180, dh: 110 });
});

test('zoom is NOT re-applied to the already-scaled absolute position', () => {
  // At stage zoom 2 a piece whose canvas-space x is 100 reports absX = 200
  // (screen px). The regression this guards: multiplying absX by the stage
  // scale again (the old code) would sample from x = 400.
  const r = computeBackdropSampleRect({
    ...BASE,
    absX: 200,
    absY: 100,
    absScaleX: 2,
    absScaleY: 2,
  });
  assert.deepEqual(r, { sx: 200, sy: 100, sw: 360, sh: 220, dx: 0, dy: 0, dw: 180, dh: 110 });
});

test('pixelRatio scales the source rect but not the local destination', () => {
  const r = computeBackdropSampleRect({ ...BASE, pixelRatio: 1.5 });
  assert.deepEqual(r, { sx: 150, sy: 75, sw: 270, sh: 165, dx: 0, dy: 0, dw: 180, dh: 110 });
});

test('zoom and pixelRatio compose', () => {
  const r = computeBackdropSampleRect({
    ...BASE,
    absX: 200,
    absY: 100,
    absScaleX: 2,
    absScaleY: 2,
    pixelRatio: 2,
    canvasWidth: 4000,
    canvasHeight: 2000,
  });
  assert.deepEqual(r, { sx: 400, sy: 200, sw: 720, sh: 440, dx: 0, dy: 0, dw: 180, dh: 110 });
});

// ---------------------------------------------------------------------------
// Clamping (edge pieces keep their glass)
// ---------------------------------------------------------------------------

test('overhang past the left edge clamps the source and offsets the destination', () => {
  const r = computeBackdropSampleRect({ ...BASE, absX: -40 });
  // 40 CSS px hang off-canvas: sample starts at 0 and the drawn region starts
  // 40 local units into the piece.
  assert.deepEqual(r, { sx: 0, sy: 50, sw: 140, sh: 110, dx: 40, dy: 0, dw: 140, dh: 110 });
});

test('overhang past the bottom-right clamps width/height without moving the origin', () => {
  const r = computeBackdropSampleRect({
    ...BASE,
    absX: 1900,
    absY: 950,
  });
  assert.deepEqual(r, { sx: 1900, sy: 950, sw: 100, sh: 50, dx: 0, dy: 0, dw: 100, dh: 50 });
});

test('clamped destination maps through zoom and pixelRatio consistently', () => {
  const r = computeBackdropSampleRect({
    ...BASE,
    absX: -30,
    absScaleX: 2,
    absScaleY: 2,
    pixelRatio: 2,
  });
  assert.equal(r.sx, 0);
  // 30 CSS px of overhang = 15 local units at scale 2.
  approx(r.dx, 15);
  approx(r.dw, 180 - 15);
  assert.equal(r.sw, Math.round(( -30 + 180 * 2) * 2));
});

test('piece fully off-canvas returns null', () => {
  assert.equal(computeBackdropSampleRect({ ...BASE, absX: -500 }), null);
  assert.equal(computeBackdropSampleRect({ ...BASE, absY: 5000 }), null);
});

// ---------------------------------------------------------------------------
// Degenerate inputs
// ---------------------------------------------------------------------------

test('non-finite or non-positive inputs return null', () => {
  assert.equal(computeBackdropSampleRect({ ...BASE, absX: NaN }), null);
  assert.equal(computeBackdropSampleRect({ ...BASE, absScaleX: 0 }), null);
  assert.equal(computeBackdropSampleRect({ ...BASE, pixelRatio: 0 }), null);
  assert.equal(computeBackdropSampleRect({ ...BASE, width: 0 }), null);
  assert.equal(computeBackdropSampleRect({ ...BASE, canvasWidth: Infinity }), null);
});

test('sub-pixel positions produce integer source rects and a consistent destination', () => {
  const r = computeBackdropSampleRect({ ...BASE, absX: 100.4, absY: 49.6 });
  assert.equal(r.sx, 100);
  assert.equal(r.sy, 50);
  assert.ok(Number.isInteger(r.sw) && Number.isInteger(r.sh));
  // Destination re-derives from the rounded source, so drawn content stays
  // registered with what actually sits behind the piece.
  approx(r.dx, 100 - 100.4);
  approx(r.dy, 50 - 49.6);
});
