// wireGeometry.js
// Architectural seam for connection-wire rendering (see brief-bezier-wire-refactor.md).
//
// Two distinct responsibilities, kept as separate functions:
//
//   1. computeWirePoints(...) — geometry job. Takes source/target anchor points
//      and their chosen edges, returns an ordered point list the wire passes
//      through. Today that is exactly [start, end]. No awareness of other nodes,
//      no collision logic. Future routing inserts waypoints HERE without touching
//      the drawing code.
//
//   2. buildWireCurve(points) — drawing job. Takes an ordered point list and
//      produces the cubic-bezier control points + an SVG path `data` string for a
//      Konva <Path>. It can also answer "point + tangent at parameter t" from the
//      SAME control points (needed by the Phase 2 chevron). It does not know or
//      care how the point list was produced.
//
// Do not inline curve math into the component; do not let point-computation reach
// into rendering.

import { clamp } from './math.js';

// --- Normal-launch control-point tuning (named constants, not magic numbers) ---
// Control-point offset = clamp(anchorDistance * WIRE_LAUNCH_FRACTION,
//                              WIRE_LAUNCH_MIN, WIRE_LAUNCH_MAX)
export const WIRE_LAUNCH_FRACTION = 0.5; // fraction of anchor distance
export const WIRE_LAUNCH_MIN = 40;       // px (canvas space) — short wires don't kink
export const WIRE_LAUNCH_MAX = 240;      // px (canvas space) — long wires don't balloon

// --- Routed-path corner fillet (R7: right-angle corners preferred, rounded) ---
// Constant radius, clamped to half the shorter adjacent segment so short
// legs never invert.
export const WIRE_FILLET_RADIUS = 12;    // px (canvas space)

// Unit normal pointing OUT of a node along the chosen edge's face.
// right -> +x, left -> -x, top -> -y, bottom -> +y.
function edgeNormal(side) {
  switch (side) {
    case 'right':  return { x: 1, y: 0 };
    case 'left':   return { x: -1, y: 0 };
    case 'top':    return { x: 0, y: -1 };
    case 'bottom': return { x: 0, y: 1 };
    default:       return { x: 1, y: 0 };
  }
}

/**
 * Edge midpoint of an anchor rect for a chosen side. Anchors are pieces OR
 * collapsed-group pill stubs — dimensions come from the anchor, falling back
 * to the provided piece constants. Single source of truth shared by the
 * selector-layer router (computeWireRoutes) and ConnectionLine's fallback
 * path; do not duplicate this math.
 *
 * @param {{x:number,y:number,width?:number,height?:number}} anchor
 * @param {string} side - 'right' | 'left' | 'top' | 'bottom'
 * @param {number} fallbackWidth
 * @param {number} fallbackHeight
 * @returns {{x:number,y:number}}
 */
export function anchorEdgePoint(anchor, side, fallbackWidth, fallbackHeight) {
  const width = Number.isFinite(anchor.width) ? anchor.width : fallbackWidth;
  const height = Number.isFinite(anchor.height) ? anchor.height : fallbackHeight;
  const centerX = anchor.x + width / 2;
  const centerY = anchor.y + height / 2;

  switch (side) {
    case 'right':
      return { x: anchor.x + width, y: centerY };
    case 'left':
      return { x: anchor.x, y: centerY };
    case 'top':
      return { x: centerX, y: anchor.y };
    case 'bottom':
      return { x: centerX, y: anchor.y + height };
    default:
      return { x: centerX, y: centerY };
  }
}

/**
 * Geometry job: returns the ordered point list a wire passes through.
 * Today this is exactly [start, end]. Each point also carries the chosen `side`
 * so the drawing job can launch control points along the edge normal.
 *
 * @param {{x:number,y:number}} sourcePoint - source edge midpoint
 * @param {string} sourceSide - 'right' | 'left' | 'top' | 'bottom'
 * @param {{x:number,y:number}} targetPoint - target edge midpoint
 * @param {string} targetSide
 * @returns {Array<{x:number,y:number,side:string}>}
 */
export function computeWirePoints(sourcePoint, sourceSide, targetPoint, targetSide) {
  return [
    { x: sourcePoint.x, y: sourcePoint.y, side: sourceSide },
    { x: targetPoint.x, y: targetPoint.y, side: targetSide }
  ];
}

