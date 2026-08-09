/**
 * useWorkspaceStageBindings — assembles the WorkspaceStage prop bag that
 * App.jsx used to construct inline. Extracted from App.jsx in Session 3
 * Group F of the app-shell extraction refactor.
 *
 * Pure consolidation: every prop is a verbatim move from the original
 * inline JSX. WorkspaceStage's signature is unchanged.
 */
export function useWorkspaceStageBindings({
  // Layout / refs
  deskWidth,
  deskHeight,
  stageRef,

  // Group menu state
  isGroupMenuOpen,
  targetGroupBounds,
  dragOverGroupBounds,
  subtractiveSourceGroupId,

  // Connections
  renderableWires,
  wireRoutes,
  onSelectConnection,
  onSelectWireBundle,

  // Off-canvas import badge (S3)
  offCanvasCountByPieceId,
  onOffCanvasBadgeClick,
  selectedConnectionId,
  syntaxConnStatuses,

  // Group pills
  groupPills,
  handleGroupPillSelect,
  handleGroupPillDoubleClick,
  handleGroupPillDragStart,
  handleGroupPillDragMove,
  handleGroupPillDragEnd,
  selectedGroupId,

  // Pieces
  visiblePieces,
  piecesById,
  slotColorsByPieceId,
  groupColorByPieceId,
  groupNameByPieceId,
  healthByPieceId,
  frostedPieceIds,
  groupHealthById,
  groupOutlines,

  // Domains (for selectors and command access)
  selectionDomain,
  connectionDomain,
  groupDomain,
  pieceDomain,
  groups,

  // Piece interaction handlers
  handlePieceClick,
  handleConnectionStart,
  handlePieceDragStart,
  handlePieceDragMove,
  finalizePieceDragWithSnap,
  handlePieceDoubleClick,

  // Stage interaction handlers
  handleStageMouseDown,
  handleStageMouseMove,
  handleStageMouseUp,
  handleStageMouseLeave,

  // Lasso, hover, drag-line
  lasso,
  hoverTarget,
  dragLine,

  // Theme + viewport
  activeTheme,
  viewport,
  handleTrackpadPan,
}) {
  return {
    deskWidth,
    deskHeight,
    stageRef,
    isGroupMenuOpen,
    targetGroupBounds,
    dragOverGroupBounds,
    subtractiveSourceGroupId,
    renderableWires,
    wireRoutes,
    piecesById,
    onSelectConnection,
    onSelectWireBundle,
    offCanvasCountByPieceId,
    onOffCanvasBadgeClick,
    selectedConnectionId,
    syntaxConnStatuses,
    groupPills,
    handleGroupPillSelect,
    handleGroupPillDoubleClick,
    handleGroupPillDragStart,
    handleGroupPillDragMove,
    handleGroupPillDragEnd,
    selectedGroupId,
    visiblePieces,
    isPieceSelected: selectionDomain.selectors.isSelected,
    getTabsForPiece: connectionDomain.selectors.getTabsForPiece,
    getSlotsForPiece: connectionDomain.selectors.getSlotsForPiece,
    slotColorsByPieceId,
    groupColorByPieceId,
    groupNameByPieceId,
    healthByPieceId,
    frostedPieceIds,
    groupHealthById,
    groups,
    groupDomain,
    pieceDomain,
    groupOutlines,
    handlePieceClick,
    handleConnectionStart,
    handlePieceDragStart,
    handlePieceDragMove,
    finalizePieceDragWithSnap,
    handlePieceDoubleClick,
    lassoSelectionBox: lasso.selectionBox,
    hoverTarget,
    dragLine,
    handleStageMouseDown,
    handleStageMouseMove,
    handleStageMouseUp,
    handleStageMouseLeave,
    theme: activeTheme,
    viewportScale: viewport.scale,
    viewportOffsetX: viewport.offsetX,
    viewportOffsetY: viewport.offsetY,
    onZoomAtPoint: viewport.zoomAtPoint,
    onTrackpadPan: handleTrackpadPan,
  };
}
