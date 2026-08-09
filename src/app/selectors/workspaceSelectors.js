import { chooseFacingSides } from '../connectionAnchoring.js';

export function buildPiecesById(pieces) {
  const map = new Map();
  pieces.forEach((piece) => map.set(piece.id, piece));
  return map;
}

export function buildPiecesByFilename(pieces) {
  const map = new Map();
  pieces.forEach((piece) => {
    if (!piece?.filename) return;
    const normalized = typeof piece.filename === 'string'
      ? piece.filename.replace(/\\/g, '/').replace(/^\/+/, '')
      : piece.filename;
    map.set(normalized, piece);
  });
  return map;
}

export function buildGroupByPieceId(groups) {
  const map = new Map();
  groups.forEach((group) => {
    (group.pieceIds || []).forEach((pieceId) => {
      map.set(pieceId, group.id);
    });
  });
  return map;
}

export function buildGroupColorByPieceId(groups) {
  const map = new Map();
  groups.forEach((group) => {
    if (!group.color) return;
    (group.pieceIds || []).forEach((pieceId) => {
      map.set(pieceId, group.color);
    });
  });
  return map;
}

/**
 * Resolve a node's left-edge color through the cascade (ADR-014 amendment 2026-06-13):
 *   1. ad-hoc piece.color (sticky per-node override)
 *   2. inherited parent/group color (groupColorByPieceId)
 *   3. ungrouped default (project setting, chosen in the wizard)
 *
 * Pure + shared: the live canvas and the New Project Wizard preview both call
 * this, so the preview can't drift from what a project actually renders.
 */
export function resolveNodeEdgeColor(piece, groupColorByPieceId, ungroupedDefault = null) {
  if (!piece) return ungroupedDefault ?? null;
  if (piece.color) return piece.color;
  const inherited = groupColorByPieceId?.get?.(piece.id);
  if (inherited) return inherited;
  return ungroupedDefault ?? null;
}

export function buildGroupNameByPieceId(groups) {
  const map = new Map();
  groups.forEach((group) => {
    const name = typeof group.name === 'string' && group.name.trim() ? group.name.trim() : null;
    if (!name) return;
    (group.pieceIds || []).forEach((pieceId) => {
      map.set(pieceId, name);
    });
  });
  return map;
}

// Children index for parentId walks. Shared by the D3 subtree machinery
// below; cheap to rebuild per call (groups lists are small).
function indexChildrenByParent(groups) {
  const map = new Map();
  for (const group of groups ?? []) {
    if (group.parentId == null) continue;
    if (!map.has(group.parentId)) map.set(group.parentId, []);
    map.get(group.parentId).push(group);
  }
  return map;
}

/**
 * Every piece id in the group's subtree (own + descendants via parentId),
 * cycle-guarded. D3 (brief-nested-group-containment, owner-ruled
 * 2026-07-28): a collapsed parent represents its whole subtree, so hiding
 * and pill counts must walk it — children's own collapse state is never
 * mutated, only represented.
 */
export function collectSubtreePieceIds(root, childrenByParent) {
  const pieceIds = new Set();
  const seen = new Set();
  const stack = [root];
  while (stack.length > 0) {
    const group = stack.pop();
    if (!group || seen.has(group.id)) continue;
    seen.add(group.id);
    for (const pieceId of group.pieceIds ?? []) pieceIds.add(pieceId);
    for (const child of childrenByParent.get(group.id) ?? []) stack.push(child);
  }
  return pieceIds;
}

/** True when any strict ANCESTOR (never the group itself) is collapsed. */
export function hasCollapsedAncestor(group, groupsById) {
  let currentId = group?.parentId ?? null;
  const seen = new Set();
  while (currentId && !seen.has(currentId)) {
    seen.add(currentId);
    const ancestor = groupsById.get(currentId);
    if (!ancestor) break;
    if (ancestor.isCollapsed) return true;
    currentId = ancestor.parentId ?? null;
  }
  return false;
}

export function buildHiddenPieceIds(groups) {
  const hidden = new Set();
  const childrenByParent = indexChildrenByParent(groups);
  groups.forEach((group) => {
    if (!group.isCollapsed) return;
    // D3: the whole subtree folds into the pill, not just direct members.
    collectSubtreePieceIds(group, childrenByParent).forEach((pieceId) => hidden.add(pieceId));
  });
  return hidden;
}