/**
 * Drawing job: build a smooth path through the point list.
 *
 * Two points → a single cubic with normal-launch control points
 * (perpendicular to each chosen edge), the shipped look for unrouted wires.
 * Three or more points (a routed polyline) → straight segments joined by
 * constant-radius corner fillets, with an ARC-LENGTH parameterized
 * `pointAt(t)` so decorations distribute uniformly along the drawn path
 * (ADR-025 S2; chevron and count chip keep working unchanged).
 *
 * Returns an SVG path `data` string suitable for a Konva <Path>, plus a
 * `pointAt` helper that answers point + tangent at parameter t from the SAME
 * geometry the path is drawn with (single source of truth).
 *
 * @param {Array<{x:number,y:number,side?:string}>} points - ordered point list
 * @returns {{ data: string, pointAt: (t:number) => ({ x, y, tangent: { x, y } }) } | null}
 */
export function buildWireCurve(points, options = {}) {
  if (!Array.isArray(points) || points.length < 2) return null;
  // Unroutable fallbacks draw the direct segment (ADR-025 §9 under-pass):
  // the normal-launch cubic LOOPS when the chosen faces point back toward
  // each other (inverted-face arrangements), which is exactly when
  // fallbacks occur. A straight dim line reads as the honest under-pass.
  if (options.straight && points.length === 2) {
    const [a, b] = points;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const mag = Math.hypot(dx, dy) || 1;
    return {
      data: `M ${a.x} ${a.y} L ${b.x} ${b.y}`,
      pointAt: (t) => ({
        x: a.x + dx * clamp(t, 0, 1),
        y: a.y + dy * clamp(t, 0, 1),
        tangent: { x: dx / mag, y: dy / mag },
      }),
    };
  }
  // Hops force the polyline path even for a straight 2-point route — the
  // cubic branch cannot bridge crossings. (A routed 2-point list is
  // axis-aligned by construction, so the line piece draws identically.)
  if (points.length > 2 || (Array.isArray(options.hops) && options.hops.length > 0)) {
    return buildPolylineCurve(points, options);
  }

  // Two points: single cubic with normal-launch control points.
  const start = points[0];
  const end = points[points.length - 1];

  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const distance = Math.hypot(dx, dy);

  const offset = clamp(distance * WIRE_LAUNCH_FRACTION, WIRE_LAUNCH_MIN, WIRE_LAUNCH_MAX);

  const startNormal = edgeNormal(start.side);
  const endNormal = edgeNormal(end.side);

  const c1 = { x: start.x + startNormal.x * offset, y: start.y + startNormal.y * offset };
  const c2 = { x: end.x + endNormal.x * offset, y: end.y + endNormal.y * offset };

  const data =
    `M ${start.x} ${start.y} ` +
    `C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${end.x} ${end.y}`;

  // Point + tangent at parameter t on the cubic bezier (P0=start, P1=c1, P2=c2, P3=end).
  const pointAt = (t) => {
    const u = 1 - t;
    // Position: standard cubic Bernstein basis.
    const x =
      u * u * u * start.x +
      3 * u * u * t * c1.x +
      3 * u * t * t * c2.x +
      t * t * t * end.x;
    const y =
      u * u * u * start.y +
      3 * u * u * t * c1.y +
      3 * u * t * t * c2.y +
      t * t * t * end.y;
    // Tangent: derivative of the cubic.
    const tx =
      3 * u * u * (c1.x - start.x) +
      6 * u * t * (c2.x - c1.x) +
      3 * t * t * (end.x - c2.x);
    const ty =
      3 * u * u * (c1.y - start.y) +
      6 * u * t * (c2.y - c1.y) +
      3 * t * t * (end.y - c2.y);
    const mag = Math.hypot(tx, ty) || 1;
    return { x, y, tangent: { x: tx / mag, y: ty / mag } };
  };

  return { data, pointAt };
}

// ---------------------------------------------------------------------------
// Routed polyline drawing (3+ points) — ADR-025 S2, hops S6
// ---------------------------------------------------------------------------

// Samples per fillet for arc-length measurement. Fillets are small (≤12px
// radius), so a coarse sampling is well within a pixel of exact.
const FILLET_LENGTH_SAMPLES = 8;

