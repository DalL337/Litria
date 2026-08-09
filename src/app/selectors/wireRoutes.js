/**
 * wireRoutes.js — the global wire-routing pass (ADR-025 §1).
 *
 * Routing is a pure, deterministic, canvas-level function: it sees every
 * wire at once (per-wire computation cannot do inter-wire spacing) and
 * returns a route map keyed by connection id. ConnectionLine receives its
 * point list as a prop and keeps drawing — the compute/draw seam survives,
 * computation moves up one level.
 *
 * S3: obstacle avoidance (R1/R2). The obstacle registry covers piece rects,
 * collapsed-group pills, and memberless manual seed boxes. Expanded group
 * boxes are deliberately absent until S5 (border discipline) — a hard box
 * obstacle would wall off wires to the group's own members; purposeful
 * crossing is that slice's whole subject. Wires whose orthogonal route
 * cannot be found fall back to the straight pair (graceful failure per the
 * current z-order; the D4 dim treatment lands in S6).
 *
 * S4: legible separation (R3/R5, D3). Terminals distribute along shared
 * faces (distributed stubs) before routing; coincident corridor legs
 * separate after routing. Both passes live in utils/wireSpacing.js.
 *
 * Determinism contract: same inputs → same routes (testable; no flicker).
 * Nothing here reads hover/selection state — geometry responds to structure,
 * appearance responds to attention (ADR-025 §3).
 */

import { anchorEdgePoint, computeWirePoints } from '../../utils/wireGeometry.js';
import {
  routeOrthogonal,
  inflate,
  segmentBlocked,
  WIRE_CLEARANCE,
} from '../../utils/orthogonalRouter.js';
import { distributeTerminals, separateCorridors } from '../../utils/wireSpacing.js';
import { computeWireHops } from '../../utils/wireCrossings.js';
import {
  COLLAPSED_STUB_HEIGHT,
  GROUP_OUTLINE_PAD,
  GROUP_NEST_PAD,
  hasCollapsedAncestor,
} from './workspaceSelectors.js';

/**
 * Build the obstacle registry for the routing pass (ADR-025 G3).
 *
 * Registry entries carry enough identity for per-wire exclusion: a wire
 * never avoids its own endpoints' rects.
 *
 * @param {object} params
 * @param {Array<{id:number, x:number, y:number, filename?:string}>} params.pieces
 * @param {Set<number>} params.hiddenPieceIds
 * @param {(path:string) => boolean} params.isPathHidden
 * @param {Array<object>} params.groups
 * @param {(group:object) => ({minX:number,minY:number,maxX:number,maxY:number}|null)} params.getGroupBounds
 * @param {number} params.pieceWidth
 * @param {number} params.pieceHeight
 * @returns {Array<{x:number,y:number,width:number,height:number,kind:string,pieceId?:number,groupId?:number}>}
 */