export function buildConnectionsByPiece(allConnections) {
  const outgoing = new Map();
  const incoming = new Map();
  allConnections.forEach((conn) => {
    if (!outgoing.has(conn.sourceId)) outgoing.set(conn.sourceId, []);
    if (!incoming.has(conn.targetId)) incoming.set(conn.targetId, []);
    outgoing.get(conn.sourceId).push(conn);
    incoming.get(conn.targetId).push(conn);
  });
  return { outgoing, incoming, all: allConnections };
}

export function buildBoundsForPieces(pieces, pieceWidth, pieceHeight) {
  if (!Array.isArray(pieces) || !pieces.length) return null;
  const minX = Math.min(...pieces.map((piece) => piece.x));
  const minY = Math.min(...pieces.map((piece) => piece.y));
  const maxX = Math.max(...pieces.map((piece) => piece.x + pieceWidth * (piece.scale ?? 1)));
  const maxY = Math.max(...pieces.map((piece) => piece.y + pieceHeight * (piece.scale ?? 1)));
  return {
    minX,
    minY,
    maxX,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

export function buildBoundsForPieceIds(pieceIds, piecesById, pieceWidth, pieceHeight) {
  if (!Array.isArray(pieceIds) || !pieceIds.length) return null;
  const members = pieceIds.map((id) => piecesById.get(id)).filter(Boolean);
  return buildBoundsForPieces(members, pieceWidth, pieceHeight);
}

// SQUIRCLE_H — height of the collapsed group stub (mirrors useGroupMenuAnchor,
// WorkspaceStage, Minimap). A collapsed group renders as a single squircle at
// the group's top-left, not across the full expanded piece footprint.
export const COLLAPSED_STUB_HEIGHT = 80;

// Visual padding of the drawn group outline around its content bounds
// (nested boxes add the nest pad). Single source of truth — WorkspaceStage
// renders with these and the wire router's border discipline (ADR-025 S5)
// treats the same padded rect as the border.
export const GROUP_OUTLINE_PAD = 12;
export const GROUP_NEST_PAD = 8;

// Seed geometry for memberless manual groups (ADR-018 box-first): a group
// with no pieces has nothing to derive bounds from, so its own persisted
// seedBounds stand in until members arrive (member-derived bounds win).
function buildSeedBounds(group) {
  const seed = group?.seedBounds;
  if (!seed) return null;
  const { x, y, width, height } = seed;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return {
    minX: x,
    minY: y,
    maxX: x + width,
    maxY: y + height,
    centerX: x + width / 2,
    centerY: y + height / 2
  };
}

export function buildGroupBounds(group, piecesById, pieceWidth, pieceHeight, excludePieceIds = null) {
  let groupPieceIds = Array.isArray(group?.pieceIds) ? group.pieceIds : [];
  // Subtractive-drag exclusion: a piece being dragged OUT (edit+subtractive)
  // no longer counts toward its source group's live box — otherwise the box
  // chases the departing piece. All pieces excluded → null (no seed
  // fallback): the vanished box is an honest preview of the group
  // dissolving on drop.
  if (excludePieceIds?.size) {
    const filtered = groupPieceIds.filter((id) => !excludePieceIds.has(id));
    if (filtered.length !== groupPieceIds.length && filtered.length === 0) {
      return null;
    }
    groupPieceIds = filtered;
  }
  const bounds = buildBoundsForPieceIds(groupPieceIds, piecesById, pieceWidth, pieceHeight)
    ?? buildSeedBounds(group);
  if (!bounds || !group?.isCollapsed) return bounds;
  // Collapsed: return stub-sized bounds at the group's top-left so hit-testing
  // (drag-over detection, extract checks, selection outline) matches the visible
  // stub instead of a phantom region spanning the expanded layout
  // (canvas-internals note 1).
  const minX = bounds.minX;
  const minY = bounds.minY;
  const maxX = minX + pieceWidth;
  const maxY = minY + COLLAPSED_STUB_HEIGHT;
  return {
    minX,
    minY,
    maxX,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2
  };
}

export function getSelectionGroupId(selectedIds, groupByPieceId) {
  if (!selectedIds.length) return null;
  const first = groupByPieceId.get(selectedIds[0]);
  if (!first) return null;
  for (const id of selectedIds) {
    if (groupByPieceId.get(id) !== first) return null;
  }
  return first;
}

export function buildSlotColorsByPieceId(incomingByPiece, piecesById) {
  const map = new Map();
  incomingByPiece.forEach((incoming, pieceId) => {
    const colorsBySide = {};
    incoming.forEach((conn) => {
      const source = piecesById.get(conn.sourceId);
      if (!source) return;
      if (!colorsBySide[conn.targetSide]) {
        colorsBySide[conn.targetSide] = source.color;
      }
    });
    map.set(pieceId, colorsBySide);
  });
  return map;
}

// Clearance added around a descendant group's bounds when its ancestor
// unions them in. The child box RENDERS at bounds + 20px (GROUP_OUTLINE_PAD
// 12 + GROUP_NEST_PAD 8 in WorkspaceStage) while the parent renders at
// bounds + 12px — anything ≤ 8 makes the child box touch or poke past the
// parent edge. 14 yields a 6px visible gutter for expanded children
// (owner-tuned 2026-07-26: the original 28/20px gutter read as too much).
const NESTED_BOUNDS_CLEARANCE = 14;

// TOP clearance is taller: header tabs live above the drawn edge, and a
// child in the parent's top-left corner must keep its tab legible below the
// parent's tab (owner request 2026-08-01). Derivation — mirrors
// WorkspaceStage's tab geometry (tabH 20, pads above); retune together:
//   child tab top   = childBounds.minY − childPad(20) − tabH(20) + 1 = minY − 39
//   parent tab bottom (worst case, root parent) = parentBounds.minY − pad(12) + 1
//   no-overlap: minY − parentBounds.minY ≥ 28 + gap → 34 gives a 6px gap.
const NESTED_TOP_CLEARANCE = 34;

/**
 * Group bounds including every descendant group's bounds (parentId chain).
 * A parent's own members say nothing about where its nested children sit —
 * without the union, a child group could render outside its parent's box
 * entirely (PRD-GNM-001 §10.2; owner expectation 2026-07-26: "heisenburg
 * rendered within main"). Collapsed groups return their stub bounds as-is:
 * the stub IS the whole representation, children included.
 *
 * `exclusions` ({ pieceIds?: Set, groupIds?: Set }) supports the
 * subtractive-drag preview: excluded pieces don't count toward any box in
 * the chain, and an excluded CHILD group is skipped from every ancestor's
 * union (it is leaving the family). The root group being measured is never
 * skipped — exclusion only affects what it absorbs.
 *
 * @param {object} group
 * @param {Array} groups - all groups (for parentId child lookup)
 * @param {Map} piecesById
 * @param {number} pieceWidth
 * @param {number} pieceHeight
 * @param {Set} [seen] - cycle guard (internal)
 * @param {object} [exclusions] - { pieceIds?: Set, groupIds?: Set }
 */
export function buildGroupBoundsWithDescendants(group, groups, piecesById, pieceWidth, pieceHeight, seen = new Set(), exclusions = null) {
  const own = buildGroupBounds(group, piecesById, pieceWidth, pieceHeight, exclusions?.pieceIds ?? null);
  if (!group) return own;
  if (group.isCollapsed) {
    if (own) return own;
    // Pure-container parent (no direct pieces, no seedBounds): D3 hides the
    // whole subtree behind this stub, so the stub must still exist even
    // though the group itself has nothing to measure — anchor it at the
    // descendants' union top-left (their coordinates are stable while
    // hidden, so expand restores in place).
    if (!Array.isArray(groups) || seen.has(group.id)) return null;
    seen.add(group.id);
    let union = null;
    for (const child of groups) {
      if (child.parentId !== group.id) continue;
      if (exclusions?.groupIds?.has(child.id)) continue;
      const childBounds = buildGroupBoundsWithDescendants(child, groups, piecesById, pieceWidth, pieceHeight, seen, exclusions);
      if (!childBounds) continue;
      union = union
        ? {
          minX: Math.min(union.minX, childBounds.minX),
          minY: Math.min(union.minY, childBounds.minY),
          maxX: Math.max(union.maxX, childBounds.maxX),
          maxY: Math.max(union.maxY, childBounds.maxY),
        }
        : { minX: childBounds.minX, minY: childBounds.minY, maxX: childBounds.maxX, maxY: childBounds.maxY };
    }
    if (!union) return null;
    const minX = union.minX;
    const minY = union.minY;
    const maxX = minX + pieceWidth;
    const maxY = minY + COLLAPSED_STUB_HEIGHT;
    return {
      minX,
      minY,
      maxX,
      maxY,
      centerX: (minX + maxX) / 2,
      centerY: (minY + maxY) / 2
    };
  }
  if (!Array.isArray(groups) || seen.has(group.id)) return own;
  seen.add(group.id);

  let bounds = own;
  for (const child of groups) {
    if (child.parentId !== group.id) continue;
    if (exclusions?.groupIds?.has(child.id)) continue;
    const childBounds = buildGroupBoundsWithDescendants(child, groups, piecesById, pieceWidth, pieceHeight, seen, exclusions);
    if (!childBounds) continue;
    const inflated = {
      minX: childBounds.minX - NESTED_BOUNDS_CLEARANCE,
      minY: childBounds.minY - NESTED_TOP_CLEARANCE,
      maxX: childBounds.maxX + NESTED_BOUNDS_CLEARANCE,
      maxY: childBounds.maxY + NESTED_BOUNDS_CLEARANCE,
    };
    bounds = bounds
      ? {
        minX: Math.min(bounds.minX, inflated.minX),
        minY: Math.min(bounds.minY, inflated.minY),
        maxX: Math.max(bounds.maxX, inflated.maxX),
        maxY: Math.max(bounds.maxY, inflated.maxY),
      }
      : inflated;
  }
  if (bounds && bounds !== own) {
    bounds.centerX = (bounds.minX + bounds.maxX) / 2;
    bounds.centerY = (bounds.minY + bounds.maxY) / 2;
  }
  return bounds;
}

/**
 * Innermost group whose bounds contain the point (smallest area wins).
 * With real nesting (parentId derived from folder containment) a parent's
 * bounds contain its child's entire area, so first-match array-order hit
 * testing made the PARENT swallow drops aimed at the child (owner repro
 * 2026-07-26: additive piece drop onto a nested child targeted the parent
 * and merged the piece upward). Smallest-area also resolves overlapping
 * sibling groups to the tighter box.
 *
 * @param {Array} groups
 * @param {number} x - canvas-space point
 * @param {number} y
 * @param {function} getGroupBounds
 * @param {function} [exclude] - candidates returning true are skipped
 * @returns {object|null} the innermost containing group, or null
 */
export function findInnermostGroupAt(groups, x, y, getGroupBounds, exclude = null) {
  let best = null;
  let bestArea = Infinity;
  for (const group of groups) {
    if (exclude && exclude(group)) continue;
    const bounds = getGroupBounds(group);
    if (!bounds) continue;
    if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
    const area = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
    if (area < bestArea) {
      best = group;
      bestArea = area;
    }
  }
  return best;
}

export function buildGroupPills(groups, getGroupBounds, pieceWidth, pieceHeight, getGroupThemeTokens = null, allGroups = null) {
  // Counts walk the subtree over the UNFILTERED list (D3): the callers pass
  // renderableGroups here, which already excludes ancestor-collapsed
  // children — the very groups whose pieces this pill represents.
  const childrenByParent = indexChildrenByParent(allGroups ?? groups);
  return groups
    .filter((group) => group.isCollapsed)
    .map((group) => {
      const bounds = getGroupBounds(group);
      if (!bounds) return null;
      const themeTokens = typeof getGroupThemeTokens === 'function'
        ? getGroupThemeTokens(group)
        : null;
      const pieceCount = collectSubtreePieceIds(group, childrenByParent).size;
      return {
        id: group.id,
        name: group.name,
        pieceCount,
        x: bounds.minX,
        y: bounds.minY,
        // Assigned group color — tints the collapsed pill's rim so a collapsed
        // folder carries its color, matching the expanded outline border.
        color: group.color ?? null,
        themeTokens: themeTokens && typeof themeTokens === 'object' ? themeTokens : null
      };
    })
    .filter(Boolean);
}

export function buildVisiblePieces(pieces, hiddenPieceIds, isPathHidden, isFiniteNumber) {
  return pieces.filter((piece) => (
    !hiddenPieceIds.has(piece.id) &&
    !isPathHidden(piece.filename) &&
    isFiniteNumber(piece.x) &&
    isFiniteNumber(piece.y)
  ));
}

export function buildViewportCulledPieces(pieces, hiddenPieceIds, isPathHidden, isFiniteNumber, visibleBounds, pieceWidth, pieceHeight) {
  if (!visibleBounds) return buildVisiblePieces(pieces, hiddenPieceIds, isPathHidden, isFiniteNumber);
  const padX = pieceWidth;
  const padY = pieceHeight;
  const vL = visibleBounds.x - padX;
  const vR = visibleBounds.x + visibleBounds.width + padX;
  const vT = visibleBounds.y - padY;
  const vB = visibleBounds.y + visibleBounds.height + padY;
  return pieces.filter((p) => {
    if (hiddenPieceIds.has(p.id) || isPathHidden(p.filename)) return false;
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y)) return false;
    const ps = p.scale ?? 1;
    return !(p.x + pieceWidth * ps < vL || p.x > vR || p.y + pieceHeight * ps < vT || p.y > vB);
  });
}

