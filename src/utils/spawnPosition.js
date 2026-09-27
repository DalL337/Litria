import { latticeCandidates, roundToStep } from './gridGeometry.js';
import { pieceRect, rectsOverlap } from './spatialGeometry2d.js';

// Rings of major intersections searched around the viewport center before
// the grid path gives up and uses the centered intersection.
const GRID_SPAWN_MAX_RING = 12;

/**
 * computeSpawnPosition — finds a non-overlapping {x, y} inside the
 * current viewport bounds for a newly created piece.
 *
 * With a grid (ADR-030), a new top-level node lands on the free major
 * intersection nearest the viewport center, found ring by ring in a fixed
 * order; a major intersection is legal in both Strict and Flex. When nothing
 * nearby is free it takes the centered intersection — deterministic, never
 * random (brief §8).
 *
 * Without a grid it keeps the pre-grid behavior: the viewport center, then a
 * 10-ring spiral, then a randomized offset from center.
 *
 * Extracted from App.jsx in Session 4 Group K of the app-shell extraction
 * refactor. Pure function — no React, no closures over component state.
 * Inputs are explicit so callers can substitute mocks or alternative
 * piece sources.
 */
export function computeSpawnPosition({
  visibleBounds,
  pieces,
  pieceWidth,
  pieceHeight,
  pad = 10,
  maxRings = 10,
  grid = null,
}) {
  const centerX = visibleBounds.x + visibleBounds.width / 2 - pieceWidth / 2;
  const centerY = visibleBounds.y + visibleBounds.height / 2 - pieceHeight / 2;

  if (grid?.steps) {
    const stepX = grid.steps.majorX;
    const stepY = grid.steps.majorY;
    const occupied = (pieces ?? [])
      .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
      .map((p) => pieceRect(p, pieceWidth, pieceHeight));
    for (const candidate of latticeCandidates({ x: centerX, y: centerY }, stepX, stepY, GRID_SPAWN_MAX_RING)) {
      const rect = { x: candidate.x, y: candidate.y, width: pieceWidth, height: pieceHeight };
      if (!occupied.some((other) => rectsOverlap(rect, other))) {
        return { x: candidate.x, y: candidate.y };
      }
    }
    return { x: roundToStep(centerX, stepX), y: roundToStep(centerY, stepY) };
  }

  const stepX = pieceWidth + pad;
  const stepY = pieceHeight + pad;

  const overlaps = (px, py) => pieces.some((p) =>
    Math.abs(p.x - px) < pieceWidth + pad &&
    Math.abs(p.y - py) < pieceHeight + pad
  );

  if (!overlaps(centerX, centerY)) return { x: centerX, y: centerY };

  for (let ring = 1; ring <= maxRings; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        if (Math.abs(dx) !== ring && Math.abs(dy) !== ring) continue;
        const x = centerX + dx * stepX;
        const y = centerY + dy * stepY;
        if (!overlaps(x, y)) return { x, y };
      }
    }
  }

  return {
    x: centerX + (Math.random() * 2 - 1) * visibleBounds.width * 0.3,
    y: centerY + (Math.random() * 2 - 1) * visibleBounds.height * 0.3,
  };
}