// Half-width of a hop bump (matches wireCrossings.WIRE_HOP_RADIUS — kept
// numerically local to avoid a utils→utils cycle; the crossing pass owns
// placement, this owns shape).
const HOP_RADIUS = 6;

// Split line pieces at hop crossings, bridging each with a small quad bump
// (ADR-025 §8: the quiet wire hops the loud one). Horizontal legs bulge up,
// vertical legs bulge right — one convention, deterministic.
function insertHops(pieces, hops) {
  if (!Array.isArray(hops) || hops.length === 0) return pieces;
  const out = [];
  for (const piece of pieces) {
    if (piece.type !== 'line') {
      out.push(piece);
      continue;
    }
    const horizontal = piece.p0.y === piece.p1.y;
    const axis = horizontal ? 'h' : 'v';
    const travel = horizontal ? 'x' : 'y';
    const coordAxis = horizontal ? 'y' : 'x';
    const dir = Math.sign(piece.p1[travel] - piece.p0[travel]);
    const lo = Math.min(piece.p0[travel], piece.p1[travel]);
    const hi = Math.max(piece.p0[travel], piece.p1[travel]);

    const mine = hops
      .filter((h) => h.axis === axis
        && h[coordAxis] === piece.p0[coordAxis]
        && h[travel] > lo + HOP_RADIUS && h[travel] < hi - HOP_RADIUS)
      .sort((a, b) => dir * (a[travel] - b[travel]));

    let cursor = piece.p0;
    for (const hop of mine) {
      const before = { ...cursor };
      const entry = { ...cursor, [travel]: hop[travel] - dir * HOP_RADIUS };
      const exit = { ...cursor, [travel]: hop[travel] + dir * HOP_RADIUS };
      const apexOffset = horizontal ? { y: -2 * HOP_RADIUS } : { x: 2 * HOP_RADIUS };
      const cp = {
        x: hop.x + (apexOffset.x ?? 0),
        y: hop.y + (apexOffset.y ?? 0),
      };
      if (entry[travel] !== before[travel]) out.push({ type: 'line', p0: before, p1: entry });
      out.push({ type: 'quad', p0: entry, cp, p1: exit });
      cursor = exit;
    }
    if (cursor[travel] !== piece.p1[travel] || cursor[coordAxis] !== piece.p1[coordAxis]) {
      out.push({ type: 'line', p0: cursor, p1: piece.p1 });
    }
  }
  return out;
}

/**
 * Build the piecewise geometry for a routed polyline: straight segments
 * joined by quadratic-bezier corner fillets at interior vertices. Collinear
 * vertices and degenerate (zero-length) segments pass straight through.
 *
 * Pieces are measured for arc length so `pointAt(t)` is uniform along the
 * drawn path — t=0.5 is halfway along the wire's actual length, regardless
 * of how legs and corners distribute.
 */