/**
 * Resolve every connection to renderable wire endpoints — D1 of
 * brief-cross-group-wires (owner-ratified 2026-07-17). Replaces the old
 * hidden-endpoint FILTER: a wire whose endpoint piece is hidden by a
 * collapsed group re-anchors to that group's collapsed pill (outermost
 * collapsed ancestor when groups nest) instead of vanishing. The underlying
 * connection/edge never changes — the pill is where the VIEW terminates
 * while detail is folded away.
 *
 * Rules:
 *  - Both endpoints inside the SAME collapsed group → internal wire, not
 *    rendered.
 *  - Two different collapsed groups → pill-to-pill wire.
 *  - Scaffold-hidden (eye) endpoints → wire not rendered (hide means
 *    "remove from view"; collapse means "summarize" — different intents).
 *    Previously such wires floated against an undrawn piece.
 *  - Re-anchored wires get geometry-derived facing sides (the user's chosen
 *    sides apply to the piece, not the pill); piece-to-piece wires keep the
 *    connection's own sides.
 *
 * @returns {Array<{ connection, sourceAnchor, targetAnchor, sourceSide, targetSide }>}
 *   Anchor: { x, y, width, height, kind: 'piece'|'pill', groupId?, status? }
 */
export function buildRenderableWires({
  connections,
  piecesById,
  groups,
  groupByPieceId,
  hiddenPieceIds,
  getGroupBounds,
  isPathHidden,
  pieceWidth,
  pieceHeight,
}) {
  const groupsById = new Map(groups.map((group) => [group.id, group]));

  // Outermost collapsed group in the piece's ancestry — the pill that is
  // actually visible when collapse states nest. Cycle-guarded.
  const outermostCollapsedGroup = (pieceId) => {
    let currentId = groupByPieceId.get(pieceId) ?? null;
    let outermost = null;
    const seen = new Set();
    while (currentId && !seen.has(currentId)) {
      seen.add(currentId);
      const group = groupsById.get(currentId);
      if (!group) break;
      if (group.isCollapsed) outermost = group;
      currentId = group.parentId ?? null;
    }
    return outermost;
  };

  const pillAnchor = (group) => {
    const bounds = getGroupBounds(group);
    if (!bounds) return null;
    return {
      x: bounds.minX,
      y: bounds.minY,
      width: pieceWidth,
      height: COLLAPSED_STUB_HEIGHT,
      kind: 'pill',
      groupId: group.id,
    };
  };
  const pieceAnchor = (piece) => ({
    x: piece.x,
    y: piece.y,
    width: pieceWidth,
    height: pieceHeight,
    kind: 'piece',
    pieceId: piece.id,
    status: piece.status,
  });

  const wires = [];
  for (const conn of connections) {
    const sourcePiece = piecesById.get(conn.sourceId);
    const targetPiece = piecesById.get(conn.targetId);
    if (!sourcePiece || !targetPiece) continue;
    if (isPathHidden(sourcePiece.filename) || isPathHidden(targetPiece.filename)) continue;

    const sourceHidden = hiddenPieceIds.has(conn.sourceId);
    const targetHidden = hiddenPieceIds.has(conn.targetId);
    const sourceGroup = sourceHidden ? outermostCollapsedGroup(conn.sourceId) : null;
    const targetGroup = targetHidden ? outermostCollapsedGroup(conn.targetId) : null;

    // Hidden endpoint with no resolvable collapsed group (defensive) → skip.
    if ((sourceHidden && !sourceGroup) || (targetHidden && !targetGroup)) continue;
    // Both endpoints fold into the same pill → internal wire.
    if (sourceGroup && targetGroup && sourceGroup.id === targetGroup.id) continue;

    const sourceAnchor = sourceGroup ? pillAnchor(sourceGroup) : pieceAnchor(sourcePiece);
    const targetAnchor = targetGroup ? pillAnchor(targetGroup) : pieceAnchor(targetPiece);
    if (!sourceAnchor || !targetAnchor) continue;

    const sides = (sourceGroup || targetGroup)
      ? chooseFacingSides(sourceAnchor, targetAnchor)
      : { sourceSide: conn.sourceSide, targetSide: conn.targetSide };

    wires.push({
      connection: conn,
      sourceAnchor,
      targetAnchor,
      sourceSide: sides.sourceSide,
      targetSide: sides.targetSide,
    });
  }
  return aggregateWiresByAnchorPair(wires);
}

