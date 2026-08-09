/**
 * orthogonalRouter.js — obstacle-avoiding orthogonal wire routing
 * (ADR-025 §1/§2, slice S3).
 *
 * Pure geometry: `(terminals, obstacles) → point list | null`. No app-layer
 * imports, no state, deterministic by construction (sorted coordinates,
 * total-order tie-breaks) — same inputs always produce the same route.
 *
 * Algorithm: A* over the sparse orthogonal grid induced by the inflated
 * obstacle edges (a Hanan grid) plus the two terminal stubs. Cost is path
 * length plus a per-corner penalty (R2 shortest route, R7 no-spaghetti —
 * fewer corners beat marginally shorter zigzags). The chosen faces are
 * honored: routes launch along each terminal's face normal (ADR-025 §6 —
 * side authority lives upstream; this module never re-sides).
 *
 * Scale posture: candidate coordinates are O(obstacles), nodes O(n²) on the
 * sparse grid — comfortable for canvas-scale inputs (dozens of pieces).
 * Revisit against G6 measurements (ADR-025 follow-ups) before assuming more.
 */

// Clearance between a wire and the obstacles it routes around, and the
// length of the terminal stub that carries the wire off its face. Half the
// GAP_X = 20 grid gutter — one constant family (ADR-025 §2).
export const WIRE_CLEARANCE = 10;

// Extra cost per 90° corner, in px-equivalent units. High enough to prefer
// an L over a staircase, low enough that a corner is always preferred over
// a long detour.
export const TURN_PENALTY = 40;

const NORMALS = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

export const inflate = (rect, by) => ({
  left: rect.x - by,
  top: rect.y - by,
  right: rect.x + rect.width + by,
  bottom: rect.y + rect.height + by,
});

const insideAny = (rects, x, y) =>
  rects.some((r) => x > r.left && x < r.right && y > r.top && y < r.bottom);

// A horizontal/vertical segment is blocked when it passes through an
// inflated obstacle's OPEN interior. Riding an exact boundary is allowed —
// that is what "routing around at clearance" means on the induced grid.
// Exported for the corridor-spacing pass (S4), which must not push a
// separated wire into an obstacle.
export function segmentBlocked(rects, x1, y1, x2, y2) {
  if (y1 === y2) {
    const [lo, hi] = x1 < x2 ? [x1, x2] : [x2, x1];
    return rects.some((r) =>
      y1 > r.top && y1 < r.bottom && hi > r.left && lo < r.right
    );
  }
  const [lo, hi] = y1 < y2 ? [y1, y2] : [y2, y1];
  return rects.some((r) =>
    x1 > r.left && x1 < r.right && hi > r.top && lo < r.bottom
  );
}

/**
 * Route one wire around the obstacle set.
 *
 * @param {object} params
 * @param {{x:number,y:number}} params.startPoint - source edge midpoint
 * @param {string} params.startSide - face the wire launches from
 * @param {{x:number,y:number}} params.endPoint - target edge midpoint
 * @param {string} params.endSide - face the wire lands on
 * @param {Array<{x:number,y:number,width:number,height:number}>} params.obstacles
 *   Rects to avoid. Callers exclude the wire's own source/target rects.
 * @returns {Array<{x:number,y:number,side?:string}>|null} full point list
 *   (terminal → stub → corners → stub → terminal), or null when no route
 *   exists (caller decides the fallback — ADR-025 §9 lands in S6).
 */
