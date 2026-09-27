// useSnap.js
// Shared snap helpers for single and group drags.

import { useCallback } from 'react';
import { pieceSize } from '../utils/spatialGeometry2d.js';

// Snap-with-seam (owner ruling 2026-07-31, ADR-025 amendment): when going
// FLUSH would seal a face that an existing wire is anchored on (to a third
// piece), the snap completes at a corridor-width seam instead — organization
// yields the minimum the relationship needs, one-shot, inside the user's
// own gesture (no fight loop). Matches the wire corridor family (GAP_X 20).
export const WIRE_SNAP_SEAM = 20;

// Is some wire anchored on this piece's face to a piece OTHER than the snap
// partner? A wire BETWEEN the snapping pair on the sealed faces is the
// contact-is-display case — flush is exactly right for it.
function faceAnchoredElsewhere(connections, pieceId, side, partnerId) {
  if (!Array.isArray(connections)) return false;
  return connections.some((c) =>
    (c.sourceId === pieceId && c.sourceSide === side && c.targetId !== partnerId)
    || (c.targetId === pieceId && c.targetSide === side && c.sourceId !== partnerId)
  );
}

function useSnap({ pieces, piecesById, selection, snapDistance, pieceWidth, pieceHeight, connections }) {
  // Every edge comes from each piece's own scaled size: the dragged piece's
  // width decides where its right edge meets a neighbor, the neighbor's
  // width where its right edge sits.
  const checkSnap = useCallback((dragged, newX, newY) => {
    const draggedSize = pieceSize(dragged, pieceWidth, pieceHeight);
    for (const piece of pieces) {
      if (piece.id === dragged.id) continue;
      if (selection?.isSelected?.(piece.id)) continue;

      const size = pieceSize(piece, pieceWidth, pieceHeight);
      const dx = newX - piece.x;
      const dy = newY - piece.y;

      // Each case: sealed faces are (dragged draggedSide) ↔ (piece pieceSide).
      // The seam applies when either sealed face carries a wire to a third
      // piece — UNLESS the user dropped OVERLAPPING the neighbor (pushed
      // past flush): an insistent gesture is the veto and goes truly flush.
      const seamFor = (draggedSide, pieceSide, pushedIn) => {
        const trapped =
          faceAnchoredElsewhere(connections, dragged.id, draggedSide, piece.id)
          || faceAnchoredElsewhere(connections, piece.id, pieceSide, dragged.id);
        return trapped && !pushedIn ? WIRE_SNAP_SEAM : 0;
      };

      if (Math.abs(dx - size.width) < snapDistance && Math.abs(dy) < snapDistance) {
        const seam = seamFor('left', 'right', dx - size.width < 0);
        return { x: piece.x + size.width + seam, y: piece.y };
      }

      if (Math.abs(dx + draggedSize.width) < snapDistance && Math.abs(dy) < snapDistance) {
        const seam = seamFor('right', 'left', dx + draggedSize.width > 0);
        return { x: piece.x - draggedSize.width - seam, y: piece.y };
      }

      if (Math.abs(dy - size.height) < snapDistance && Math.abs(dx) < snapDistance) {
        const seam = seamFor('top', 'bottom', dy - size.height < 0);
        return { x: piece.x, y: piece.y + size.height + seam };
      }

      if (Math.abs(dy + draggedSize.height) < snapDistance && Math.abs(dx) < snapDistance) {
        const seam = seamFor('bottom', 'top', dy + draggedSize.height > 0);
        return { x: piece.x, y: piece.y - draggedSize.height - seam };
      }
    }
    return null;
  }, [pieces, selection, snapDistance, pieceWidth, pieceHeight, connections]);

  const getGroupBounds = useCallback((ids) => {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    ids.forEach(id => {
      const piece = piecesById.get(id);
      if (!piece) return;
      const size = pieceSize(piece, pieceWidth, pieceHeight);
      minX = Math.min(minX, piece.x);
      minY = Math.min(minY, piece.y);
      maxX = Math.max(maxX, piece.x + size.width);
      maxY = Math.max(maxY, piece.y + size.height);
    });
    if (!Number.isFinite(minX)) return null;
    return { minX, minY, maxX, maxY };
  }, [piecesById, pieceWidth, pieceHeight]);

  const getGroupSnapDelta = useCallback((ids) => {
    if (ids.length === 0) return null;
    const bounds = getGroupBounds(ids);
    if (!bounds) return null;

    const selected = new Set(ids);
    const tolerance = snapDistance;
    let best = null;

    const overlaps = (aStart, aEnd, bStart, bEnd) =>
      (aStart - tolerance) <= bEnd && (aEnd + tolerance) >= bStart;

    pieces.forEach(piece => {
      if (selected.has(piece.id)) return;
      const size = pieceSize(piece, pieceWidth, pieceHeight);
      const left = piece.x;
      const right = piece.x + size.width;
      const top = piece.y;
      const bottom = piece.y + size.height;

      if (Math.abs(bounds.maxX - left) < snapDistance && overlaps(bounds.minY, bounds.maxY, top, bottom)) {
        const dx = left - bounds.maxX;
        const dist = Math.abs(dx);
        if (!best || dist < best.dist) best = { dx, dy: 0, dist };
      }

      if (Math.abs(bounds.minX - right) < snapDistance && overlaps(bounds.minY, bounds.maxY, top, bottom)) {
        const dx = right - bounds.minX;
        const dist = Math.abs(dx);
        if (!best || dist < best.dist) best = { dx, dy: 0, dist };
      }

      if (Math.abs(bounds.maxY - top) < snapDistance && overlaps(bounds.minX, bounds.maxX, left, right)) {
        const dy = top - bounds.maxY;
        const dist = Math.abs(dy);
        if (!best || dist < best.dist) best = { dx: 0, dy, dist };
      }

      if (Math.abs(bounds.minY - bottom) < snapDistance && overlaps(bounds.minX, bounds.maxX, left, right)) {
        const dy = bottom - bounds.minY;
        const dist = Math.abs(dy);
        if (!best || dist < best.dist) best = { dx: 0, dy, dist };
      }
    });

    return best;
  }, [pieces, getGroupBounds, snapDistance, pieceWidth, pieceHeight]);

  return {
    checkSnap,
    getGroupSnapDelta
  };
}

export default useSnap;
