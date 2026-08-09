/**
 * wireNudge.js — wire seams: adjacency parts so wires route
 * (ADR-025 §4 as amended 2026-07-31; doctrine: wires override adjacency —
 * design_wire_over_adjacency).
 *
 * Two seam mechanisms, both pure:
 *
 * 1. FACE-BURIAL seam (computeBirthNudge): a wire's anchored face buried
 *    behind flush/overlapping neighbors → they part along the face normal
 *    until a one-wire corridor exists.
 * 2. TRANSIT seam (computeTransitSeams): a flush pair whose shared seam sits
 *    on the wire's path between its terminals → the pair parts LATERALLY,
 *    half each way, so the wire drops between them.
 *
 * computeWireSeams runs both. Owner ruling (2026-07-31, superseding the
 * original D1b one-shot): seams are maintained at EVERY arrangement settle
 * (wire birth AND piece drag-end) — a wire is never left under-passing
 * because adjacency sealed its path. No fight loop arises: each user
 * gesture gets exactly one seam response. Discovery runs still never nudge
 * (they re-derive wires on every load; the drag-end trigger covers those
 * wires the moment the user arranges anything).
 *
 * Callers apply moves through the standard piece write path in the SAME
 * history action/group as the triggering gesture (single undo), with
 * adjacency rebuilt for moved pieces so stored `adjacentTo` follows the
 * geometry in both directions.
 *
 * Proportionality (D1d): flush adjacency parts readily; group interiors
 * yield only through their own layout engine — group-member blockers
 * abort their seam, degrading to the D4 fallback.
 */

import { WIRE_CLEARANCE } from './orthogonalRouter.js';
import { WIRE_CORRIDOR_SPACING } from './wireSpacing.js';

// The opened seam: matches the corridor-width family (GAP_X 20,
// WIRE_SNAP_SEAM 20). Stub (10) + clearance (9.5) fit inside it.
export const WIRE_NUDGE_SEAM = 20;

// Most pieces a single endpoint's seam may displace (cascade included)
// before the nudge gives up (rung 4: D4 fallback).
export const WIRE_NUDGE_MAX_CASCADE = 6;

const NORMALS = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

const rectsOverlap = (a, b) =>
  a.x < b.x + b.width && a.x + a.width > b.x
  && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * Compute the piece displacements a new wire's birth requires, or null when
 * no nudge should happen (nothing blocking, or blockers that must not move).
 *
 * @param {object} params
 * @param {number|string} params.sourceId
 * @param {string} params.sourceSide
 * @param {number|string} params.targetId
 * @param {string} params.targetSide
 * @param {Array<{id:number|string,x:number,y:number}>} params.pieces
 * @param {Set<number|string>} [params.hiddenPieceIds]
 * @param {Map<number|string, number>} [params.groupByPieceId]
 * @param {number} params.pieceWidth
 * @param {number} params.pieceHeight
 * @returns {Array<{id:number|string, dx:number, dy:number}>|null}
 */
