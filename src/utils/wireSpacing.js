/**
 * wireSpacing.js — legible separation for routed wires (ADR-025 S4).
 *
 * Two pure passes, both deterministic:
 *
 * 1. distributeTerminals (D3 — distributed stubs). Wires converging on the
 *    same face of the same anchor spread their terminal points along that
 *    face instead of stacking on the midpoint. The user-chosen SIDE is
 *    preserved absolutely (ADR-025 §6); only the position along the face
 *    relaxes. Stubs are dynamic pseudo-ports: they exist only where wires
 *    exist, placed here, never a static grid (§7).
 *
 * 2. separateCorridors (R3/R5). Routed wires sharing a corridor — coincident
 *    collinear interior legs — offset apart in steps, compressing nothing
 *    into obstacles. Terminal legs never move; offsets that would push a
 *    leg into an obstacle or invert a stub are dropped for that wire
 *    (overlap is acceptable — the hover focus swap disambiguates, G4).
 */

import { anchorEdgePoint } from './wireGeometry.js';
import { inflate, segmentBlocked, WIRE_CLEARANCE } from './orthogonalRouter.js';

// Step between distributed terminals along a face (the R5 ceiling), and how
// far terminals stay off the face's corners.
export const WIRE_TERMINAL_SPACING = 20;
export const TERMINAL_FACE_PAD = 14;

// Step between separated parallel legs in a shared corridor. Under the R5
// 20px ceiling — thin rest-gauge wires (S0) read clearly at this distance.
// (12 → 16, owner tuning 2026-07-31: two lanes at 12 read too tight in a
// seam channel.)
export const WIRE_CORRIDOR_SPACING = 16;

// A corridor offset may stretch/shrink an adjacent terminal leg; below this
// remaining length (or on inversion) the offset is dropped instead.
const MIN_TERMINAL_LEG = 4;

const anchorIdentity = (anchor) => (
  anchor?.kind === 'pill' ? `pill:${anchor.groupId}` : `piece:${anchor?.pieceId}`
);

const faceAxis = (side) => (side === 'left' || side === 'right' ? 'y' : 'x');

const anchorCenter = (anchor, pieceWidth, pieceHeight) => ({
  x: anchor.x + (Number.isFinite(anchor.width) ? anchor.width : pieceWidth) / 2,
  y: anchor.y + (Number.isFinite(anchor.height) ? anchor.height : pieceHeight) / 2,
});

/**
 * Distribute terminal points for every wire endpoint (D3).
 *
 * @param {Array<object>} wires - renderable wires (aggregated)
 * @param {number} pieceWidth
 * @param {number} pieceHeight
 * @returns {Map<number|string, {
 *   sourcePoint: {x:number,y:number},
 *   targetPoint: {x:number,y:number},
 * }>} terminal override per connection id (always present per wire)
 */
export function distributeTerminals(wires, pieceWidth, pieceHeight) {
  const terminals = new Map();
  for (const wire of wires ?? []) {
    if (!wire?.connection || !wire.sourceAnchor || !wire.targetAnchor) continue;
    terminals.set(wire.connection.id, {
      sourcePoint: anchorEdgePoint(wire.sourceAnchor, wire.sourceSide, pieceWidth, pieceHeight),
      targetPoint: anchorEdgePoint(wire.targetAnchor, wire.targetSide, pieceWidth, pieceHeight),
    });
  }

  // Group endpoints by (anchor identity, side).
  const groupsByFace = new Map();
  for (const wire of wires ?? []) {
    if (!terminals.has(wire?.connection?.id)) continue;
    for (const end of ['source', 'target']) {
      const anchor = end === 'source' ? wire.sourceAnchor : wire.targetAnchor;
      const side = end === 'source' ? wire.sourceSide : wire.targetSide;
      const key = `${anchorIdentity(anchor)}|${side}`;
      if (!groupsByFace.has(key)) groupsByFace.set(key, []);
      groupsByFace.get(key).push({ wire, end, anchor, side });
    }
  }

  for (const members of groupsByFace.values()) {
    if (members.length < 2) continue; // single wire keeps the midpoint

    const { anchor, side } = members[0];
    const axis = faceAxis(side);
    const faceLen = axis === 'y'
      ? (Number.isFinite(anchor.height) ? anchor.height : pieceHeight)
      : (Number.isFinite(anchor.width) ? anchor.width : pieceWidth);

    // Order along the face follows the far endpoint's position on the same
    // axis — wires from above land above, keeping stubs uncrossed.
    // Connection-id tie-break keeps it total and deterministic.
    const sorted = [...members].sort((a, b) => {
      const farA = anchorCenter(
        a.end === 'source' ? a.wire.targetAnchor : a.wire.sourceAnchor, pieceWidth, pieceHeight
      )[axis];
      const farB = anchorCenter(
        b.end === 'source' ? b.wire.targetAnchor : b.wire.sourceAnchor, pieceWidth, pieceHeight
      )[axis];
      return farA - farB || String(a.wire.connection.id).localeCompare(String(b.wire.connection.id));
    });

    const n = sorted.length;
    const usable = Math.max(faceLen - 2 * TERMINAL_FACE_PAD, 0);
    const step = n > 1 ? Math.min(WIRE_TERMINAL_SPACING, usable / (n - 1)) : 0;

    sorted.forEach((member, i) => {
      const override = terminals.get(member.wire.connection.id);
      const point = member.end === 'source' ? override.sourcePoint : override.targetPoint;
      point[axis] += (i - (n - 1) / 2) * step;
    });
  }

  return terminals;
}

