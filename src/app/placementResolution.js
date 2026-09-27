/**
 * placementResolution.js — where a moved set of nodes lands (ADR-030,
 * brief-structural-grid §5). Pure: intent in, positions out. History, seams,
 * saving and animation stay with the caller.
 *
 * The moving set snaps by the top-left corner of its bounds and keeps every
 * member's offset, so a multi-selection or group moves rigidly.
 *
 *   Strict  the grid always wins (owner ruling 2026-09-27): major
 *           intersections only, never a flush dock. A drop onto a neighbor
 *           takes the nearest free major intersection.
 *   Flex    today's docking first (flush, or a wire seam), then smart
 *           guides (the nearest aligned face within a screen-space
 *           tolerance), then the finest lattice intersection.
 *
 * A candidate is legal when no member's scaled body overlaps a visible
 * node that is not moving. The search is bounded and deterministic; when
 * nothing nearby is free the result says so (`reason: 'blocked'`) instead
 * of jumping far away or overlapping silently. Hidden nodes (members of a
 * collapsed group) are neither obstacles nor guide targets.
 */

import { latticeCandidates, normalizeZero, roundToStep, gridLevelAt } from '../utils/gridGeometry.js';
import { boundsOfRects, pieceRect, rectsOverlap } from '../utils/spatialGeometry2d.js';
import { PIECE_WIDTH, PIECE_HEIGHT } from '../utils/pieceDimensions.js';

// How far out the lattice search looks before reporting "blocked".
const STRICT_MAX_RING = 6;
const FLEX_MAX_RING = 40;

const facesOf = (rect, axis) => (axis === 'x'
  ? [rect.x, rect.x + rect.width / 2, rect.x + rect.width]
  : [rect.y, rect.y + rect.height / 2, rect.y + rect.height]);
const extentOf = (rect, axis) => (axis === 'x'
  ? [rect.y, rect.y + rect.height]
  : [rect.x, rect.x + rect.width]);

const EPSILON = 1e-6;

/** Scaled rectangles of the visible nodes that are not moving. */
export function staticObstacles({ pieces, movingIds, hiddenPieceIds = null, baseWidth = PIECE_WIDTH, baseHeight = PIECE_HEIGHT }) {
  const moving = movingIds instanceof Set ? movingIds : new Set(movingIds);
  const rects = [];
  for (const piece of pieces ?? []) {
    if (moving.has(piece.id)) continue;
    if (hiddenPieceIds?.has(piece.id)) continue;
    if (!Number.isFinite(piece.x) || !Number.isFinite(piece.y)) continue;
    rects.push(pieceRect(piece, baseWidth, baseHeight));
  }
  return rects;
}

/**
 * The nearest face of a static rectangle that one of `bounds`' faces can
 * align with on `axis`, within `tolerance` world units (0 = exact only).
 * Edges pair with edges, centers with centers. Opposite edges of rectangles
 * that share extent are a seam, not a guide — docking owns that case. Ties
 * prefer same-side edges, then centers, then opposite edges.
 */
export function nearestGuide(bounds, axis, obstacles, tolerance) {
  const mf = facesOf(bounds, axis);
  const me = extentOf(bounds, axis);
  let best = null;
  for (const rect of obstacles) {
    const of = facesOf(rect, axis);
    const oe = extentOf(rect, axis);
    const sharesExtent = me[0] < oe[1] + EPSILON && me[1] > oe[0] - EPSILON;
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if ((i === 1) !== (j === 1)) continue;
        const opposite = i !== j && i !== 1;
        if (opposite && sharesExtent) continue;
        const distance = Math.abs(of[j] - mf[i]);
        if (distance > tolerance + EPSILON) continue;
        const rank = i === 1 ? 1 : opposite ? 2 : 0;
        if (!best || distance < best.distance - EPSILON
          || (Math.abs(distance - best.distance) < EPSILON && rank < best.rank)) {
          best = { axis, value: of[j], anchor: normalizeZero(of[j] - (mf[i] - mf[0])), distance, rank };
        }
      }
    }
  }
  return best;
}

/**
 * Guide lines to draw for a landing: at most one per axis (the exact
 * alignment nearestGuide prefers), spanning the moving bounds and every
 * static rectangle with a face on that line.
 */
export function guideLinesFor(bounds, obstacles) {
  const lines = [];
  for (const axis of ['x', 'y']) {
    const guide = nearestGuide(bounds, axis, obstacles, 0);
    if (!guide) continue;
    let [lo, hi] = extentOf(bounds, axis);
    for (const rect of obstacles) {
      if (!facesOf(rect, axis).some((face) => Math.abs(face - guide.value) < EPSILON)) continue;
      const extent = extentOf(rect, axis);
      lo = Math.min(lo, extent[0]);
      hi = Math.max(hi, extent[1]);
    }
    lines.push({ axis, value: guide.value, lo, hi });
  }
  return lines;
}

