/**
 * useOffCanvasImports — the off-canvas import badge flow
 * (brief-cross-group-wires S3, owner-ratified D4).
 *
 * Discovery retains import edges whose imported file has no canvas piece
 * (pending edges). This hook derives, per ON-canvas importing piece, the
 * list of off-canvas files it imports — the piece renders a count badge.
 * Clicking the badge lists those files; picking one places its piece (via
 * the scaffold's createPieceFromFile) and immediately wires every pending
 * edge the new piece satisfies.
 *
 * Evaporation is DERIVED (owner rule): the badge recomputes from
 * pendingEdges × pieces, so a file placed by ANY means (badge click,
 * scaffold drag) drops out of the badge instantly; deleting the piece
 * brings the entry back. No stored badge state.
 */

import { useCallback, useMemo, useState } from 'react';
import { buildPathToPiece, createConnectionsForEdges } from './useDiscoveryLifecycle.js';

/**
 * Pure derivation: pending edges grouped by their ON-canvas importer piece,
 * keeping only edges whose imported file is still OFF canvas.
 * Exported for tests.
 *
 * @returns {Map<number, Array>} importerPieceId → pending edges
 */
export function buildOffCanvasImportsByPieceId(pendingEdges, pathToPiece) {
  const map = new Map();
  for (const edge of pendingEdges ?? []) {
    const importer = pathToPiece.get(edge.targetFilePath);
    if (!importer) continue;                          // importer itself off-canvas
    if (pathToPiece.has(edge.sourceFilePath)) continue; // placed → evaporated
    if (!map.has(importer.id)) map.set(importer.id, []);
    map.get(importer.id).push(edge);
  }
  return map;
}

export function useOffCanvasImports({
  piecesById,
  projectRootPath,
  stageRef,
  canvasToScreen,
  createPieceFromFile,
  syntaxDomain,
  syntaxAdapter,
  connectionDomain,
  showToast,
  PIECE_WIDTH,
}) {
  const [pendingEdges, setPendingEdges] = useState([]);
  // null | { pieceId, entries: [{ id: absPath, label }], style }
  const [badgeMenu, setBadgeMenu] = useState(null);

  const root = (projectRootPath ?? '').replace(/\\/g, '/').replace(/\/$/, '');

  const pathToPiece = useMemo(
    () => (root ? buildPathToPiece(piecesById, root) : new Map()),
    [piecesById, root]
  );

  const offCanvasByPieceId = useMemo(
    () => buildOffCanvasImportsByPieceId(pendingEdges, pathToPiece),
    [pendingEdges, pathToPiece]
  );

  const offCanvasCountByPieceId = useMemo(() => {
    const counts = new Map();
    for (const [pieceId, edges] of offCanvasByPieceId) counts.set(pieceId, edges.length);
    return counts;
  }, [offCanvasByPieceId]);

  // Discovery pushes a fresh pending set each run (full-replace semantics).
  const onPendingEdges = useCallback((edges) => {
    setPendingEdges(Array.isArray(edges) ? edges : []);
    setBadgeMenu(null);
  }, []);

  const toScreenAnchor = useCallback((canvasX, canvasY) => {
    const stage = stageRef.current;
    let left = canvasX;
    let top = canvasY;
    if (stage) {
      const screenPos = canvasToScreen(canvasX, canvasY);
      const rect = stage.container().getBoundingClientRect();
      left = screenPos.x + rect.left;
      top = screenPos.y + rect.top;
    }
    return { left, top };
  }, [stageRef, canvasToScreen]);

  const openOffCanvasBadgeMenu = useCallback((piece) => {
    const edges = offCanvasByPieceId.get(piece?.id) ?? [];
    if (!edges.length) return;
    const entries = [...new Set(edges.map((e) => e.sourceFilePath))].map((absPath) => ({
      id: absPath,
      label: absPath.startsWith(`${root}/`) ? absPath.slice(root.length + 1) : absPath,
    }));
    setBadgeMenu({
      pieceId: piece.id,
      entries,
      style: toScreenAnchor(piece.x + (PIECE_WIDTH ?? 180), piece.y),
    });
  }, [offCanvasByPieceId, root, toScreenAnchor, PIECE_WIDTH]);

  const dismissOffCanvasBadgeMenu = useCallback(() => setBadgeMenu(null), []);

  /** Place the piece for an off-canvas file, then wire every pending edge it
   *  satisfies through the same path discovery uses. */
  const handlePlaceOffCanvasImport = useCallback(async (absPath) => {
    setBadgeMenu(null);
    if (!root || typeof createPieceFromFile !== 'function') return;
    const relPath = absPath.startsWith(`${root}/`) ? absPath.slice(root.length + 1) : absPath;
    const newPiece = await createPieceFromFile(relPath);
    if (!newPiece) {
      showToast?.("Couldn't place the file on canvas", { severity: 'error' });
      return;
    }

    const satisfied = pendingEdges.filter(
      (edge) => edge.sourceFilePath === absPath || edge.targetFilePath === absPath
    );
    const lookup = new Map(pathToPiece);
    lookup.set(absPath, newPiece);
    const { pendingEdges: stillPending } = await createConnectionsForEdges({
      edges: satisfied,
      pathToPiece: lookup,
      syntaxDomain,
      syntaxAdapter,
      connectionDomain,
    });
    const wired = new Set(satisfied.filter((e) => !stillPending.includes(e)));
    setPendingEdges((prev) => prev.filter((e) => !wired.has(e)));
  }, [root, createPieceFromFile, pendingEdges, pathToPiece, syntaxDomain, syntaxAdapter, connectionDomain, showToast]);

  return {
    onPendingEdges,
    offCanvasCountByPieceId,
    badgeMenu,
    openOffCanvasBadgeMenu,
    dismissOffCanvasBadgeMenu,
    handlePlaceOffCanvasImport,
  };
}