/**
 * Aggregate wires sharing the same DIRECTIONAL visual endpoint pair into one
 * renderable wire with a count (brief-cross-group-wires D2, owner-ratified:
 * one heavier wire + count, not N parallel wires into a pill). Piece-to-piece
 * pairs are unique per direction by construction, so aggregation only ever
 * merges pill-involving wires. Opposite directions stay separate wires — the
 * chevron keeps meaning.
 *
 * Each aggregate carries `connections` (all members, first = representative)
 * and `countEnd` ('source'|'target') — which end the count chip renders at
 * (the pill end; target wins when both ends are pills).
 */
function aggregateWiresByAnchorPair(wires) {
  const anchorKey = (anchor) => (
    anchor.kind === 'pill' ? `pill:${anchor.groupId}` : `piece:${anchor.pieceId}`
  );
  const byPair = new Map();
  for (const wire of wires) {
    const key = `${anchorKey(wire.sourceAnchor)}→${anchorKey(wire.targetAnchor)}`;
    const existing = byPair.get(key);
    if (existing) {
      existing.connections.push(wire.connection);
      existing.count += 1;
      continue;
    }
    byPair.set(key, {
      ...wire,
      connections: [wire.connection],
      count: 1,
      countEnd: wire.targetAnchor.kind === 'pill' ? 'target'
        : wire.sourceAnchor.kind === 'pill' ? 'source'
          : 'target',
    });
  }
  return [...byPair.values()];
}

