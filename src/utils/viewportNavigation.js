import { easeOutCubic } from './math.js';

/**
 * Compute viewport state to center a piece on screen at a target zoom level.
 *
 * Viewport transform: screenX = canvasX * scale + offsetX
 * To center piece: offsetX = containerW/2 - pieceCenterX * scale
 */
export function computeCenterOnPiece(piece, containerW, containerH, pieceW, pieceH, targetScale = 0.85) {
  const ps = piece.scale ?? 1;
  const cx = piece.x + (pieceW * ps) / 2;
  const cy = piece.y + (pieceH * ps) / 2;
  return {
    scale: targetScale,
    offsetX: containerW / 2 - cx * targetScale,
    offsetY: containerH / 2 - cy * targetScale
  };
}

/**
 * Compute viewport state for Home: canvas (0,0) centered on screen at 100% zoom.
 */
export function computeHomeViewport(containerW, containerH) {
  return {
    scale: 1,
    offsetX: containerW / 2,
    offsetY: containerH / 2
  };
}

/**
 * Animate viewport from current state to target over `duration` ms using ease-out.
 * Returns a cancel function. Cancelling a completed animation is a no-op.
 *
 * @param {Object} options
 * @param {{ scale: number, offsetX: number, offsetY: number }} options.from
 * @param {{ scale: number, offsetX: number, offsetY: number }} options.to
 * @param {number}   [options.duration=300]
 * @param {Function} options.setScale
 * @param {Function} options.setOffsetX
 * @param {Function} options.setOffsetY
 * @returns {Function} cancel
 */
export function animateViewport({ from, to, duration = 300, setScale, setOffsetX, setOffsetY }) {
  let rafId = null;
  const start = performance.now();

  function tick(now) {
    const elapsed = now - start;
    const t = Math.min(elapsed / duration, 1);
    const eased = easeOutCubic(t);

    setScale(from.scale + (to.scale - from.scale) * eased);
    setOffsetX(from.offsetX + (to.offsetX - from.offsetX) * eased);
    setOffsetY(from.offsetY + (to.offsetY - from.offsetY) * eased);

    if (t < 1) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = null;
    }
  }

  rafId = requestAnimationFrame(tick);
  return () => {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  };
}
