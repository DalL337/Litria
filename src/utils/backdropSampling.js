/**
 * backdropSampling.js — sample-rect math for the glass backdrop-blur pipeline.
 *
 * Pure geometry, no Konva dependency. Computes which region of a layer's
 * backing canvas sits behind a piece, and where the (possibly clamped) region
 * lands in the piece's local coordinate space.
 *
 * Coordinate contract (see brief-glass-backdrop-sampling.md, Cause A):
 *  - absX/absY/absScaleX/absScaleY come from Konva's getAbsolutePosition() /
 *    getAbsoluteScale() and therefore ALREADY include every ancestor
 *    transform — stage pan, stage zoom, and the piece's own scale. Do not
 *    multiply by stage scale again.
 *  - The backing canvas is sized in DEVICE pixels (CSS size × pixelRatio);
 *    drawImage source coordinates are device px, so the screen rect must be
 *    scaled by pixelRatio before clamping against canvasWidth/Height.
 *  - Destination coordinates are LOCAL piece units, because the sceneFunc's
 *    ctx is already carrying the piece's absolute transform.
 */

/**
 * @param {object} p
 * @param {number} p.absX         - Piece top-left on screen, CSS px.
 * @param {number} p.absY         - Piece top-left on screen, CSS px.
 * @param {number} p.absScaleX    - Total absolute scale (stage zoom × piece scale).
 * @param {number} p.absScaleY    - Total absolute scale.
 * @param {number} p.pixelRatio   - Device px per CSS px of the backing canvas.
 * @param {number} p.canvasWidth  - Backing canvas width, device px.
 * @param {number} p.canvasHeight - Backing canvas height, device px.
 * @param {number} p.width        - Piece width in local units.
 * @param {number} p.height       - Piece height in local units.
 * @returns {{ sx: number, sy: number, sw: number, sh: number,
 *             dx: number, dy: number, dw: number, dh: number } | null}
 *   Source rect (device px, integer) + destination rect (local units), or
 *   null when the piece is entirely off-canvas or inputs are degenerate.
 */
export function computeBackdropSampleRect({
  absX,
  absY,
  absScaleX,
  absScaleY,
  pixelRatio,
  canvasWidth,
  canvasHeight,
  width,
  height,
}) {
  const inputs = [absX, absY, absScaleX, absScaleY, pixelRatio, canvasWidth, canvasHeight, width, height];
  if (!inputs.every(Number.isFinite)) return null;
  if (absScaleX <= 0 || absScaleY <= 0 || pixelRatio <= 0 || width <= 0 || height <= 0) return null;

  // Piece rect on the backing canvas, device px.
  const devX = absX * pixelRatio;
  const devY = absY * pixelRatio;
  const devW = width * absScaleX * pixelRatio;
  const devH = height * absScaleY * pixelRatio;

  // Clamp to the canvas so edge pieces sample their visible portion instead
  // of losing glass entirely (the old guard skipped on any overhang).
  const sx = Math.round(Math.max(0, devX));
  const sy = Math.round(Math.max(0, devY));
  const sxEnd = Math.round(Math.min(canvasWidth, devX + devW));
  const syEnd = Math.round(Math.min(canvasHeight, devY + devH));
  const sw = sxEnd - sx;
  const sh = syEnd - sy;
  if (sw <= 0 || sh <= 0) return null;

  // Map the clamped device rect back into local piece units so the drawn
  // region lands exactly where the sampled region sits behind the piece.
  const toLocalX = (device) => (device / pixelRatio - absX) / absScaleX;
  const toLocalY = (device) => (device / pixelRatio - absY) / absScaleY;
  const dx = toLocalX(sx);
  const dy = toLocalY(sy);
  const dw = toLocalX(sxEnd) - dx;
  const dh = toLocalY(syEnd) - dy;

  return { sx, sy, sw, sh, dx, dy, dw, dh };
}