export function computeBirthNudge({
  sourceId,
  sourceSide,
  targetId,
  targetSide,
  pieces,
  hiddenPieceIds = null,
  groupByPieceId = null,
  pieceWidth,
  pieceHeight,
}) {
  const endpointIds = new Set([sourceId, targetId]);
  // Working positions — endpoint two processed after any displacement the
  // first endpoint's seam caused.
  const working = new Map();
  for (const piece of pieces ?? []) {
    if (!Number.isFinite(piece.x) || !Number.isFinite(piece.y)) continue;
    if (hiddenPieceIds?.has(piece.id)) continue;
    working.set(piece.id, { x: piece.x, y: piece.y });
  }
  if (!working.has(sourceId) || !working.has(targetId)) return null;

  const moves = new Map(); // id → {dx, dy}

  for (const endpoint of [
    { id: sourceId, side: sourceSide },
    { id: targetId, side: targetSide },
  ]) {
    const normal = NORMALS[endpoint.side];
    if (!normal) continue;
    const anchor = working.get(endpoint.id);

    // Terminal (face midpoint) and the approach zone: a one-wire corridor
    // extending WIRE_NUDGE_SEAM out from the face, WIRE_CLEARANCE either
    // side of the terminal.
    const terminal = {
      x: anchor.x + (normal.x === 1 ? pieceWidth : normal.x === -1 ? 0 : pieceWidth / 2),
      y: anchor.y + (normal.y === 1 ? pieceHeight : normal.y === -1 ? 0 : pieceHeight / 2),
    };
    const zone = normal.x !== 0
      ? {
          x: normal.x === 1 ? terminal.x : terminal.x - WIRE_NUDGE_SEAM,
          y: terminal.y - WIRE_CLEARANCE,
          width: WIRE_NUDGE_SEAM,
          height: 2 * WIRE_CLEARANCE,
        }
      : {
          x: terminal.x - WIRE_CLEARANCE,
          y: normal.y === 1 ? terminal.y : terminal.y - WIRE_NUDGE_SEAM,
          width: 2 * WIRE_CLEARANCE,
          height: WIRE_NUDGE_SEAM,
        };

    // Blockers: visible non-endpoint pieces intruding into the corridor.
    const blockers = [];
    for (const [id, pos] of working.entries()) {
      if (endpointIds.has(id)) continue;
      const rect = { x: pos.x, y: pos.y, width: pieceWidth, height: pieceHeight };
      if (rectsOverlap(rect, zone)) blockers.push(id);
    }
    if (blockers.length === 0) continue;

    // Displacement per blocker: push along the normal until its near edge
    // sits a full seam off the face. Cascaded pieces (flush behind a pushed
    // blocker) inherit the pusher's delta — a rigid chain, so their own
    // flushness is preserved and only the seam at the face opens.
    const faceSeamDelta = (pos) => (
      normal.x === 1 ? (terminal.x + WIRE_NUDGE_SEAM) - pos.x
        : normal.x === -1 ? pos.x + pieceWidth - (terminal.x - WIRE_NUDGE_SEAM)
          : normal.y === 1 ? (terminal.y + WIRE_NUDGE_SEAM) - pos.y
            : pos.y + pieceHeight - (terminal.y - WIRE_NUDGE_SEAM)
    );
    const queue = blockers.map((id) => ({ id, inherited: null }));
    const pushed = new Set();
    while (queue.length > 0) {
      const { id, inherited } = queue.shift();
      if (pushed.has(id)) continue;
      if (endpointIds.has(id)) return null; // seam would shove an endpoint
      // Proportionality: group interiors never freeform-nudge (D1d).
      if (groupByPieceId?.get?.(id) != null) return null;
      pushed.add(id);
      if (pushed.size > WIRE_NUDGE_MAX_CASCADE) return null;

      const pos = working.get(id);
      const delta = inherited ?? faceSeamDelta(pos);
      if (delta <= 0) continue;

      const dx = normal.x * delta;
      const dy = normal.y * delta;
      const before = { x: pos.x, y: pos.y, width: pieceWidth, height: pieceHeight };
      pos.x += dx;
      pos.y += dy;
      const prev = moves.get(id) ?? { dx: 0, dy: 0 };
      moves.set(id, { dx: prev.dx + dx, dy: prev.dy + dy });

      // Cascade sweep: anything the moved rect now overlaps (or that sat
      // flush within the swept band) moves too.
      const swept = {
        x: Math.min(before.x, pos.x),
        y: Math.min(before.y, pos.y),
        width: pieceWidth + Math.abs(dx),
        height: pieceHeight + Math.abs(dy),
      };
      for (const [otherId, otherPos] of working.entries()) {
        if (pushed.has(otherId) || otherId === id) continue;
        const otherRect = { x: otherPos.x, y: otherPos.y, width: pieceWidth, height: pieceHeight };
        if (endpointIds.has(otherId)) {
          // Endpoints are never pushed. A pre-existing overlap the blocker
          // is moving AWAY from is fine; the blocker's post-move rect
          // landing ON an endpoint is a genuine shove — abort to D4.
          const landed = { x: pos.x, y: pos.y, width: pieceWidth, height: pieceHeight };
          if (rectsOverlap(otherRect, landed)) return null;
          continue;
        }
        if (rectsOverlap(otherRect, swept)) queue.push({ id: otherId, inherited: delta });
      }
    }
  }

  if (moves.size === 0) return null;
  return [...moves.entries()]
    .sort(([a], [b]) => String(a).localeCompare(String(b)))
    .map(([id, d]) => ({ id, dx: d.dx, dy: d.dy }));
}

// Where does segment a→b cross the band [lo, hi] on `bandAxis` ('y' for a
// vertical seam's y-band)? Returns the crossing position on the OTHER axis
// at the band's midpoint, or null when the segment misses the band.
function bandCrossing(a, b, lo, hi, bandAxis) {
  const other = bandAxis === 'y' ? 'x' : 'y';
  const s0 = Math.min(a[bandAxis], b[bandAxis]);
  const s1 = Math.max(a[bandAxis], b[bandAxis]);
  const ovLo = Math.max(lo, s0);
  const ovHi = Math.min(hi, s1);
  if (ovLo > ovHi) return null;
  const span = b[bandAxis] - a[bandAxis];
  if (Math.abs(span) < 1e-9) {
    // Segment runs along the band — its whole other-axis range applies;
    // report its midpoint.
    return (a[other] + b[other]) / 2;
  }
  const mid = (ovLo + ovHi) / 2;
  const t = (mid - a[bandAxis]) / span;
  return a[other] + (b[other] - a[other]) * t;
}

