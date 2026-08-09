import { useCallback } from 'react';
import { clamp } from '../utils/math';

const ZOOM_STEP = 1.25;
// Float guard so the zoom items disable exactly at the clamp bounds.
const SCALE_EPSILON = 0.001;

/**
 * MenuBar prop bag — assembles the App-scope handlers and enablement state the
 * menu bar needs, mirroring the useWorkspaceStageBindings pattern. Menu
 * structure and enablement rules live in src/components/menuBarItems.js; this
 * hook collects App-scope values and composes the menu-only handlers (delete
 * dispatch, scaffold create requests, zoom steps) so App.jsx stays a shell.
 */
export function useMenuBarBindings({
  // File
  onNewProject,
  onOpenProject,
  setScaffoldRequest,
  onNewNode,
  saveTab,
  saveAllTabs,
  activeTabId,
  isTabDirty,
  hasDirtyTabs,
  onExitToLauncher,
  onExit,
  onOpenPreferences,
  // Edit
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  handleDeleteSelected,
  handleDeselectAll,
  handleDeleteConnection,
  handleClearConnectionSelection,
  selectedConnectionId,
  selectedCount,
  targetGroupId,
  selectionDomain,
  allVisiblePieces,
  // View
  onFitContent,
  onFitSelection,
  onNavigateHome,
  onZoomChange,
  viewportScale,
  minScale,
  maxScale,
  onResetView,
  isMinimapVisible,
  onToggleMinimap,
  isHudVisible,
  onToggleHud,
  interactionMode,
  modeDomain,
  onOpenNodeSearch,
  isEditorOpen,
  onOpenEditor,
  onHideEditor,
  canOpenEditor,
  onSplitEditor,
  canSplitEditor,
  // Actions (canvas pill mirror)
  singleSelectedPiece,
  isNodeDirty,
  isGroupDirty,
  onSavePiece,
  onSaveGroup,
  onSetPieceColor,
  onSetPieceLabel,
  onRenamePieceFile,
  renameGroupValue,
  onRenameGroupValueChange,
  onOpenRenameGroup,
  onConfirmRenameGroup,
  targetGroupColor,
  onSetGroupColor,
  themeOptions,
  targetGroupThemeId,
  onAssignGroupTheme,
  onToggleCollapseGroup,
  onExpandGroup,
  onCreateFolderGroup,
  handleAddSymbolToConnection,
  // Diagnostics (Actions ▸ Logs)
  onViewBuildLogs,
  onViewCrashLogs,
  // Settings
  activeThemeId,
  onSetActiveTheme,
  energyLevel,
  onSetEnergyLevel,
  accentSwatches,
  activeAccentColor,
  onSelectAccentColor,
  onResetThemeAccent,
}) {
  /* ── File ── */
  // Scaffold create requests (feedback #7, D4 signal): the menu can't reach
  // the scaffold's inline-input state directly, so it bumps a token the drawer
  // consumes. Parent-path derivation happens inside DrawerContentScaffold
  // against RAW tree paths — deriving it here from the normalized
  // scaffoldFocus path would reintroduce the feedback #23 mismatch.
  const requestScaffoldCreate = useCallback((kind, target) => {
    setScaffoldRequest((prev) => ({ token: (prev?.token ?? 0) + 1, kind, target }));
  }, [setScaffoldRequest]);

  const onNewFile = useCallback(() => requestScaffoldCreate('newFile', 'focus'), [requestScaffoldCreate]);
  const onNewFolder = useCallback(() => requestScaffoldCreate('newFolder', 'focus'), [requestScaffoldCreate]);
  // A group is a folder at project root (reconciled onto the canvas).
  const onNewGroup = useCallback(() => requestScaffoldCreate('newFolder', 'root'), [requestScaffoldCreate]);

  const onSave = useCallback(() => {
    if (activeTabId) saveTab(activeTabId);
  }, [activeTabId, saveTab]);
  const canSave = Boolean(activeTabId && isTabDirty(activeTabId));

  /* ── Edit ── */
  // Delete dispatch: a selected wire wins (mutually exclusive with piece/group
  // selection — App clears one when the other appears).
  const onDelete = useCallback(() => {
    if (selectedConnectionId) {
      handleDeleteConnection(selectedConnectionId);
      handleClearConnectionSelection();
      return;
    }
    handleDeleteSelected();
  }, [selectedConnectionId, handleDeleteConnection, handleClearConnectionSelection, handleDeleteSelected]);
  const canDelete = selectedCount > 0 || Boolean(selectedConnectionId) || Boolean(targetGroupId);

  const onDeselectAll = useCallback(() => {
    handleDeselectAll();
    handleClearConnectionSelection();
  }, [handleDeselectAll, handleClearConnectionSelection]);

  const onSelectAll = useCallback(() => {
    selectionDomain.commands.selectMultiple(allVisiblePieces.map((piece) => piece.id));
  }, [selectionDomain, allVisiblePieces]);
  const canSelectAll = allVisiblePieces.length > 0;

  /* ── View ── */
  const onZoomIn = useCallback(() => {
    onZoomChange(clamp(viewportScale * ZOOM_STEP, minScale, maxScale));
  }, [onZoomChange, viewportScale, minScale, maxScale]);
  const onZoomOut = useCallback(() => {
    onZoomChange(clamp(viewportScale / ZOOM_STEP, minScale, maxScale));
  }, [onZoomChange, viewportScale, minScale, maxScale]);
  const canZoomIn = viewportScale < maxScale - SCALE_EPSILON;
  const canZoomOut = viewportScale > minScale + SCALE_EPSILON;

  const onToggleEditMode = useCallback(() => {
    modeDomain.commands.toggleMode();
  }, [modeDomain]);
  const isEditMode = interactionMode === 'edit';

  const onToggleEditor = useCallback(() => {
    if (isEditorOpen) onHideEditor();
    else onOpenEditor();
  }, [isEditorOpen, onHideEditor, onOpenEditor]);
  const canToggleEditor = isEditorOpen || canOpenEditor;

  /* ── Actions (canvas pill mirror) ── */
  const onAddSymbolToWire = useCallback(() => {
    if (selectedConnectionId) handleAddSymbolToConnection(selectedConnectionId);
  }, [selectedConnectionId, handleAddSymbolToConnection]);

  return {
    // File
    onNewProject,
    onOpenProject,
    onNewFile,
    onNewFolder,
    onNewNode,
    onNewGroup,
    onSave,
    canSave,
    onSaveAll: saveAllTabs,
    canSaveAll: Boolean(hasDirtyTabs),
    onExitToLauncher,
    onExit,
    onOpenPreferences,
    // Edit
    onUndo,
    onRedo,
    canUndo,
    canRedo,
    onDelete,
    canDelete,
    onDeselectAll,
    canDeselect: canDelete,
    onSelectAll,
    canSelectAll,
    // View
    onFitContent,
    onFitSelection,
    onNavigateHome,
    onZoomIn,
    canZoomIn,
    onZoomOut,
    canZoomOut,
    onResetView,
    isMinimapVisible,
    onToggleMinimap,
    isHudVisible,
    onToggleHud,
    isEditMode,
    onToggleEditMode,
    onOpenNodeSearch,
    isEditorOpen,
    onToggleEditor,
    canToggleEditor,
    onSplitEditor,
    canSplitEditor,
    // Actions (canvas pill mirror) — enablement inputs + pill handlers
    singleSelectedPiece,
    targetGroupId,
    selectedCount,
    selectedConnectionId,
    isNodeDirty,
    isGroupDirty,
    onSavePiece,
    onSaveGroup,
    onSetPieceColor,
    onSetPieceLabel,
    onRenamePieceFile,
    renameGroupValue,
    onRenameGroupValueChange,
    onOpenRenameGroup,
    onConfirmRenameGroup,
    targetGroupColor,
    onSetGroupColor,
    themeOptions,
    targetGroupThemeId,
    onAssignGroupTheme,
    onToggleCollapseGroup,
    onExpandGroup,
    onCreateFolderGroup,
    onAddSymbolToWire,
    // Diagnostics (Actions ▸ Logs)
    onViewBuildLogs,
    onViewCrashLogs,
    // Settings
    activeThemeId,
    onSetActiveTheme,
    energyLevel,
    onSetEnergyLevel,
    accentSwatches,
    activeAccentColor,
    onSelectAccentColor,
    onResetThemeAccent,
  };
}
