/**
 * placementTransition.js — the settle slide (ADR-030, brief §5 "Slide into
 * the resolved result"). Pure.
 *
 * A drop commits its final coordinates once; the slide is presentation only.
 * A transition describes where each settled node was drawn at release and
 * where it now is, and interpolates between them for a short, finite time.
 * Nothing here reaches piece state, the outbox or the router.
 */

const EASINGS = {
  cubic: (t) => 1 - (1 - t) ** 3,
  quint: (t) => 1 - (1 - t) ** 5,
  sine: (t) => Math.sin((t * Math.PI) / 2),
  linear: (t) => t,
};

/** Eased progress for t in [0, 1]; unknown easings fall back to cubic. */
export function easeProgress(easing, t) {
  const clamped = Math.min(1, Math.max(0, t));
  return (EASINGS[easing] ?? EASINGS.cubic)(clamped);
}

/**
 * Build a transition from release positions to settled positions. Nodes
 * that did not move are left out. Returns null when nothing moves, when the
 * duration is not positive, or when motion is reduced.
 */
export function createPlacementTransition({ from, to, start, durationMs, easing = 'cubic', reduceMotion = false }) {
  if (reduceMotion || !(durationMs > 0) || !from || !to) return null;
  const moves = new Map();
  for (const [id, end] of to) {
    const begin = from.get(id);
    if (!begin) continue;
    if (Math.abs(begin.x - end.x) < 1e-6 && Math.abs(begin.y - end.y) < 1e-6) continue;
    moves.set(id, { fromX: begin.x, fromY: begin.y, toX: end.x, toY: end.y });
  }
  if (!moves.size) return null;
  return { moves, start, durationMs, easing };
}

/** Is the transition finished at `now`? */
export function transitionDone(transition, now) {
  return !transition || now - transition.start >= transition.durationMs;
}

/** Drawn positions at `now`, by node id. */
export function positionsAt(transition, now) {
  const positions = new Map();
  if (!transition) return positions;
  const progress = easeProgress(transition.easing, (now - transition.start) / transition.durationMs);
  for (const [id, m] of transition.moves) {
    positions.set(id, {
      x: m.fromX + (m.toX - m.fromX) * progress,
      y: m.fromY + (m.toY - m.fromY) * progress,
    });
  }
  return positions;
}

/** Pieces as drawn at `now`: settled pieces with in-flight nodes interpolated. */
export function piecesAt(pieces, transition, now) {
  if (!transition || transitionDone(transition, now)) return pieces;
  const positions = positionsAt(transition, now);
  return pieces.map((piece) => {
    const at = positions.get(piece.id);
    return at ? { ...piece, x: at.x, y: at.y } : piece;
  });
}