/**
 * Transit seams: flush pairs whose shared seam is crossed by a wire's
 * terminal-to-terminal intent line part LATERALLY (half each way) to a
 * one-wire corridor. Cascades ride outward with each half (rigid chains).
 *
 * @param {object} params - same shape as computeBirthNudge, plus:
 * @param {Array<{sourceId, sourceSide, targetId, targetSide}>} params.wires
 * @returns {Array<{id, dx, dy}>|null}
 */
export function computeTransitSeams({
  wires,
  pieces,
  hiddenPieceIds = null,
  groupByPieceId = null,
  pieceWidth,
  pieceHeight,
}) {
  const working = new Map();
  for (const piece of pieces ?? []) {
    if (!Number.isFinite(piece.x) || !Number.isFinite(piece.y)) continue;
    if (hiddenPieceIds?.has(piece.id)) continue;
    working.set(piece.id, { x: piece.x, y: piece.y });
  }
  const moves = new Map();
  const addMove = (id, dx, dy) => {
    const pos = working.get(id);
    pos.x += dx;
    pos.y += dy;
    const prev = moves.get(id) ?? { dx: 0, dy: 0 };
    moves.set(id, { dx: prev.dx + dx, dy: prev.dy + dy });
  };

  const terminalOf = (id, side) => {
    const pos = working.get(id);
    if (!pos) return null;
    return {
      x: pos.x + (side === 'right' ? pieceWidth : side === 'left' ? 0 : pieceWidth / 2),
      y: pos.y + (side === 'bottom' ? pieceHeight : side === 'top' ? 0 : pieceHeight / 2),
    };
  };

  // Rigid half-chain: piece `id` and everything flush beyond it in
  // direction (dx,dy) move together. Null when a group member or an
  // endpoint would move, or the chain exceeds the cascade cap.
  const collectChain = (startId, dirX, dirY, endpointIds) => {
    const chain = [];
    const queue = [startId];
    const seen = new Set();
    while (queue.length > 0) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      if (endpointIds.has(id)) return null;
      if (groupByPieceId?.get?.(id) != null) return null;
      chain.push(id);
      if (chain.length > WIRE_NUDGE_MAX_CASCADE) return null;
      const pos = working.get(id);
      const swept = {
        x: Math.min(pos.x, pos.x + dirX * WIRE_NUDGE_SEAM),
        y: Math.min(pos.y, pos.y + dirY * WIRE_NUDGE_SEAM),
        width: pieceWidth + Math.abs(dirX * WIRE_NUDGE_SEAM),
        height: pieceHeight + Math.abs(dirY * WIRE_NUDGE_SEAM),
      };
      for (const [otherId, otherPos] of working.entries()) {
        if (seen.has(otherId)) continue;
        const rect = { x: otherPos.x, y: otherPos.y, width: pieceWidth, height: pieceHeight };
        if (endpointIds.has(otherId)) {
          // Same rule as the face phase: only a post-move landing on an
          // endpoint is a shove (abort); moving away past a pre-existing
          // overlap is not.
          const landed = {
            x: pos.x + dirX * WIRE_NUDGE_SEAM,
            y: pos.y + dirY * WIRE_NUDGE_SEAM,
            width: pieceWidth,
            height: pieceHeight,
          };
          if (rectsOverlap(rect, landed)) return null;
          continue;
        }
        if (rectsOverlap(rect, swept)) queue.push(otherId);
      }
    }
    return chain;
  };

  // Terminals per wire, against current working positions.
  const wireGeo = (wires ?? [])
    .map((wire) => ({
      wire,
      endpointIds: new Set([wire.sourceId, wire.targetId]),
      a: terminalOf(wire.sourceId, wire.sourceSide),
      b: terminalOf(wire.targetId, wire.targetSide),
    }))
    .filter((w) => w.a && w.b);

  // Widest seam any realistic fan-through needs before it stops being a
  // "seam" at all — bounds pair candidacy.
  const SEAM_CANDIDATE_CEILING =
    WIRE_NUDGE_SEAM + (WIRE_NUDGE_MAX_CASCADE - 1) * WIRE_CORRIDOR_SPACING;

  // Per flush pair: count the wires whose intent line is blocked inside the
  // pair's shared band with the crossing in the inner halves (the seam is
  // the natural escape; outer-half crossings route around). The seam opens
  // to N LANES — readability ruling (owner, 2026-07-31, per the D1c mock):
  // wires through a seam stay separate, so the seam widens by a corridor
  // step per extra wire instead of stacking them.
  for (const [idA, posA] of working.entries()) {
    for (const [idB, posB] of working.entries()) {
      if (idB === idA) continue;

      // Vertical shared seam: A left of B.
      const vGap = posB.x - (posA.x + pieceWidth);
      const vOverlap = Math.min(posA.y + pieceHeight, posB.y + pieceHeight)
        - Math.max(posA.y, posB.y);
      if (vGap >= 0 && vGap < SEAM_CANDIDATE_CEILING && vOverlap > 0) {
        const seamX = posA.x + pieceWidth + vGap / 2;
        const y0 = Math.max(posA.y, posB.y);
        const crossing = wireGeo.filter(({ endpointIds, a, b }) => {
          if (endpointIds.has(idA) || endpointIds.has(idB)) return false;
          const crossX = bandCrossing(a, b, y0, y0 + vOverlap, 'y');
          return crossX != null
            && crossX > posA.x && crossX < posB.x + pieceWidth
            && Math.abs(crossX - seamX) <= pieceWidth / 2;
        });
        const required = crossing.length > 0
          ? WIRE_NUDGE_SEAM + (crossing.length - 1) * WIRE_CORRIDOR_SPACING
          : 0;
        if (crossing.length > 0 && vGap < required) {
          const sacred = new Set(crossing.flatMap((w) => [...w.endpointIds]));
          const need = (required - vGap) / 2;
          const left = collectChain(idA, -1, 0, sacred);
          const right = collectChain(idB, 1, 0, sacred);
          if (left && right) {
            left.forEach((id) => addMove(id, -need, 0));
            right.forEach((id) => addMove(id, need, 0));
          }
        }
      }

      // Horizontal shared seam: A above B — same rule rotated.
      const hGap = posB.y - (posA.y + pieceHeight);
      const hOverlap = Math.min(posA.x + pieceWidth, posB.x + pieceWidth)
        - Math.max(posA.x, posB.x);
      if (hGap >= 0 && hGap < SEAM_CANDIDATE_CEILING && hOverlap > 0) {
        const seamY = posA.y + pieceHeight + hGap / 2;
        const x0 = Math.max(posA.x, posB.x);
        const crossing = wireGeo.filter(({ endpointIds, a, b }) => {
          if (endpointIds.has(idA) || endpointIds.has(idB)) return false;
          const crossY = bandCrossing(a, b, x0, x0 + hOverlap, 'x');
          return crossY != null
            && crossY > posA.y && crossY < posB.y + pieceHeight
            && Math.abs(crossY - seamY) <= pieceHeight / 2;
        });
        const required = crossing.length > 0
          ? WIRE_NUDGE_SEAM + (crossing.length - 1) * WIRE_CORRIDOR_SPACING
          : 0;
        if (crossing.length > 0 && hGap < required) {
          const sacred = new Set(crossing.flatMap((w) => [...w.endpointIds]));
          const need = (required - hGap) / 2;
          const up = collectChain(idA, 0, -1, sacred);
          const down = collectChain(idB, 0, 1, sacred);
          if (up && down) {
            up.forEach((id) => addMove(id, 0, -need));
            down.forEach((id) => addMove(id, 0, need));
          }
        }
      }
    }
  }

  if (moves.size === 0) return null;
  return [...moves.entries()]
    .sort(([x], [y]) => String(x).localeCompare(String(y)))
    .map(([id, d]) => ({ id, dx: d.dx, dy: d.dy }));
}