export function buildWireObstacles({
  pieces,
  hiddenPieceIds,
  isPathHidden,
  groups,
  getGroupBounds,
  pieceWidth,
  pieceHeight,
}) {
  const obstacles = [];

  for (const piece of pieces ?? []) {
    if (!Number.isFinite(piece.x) || !Number.isFinite(piece.y)) continue;
    if (hiddenPieceIds?.has(piece.id)) continue;
    if (piece.filename && isPathHidden?.(piece.filename)) continue;
    obstacles.push({
      x: piece.x,
      y: piece.y,
      width: pieceWidth,
      height: pieceHeight,
      kind: 'piece',
      pieceId: piece.id,
    });
  }

  const groupsById = new Map((groups ?? []).map((g) => [g.id, g]));
  for (const group of groups ?? []) {
    if (group.folderPath && isPathHidden?.(group.folderPath)) continue;
    // Ancestor-collapsed groups don't render (D3 — folded into the ancestor
    // pill), so they must not leave a phantom pill/box obstacle where they
    // used to draw.
    if (hasCollapsedAncestor(group, groupsById)) continue;
    if (group.isCollapsed) {
      const bounds = getGroupBounds?.(group);
      if (!bounds) continue;
      obstacles.push({
        x: bounds.minX,
        y: bounds.minY,
        width: pieceWidth,
        height: COLLAPSED_STUB_HEIGHT,
        kind: 'pill',
        groupId: group.id,
      });
      continue;
    }
    // Memberless manual box (ADR-018 box-first): a drawn rect with no
    // pieces inside — wires shouldn't cut through it.
    if ((group.pieceIds?.length ?? 0) === 0 && group.seedBounds) {
      const bounds = getGroupBounds?.(group);
      if (!bounds) continue;
      obstacles.push({
        x: bounds.minX,
        y: bounds.minY,
        width: bounds.maxX - bounds.minX,
        height: bounds.maxY - bounds.minY,
        kind: 'box',
        groupId: group.id,
      });
      continue;
    }
    // Expanded group WITH members (S5 border discipline): the drawn box —
    // content bounds + the same pad WorkspaceStage renders with — is a
    // border obstacle. Annotated with its subtree so the routing pass can
    // tell member wires (gate through) from stranger wires (route around).
    if ((group.pieceIds?.length ?? 0) > 0) {
      const bounds = getGroupBounds?.(group);
      if (!bounds) continue;
      const pad = group.parentId ? GROUP_OUTLINE_PAD + GROUP_NEST_PAD : GROUP_OUTLINE_PAD;
      const subtree = collectSubtree(group, groups);
      obstacles.push({
        x: bounds.minX - pad,
        y: bounds.minY - pad,
        width: bounds.maxX - bounds.minX + 2 * pad,
        height: bounds.maxY - bounds.minY + 2 * pad,
        kind: 'groupBox',
        groupId: group.id,
        containsPieceIds: subtree.pieceIds,
        containsGroupIds: subtree.groupIds,
      });
    }
  }

  return obstacles;
}

// All piece ids and group ids in a group's subtree (the group itself plus
// descendants via parentId), cycle-guarded. Collapsed descendants count:
// their pills anchor wires that must gate through the expanded ancestors.
function collectSubtree(root, groups) {
  const childrenByParent = new Map();
  for (const g of groups ?? []) {
    if (g.parentId == null) continue;
    if (!childrenByParent.has(g.parentId)) childrenByParent.set(g.parentId, []);
    childrenByParent.get(g.parentId).push(g);
  }
  const pieceIds = new Set();
  const groupIds = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const g = stack.pop();
    if (groupIds.has(g.id)) continue;
    groupIds.add(g.id);
    for (const pid of g.pieceIds ?? []) pieceIds.add(pid);
    for (const child of childrenByParent.get(g.id) ?? []) stack.push(child);
  }
  return { pieceIds, groupIds };
}

// Does this obstacle belong to one of the wire's own endpoints?
function isEndpointObstacle(obstacle, sourceAnchor, targetAnchor) {
  if (obstacle.kind === 'piece') {
    return obstacle.pieceId === sourceAnchor?.pieceId
      || obstacle.pieceId === targetAnchor?.pieceId;
  }
  if (obstacle.kind === 'pill') {
    return obstacle.groupId === sourceAnchor?.groupId
      || obstacle.groupId === targetAnchor?.groupId;
  }
  return false;
}

// Group boxes whose subtree contains this anchor (piece by membership,
// nested collapsed pill by group ancestry).
function boxesContaining(groupBoxes, anchor) {
  if (anchor?.kind === 'pill') {
    return groupBoxes.filter((b) =>
      b.groupId !== anchor.groupId && b.containsGroupIds.has(anchor.groupId));
  }
  return groupBoxes.filter((b) => b.containsPieceIds.has(anchor?.pieceId));
}