function buildPolylineCurve(rawPoints, options = {}) {
  // Dedupe consecutive duplicates — zero-length legs contribute nothing.
  const pts = [];
  for (const p of rawPoints) {
    const prev = pts[pts.length - 1];
    if (prev && prev.x === p.x && prev.y === p.y) continue;
    pts.push(p);
  }
  if (pts.length < 2) return null;
  // Two points degenerate to the cubic — unless hops must be bridged, in
  // which case the corner loop no-ops and the single line piece below
  // carries the bumps.
  if (pts.length === 2 && !(Array.isArray(options.hops) && options.hops.length > 0)) {
    return buildWireCurve(pts);
  }

  // For each interior vertex, compute the fillet: pull back along both legs
  // by r (clamped to half of each leg) and bridge with a quadratic whose
  // control point is the vertex itself.
  const pieces = []; // {type:'line',p0,p1} | {type:'quad',p0,cp,p1}
  let cursor = pts[0];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1];
    const v = pts[i];
    const next = pts[i + 1];

    const inLen = Math.hypot(v.x - prev.x, v.y - prev.y);
    const outLen = Math.hypot(next.x - v.x, next.y - v.y);
    const inDir = { x: (v.x - prev.x) / (inLen || 1), y: (v.y - prev.y) / (inLen || 1) };
    const outDir = { x: (next.x - v.x) / (outLen || 1), y: (next.y - v.y) / (outLen || 1) };

    // Collinear (or reversal-free straight-through): no corner, no fillet.
    const cross = inDir.x * outDir.y - inDir.y * outDir.x;
    const dot = inDir.x * outDir.x + inDir.y * outDir.y;
    if (Math.abs(cross) < 1e-9 && dot > 0) continue;

    const r = Math.min(WIRE_FILLET_RADIUS, inLen / 2, outLen / 2);
    const filletStart = { x: v.x - inDir.x * r, y: v.y - inDir.y * r };
    const filletEnd = { x: v.x + outDir.x * r, y: v.y + outDir.y * r };

    if (filletStart.x !== cursor.x || filletStart.y !== cursor.y) {
      pieces.push({ type: 'line', p0: cursor, p1: filletStart });
    }
    pieces.push({ type: 'quad', p0: filletStart, cp: { x: v.x, y: v.y }, p1: filletEnd });
    cursor = filletEnd;
  }
  const last = pts[pts.length - 1];
  if (last.x !== cursor.x || last.y !== cursor.y) {
    pieces.push({ type: 'line', p0: cursor, p1: last });
  }
  if (pieces.length === 0) return null;

  // S6: bridge hop crossings with quad bumps (quiet wire over loud wire).
  const finalPieces = insertHops(pieces, options.hops);

  // --- Arc-length table ---
  const quadPoint = (piece, t) => {
    const u = 1 - t;
    return {
      x: u * u * piece.p0.x + 2 * u * t * piece.cp.x + t * t * piece.p1.x,
      y: u * u * piece.p0.y + 2 * u * t * piece.cp.y + t * t * piece.p1.y,
    };
  };
  const pieceLength = (piece) => {
    if (piece.type === 'line') return Math.hypot(piece.p1.x - piece.p0.x, piece.p1.y - piece.p0.y);
    let len = 0;
    let prev = piece.p0;
    for (let i = 1; i <= FILLET_LENGTH_SAMPLES; i++) {
      const p = quadPoint(piece, i / FILLET_LENGTH_SAMPLES);
      len += Math.hypot(p.x - prev.x, p.y - prev.y);
      prev = p;
    }
    return len;
  };
  const lengths = finalPieces.map(pieceLength);
  const totalLength = lengths.reduce((a, b) => a + b, 0);
  if (totalLength === 0) return null;

  // --- SVG path data ---
  let data = `M ${finalPieces[0].p0.x} ${finalPieces[0].p0.y}`;
  for (const piece of finalPieces) {
    data += piece.type === 'line'
      ? ` L ${piece.p1.x} ${piece.p1.y}`
      : ` Q ${piece.cp.x} ${piece.cp.y} ${piece.p1.x} ${piece.p1.y}`;
  }

  // --- Arc-length parameterized pointAt ---
  const pointAt = (t) => {
    const target = clamp(t, 0, 1) * totalLength;
    let acc = 0;
    for (let i = 0; i < finalPieces.length; i++) {
      const piece = finalPieces[i];
      const len = lengths[i];
      if (acc + len < target && i < finalPieces.length - 1) {
        acc += len;
        continue;
      }
      const local = len === 0 ? 0 : clamp((target - acc) / len, 0, 1);
      if (piece.type === 'line') {
        const dx = piece.p1.x - piece.p0.x;
        const dy = piece.p1.y - piece.p0.y;
        const mag = Math.hypot(dx, dy) || 1;
        return {
          x: piece.p0.x + dx * local,
          y: piece.p0.y + dy * local,
          tangent: { x: dx / mag, y: dy / mag },
        };
      }
      const p = quadPoint(piece, local);
      // Quadratic derivative: 2(1-t)(cp-p0) + 2t(p1-cp)
      const u = 1 - local;
      const tx = 2 * u * (piece.cp.x - piece.p0.x) + 2 * local * (piece.p1.x - piece.cp.x);
      const ty = 2 * u * (piece.cp.y - piece.p0.y) + 2 * local * (piece.p1.y - piece.cp.y);
      const mag = Math.hypot(tx, ty) || 1;
      return { x: p.x, y: p.y, tangent: { x: tx / mag, y: ty / mag } };
    }
    // Unreachable (loop always returns on the last piece) — defensive.
    const tail = finalPieces[finalPieces.length - 1];
    const endPoint = tail.type === 'line' ? tail.p1 : tail.p1;
    return { x: endPoint.x, y: endPoint.y, tangent: { x: 1, y: 0 } };
  };

  return { data, pointAt };
}