/**
 * The umbrella: face-burial seams for each wire's endpoints, then transit
 * seams for flush pairs on wire paths, computed against the already-parted
 * positions. Returns merged moves or null.
 */
export function computeWireSeams({
  wires,
  pieces,
  hiddenPieceIds = null,
  groupByPieceId = null,
  pieceWidth,
  pieceHeight,
}) {
  const merged = new Map();
  let current = pieces;

  const fold = (moves) => {
    if (!moves) return;
    const byId = new Map(moves.map((m) => [m.id, m]));
    current = current.map((piece) => {
      const d = byId.get(piece.id);
      return d ? { ...piece, x: piece.x + d.dx, y: piece.y + d.dy } : piece;
    });
    for (const m of moves) {
      const prev = merged.get(m.id) ?? { dx: 0, dy: 0 };
      merged.set(m.id, { dx: prev.dx + m.dx, dy: prev.dy + m.dy });
    }
  };

  for (const wire of wires ?? []) {
    fold(computeBirthNudge({
      sourceId: wire.sourceId,
      sourceSide: wire.sourceSide,
      targetId: wire.targetId,
      targetSide: wire.targetSide,
      pieces: current,
      hiddenPieceIds,
      groupByPieceId,
      pieceWidth,
      pieceHeight,
    }));
  }
  fold(computeTransitSeams({
    wires, pieces: current, hiddenPieceIds, groupByPieceId, pieceWidth, pieceHeight,
  }));

  if (merged.size === 0) return null;
  return [...merged.entries()]
    .sort(([x], [y]) => String(x).localeCompare(String(y)))
    .map(([id, d]) => ({ id, dx: d.dx, dy: d.dy }));
}
