import { useMemo } from 'react';

import { buildBoundsForPieceIds } from './selectors/workspaceSelectors';

const SQUIRCLE_H = 80;

/**
 * useGroupMenuAnchor — derives the canvas-space and screen-space anchor
 * bounds the group context menu pins to, plus the single-selected piece
 * shortcut. Extracted from App.jsx in Session 3 Group E of the app-shell
 * extraction refactor.
 *
 * Pure consolidation: every derivation is a verbatim move from App.jsx
 * with the same dependency keys. Kept as its own hook (not folded into
 * useGroupMenuUi) per the plan note — folding would balloon that hook.
 *
 * PIECE_WIDTH / PIECE_HEIGHT are passed in (rather than imported from
 * src/components/PuzzlePiece) so this hook stays inside the domain
 * layer per the architecture guard.
 */
export function useGroupMenuAnchor({
  selectedGroupId,
  selectionGroupId,
  groups,
  getGroupBounds,
  selectedIds,
  piecesById,
  viewport,
  PIECE_WIDTH,
  PIECE_HEIGHT,
}) {
  const targetGroupId = selectedGroupId || selectionGroupId;
  const targetGroup = targetGroupId
    ? groups.find((group) => group.id === targetGroupId)
    : null;
  const targetGroupThemeId = typeof targetGroup?.themeId === 'string' && targetGroup.themeId.trim()
    ? targetGroup.themeId
    : null;
  const targetGroupBounds = useMemo(
    () => (targetGroup ? getGroupBounds(targetGroup) : null),
    [getGroupBounds, targetGroup]
  );
  const selectionBounds = useMemo(
    () => buildBoundsForPieceIds(selectedIds, piecesById, PIECE_WIDTH, PIECE_HEIGHT),
    [piecesById, selectedIds]
  );
  const groupMenuAnchorBounds = useMemo(() => {
    if (targetGroup?.isCollapsed && targetGroupBounds) {
      return {
        minX: targetGroupBounds.minX,
        minY: targetGroupBounds.minY,
        maxX: targetGroupBounds.minX + PIECE_WIDTH,
        maxY: targetGroupBounds.minY + SQUIRCLE_H,
        centerX: targetGroupBounds.minX + PIECE_WIDTH / 2,
        centerY: targetGroupBounds.minY + SQUIRCLE_H / 2
      };
    }
    return targetGroupBounds || selectionBounds;
  }, [targetGroup?.isCollapsed, targetGroupBounds, selectionBounds]);
  const screenAnchorBounds = useMemo(() => {
    if (!groupMenuAnchorBounds) return null;
    const tl = viewport.canvasToScreen(groupMenuAnchorBounds.minX, groupMenuAnchorBounds.minY);
    const br = viewport.canvasToScreen(groupMenuAnchorBounds.maxX, groupMenuAnchorBounds.maxY);
    return { minX: tl.x, minY: tl.y, maxX: br.x, maxY: br.y };
  }, [groupMenuAnchorBounds, viewport.canvasToScreen]);

  const singleSelectedPiece = selectedIds.length === 1 ? piecesById.get(selectedIds[0]) : null;

  return {
    targetGroupId,
    targetGroup,
    targetGroupThemeId,
    targetGroupBounds,
    selectionBounds,
    groupMenuAnchorBounds,
    screenAnchorBounds,
    singleSelectedPiece,
  };
}