function memberLayout(members, baseWidth, baseHeight) {
  const rects = members.map(({ piece, position }) => pieceRect(piece, baseWidth, baseHeight, position));
  const bounds = boundsOfRects(rects);
  return {
    bounds,
    offsets: members.map(({ piece }, index) => ({
      piece,
      dx: rects[index].x - bounds.x,
      dy: rects[index].y - bounds.y,
      width: rects[index].width,
      height: rects[index].height,
    })),
  };
}

function placeAt(layout, anchor) {
  const positions = new Map();
  const rects = [];
  for (const member of layout.offsets) {
    const position = { x: normalizeZero(anchor.x + member.dx), y: normalizeZero(anchor.y + member.dy) };
    positions.set(member.piece.id, position);
    rects.push({ ...position, width: member.width, height: member.height });
  }
  return { positions, rects };
}

function isFree(rects, obstacles) {
  for (const rect of rects) {
    for (const obstacle of obstacles) {
      if (rectsOverlap(rect, obstacle)) return false;
    }
  }
  return true;
}

// Only obstacles the search could reach matter; filter once per resolve.
function nearbyObstacles(obstacles, bounds, reachX, reachY) {
  const window = {
    x: bounds.x - reachX,
    y: bounds.y - reachY,
    width: bounds.width + 2 * reachX,
    height: bounds.height + 2 * reachY,
  };
  return obstacles.filter((rect) => rectsOverlap(rect, window, 0));
}

/**
 * Resolve where the moving set lands.
 *
 * @param {object} intent
 * @param {Array<{piece, position}>} intent.members - moving nodes with their
 *   current (dragged) corner positions
 * @param {Array<object>} intent.obstacles - static rectangles (staticObstacles)
 * @param {object} intent.steps - deriveGridSteps(definition)
 * @param {'strict'|'flex'} intent.mode
 * @param {{x:number,y:number}|null} [intent.dockAnchor] - Flex only: where
 *   today's docking would put the set's corner, or null
 * @param {number} [intent.guideTolerance] - world units; 0 turns guides off
 * @param {boolean} [intent.occupancy] - false for group drags, whose visible
 *   footprint is not their members' rectangles
 * @returns {{ positions: Map, anchor: {x,y}, reason: string, level: string }}
 *   reason is 'major' | 'fine' | 'dock' | 'guide' | 'blocked'
 */
export function resolvePlacement({
  members,
  obstacles = [],
  steps,
  mode,
  dockAnchor = null,
  guideTolerance = 0,
  occupancy = true,
  baseWidth = PIECE_WIDTH,
  baseHeight = PIECE_HEIGHT,
}) {
  const layout = memberLayout(members, baseWidth, baseHeight);
  const { bounds } = layout;
  const strict = mode === 'strict';
  const stepX = strict ? steps.majorX : steps.subX;
  const stepY = strict ? steps.majorY : steps.subY;
  const maxRing = strict ? STRICT_MAX_RING : Math.min(FLEX_MAX_RING, Math.ceil((2 * Math.max(steps.majorX, steps.majorY)) / Math.min(steps.subX, steps.subY)));
  const reachable = occupancy
    ? nearbyObstacles(obstacles, bounds, (maxRing + 1) * stepX, (maxRing + 1) * stepY)
    : [];
  const legal = (placement) => !occupancy || isFree(placement.rects, reachable);
  const result = (anchor, reason, placement) => ({
    positions: placement.positions,
    anchor,
    reason,
    level: gridLevelAt(anchor.x, anchor.y, steps),
  });

  if (!strict && dockAnchor) {
    // Today's docking, unchanged: it already chose flush or a wire seam.
    return result(dockAnchor, 'dock', placeAt(layout, dockAnchor));
  }

  if (!strict && guideTolerance > 0) {
    const gx = nearestGuide(bounds, 'x', obstacles, guideTolerance);
    const gy = nearestGuide(bounds, 'y', obstacles, guideTolerance);
    if (gx || gy) {
      const anchor = {
        x: gx ? gx.anchor : roundToStep(bounds.x, steps.subX),
        y: gy ? gy.anchor : roundToStep(bounds.y, steps.subY),
      };
      const placement = placeAt(layout, anchor);
      if (legal(placement)) return result(anchor, 'guide', placement);
    }
  }

  for (const candidate of latticeCandidates(bounds, stepX, stepY, occupancy ? maxRing : 0)) {
    const anchor = { x: candidate.x, y: candidate.y };
    const placement = placeAt(layout, anchor);
    if (legal(placement)) return result(anchor, strict ? 'major' : 'fine', placement);
  }

  return {
    positions: null,
    anchor: null,
    reason: 'blocked',
    level: null,
  };
}
