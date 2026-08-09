import { useMemo, useRef } from 'react';

import {
  buildSlotColorsByPieceId,
  buildGroupPills,
  buildRenderableWires,
  buildViewportCulledPieces,
  buildVisiblePieces,
  hasCollapsedAncestor,
} from './selectors/workspaceSelectors';
import { buildWireObstacles, computeWireRoutes, buildDragWireRoutes } from './selectors/wireRoutes';
import { computeAllNodeHealth, useDiagnosticVersion } from '../hooks/useNodeHealth';
import { useGroupHealth } from '../hooks/useGroupHealth';
import { isFiniteNumber } from '../utils/path';
import { worstSyntaxStatus } from '../utils/wireStatus';
import { isExceptionStatus } from '../utils/wireAppearance';

/**
 * useWorkspaceRenderSelectors — render-time derivations and visibility
 * selectors that App.jsx used to compute inline before the canvas tree
 * renders. Extracted from App.jsx in Session 3 Group D of the app-shell
 * extraction refactor.
 *
 * Pure consolidation: every selector is a verbatim move from App.jsx
 * with the same dependency keys. No behavior changes.
 *
 * PIECE_WIDTH / PIECE_HEIGHT are passed in (rather than imported from
 * src/components/PuzzlePiece) so this hook stays inside the domain
 * layer per the architecture guard.
 */