const GATE_NORMALS = {
  right: { x: 1, y: 0 },
  left: { x: -1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
};

// Are a previous route's interior legs (everything but the first and last
// segment) still clear of the current obstacle set? Cheap validation that
// lets an unchanged wire skip A* entirely (S7 stability bias).
function interiorLegsClear(points, obstacles) {
  if (points.length < 4) return true; // only terminal legs — nothing to check
  const rects = obstacles.map((o) => inflate(o, o.coreOnly ? 1 : WIRE_CLEARANCE - 0.5));
  for (let i = 1; i < points.length - 2; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (segmentBlocked(rects, a.x, a.y, b.x, b.y)) return false;
  }
  return true;
}

/**
 * D6 drag overlay (ADR-025 §10): while a drag is in flight, no routing
 * runs. Wires whose anchors the drag is moving fall back to the cheap
 * direct pair (the shipped drag look); every other wire keeps its frozen
 * settled route. The router computes final paths on drop.
 *
 * @param {object} params
 * @param {Array<object>} params.wires - current renderable wires
 * @param {Map<number|string, object>} params.settledRoutes - last settled map
 * @param {number} params.pieceWidth
 * @param {number} params.pieceHeight
 * @returns {Map<number|string, object>}
 */
export function buildDragWireRoutes({ wires, settledRoutes, pieceWidth, pieceHeight }) {
  const out = new Map();
  for (const wire of wires ?? []) {
    const { connection, sourceAnchor, targetAnchor, sourceSide, targetSide } = wire;
    if (!connection || !sourceAnchor || !targetAnchor) continue;
    const anchorKey =
      `${sourceAnchor.x},${sourceAnchor.y},${targetAnchor.x},${targetAnchor.y}`;
    const settled = settledRoutes?.get?.(connection.id);
    if (settled && settled.anchorKey === anchorKey) {
      out.set(connection.id, settled);
      continue;
    }
    const sourcePoint = anchorEdgePoint(sourceAnchor, sourceSide, pieceWidth, pieceHeight);
    const targetPoint = anchorEdgePoint(targetAnchor, targetSide, pieceWidth, pieceHeight);
    if (!Number.isFinite(sourcePoint.x) || !Number.isFinite(targetPoint.x)) continue;
    // routed:true — a drag wire is following the hand, not failing (no D4
    // dim); 2 points → the cheap direct bezier.
    out.set(connection.id, {
      points: computeWirePoints(sourcePoint, sourceSide, targetPoint, targetSide),
      routed: true,
      drag: true,
      anchorKey,
    });
  }
  return out;
}

/**
 * Border discipline (R6): a wire ending inside a group crosses the border
 * on the extension of its terminal stub — perpendicular through the box
 * edge, straight toward the specific node. The gate is that crossing's
 * exit point just outside the OUTERMOST non-shared box.
 *
 * Returns null when the perpendicular corridor from terminal to gate is
 * blocked (a sibling piece in the way) — caller falls back to excluding
 * the chain's boxes for this wire instead.
 */
function resolveGate(terminal, side, chainBoxes, blockingRects) {
  const normal = GATE_NORMALS[side] ?? GATE_NORMALS.right;
  let outer = chainBoxes[0];
  for (const box of chainBoxes) {
    if (box.width * box.height > outer.width * outer.height) outer = box;
  }
  const gate = normal.x === 1 ? { x: outer.x + outer.width + WIRE_CLEARANCE, y: terminal.y }
    : normal.x === -1 ? { x: outer.x - WIRE_CLEARANCE, y: terminal.y }
      : normal.y === 1 ? { x: terminal.x, y: outer.y + outer.height + WIRE_CLEARANCE }
        : { x: terminal.x, y: outer.y - WIRE_CLEARANCE };

  // The gate must actually lie beyond the terminal along the normal.
  const forward = (gate.x - terminal.x) * normal.x + (gate.y - terminal.y) * normal.y;
  if (forward <= 0) return null;

  if (segmentBlocked(blockingRects, terminal.x, terminal.y, gate.x, gate.y)) return null;
  return gate;
}

/**
 * Compute routes for every renderable wire.
 *
 * @param {object} params
 * @param {Array<{
 *   connection: { id: number|string },
 *   sourceAnchor: { x: number, y: number, width?: number, height?: number },
 *   targetAnchor: { x: number, y: number, width?: number, height?: number },
 *   sourceSide: string,
 *   targetSide: string,
 * }>} params.wires - output of buildRenderableWires (aggregated)
 * @param {Array<object>} [params.obstacles] - buildWireObstacles output
 * @param {number} params.pieceWidth - anchor dimension fallback
 * @param {number} params.pieceHeight - anchor dimension fallback
 * @returns {Map<number|string, { points: Array<{x:number,y:number,side?:string}>, routed: boolean }>}
 */
export function computeWireRoutes({
  wires,
  obstacles = [],
  pieceWidth,
  pieceHeight,
  // Connection ids whose wires rest popped (exception status) — route-time
  // loudness for hop ownership (ADR-025 §8). Hover never changes this.
  loudConnectionIds = null,
  // Previous settled route map (ADR-025 §2 stability bias, S7): a wire
  // keeps its previous route when its terminals are unchanged and the old
  // interior legs are still clear — unrelated changes never flap it.
  previousRoutes = null,
}) {
  // D3: wires converging on one face spread their terminals along it
  // (distributed stubs — side preserved, midpoint relaxed).
  const terminals = distributeTerminals(wires, pieceWidth, pieceHeight);
  const groupBoxes = obstacles.filter((o) => o.kind === 'groupBox');

  const routes = new Map();
  for (const wire of wires ?? []) {
    const { connection, sourceAnchor, targetAnchor, sourceSide, targetSide } = wire;
    if (!connection || !sourceAnchor || !targetAnchor) continue;

    const terminal = terminals.get(connection.id);
    if (!terminal) continue;
    const { sourcePoint, targetPoint } = terminal;
    if (!Number.isFinite(sourcePoint.x) || !Number.isFinite(sourcePoint.y)) continue;
    if (!Number.isFinite(targetPoint.x) || !Number.isFinite(targetPoint.y)) continue;

    // S5 border classification: boxes shared by both endpoints are interior
    // (route freely inside — an intra-group wire never crosses its own
    // border); boxes owning exactly one endpoint are gated through.
    const sourceBoxes = boxesContaining(groupBoxes, sourceAnchor);
    const targetBoxes = boxesContaining(groupBoxes, targetAnchor);
    const targetBoxIds = new Set(targetBoxes.map((b) => b.groupId));
    const commonIds = new Set(
      sourceBoxes.filter((b) => targetBoxIds.has(b.groupId)).map((b) => b.groupId)
    );
    const sourceChain = sourceBoxes.filter((b) => !commonIds.has(b.groupId));
    const targetChain = targetBoxes.filter((b) => !commonIds.has(b.groupId));

    const baseObstacles = obstacles.filter((o) =>
      !isEndpointObstacle(o, sourceAnchor, targetAnchor)
      && !(o.kind === 'groupBox' && commonIds.has(o.groupId))
    );

    // Gate legs may cross their own chain's borders but nothing else.
    const gateBlockers = baseObstacles
      .filter((o) => !(o.kind === 'groupBox'
        && (sourceChain.includes(o) || targetChain.includes(o))))
      .map((o) => inflate(o, WIRE_CLEARANCE - 0.5));

    const sourceGate = sourceChain.length > 0
      ? resolveGate(sourcePoint, sourceSide, sourceChain, gateBlockers)
      : null;
    const targetGate = targetChain.length > 0
      ? resolveGate(targetPoint, targetSide, targetChain, gateBlockers)
      : null;

    // A chain without a workable gate is excluded from this wire's
    // obstacles instead (the wire still crosses the border, just without
    // the ceremonial perpendicular entry — fallback, not failure).
    const wireObstacles = baseObstacles.filter((o) => {
      if (o.kind !== 'groupBox') return true;
      if (sourceChain.includes(o)) return sourceGate != null;
      if (targetChain.includes(o)) return targetGate != null;
      return true;
    });

    // Anchor fingerprint rides every route so the drag overlay (S7/D6) can
    // tell which wires an in-flight drag is moving.
    const anchorKey =
      `${sourceAnchor.x},${sourceAnchor.y},${targetAnchor.x},${targetAnchor.y}`;

    // Own endpoint rects as CORE obstacles (minimal inflation) — shared by
    // the A* set and the reuse validation below.
    const ownCores = obstacles
      .filter((o) => isEndpointObstacle(o, sourceAnchor, targetAnchor))
      .map((o) => ({ ...o, coreOnly: true }));

    // Stability bias (S7): reuse the previous route outright when this
    // wire's distributed terminals are unchanged and its interior legs are
    // still clear of the current obstacle set. Terminal/gate legs are
    // exempt from the clearance check — they are pinned by the terminals
    // and may legally cross this wire's own borders.
    const prev = previousRoutes?.get?.(connection.id);
    if (prev?.routed && prev.points.length >= 2) {
      const prevStart = prev.points[0];
      const prevEnd = prev.points[prev.points.length - 1];
      // Terminal legs validate against the gate-blocker set (everything
      // except this wire's own border chain — a gate leg legally crosses
      // its chain); interior legs against the full wire obstacle set.
      const p = prev.points;
      const first = [p[0], p[1]];
      const last = [p[p.length - 2], p[p.length - 1]];
      const terminalLegsClear =
        !segmentBlocked(gateBlockers, first[0].x, first[0].y, first[1].x, first[1].y)
        && !segmentBlocked(gateBlockers, last[0].x, last[0].y, last[1].x, last[1].y);
      if (
        prevStart.x === sourcePoint.x && prevStart.y === sourcePoint.y
        && prevEnd.x === targetPoint.x && prevEnd.y === targetPoint.y
        && terminalLegsClear
        && interiorLegsClear(prev.points, [...wireObstacles, ...ownCores])
      ) {
        routes.set(connection.id, { points: prev.points, routed: true, anchorKey });
        continue;
      }
    }

    const routeStart = sourceGate ?? sourcePoint;
    const routeEnd = targetGate ?? targetPoint;
    // The A* set includes the own cores: routes may hug their own tiles
    // but never pass through a body. Terminal legs are prepended outside
    // the search and gate legs validate against gateBlockers (own rects
    // excluded), so launches stay legal. Deep overlaps bury a stub inside
    // the other endpoint's core → null → D4 fallback.
    const routed = routeOrthogonal({
      startPoint: routeStart,
      startSide: sourceSide,
      endPoint: routeEnd,
      endSide: targetSide,
      obstacles: [...wireObstacles, ...ownCores],
    });

    if (routed) {
      // Stitch gated terminals back on. The gate sits on the terminal's
      // face normal, and the router's first/last legs leave the gates along
      // that same normal — the joins are collinear by construction.
      const points = [...routed];
      if (sourceGate) points.splice(0, 1, { ...sourcePoint, side: sourceSide });
      if (targetGate) points.splice(points.length - 1, 1, { ...targetPoint, side: targetSide });
      routes.set(connection.id, { points, routed: true, anchorKey });
    } else {
      routes.set(connection.id, {
        points: computeWirePoints(sourcePoint, sourceSide, targetPoint, targetSide),
        routed: false,
        anchorKey,
      });
    }
  }

  // R3/R5: coincident corridor legs separate in steps; terminal legs and
  // obstacle clearances are respected, overlap survives where they can't be.
  const separated = separateCorridors(routes, obstacles);

  // D5 hops: quiet wires bridge loud ones at asymmetric-visibility
  // crossings. Ownership is fixed here, at route time.
  const hops = computeWireHops(separated, loudConnectionIds ?? new Set());
  for (const [id, wireHops] of hops.entries()) {
    const route = separated.get(id);
    separated.set(id, { ...route, hops: wireHops });
  }
  return separated;
}