// Worst-status-wins for aggregated wires lives in src/utils/wireStatus.js —
// shared with the canvas components without crossing the domain/UI boundary.

// Per-pair anchor-side override for discovery: the sides the user chose when
// drawing a connection (persisted via persistConnectionSides). Discovery reads
// this and falls back to geometry for pairs without a persisted side. Keyed by
// `fromPieceId-toPieceId`; last row wins if a pair somehow has several.
export function buildPersistedConnectionSides(dbConnections) {
  const map = new Map();
  for (const c of (dbConnections ?? [])) {
    if (c?.fromPieceId == null || c?.toPieceId == null) continue;
    if (c.sourceSide == null && c.targetSide == null) continue;
    map.set(`${c.fromPieceId}-${c.toPieceId}`, {
      sourceSide: c.sourceSide ?? null,
      targetSide: c.targetSide ?? null,
    });
  }
  return map;
}

// A scaffold path is hidden when it or any ancestor folder is in the hidden
// set. normalizePath is injected (same pattern as buildVisiblePieces) so the
// selectors module stays dependency-free.
export function isScaffoldPathHidden(path, hiddenScaffoldPaths, normalizePath) {
  const normalized = normalizePath(path);
  if (!normalized) return false;
  return hiddenScaffoldPaths.some((hidden) => (
    normalized === hidden || normalized.startsWith(`${hidden}/`)
  ));
}