export function useWorkspaceRenderSelectors({
  connectionsByPiece,
  hiddenPieceIds,
  interactionDomain,
  piecesById,
  pieces,
  groups,
  groupByPieceId,
  getGroupBounds,
  themeDomain,
  isPathHidden,
  viewport,
  dirtyPieceIds,
  projectInstance,
  isEditorOpen,
  openTabIds,
  syntaxConnStatuses,
  PIECE_WIDTH,
  PIECE_HEIGHT,
}) {
  const allConnections = connectionsByPiece.all;
  // Endpoint RESOLVER, not a filter (brief-cross-group-wires D1): wires to
  // collapsed-group members re-anchor to the pill instead of vanishing.
  const renderableWires = useMemo(
    () => buildRenderableWires({
      connections: allConnections,
      piecesById,
      groups,
      groupByPieceId,
      hiddenPieceIds,
      getGroupBounds,
      isPathHidden,
      pieceWidth: PIECE_WIDTH,
      pieceHeight: PIECE_HEIGHT,
    }),
    [allConnections, piecesById, groups, groupByPieceId, hiddenPieceIds, getGroupBounds, isPathHidden, PIECE_WIDTH, PIECE_HEIGHT]
  );
  // Global routing pass (ADR-025 §1): every wire's point list is computed
  // here, canvas-wide, and ConnectionLine draws what it's given. The
  // obstacle registry (G3: piece rects, collapsed pills, memberless seed
  // boxes) memoizes separately so pure wire changes reuse it.
  const wireObstacles = useMemo(
    () => buildWireObstacles({
      pieces,
      hiddenPieceIds,
      isPathHidden,
      groups,
      getGroupBounds,
      pieceWidth: PIECE_WIDTH,
      pieceHeight: PIECE_HEIGHT,
    }),
    [pieces, hiddenPieceIds, isPathHidden, groups, getGroupBounds, PIECE_WIDTH, PIECE_HEIGHT]
  );
  // Route-time loudness (ADR-025 §8): wires that rest popped (exception
  // status) are "loud"; quiet wires hop them at crossings. Mirrors
  // ConnectionLine's status derivation — syntax worst-of-members first,
  // anchor piece health as fallback. Hover never enters this set.
  const loudConnectionIds = useMemo(() => {
    const loud = new Set();
    for (const wire of renderableWires) {
      const worst = worstSyntaxStatus(
        wire.connections.map((c) => syntaxConnStatuses?.get(c.id))
      );
      const anchorStatus = (a) => a?.status || 'valid';
      const health =
        ['error', 'empty'].includes(anchorStatus(wire.sourceAnchor))
          || ['error', 'empty'].includes(anchorStatus(wire.targetAnchor)) ? 'error'
          : anchorStatus(wire.sourceAnchor) === 'warning'
            || anchorStatus(wire.targetAnchor) === 'warning' ? 'warning'
            : 'valid';
      if (isExceptionStatus(worst, health)) loud.add(wire.connection.id);
    }
    return loud;
  }, [renderableWires, syntaxConnStatuses]);
  // D6 drag mode (ADR-025 §10): while a drag is in flight, zero routing —
  // wires the drag is moving fall back to the cheap direct bezier, every
  // other wire keeps its frozen settled route; the router computes final
  // paths on drop. Off-drag, the settled map feeds back as previousRoutes
  // (stability bias: unchanged wires keep their exact route, no flap).
  const isDragActive = interactionDomain.lifecycle.isDragActive;
  const settledRoutesRef = useRef(new Map());
  const wireRoutes = useMemo(() => {
    if (isDragActive) {
      return buildDragWireRoutes({
        wires: renderableWires,
        settledRoutes: settledRoutesRef.current,
        pieceWidth: PIECE_WIDTH,
        pieceHeight: PIECE_HEIGHT,
      });
    }
    const routes = computeWireRoutes({
      wires: renderableWires,
      obstacles: wireObstacles,
      pieceWidth: PIECE_WIDTH,
      pieceHeight: PIECE_HEIGHT,
      loudConnectionIds,
      previousRoutes: settledRoutesRef.current,
    });
    settledRoutesRef.current = routes;
    return routes;
  }, [isDragActive, renderableWires, wireObstacles, loudConnectionIds, PIECE_WIDTH, PIECE_HEIGHT]);
  const dragLine = interactionDomain.selectors.getDragLine();
  const hoverTarget = interactionDomain.selectors.getHoverTarget();

  const slotColorsByPieceId = useMemo(
    () => buildSlotColorsByPieceId(connectionsByPiece.incoming, piecesById),
    [connectionsByPiece.incoming, piecesById]
  );
  // Scaffold-hidden folders hide their member PIECES via hiddenPieceIds,
  // but the group frame itself must be filtered too — otherwise hiding a
  // folder leaves its empty box/pill on the canvas (owner-reported: "eye
  // works on nodes, not groups"). Likewise ancestor-collapsed groups (D3):
  // the whole subtree folds into the ancestor's pill, so a descendant's own
  // box OR pill must not render outside it (owner-reported live 2026-08-01).
  const renderableGroups = useMemo(() => {
    const groupsById = new Map(groups.map((g) => [g.id, g]));
    return groups.filter((g) => !(g.folderPath && isPathHidden(g.folderPath))
      && !hasCollapsedAncestor(g, groupsById));
  }, [groups, isPathHidden]);
  const groupPills = useMemo(
    () => buildGroupPills(
      renderableGroups,
      getGroupBounds,
      PIECE_WIDTH,
      PIECE_HEIGHT,
      (group) => themeDomain.selectors.resolveGroupTokens(group),
      groups
    ),
    [getGroupBounds, renderableGroups, groups, themeDomain]
  );
  const groupOutlines = useMemo(() => {
    return renderableGroups
      // Memberless manual groups (ADR-018 box-first) render via seedBounds.
      .filter((g) => !g.isCollapsed && (g.pieceIds.length > 0 || g.seedBounds))
      .map((g) => {
        const bounds = getGroupBounds(g);
        if (!bounds) return null;
        const themeTokens = themeDomain.selectors.resolveGroupTokens(g);
        return {
          id: g.id,
          name: g.name ?? null,
          parentId: g.parentId ?? null,
          bounds,
          color: g.color ?? themeTokens?.groupPillStroke ?? null,
        };
      })
      .filter(Boolean);
  }, [renderableGroups, getGroupBounds, themeDomain]);
  const visiblePieces = useMemo(
    () => buildViewportCulledPieces(pieces, hiddenPieceIds, isPathHidden, isFiniteNumber,
      viewport.getVisibleBounds(), PIECE_WIDTH, PIECE_HEIGHT),
    [hiddenPieceIds, isPathHidden, pieces, viewport.scale, viewport.offsetX, viewport.offsetY]
  );
  const allVisiblePieces = useMemo(
    () => buildVisiblePieces(pieces, hiddenPieceIds, isPathHidden, isFiniteNumber),
    [hiddenPieceIds, isPathHidden, pieces]
  );

  // Corner LED health for ALL pieces — deliberately unfiltered. Computing
  // this from visiblePieces fed the group aggregator an input from which
  // collapse had just removed the members it exists to represent: every
  // collapsed pill's LED read 'empty' (owner-reported 2026-08-01). Piece
  // renderers look up by id, so the superset is harmless — and dropping the
  // viewport dependency stops pan/zoom from recomputing health.
  const diagnosticVersion = useDiagnosticVersion();
  const healthByPieceId = useMemo(
    () => computeAllNodeHealth(pieces, dirtyPieceIds, projectInstance?.rootPath ?? null),
    [pieces, dirtyPieceIds, projectInstance?.rootPath, diagnosticVersion]
  );
  // Frosted state: pieces with open editor tabs
  const frostedPieceIds = useMemo(
    () => isEditorOpen ? new Set(openTabIds) : new Set(),
    [isEditorOpen, openTabIds]
  );
  // Group aggregate LED: worst-case health of children
  const groupHealthById = useGroupHealth(groups, healthByPieceId);

  return {
    allConnections,
    renderableWires,
    wireRoutes,
    dragLine,
    hoverTarget,
    slotColorsByPieceId,
    groupPills,
    groupOutlines,
    visiblePieces,
    allVisiblePieces,
    healthByPieceId,
    frostedPieceIds,
    groupHealthById,
  };
}
