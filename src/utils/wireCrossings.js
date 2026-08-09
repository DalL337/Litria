/**
 * wireCrossings.js — hop detection at asymmetric-visibility crossings
 * (ADR-025 §8 / D5, slice S6).
 *
 * Plain right-angle crossings are the default — they read cleanly. Hops
 * (electrical-diagram bridges) appear EXACTLY at asymmetric-visibility
 * crossings: where a quiet (neutral-rest) wire crosses a loud
 * (exception-popped) one, the quiet wire hops the loud one, making it
 * noticeable that something passes underneath.
 *
 * Hop ownership is assigned at ROUTE time from rest-state loudness and
 * never flips on hover — opacity swaps, shape doesn't (owner ruling,
 * 2026-07-29). Symmetric crossings (both quiet or both loud) stay plain.
 */

// On-screen-ish half-width of a hop bump (canvas px; small enough to ride
// the fillet aesthetic, follows the under-wire gauge family).
export const WIRE_HOP_RADIUS = 6;

/**
 * Detect hops for every quiet wire crossing a loud wire.
 *
 * @param {Map<number|string, {points: Array<{x:number,y:number}>, routed: boolean}>} routes
 * @param {Set<number|string>} loudIds - connection ids that rest popped
 *   (exception status) — route-time state, not hover.
 * @returns {Map<number|string, Array<{x:number,y:number,axis:'h'|'v'}>>}
 *   hops per QUIET connection id; axis is the axis of the quiet wire's leg
 *   at the crossing. Wires without hops are absent.
 */
export function computeWireHops(routes, loudIds) {
  const hops = new Map();
  if (!loudIds || loudIds.size === 0) return hops;

  const legsOf = (route) => {
    const legs = [];
    const pts = route.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (a.y === b.y && a.x !== b.x) {
        legs.push({ axis: 'h', coord: a.y, lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x) });
      } else if (a.x === b.x && a.y !== b.y) {
        legs.push({ axis: 'v', coord: a.x, lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y) });
      }
    }
    return legs;
  };

  const quiet = [];
  const loud = [];
  for (const [id, route] of routes.entries()) {
    if (!route.routed) continue; // fallback wires already de-emphasize (D4)
    (loudIds.has(id) ? loud : quiet).push({ id, legs: legsOf(route) });
  }
  if (loud.length === 0 || quiet.length === 0) return hops;

  for (const q of quiet) {
    const found = [];
    for (const qLeg of q.legs) {
      for (const l of loud) {
        for (const lLeg of l.legs) {
          if (qLeg.axis === lLeg.axis) continue; // parallel — corridor's job
          // Perpendicular pair: crossing exists when each leg's coordinate
          // falls strictly inside the other's span (shared endpoints and
          // T-touches are joints, not crossings).
          if (
            lLeg.coord > qLeg.lo + WIRE_HOP_RADIUS && lLeg.coord < qLeg.hi - WIRE_HOP_RADIUS
            && qLeg.coord > lLeg.lo && qLeg.coord < lLeg.hi
          ) {
            found.push(qLeg.axis === 'h'
              ? { x: lLeg.coord, y: qLeg.coord, axis: 'h' }
              : { x: qLeg.coord, y: lLeg.coord, axis: 'v' });
          }
        }
      }
    }
    if (found.length > 0) {
      // Deterministic order along the quiet wire's travel; dedupe crossings
      // shared by overlapping loud legs.
      const seen = new Set();
      const unique = found.filter((h) => {
        const key = `${h.x},${h.y}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      hops.set(q.id, unique);
    }
  }
  return hops;
}
