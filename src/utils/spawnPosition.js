/**
 * computeSpawnPosition — finds a non-overlapping {x, y} inside the
 * current viewport bounds for a newly created piece. Tries the viewport
 * center first, then spirals outward in a 10-ring grid, finally falling
 * back to a randomized offset from center.
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
}) {
  const centerX = visibleBounds.x + visibleBounds.width / 2 - pieceWidth / 2;
  const centerY = visibleBounds.y + visibleBounds.height / 2 - pieceHeight / 2;
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