export function routeOrthogonal({ startPoint, startSide, endPoint, endSide, obstacles }) {
  const startNormal = NORMALS[startSide] ?? NORMALS.right;
  const endNormal = NORMALS[endSide] ?? NORMALS.left;

  const stubStart = {
    x: startPoint.x + startNormal.x * WIRE_CLEARANCE,
    y: startPoint.y + startNormal.y * WIRE_CLEARANCE,
  };
  const stubEnd = {
    x: endPoint.x + endNormal.x * WIRE_CLEARANCE,
    y: endPoint.y + endNormal.y * WIRE_CLEARANCE,
  };

  // Inflate by a hair under the clearance so a wire riding the grid line AT
  // clearance distance is not counted as "inside" by float noise.
  // `coreOnly` obstacles (a wire's OWN endpoint rects) inflate minimally:
  // the wire may hug or thread the clearance zone of its own tiles, but
  // never pass THROUGH a body — inverted-face arrangements wrap cleanly
  // around instead (ADR-025 §6: the router makes the wrap clean).
  const rects = (obstacles ?? []).map((o) =>
    inflate(o, o.coreOnly ? 1 : WIRE_CLEARANCE - 0.5));

  // A stub buried inside someone else's clearance zone has no legal launch;
  // let the caller fall back (S6 owns graceful failure).
  if (insideAny(rects, stubStart.x, stubStart.y) || insideAny(rects, stubEnd.x, stubEnd.y)) {
    return null;
  }

  // --- Sparse grid coordinates: obstacle edges + both stubs ---
  const xsSet = new Set([stubStart.x, stubEnd.x]);
  const ysSet = new Set([stubStart.y, stubEnd.y]);
  for (const r of rects) {
    xsSet.add(r.left); xsSet.add(r.right);
    ysSet.add(r.top); ysSet.add(r.bottom);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const xIndex = new Map(xs.map((v, i) => [v, i]));
  const yIndex = new Map(ys.map((v, i) => [v, i]));

  const nodeKey = (xi, yi) => xi * ys.length + yi;
  const startKey = nodeKey(xIndex.get(stubStart.x), yIndex.get(stubStart.y));
  const endKey = nodeKey(xIndex.get(stubEnd.x), yIndex.get(stubEnd.y));

  // --- A* (Manhattan heuristic; admissible with segment costs = length) ---
  // Total-order tie-break (f, then turns, then insertion order) keeps the
  // search deterministic across runs and platforms.
  const heuristic = (xi, yi) =>
    Math.abs(xs[xi] - stubEnd.x) + Math.abs(ys[yi] - stubEnd.y);

  // Entry direction matters for the corner count, so the search state is
  // (node, incoming direction). 0=+x 1=-x 2=+y 3=-y, 4=none (start).
  const DIRS = [
    { dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 },
  ];
  const startDir =
    startNormal.x === 1 ? 0 : startNormal.x === -1 ? 1 : startNormal.y === 1 ? 2 : 3;

  const stateKey = (nk, dir) => nk * 5 + dir;
  const gScore = new Map();
  const cameFrom = new Map();
  let seq = 0;
  // Binary min-heap over [f, turns, seq, nodeKey, dir, g]
  const heap = [];
  const heapPush = (entry) => {
    heap.push(entry);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compare(heap[i], heap[p]) >= 0) break;
      [heap[i], heap[p]] = [heap[p], heap[i]];
      i = p;
    }
  };
  const heapPop = () => {
    const top = heap[0];
    const tail = heap.pop();
    if (heap.length > 0) {
      heap[0] = tail;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && compare(heap[l], heap[m]) < 0) m = l;
        if (r < heap.length && compare(heap[r], heap[m]) < 0) m = r;
        if (m === i) break;
        [heap[i], heap[m]] = [heap[m], heap[i]];
        i = m;
      }
    }
    return top;
  };
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

  const startState = stateKey(startKey, startDir);
  gScore.set(startState, 0);
  heapPush([heuristic(xIndex.get(stubStart.x), yIndex.get(stubStart.y)), 0, seq++, startKey, startDir, 0]);

  let found = null;
  while (heap.length > 0) {
    const [, turns, , nk, dir, g] = heapPop();
    const sk = stateKey(nk, dir);
    if (g > (gScore.get(sk) ?? Infinity)) continue;
    if (nk === endKey) {
      found = sk;
      break;
    }
    const xi = Math.floor(nk / ys.length);
    const yi = nk % ys.length;

    for (let d = 0; d < 4; d++) {
      const { dx, dy } = DIRS[d];
      const nxi = xi + dx;
      const nyi = yi + dy;
      if (nxi < 0 || nxi >= xs.length || nyi < 0 || nyi >= ys.length) continue;
      const x1 = xs[xi], y1 = ys[yi], x2 = xs[nxi], y2 = ys[nyi];
      if (segmentBlocked(rects, x1, y1, x2, y2)) continue;
      // Neighbor grid POINTS inside an inflated rect are unreachable anyway
      // (their segments are blocked), so no separate node test is needed.
      const stepLen = Math.abs(x2 - x1) + Math.abs(y2 - y1);
      const turned = dir !== 4 && d !== dir ? 1 : 0;
      const ng = g + stepLen + turned * TURN_PENALTY;
      const nsk = stateKey(nodeKey(nxi, nyi), d);
      if (ng < (gScore.get(nsk) ?? Infinity)) {
        gScore.set(nsk, ng);
        cameFrom.set(nsk, sk);
        heapPush([ng + heuristic(nxi, nyi), turns + turned, seq++, nodeKey(nxi, nyi), d, ng]);
      }
    }
  }
  if (found == null) return null;

  // --- Reconstruct, then merge collinear runs ---
  const gridPath = [];
  for (let sk = found; sk != null; sk = cameFrom.get(sk)) {
    const nk = Math.floor(sk / 5);
    gridPath.push({ x: xs[Math.floor(nk / ys.length)], y: ys[nk % ys.length] });
    if (sk === startState) break;
  }
  gridPath.reverse();

  const full = [
    { x: startPoint.x, y: startPoint.y, side: startSide },
    ...gridPath,
    { x: endPoint.x, y: endPoint.y, side: endSide },
  ];
  const simplified = [full[0]];
  for (let i = 1; i < full.length - 1; i++) {
    const a = simplified[simplified.length - 1];
    const b = full[i];
    const c = full[i + 1];
    if (a.x === b.x && b.x === c.x) continue;
    if (a.y === b.y && b.y === c.y) continue;
    if (a.x === b.x && a.y === b.y) continue; // duplicate
    simplified.push(b);
  }
  simplified.push(full[full.length - 1]);
  return simplified;
}
