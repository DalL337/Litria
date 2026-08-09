import { useCallback } from 'react';
import { computeGridLayout } from '../utils/gridLayout';

export function useCanvasUiActions({
  connectionDomain,
  selectionDomain,
  setSelectedGroupId,
  groupDomain,
  pieceDomain,
  groups,
  piecesById,
  setIsGroupMenuOpen,
  syntaxAdapter = null,
}) {
  const handleToggleGroupMenu = useCallback(() => {
    setIsGroupMenuOpen((open) => !open);
  }, [setIsGroupMenuOpen]);

  const handleDeleteConnection = useCallback((connectionId) => {
    connectionDomain.commands.deleteConnectionByIdWithHistory(connectionId);
    // handleDisconnect is async (it may read/write closed files); fire-and-forget
    // with a swallowed rejection so a write failure can't break the UI.
    Promise.resolve(syntaxAdapter?.handleDisconnect({ connectionId })).catch(() => {});
  }, [connectionDomain, syntaxAdapter]);

  const handleGroupPillSelect = useCallback((groupId, e) => {
    if (e) {
      e.cancelBubble = true;
    }
    selectionDomain.commands.clear();
    setSelectedGroupId(groupId);
  }, [selectionDomain, setSelectedGroupId]);

  const handleGroupPillDoubleClick = useCallback((groupId) => {
    // Find the group and its pill position to use as the layout origin.
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;

    // Expand the group first.
    groupDomain.commands.expand(groupId);

    // Find the pill's position (use first piece position as fallback origin).
    const firstPiece = group.pieceIds.length > 0 ? piecesById.get(group.pieceIds[0]) : null;
    const originX = firstPiece?.x ?? 100;
    const originY = firstPiece?.y ?? 100;

    // Separate file pieces from subfolder groups.
    // For now, all pieces in the group are file pieces (subfolder groups come in Phase 2+).
    const filePieceIds = group.pieceIds.filter((id) => piecesById.has(id));

    // Sort alphabetically by filename for consistent grid ordering.
    filePieceIds.sort((a, b) => {
      const pa = piecesById.get(a);
      const pb = piecesById.get(b);
      const nameA = pa?.filename ?? '';
      const nameB = pb?.filename ?? '';
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
    });

    // Get the group's grid tier (default to 0 = 3×3).
    const tierIndex = group.gridTier ?? 0;

    const layout = computeGridLayout({
      filePieceIds,
      subfolderGroupIds: [],
      tierIndex,
      originX,
      originY
    });

    // Batch reposition all visible pieces into the grid.
    if (layout.piecePositions.size > 0) {
      pieceDomain.commands.batchMovePieces(layout.piecePositions);
    }
  }, [groupDomain, groups, pieceDomain, piecesById]);

  return {
    handleToggleGroupMenu,
    handleDeleteConnection,
    handleGroupPillSelect,
    handleGroupPillDoubleClick
  };
}