/**
 * Separate coincident collinear legs of routed wires (R3/R5).
 *
 * Operates on the route map in place-safe fashion: returns a new Map with
 * fresh point arrays for the wires it moved; untouched wires keep their
 * original entries.
 *
 * @param {Map<number|string, {points: Array<{x:number,y:number}>, routed: boolean}>} routes
 * @param {Array<{x:number,y:number,width:number,height:number}>} obstacles
 * @returns {Map<number|string, {points: Array, routed: boolean}>}
 */
export function separateCorridors(routes, obstacles = []) {
  const rects = obstacles.map((o) => inflate(o, WIRE_CLEARANCE - 0.5));

  // Collect interior legs (never the first or last segment — terminals and
  // their launch legs are fixed by distributeTerminals).
  const segments = []; // {id, index, axis, coord, lo, hi, points}
  for (const [id, route] of routes.entries()) {
    if (!route.routed) continue;
    const pts = route.points;
    for (let i = 1; i < pts.length - 2; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      if (a.y === b.y && a.x !== b.x) {
        segments.push({
          id, index: i, axis: 'h', coord: a.y,
          lo: Math.min(a.x, b.x), hi: Math.max(a.x, b.x),
        });
      } else if (a.x === b.x && a.y !== b.y) {
        segments.push({
          id, index: i, axis: 'v', coord: a.x,
          lo: Math.min(a.y, b.y), hi: Math.max(a.y, b.y),
        });
      }
    }
  }

  // Cluster: same axis, same coordinate (quarter-px snap), overlapping span.
  const byLine = new Map();
  for (const seg of segments) {
    const key = `${seg.axis}:${Math.round(seg.coord * 4) / 4}`;
    if (!byLine.has(key)) byLine.set(key, []);
    byLine.get(key).push(seg);
  }

  const planned = []; // {id, index, axis, delta}
  for (const line of byLine.values()) {
    if (line.length < 2) continue;
    line.sort((a, b) => a.lo - b.lo || String(a.id).localeCompare(String(b.id)));
    let cluster = [];
    let clusterHi = -Infinity;
    const flush = () => {
      if (cluster.length >= 2) planned.push(...assignOffsets(cluster, routes));
      cluster = [];
      clusterHi = -Infinity;
    };
    for (const seg of line) {
      if (cluster.length > 0 && seg.lo >= clusterHi) flush();
      cluster.push(seg);
      clusterHi = Math.max(clusterHi, seg.hi);
    }
    flush();
  }
  if (planned.length === 0) return routes;

  // Apply with guards, lowest segment index first per wire.
  const out = new Map(routes);
  const cloned = new Set();
  for (const move of planned.sort((a, b) =>
    String(a.id).localeCompare(String(b.id)) || a.index - b.index)) {
    const route = out.get(move.id);
    const pts = route.points;
    const i = move.index;
    const perpAxis = move.axis === 'h' ? 'y' : 'x';
    const newCoord = pts[i][perpAxis] + move.delta;

    // Guard 1: adjacent terminal legs must survive (length + direction).
    if (!terminalLegSurvives(pts, i, perpAxis, newCoord)) continue;
    // Guard 2: the moved leg must not land inside an obstacle.
    const [p, q] = [pts[i], pts[i + 1]];
    const blocked = move.axis === 'h'
      ? segmentBlocked(rects, p.x, newCoord, q.x, newCoord)
      : segmentBlocked(rects, newCoord, p.y, newCoord, q.y);
    if (blocked) continue;

    if (!cloned.has(move.id)) {
      out.set(move.id, { ...route, points: route.points.map((pt) => ({ ...pt })) });
      cloned.add(move.id);
    }
    const target = out.get(move.id).points;
    target[i][perpAxis] += move.delta;
    target[i + 1][perpAxis] += move.delta;
  }
  return out;
}

// Slots centered on the shared line: (i - (n-1)/2) * spacing. Wires whose
// adjacent legs arrive from the low side take low slots — fewer crossings.
function assignOffsets(cluster, routes) {
  const sorted = [...cluster].sort((a, b) => {
    const keyOf = (seg) => {
      const pts = routes.get(seg.id).points;
      const perp = seg.axis === 'h' ? 'y' : 'x';
      const before = pts[seg.index - 1]?.[perp] ?? pts[seg.index][perp];
      const after = pts[seg.index + 2]?.[perp] ?? pts[seg.index + 1][perp];
      return before + after;
    };
    return keyOf(a) - keyOf(b) || String(a.id).localeCompare(String(b.id));
  });
  const n = sorted.length;
  return sorted.map((seg, i) => ({
    id: seg.id,
    index: seg.index,
    axis: seg.axis,
    delta: (i - (n - 1) / 2) * WIRE_CORRIDOR_SPACING,
  }));
}

// When the moved leg's neighbor is a terminal launch leg (segment 0 or the
// last segment), the offset stretches or shrinks it along its own axis; the
// leg must keep its direction and at least MIN_TERMINAL_LEG of length.
function terminalLegSurvives(pts, i, perpAxis, newCoord) {
  if (i === 1) {
    const t = pts[0];
    const oldLen = pts[1][perpAxis] - t[perpAxis];
    const newLen = newCoord - t[perpAxis];
    if (Math.sign(newLen) !== Math.sign(oldLen) || Math.abs(newLen) < MIN_TERMINAL_LEG) {
      return false;
    }
  }
  if (i + 2 === pts.length - 1) {
    const t = pts[pts.length - 1];
    const oldLen = pts[i + 1][perpAxis] - t[perpAxis];
    const newLen = newCoord - t[perpAxis];
    if (Math.sign(newLen) !== Math.sign(oldLen) || Math.abs(newLen) < MIN_TERMINAL_LEG) {
      return false;
    }
  }
  return true;
}
