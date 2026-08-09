/**
 * connectionAnchoring.js — geometry-derived anchor sides for connections.
 *
 * When a connection is created without an explicit user-picked edge (discovery
 * on reopen, or a legacy persisted row with no stored sides), we still want it
 * to launch from a sensible edge rather than always hardcoding right→left.
 *
 * `chooseFacingSides` picks the source edge that points toward the target and
 * the opposing edge on the target — the "nearest facing edges" rule. Pieces are
 * a fixed size, so the center-to-center direction equals the top-left-to-
 * top-left direction (the +width/2, +height/2 offsets cancel in the delta);
 * the function therefore needs only `x`/`y` and no width/height.
 */

const OPPOSITE_SIDE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

/**
 * Choose facing edge sides for a connection from two pieces' positions.
 *
 * @param {{ x: number, y: number }} source
 * @param {{ x: number, y: number }} target
 * @returns {{ sourceSide: 'left'|'right'|'top'|'bottom', targetSide: 'left'|'right'|'top'|'bottom' }}
 */
export function chooseFacingSides(source, target) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;

  // Primary axis wins; ties (perfect diagonal) and the degenerate
  // same-position case resolve to the vertical axis deterministically.
  const sourceSide = Math.abs(dx) > Math.abs(dy)
    ? (dx > 0 ? 'right' : 'left')
    : (dy > 0 ? 'bottom' : 'top');

  return { sourceSide, targetSide: OPPOSITE_SIDE[sourceSide] };
}
