/**
 * spatialGeometry2d.js — the explicit 2D geometry contract for canvas nodes
 * (ADR-030 §7, brief-structural-grid §4).
 *
 * A node is stored by its body's top-left corner (x, y) plus a scale. Its
 * rectangle is the canonical body size times that scale, growing right and
 * down from the corner. Every placement, snap, adjacency, anchor and
 * obstacle calculation reads rectangles from here, so rendered and model
 * bounds cannot disagree for a scaled node.
 *
 * Positive X is right and positive Y is down. Pure data in and out: no
 * React, Konva or DOM imports. A future 3D adapter supplies its own bounds
 * rather than extending these rectangles with a depth field.
 */

import { PIECE_WIDTH, PIECE_HEIGHT } from './pieceDimensions.js';

/** A node's scale, or 1 when it is missing, non-finite or not positive. */
export function pieceScale(piece) {
  const scale = Number(piece?.scale);
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

/** The node body's scaled width and height. */
export function pieceSize(piece, baseWidth = PIECE_WIDTH, baseHeight = PIECE_HEIGHT) {
  const scale = pieceScale(piece);
  return { width: baseWidth * scale, height: baseHeight * scale };
}

/**
 * The node body's rectangle. `position` overrides the stored corner (a drag
 * candidate, a preview frame) while keeping the node's own scale.
 */
export function pieceRect(piece, baseWidth = PIECE_WIDTH, baseHeight = PIECE_HEIGHT, position = null) {
  const { width, height } = pieceSize(piece, baseWidth, baseHeight);
  const x = position ? position.x : piece.x;
  const y = position ? position.y : piece.y;
  return { x, y, width, height };
}

export const rectRight = (rect) => rect.x + rect.width;
export const rectBottom = (rect) => rect.y + rect.height;
export const rectCenterX = (rect) => rect.x + rect.width / 2;
export const rectCenterY = (rect) => rect.y + rect.height / 2;

/**
 * Do two rectangles share interior area? Touching edges do not overlap, so a
 * flush neighbor is legal. `epsilon` absorbs floating-point noise.
 */
export function rectsOverlap(a, b, epsilon = 1e-6) {
  return a.x < rectRight(b) - epsilon && rectRight(a) > b.x + epsilon
    && a.y < rectBottom(b) - epsilon && rectBottom(a) > b.y + epsilon;
}

/** The smallest rectangle containing every rectangle given, or null. */
export function boundsOfRects(rects) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    if (!rect) continue;
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rectRight(rect));
    maxY = Math.max(maxY, rectBottom(rect));
  }
  if (!Number.isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
