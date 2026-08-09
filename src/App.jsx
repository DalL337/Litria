import { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';

import {
  useSelection,
  useLassoSelection,
  useKeyboardModifiers,
  useGroupDrag,
  usePiecePlacement,
  useAdjacency,
  useConnections,
  useConnectionDrag,
  useSnap,
  useViewport,
  useAutoPan
} from './behaviors';

import { PIECE_WIDTH, PIECE_HEIGHT } from './components/PuzzlePiece';
import CreatePieceModal from './components/CreatePieceModal';
import PreferencesPanel from './components/PreferencesPanel';
import EditorDrawer from './components/EditorDrawer';
import EditorLauncherTab from './components/EditorLauncherTab';
import UnsavedChangesPrompt from './components/UnsavedChangesPrompt';
import LaunchScreen from './components/LaunchScreen';
import ProjectBar from './components/ProjectBar';
import CanvasArea from './components/CanvasArea';
import GroupMenuOverlay from './components/GroupMenuOverlay';
import SearchPill from './components/SearchPill';
import SyntaxSymbolPicker from './components/SyntaxSymbolPicker';
import WireActionMenu, { WireBundleMenu } from './components/WireActionMenu';
import WorkspaceStage from './components/WorkspaceStage';
import Minimap from './components/Minimap';
import CanvasHud from './components/CanvasHud';
import StatusBar from './components/StatusBar';
import ProjectSwitcher from './components/ProjectSwitcher';
import MenuBar from './components/MenuBar';
import SplashScreen from './components/SplashScreen';
import { useAppDrawers } from './components/useAppDrawers';

import { DrawerProvider } from './drawers/DrawerContext';
import DrawerShell from './drawers/DrawerShell';
import { TopDrawerProvider } from './drawers/TopDrawerContext';
import TopDrawerOpenBridge from './drawers/TopDrawerOpenBridge';
import TopDrawerShell from './drawers/TopDrawerShell';
import PillNotification from './components/PillNotification';
import { ToastViewport, showToast } from './components/Toast';
import { createUndoManager } from './history/undoManager';
import { movePiecesAction } from './history/actions';
import { clamp } from './utils/math';
import { computeSpawnPosition } from './utils/spawnPosition';
import { getRandomPieceColor } from './utils/pieceColors';
import { normalizePath, getBasename, getDirname, toFolderSegment, isFiniteNumber } from './utils/path';
import { createProjectDomain } from './project/projectDomain';
import { useProjectPersistence } from './project/useProjectPersistence';
import { createTerminalDomain } from './terminal/terminalDomain';
import { createPillDomain } from './terminal/pillDomain';
import { createBuildLogDomain } from './app/buildLogDomain';
import { useBuildLogs } from './app/useBuildLogs';
import { useTerminalLifecycle } from './terminal/useTerminalLifecycle';
import { useEditorSession } from './editor/EditorSessionContext';
import { useWindowCloseGuard } from './app/useWindowCloseGuard';
import { useExternalFileDropGuard } from './app/useExternalFileDropGuard';
import { createLanguageSupportDomain } from './app/languageSupportDomain';
import { createLspAdapters } from './lsp/createLspAdapters';
import { useGroupMenuActions } from './app/useGroupMenuActions';
import { useProjectLaunch } from './app/useProjectLaunch';
import { useUntitledSaveAs } from './app/useUntitledSaveAs';
import { setCrashProjectName } from './crash/errorCapture';
import { crumb } from './crash/breadcrumbs';
import { useCrashBoot } from './crash/useCrashBoot';
import { usePieceUiActions } from './app/usePieceUiActions';
import { useScaffoldActions } from './app/useScaffoldActions';
import { useScaffoldOperations } from './app/useScaffoldOperations';
import { useFilesystemWriteManager, useManagerFileWriter } from './app/useFilesystemWriteManager';
import { useGroupDropHandlers } from './app/useGroupDropHandlers';
import { useWorkspaceRenderSelectors } from './app/useWorkspaceRenderSelectors';
import { useGroupMenuAnchor } from './app/useGroupMenuAnchor';
import { useWorkspaceStageBindings } from './app/useWorkspaceStageBindings';
import { useViewportNavigation } from './app/useViewportNavigation';
import { useCanvasHud } from './app/useCanvasHud';
import { useMenuBarBindings } from './app/useMenuBarBindings';
import { useEditorPaneDrop } from './app/useEditorPaneDrop';
import { useGroupFolderReconciliation } from './app/useGroupFolderReconciliation';
// DP2 ghost-group rectification (brief-group-physicality W4)
import { useGroupPhysicalityMigration } from './app/useGroupPhysicalityMigration';
import { useCanvasUiActions } from './app/useCanvasUiActions';
import { useExitPromptActions } from './app/useExitPromptActions';
import { useUnsavedChangesGate, UNSAVED_CHANGES_PROMPT_COPY } from './app/useUnsavedChangesGate';
import { useGroupMenuUi } from './app/useGroupMenuUi';
import { usePythonLspLifecycle } from './app/usePythonLspLifecycle';
import { usePythonFirstOpen } from './app/usePythonFirstOpen';
import { useNpmScriptsFirstOpen } from './app/useNpmScriptsFirstOpen';
import { useManagedServerOffers } from './app/useManagedServerOffers';
import { useGoToolchainOffer } from './app/useGoToolchainOffer';
import { useManagedLspLifecycle } from './app/useManagedLspLifecycle';
import { useTsLspLifecycle } from './app/useTsLspLifecycle';
import { useSyntaxDomainLifecycle } from './app/useSyntaxDomainLifecycle';
import { useSyntaxPickerActions } from './app/useSyntaxPickerActions';
import { useGlobalShortcuts } from './app/useGlobalShortcuts';
import { useDiscoveryLifecycle } from './app/useDiscoveryLifecycle';
// Off-canvas import badge flow (brief-cross-group-wires S3) — shell wiring only.
import { useOffCanvasImports } from './app/useOffCanvasImports';
// Drop-on-pill picker (brief-cross-group-wires S4) — shell wiring only.
import { useWireDropOnPill } from './app/useWireDropOnPill';
import { useRecentProjects } from './app/useRecentProjects';
import { createPieceDomain } from './app/pieceDomain';
import { createSelectionDomain } from './app/selectionDomain';
import { createGroupDomain } from './app/groupDomain';
import { createConnectionDomain } from './app/connectionDomain';
import { THEME_ACCENT_SWATCHES } from './app/themeDomain';
import { useThemeActions } from './app/useThemeActions';
import { usePreferencesSurface } from './app/usePreferencesSurface';
import { useSplashVisibility } from './app/useSplashVisibility';
import { useTopDrawers } from './components/useTopDrawers';
import { useInteractionDomain } from './app/interactionDomain';
import { WorkspaceProvider } from './app/WorkspaceContext';
import { PlatformProvider } from './platform/usePlatformConfig';
import {
  buildConnectionsByPiece,
  buildPersistedConnectionSides,
  isScaffoldPathHidden,
  buildGroupBoundsWithDescendants,
  buildGroupByPieceId,
  buildGroupColorByPieceId,
  buildGroupNameByPieceId,
  buildHiddenPieceIds,
  buildPiecesByFilename,
  buildPiecesById,
  getSelectionGroupId
} from './app/selectors/workspaceSelectors';
import './styles/fonts.css';
import './styles/tailwind.css';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/splash.css';
import './styles/menu-bar.css';
import './styles/project-bar.css';
import './styles/canvas.css';
import './styles/drawers.css';
import './styles/pill-notification.css';
import './styles/toast.css';
import './styles/scaffold.css';
import './styles/editor.css';
import './styles/hover-card.css';
import './styles/monaco-overrides.css';
import './styles/modals.css';
import './styles/context-menus.css';
import './styles/launch.css';
import './styles/new-project-wizard.css';
import './styles/status-bar.css';
import './styles/search.css';
import './styles/hud.css';

function App() {
  /* ================================
     Undo/redo manager (command history)
  ================================ */
  const historyRef = useRef(null);
  if (!historyRef.current) {
    historyRef.current = createUndoManager();
  }
  const history = historyRef.current;

  const [pieces, setPieces] = useState([]);
  const piecesRef = useRef(pieces);
  piecesRef.current = pieces;
  const [groups, setGroups] = useState([]);
  const [nextGroupId, setNextGroupId] = useState(1);
  const nextGroupIdRef = useRef(nextGroupId);
  nextGroupIdRef.current = nextGroupId;
  const [selectedGroupId, setSelectedGroupId] = useState(null);
  const [projectInstance, setProjectInstance] = useState(null);
  const { showSplash, dismissSplash } = useSplashVisibility();
  const [scaffoldFocus, setScaffoldFocus] = useState(null);
  const [scaffoldRefreshToken, setScaffoldRefreshToken] = useState(0);
  // Menu-triggered scaffold create (feedback #7): bumped by useMenuBarBindings,
  // consumed by DrawerContentScaffold's inline-input effect.
  // { token, kind: 'newFile'|'newFolder', target: 'focus'|'root' }
  const [scaffoldRequest, setScaffoldRequest] = useState(null);
  const [isGroupMenuOpen, setIsGroupMenuOpen] = useState(false);
  const [hiddenScaffoldPaths, setHiddenScaffoldPaths] = useState([]);
  const [isRenameGroupOpen, setIsRenameGroupOpen] = useState(false);
  const [renameGroupValue, setRenameGroupValue] = useState('');
  const [dragDebug, setDragDebug] = useState(null);
  const [isMinimapVisible, setIsMinimapVisible] = useState(true);
  const [isNodeSearchOpen, setIsNodeSearchOpen] = useState(false);
  const [, forceHistoryUpdate] = useState(0);
  const groupsRef = useRef(groups);
  const { recents, refresh: refreshRecents, pinProject, removeProject } = useRecentProjects();
  useEffect(() => {
    // The backend registers the project on open/create (db_open_project /
    // db_bootstrap_project write the app-level recents row). We just refresh the
    // list so a freshly opened project surfaces if the user returns here.
    if (projectInstance?.rootPath) refreshRecents();
  }, [refreshRecents, projectInstance?.rootPath]);

  /* ================================
     Crash system (B5): boot sequence + session context
  ================================ */
  const { crashNotices, dismissCrashNotices } = useCrashBoot();
  useEffect(() => {
    setCrashProjectName(projectInstance?.name ?? null);
    crumb('project', projectInstance ? `active:${projectInstance.name ?? '?'}` : 'none');
  }, [projectInstance?.name, projectInstance]);

  const handleMenuUndo = useCallback(() => history.undo(), [history]);
  const handleMenuRedo = useCallback(() => history.redo(), [history]);
  const handleToggleMinimap = useCallback(() => {
    setIsMinimapVisible((prev) => !prev);
  }, []);

  useEffect(() => {
    return history.subscribe(() => {
      forceHistoryUpdate(tick => tick + 1);
    });
  }, [history]);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  /* ================================
     Core state
  ================================ */
  const [nextId, setNextId] = useState(1);
  const [isCreatePieceModalOpen, setIsCreatePieceModalOpen] = useState(false);
  const stageRef = useRef(null);
  const deskRef = useRef(null);
  const snapDistance = 40;
  const [deskSize, setDeskSize] = useState({ width: 0, height: 0 });

  // Adjacency accuracy vs performance (admin-toggle candidate).
  const adjacencyMode = 'fast'; // 'fast' | 'accurate'
  const minScale = 0.25;
  const maxScale = 1.5;

  useLayoutEffect(() => {
    const updateSize = () => {
      const rect = deskRef.current?.getBoundingClientRect();
      if (!rect) return;
      setDeskSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height))
      });
    };

    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  const deskWidth = deskSize.width || window.innerWidth;
  const deskHeight = deskSize.height || window.innerHeight;
  const viewport = useViewport(deskWidth, deskHeight);

  /* ================================
     Behaviors
  ================================ */
  const selection = useSelection();
  const selectionDomain = useMemo(() => createSelectionDomain(selection), [selection]);
  const lasso = useLassoSelection();
  const modifiers = useKeyboardModifiers();
  const groupDrag = useGroupDrag();
  const placement = usePiecePlacement();
  const adjacency = useAdjacency();
  const connections = useConnections();
  const connectionDrag = useConnectionDrag();
  const projectDomain = useMemo(() => createProjectDomain(), []);
  const terminalDomain = useMemo(() => createTerminalDomain(), []);
  const pillDomain = useMemo(() => createPillDomain(), []);
  const buildLogDomain = useMemo(() => createBuildLogDomain(), []);
  const buildLogActions = useBuildLogs(buildLogDomain);
  // Actions ▸ Logs raises a request; TopDrawerOpenBridge (inside the drawer
  // provider) performs the actual open. seq makes a repeat click re-open.
  const [logsRequest, setLogsRequest] = useState(null);
  const logsSeqRef = useRef(0);
  const openLogsDrawer = useCallback((tab) => {
    logsSeqRef.current += 1;
    setLogsRequest({ id: 'logs', tab, seq: logsSeqRef.current });
  }, []);
  const handleViewBuildLogs = useCallback(() => openLogsDrawer('build'), [openLogsDrawer]);
  const handleViewCrashLogs = useCallback(() => openLogsDrawer('crash'), [openLogsDrawer]);
  const languageSupportDomain = useMemo(
    () => createLanguageSupportDomain({ adapters: createLspAdapters() }),
    []
  );
  const readProjectFile = projectDomain.commands.readFile;
  const openFileDialog = projectDomain.commands.openFileDialog;
  const writeProjectFile = projectDomain.commands.writeFile;
  const moveProjectPath = projectDomain.commands.movePath;
  const deleteProjectPath = projectDomain.commands.deletePath;
  const listProjectTree = projectDomain.commands.listTree;
  const getProjectStorageError = projectDomain.commands.getLastStorageError;
  const applyScaffold = projectDomain.commands.applyScaffold;
  const connectionDomain = useMemo(
    () => createConnectionDomain({ connections, history }),
    [connections, history]
  );

  const piecesById = useMemo(() => buildPiecesById(pieces), [pieces]);

  // Descendant-aware: a parent's box must contain its nested children's
  // boxes (§10.2 containment slice, 2026-07-26) — member-only bounds let a
  // child group render outside its parent entirely.
  const getGroupBounds = useCallback((group) => (
    buildGroupBoundsWithDescendants(group, groups, piecesById, PIECE_WIDTH, PIECE_HEIGHT)
  ), [groups, piecesById]);

  const piecesByFilename = useMemo(() => buildPiecesByFilename(pieces), [pieces]);
  const groupByPieceId = useMemo(() => buildGroupByPieceId(groups), [groups]);
  const groupColorByPieceId = useMemo(() => buildGroupColorByPieceId(groups), [groups]);
  const groupNameByPieceId = useMemo(() => buildGroupNameByPieceId(groups), [groups]);
  const hiddenPieceIds = useMemo(() => buildHiddenPieceIds(groups), [groups]);
  const connectionsByPiece = useMemo(
    () => buildConnectionsByPiece(connectionDomain.selectors.getAllConnections()),
    [connectionDomain, pieces]
  );

  const { checkSnap, getGroupSnapDelta } = useSnap({
    pieces,
    piecesById,
    selection,
    snapDistance,
    pieceWidth: PIECE_WIDTH,
    pieceHeight: PIECE_HEIGHT,
    // Snap-with-seam (owner ruling 2026-07-31): flush yields a corridor
    // seam when it would seal a wired face.
    connections: connections.connections
  });
  const selectedIds = selectionDomain.selectors.getSelectedIds();
  const selectedCount = selectionDomain.selectors.getCount();
  const selectionGroupId = useMemo(
    () => getSelectionGroupId(selectedIds, groupByPieceId),
    [groupByPieceId, selectedIds]
  );
  const {
    isOpen: isEditorOpen,
    hideDrawer: hideEditorDrawer,
    openTabIds,
    activeTabId,
    activeTabIdByPane,
    tabPaneAssignments,
    paneTagsByPieceId,
    paneSplitRatio,
    setPaneSplitRatio,
    splitEditor,
    canSplitEditor,
    isSplit: isEditorSplit,
    paneTabIds,
    tabsById,
    openFromSelection,
    openForPiece,
    openForPieceInOtherPane,
    openFromSnapshot,
    hasDirtyTabs,
    dirtyPieceIds,
    isTabDirty,
    setActiveTab,
    saveTab,
    saveAllTabs,
    updateTabFilename,
    discardAllTabs,
    closeTab,
    configurePersistence,
    setProjectInstanceId
  } = useEditorSession();
  const selectedScale = selectedCount
    ? clamp(piecesById.get(selectedIds[0])?.scale ?? 1, minScale, maxScale)
    : 1;
  const { rebuildAllAdjacencies } = adjacency;
  const isPathHidden = useCallback((path) => (
    isScaffoldPathHidden(path, hiddenScaffoldPaths, normalizePath)
  ), [hiddenScaffoldPaths]);
  const {
    targetGroupId,
    targetGroup,
    targetGroupThemeId,
    targetGroupBounds,
    selectionBounds,
    groupMenuAnchorBounds,
    screenAnchorBounds,
    singleSelectedPiece,
  } = useGroupMenuAnchor({
    selectedGroupId,
    selectionGroupId,
    groups,
    getGroupBounds,
    selectedIds,
    piecesById,
    viewport,
    PIECE_WIDTH,
    PIECE_HEIGHT,
  });

  const {
    isExitPromptOpen,
    setIsExitPromptOpen,
    beginShutdown,
    closeTauriWindow,
    requestAppClose
  } = useWindowCloseGuard({ hasDirtyTabs });
  useExternalFileDropGuard();
  const {
    handleCancelExitPrompt,
    handleDiscardAndExit,
    handleSaveAndExit
  } = useExitPromptActions({
    setIsExitPromptOpen,
    beginShutdown,
    discardAllTabs,
    closeTauriWindow,
    saveAllTabs
  });
  const {
    promptKind: unsavedGateKind,
    guardUnsavedChanges,
    handlePromptCancel: handleUnsavedGateCancel,
    handlePromptDiscard: handleUnsavedGateDiscard,
    handlePromptSave: handleUnsavedGateSave
  } = useUnsavedChangesGate({ hasDirtyTabs, discardAllTabs, saveAllTabs });

  // Identity-stable manager-backed content writer for consumers composed
  // before the manager itself (persistence saves, syntax adapter); the
  // manager hook below keeps fsManagerRef current.
  const { managerRef: fsManagerRef, writeContentFile } = useManagerFileWriter();

  // Launcher "New File": Save As resolver that materializes the project root
  // on first save of an untitled single-file session (see useUntitledSaveAs).
  // Null unless the session is untitled.
  const { resolveUntitledSave } = useUntitledSaveAs({
    projectInstance,
    setProjectInstance,
    setPieces,
    updateTabFilename,
    writeProjectFile,
    showToast
  });

  const { persistConnectionSides } = useProjectPersistence({
    projectInstance,
    pieces,
    setPieces,
    piecesById,
    groups,
    setGroups,
    nextGroupId,
    setNextGroupId,
    setNextId,
    hiddenScaffoldPaths,
    setHiddenScaffoldPaths,
    rebuildAllAdjacencies,
    openTabIds,
    activeTabId,
    tabPaneAssignments,
    paneSplitRatio,
    setPaneSplitRatio,
    tabsById,
    openFromSnapshot,
    closeTab,
    configurePersistence,
    setProjectInstanceId,
    projectDomain,
    viewportScale: viewport.scale,
    viewportOffsetX: viewport.offsetX,
    viewportOffsetY: viewport.offsetY,
    setViewportScale: viewport.setScale,
    setViewportOffsetX: viewport.setOffsetX,
    setViewportOffsetY: viewport.setOffsetY,
    connections: connections.connections,
    setConnections: connections.setConnections,
    getNextConnectionIdValue: connections.getNextConnectionIdValue,
    setNextConnectionIdValue: connections.setNextConnectionIdValue,
    writeProjectFile: writeContentFile,
    resolveUntitledSave
  });

  const persistedConnectionSides = useMemo(
    () => buildPersistedConnectionSides(projectInstance?._dbState?.connections),
    [projectInstance?._dbState]
  );

  useTerminalLifecycle({
    projectInstance,
    terminalDomain
  });

  // Union of both panes' active files (ADR-017): with a split showing a .py
  // beside a .tsx, a single "active filename" would deactivate whichever
  // language server the other pane needs.
  const activeEditorFilenames = useMemo(() => (
    [activeTabIdByPane?.[1], activeTabIdByPane?.[2]]
      .map((id) => (id != null ? tabsById[id]?.filename : null))
      .filter(Boolean)
  ), [activeTabIdByPane, tabsById]);
  usePythonLspLifecycle({
    projectInstance,
    activeFilenames: activeEditorFilenames,
    languageSupportDomain
  });

  // First-open offers for Python projects (ADR-020 Slice 4): finish a
  // deferred environment / install declared deps / one-time run hint —
  // raised as an action pill whose click runs the command in the visible
  // terminal.
  usePythonFirstOpen({
    projectInstance,
    pillDomain,
    languageSupportDomain
  });

  // Scripts-off consent pill for npm-scaffolded projects (ADR-021 §3):
  // installs ran with dependency scripts disabled; one visible click runs
  // `npm rebuild` in the terminal for projects that need them.
  useNpmScriptsFirstOpen({
    projectInstance,
    pillDomain
  });

  // Managed language-server install offers (ADR-005 A2/A3, Slice 5): opening
  // a registry-language file raises a provenance-first consent pill whose
  // click runs the staged, verified install — then starts the session
  // (Slice 6) so intelligence lights up without reopening the file.
  useManagedServerOffers({
    projectInstance,
    activeFilenames: activeEditorFilenames,
    pillDomain,
    languageSupportDomain
  });

  // Go's class-3 acquisition path (ADR-005 Slice 6.5): gopls has no prebuilt
  // binaries, so the offer pill types a pinned `go install` into the visible
  // terminal (toolchain present) or honestly names the missing toolchain.
  useGoToolchainOffer({
    projectInstance,
    activeFilenames: activeEditorFilenames,
    pillDomain
  });

  // Managed language-server lifecycle (ADR-005 Slice 6): one hook for all
  // generic pack languages (rust, cpp, go) — starts a session on file open
  // when the resolver can supply the server, stops it on project switch.
  useManagedLspLifecycle({
    projectInstance,
    activeFilenames: activeEditorFilenames,
    languageSupportDomain
  });

  useTsLspLifecycle({
    projectInstance,
    activeFilenames: activeEditorFilenames,
    languageSupportDomain
  });

  const { syntaxDomain, syntaxAdapter, syntaxConnStatuses } = useSyntaxDomainLifecycle({
    projectRoot: projectInstance?.rootPath ?? '',
    readProjectFile,
    // Manager-backed + identity-stable: a churning writer identity would
    // recreate the adapter and wipe its Monaco model registry.
    writeProjectFile: writeContentFile,
  });

  // useDiscoveryLifecycle moved below useScaffoldActions: the off-canvas
  // badge flow (S3) sits between them — it consumes createPieceFromFile and
  // supplies discovery's onPendingEdges.

  const {
    syntaxPickerState,
    handlePickSymbols,
    dismissSyntaxPicker,
    selectedConnectionId,
    handleSelectConnection,
    handleClearConnectionSelection,
    handleAddSymbolToConnection,
    onSyntaxPendingCreated,
    wireMenu,
    wireBundleState,
    handleSelectWireBundle,
    handlePickBundleEntry,
    dismissWireBundle,
  } = useSyntaxPickerActions({
    syntaxDomain,
    syntaxAdapter,
    connections: connections.connections,
    piecesById,
    projectRootPath: projectInstance?.rootPath ?? null,
    stageRef,
    canvasToScreen: viewport.canvasToScreen,
    selectionDomain,
    setSelectedGroupId,
    selectedIds,
    selectedGroupId,
    showToast,
    PIECE_WIDTH,
    PIECE_HEIGHT,
  });

  /* ================================
     Piece creation
  ================================ */
  const getSpawnPosition = useCallback(() => computeSpawnPosition({
    visibleBounds: viewport.getVisibleBounds(),
    pieces: piecesRef.current,
    pieceWidth: PIECE_WIDTH,
    pieceHeight: PIECE_HEIGHT,
  }), [viewport.getVisibleBounds]);

  const pieceDomain = useMemo(() => createPieceDomain({
    history,
    setPieces,
    setNextId,
    getSpawnPosition,
    getNextId: () => nextId,
    getRandomColor: getRandomPieceColor
  }), [getSpawnPosition, history, nextId]);
  const groupDomain = useMemo(() => createGroupDomain({
    setGroups,
    history,
    getGroups: () => groupsRef.current,
    getNextGroupId: () => nextGroupIdRef.current,
    setNextGroupId
  }), [history]);

  const addPiece = useCallback(({ filename, label, code = '', workingCode = null, id = null, x, y }) => {
    return pieceDomain.commands.createPiece({ filename, label, code, workingCode, id, x, y });
  }, [pieceDomain]);

  const {
    themeDomain,
    activeTheme,
    canvasTheme,
    energyLevel,
    globalEnergyLevel,
    projectEnergyLevel,
    toggleEnergyLevel,
    setEnergyLevel,
    setProjectEnergyOverride,
    activeThemeId,
    activeThemeName,
    canDeleteActiveTheme,
    themeOptions,
    activeAccentColor,
    handleSetActiveTheme,
    handleCreateTheme,
    handleRenameActiveTheme,
    handleDeleteActiveTheme,
    handleSelectAccentColor,
    handleResetThemeAccent,
    handleUpdateThemeToken,
    handleSetPieceColor,
    handleSetGroupColor,
    handleSetFolderColor,
    getFolderColor
  } = useThemeActions({ projectInstance, pieceDomain, groupDomain, targetGroupId, groups });

  const { isPreferencesOpen, openPreferences, closePreferences } = usePreferencesSurface();

  useEffect(() => {
    const hasInvalid = pieces.some((piece) => (
      !Number.isFinite(piece.x) || !Number.isFinite(piece.y)
    ));
    if (!hasInvalid) return;
    pieceDomain.commands.normalizeInvalidCoordinates();
  }, [pieceDomain, pieces]);

  const {
    createPieceFromFile,
    handleScaffoldSelectEntry,
    handleToggleScaffoldVisibility,
    handleScaffoldOpenEntry,
    bumpScaffoldRefresh,
    handleEditorLauncherOpen,
    handleDeselectAll
  } = useScaffoldActions({
    projectRootPath: projectInstance?.rootPath,
    defaultFolderGroupColor: projectInstance?.workspaceStyle?.defaultFolderGroupColor ?? null,
    normalizePath,
    piecesByFilename,
    readProjectFile,
    getBasename,
    addPiece,
    openForPiece,
    selectionDomain,
    setScaffoldFocus,
    setSelectedGroupId,
    hiddenScaffoldPaths,
    setHiddenScaffoldPaths,
    selectedCount,
    selectedIds,
    piecesById,
    openFromSelection,
    scaffoldFocusPath: scaffoldFocus?.path,
    setScaffoldRefreshToken,
    setIsGroupMenuOpen,
    setIsRenameGroupOpen,
    groupDomain,
    pieceDomain,
    listTree: projectDomain.commands.listTree,
    getSpawnPosition,
    groups,
    pieceWidth: PIECE_WIDTH
  });

  // Off-canvas import badge (brief-cross-group-wires S3): discovery retains
  // edges whose imported file has no piece; pieces badge the count; placing
  // from the badge wires them immediately.
  const {
    onPendingEdges,
    offCanvasCountByPieceId,
    badgeMenu: offCanvasBadgeMenu,
    openOffCanvasBadgeMenu,
    dismissOffCanvasBadgeMenu,
    handlePlaceOffCanvasImport,
  } = useOffCanvasImports({
    piecesById,
    projectRootPath: projectInstance?.rootPath ?? null,
    stageRef,
    canvasToScreen: viewport.canvasToScreen,
    createPieceFromFile,
    syntaxDomain,
    syntaxAdapter,
    connectionDomain,
    showToast,
    PIECE_WIDTH,
  });

  useDiscoveryLifecycle({
    projectRoot: projectInstance?.rootPath ?? null,
    // Fresh object per dbOpenProject (incl. reopening the same project), so
    // discovery re-runs on every project load — not just the first of a session.
    loadToken: projectInstance?._dbState ?? null,
    syntaxDomain,
    syntaxAdapter,
    connectionDomain,
    piecesById,
    persistedSides: persistedConnectionSides,
    onPendingEdges,
    scaffoldRefreshToken,
    dirtyPieceIds,
    enabled: !!projectInstance?.rootPath,
  });

  const fsManager = useFilesystemWriteManager({
    managerRef: fsManagerRef,
    moveProjectPath, writeProjectFile, deleteProjectPath, readProjectFile,
    pieceDomain, groupDomain, connectionDomain, syntaxDomain,
    piecesById, piecesByFilename, pieces, groups, groupByPieceId,
    updateTabFilename, closeTab, bumpScaffoldRefresh, projectInstance,
  });

  // Demotion (owner-ratified 2026-07-18, wire-arc E): remove selected pieces
  // from the canvas without touching their files. Reversal = re-placement
  // (off-canvas badge / scaffold drag), not undo.
  const handleRemoveFromCanvas = useCallback(() => {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setIsGroupMenuOpen(false);
    selectionDomain.commands.clear();
    Promise.resolve(fsManager.removeFromCanvas(ids)).catch(() => {});
  }, [selectedIds, selectionDomain, fsManager, setIsGroupMenuOpen]);

  useGroupFolderReconciliation({
    pieces,
    groups,
    groupDomain,
    scaffoldRefreshToken,
    // Per-load identity: reconciliation runs once after pieces hydrate on
    // every project open, so groups draw at launch (live-verify D fix).
    loadToken: projectInstance?._dbState ?? null,
    normalizePath,
    getBasename,
    // D2 parity (brief-group-physicality): the disk tree is the reconcile
    // input — every folder gets a group, empty included; seeds place them.
    listTree: listProjectTree,
    projectRootPath: projectInstance?.rootPath ?? null,
    getSpawnPosition,
    getGroupBounds,
    pieceWidth: PIECE_WIDTH,
  });

  // DP2 (brief-group-physicality): ghost groups rectify silently on open —
  // folder minted, files moved in, one informational pill after the fact.
  useGroupPhysicalityMigration({
    groups,
    pieces,
    piecesById,
    groupDomain,
    fsManager,
    pillDomain,
    projectId: projectInstance?.instanceId ?? null,
    projectRootPath: projectInstance?.rootPath ?? null,
    loadToken: projectInstance?._dbState ?? null,
    normalizePath,
    getBasename,
    getDirname,
    bumpScaffoldRefresh,
  });

  const {
    handleScaffoldDrop,
    handleContextRename,
    handleContextDelete,
    handleContextNewFile,
    handleContextNewFolder
  } = useScaffoldOperations({
    projectRootPath: projectInstance?.rootPath,
    fsManager
  });

  const {
    handleOpenCreatePieceModal,
    handleCloseCreatePieceModal,
    handleCreatePiece,
    validateNewPieceFilename,
    handlePieceClick,
    handlePieceDoubleClick
  } = usePieceUiActions({
    addPiece,
    pieces,
    projectRootPath: projectInstance?.rootPath,
    writeProjectFile: writeContentFile,
    bumpScaffoldRefresh,
    pillDomain,
    projectInstanceId: projectInstance?.instanceId,
    selectionDomain,
    setSelectedGroupId,
    setScaffoldFocus,
    piecesById,
    openForPiece,
    openForPieceInOtherPane,
    setIsCreatePieceModalOpen,
    getSpawnPosition
  });

  const {
    handlePieceGroupDrop,
    handleGroupStructureDrop,
    groupStructureOps,
  } = useGroupDropHandlers({
    piecesById,
    groups,
    projectInstance,
    fsManager,
    pillDomain,
    groupDomain,
  });

  const {
    handleDeleteSelected,
    handleCreateFolderGroup,
    handleCommitGroupCreate,
    handleTranslateGroupSeed,
    mergeTargets,
    handleMergeInto,
    handleToggleCollapseGroup,
    handleExpandGroup,
    handleOpenRenameGroup,
    handleCancelRenameGroup,
    handleConfirmRenameGroup,
    handleAssignGroupTheme,
    handleClearGroupTheme,
    handleSetPieceLabel,
    handleRenamePieceFile,
    handleSavePiece,
    handleSaveGroup,
    isNodeDirty,
    isGroupDirty
  } = useGroupMenuActions({
    selectedCount,
    projectRootPath: projectInstance?.rootPath,
    selectedIds,
    pieceDomain,
    piecesById,
    pieces,
    groups,
    normalizePath,
    connectionDomain,
    groupDomain,
    deleteProjectPath,
    scaffoldFocusPath: scaffoldFocus?.path,
    setScaffoldFocus,
    projectDomain,
    bumpScaffoldRefresh,
    targetGroupId,
    selectionDomain,
    setIsGroupMenuOpen,
    setIsRenameGroupOpen,
    setSelectedGroupId,
    nextGroupId,
    setNextGroupId,
    getBasename,
    targetGroup,
    themeOptions,
    targetGroupThemeId,
    renameGroupValue,
    getDirname,
    toFolderSegment,
    getGroupBounds,
    setHiddenScaffoldPaths,
    setRenameGroupValue,
    fsManager,
    groupStructureOps,
    singleSelectedPiece,
    saveTab,
    tabsById,
    dirtyPieceIds,
    showToast
  });

  const canvasHud = useCanvasHud({
    projectRootPath: projectInstance?.rootPath,
    viewport,
    deskWidth,
    deskHeight,
    pieceWidth: PIECE_WIDTH,
    pieceHeight: PIECE_HEIGHT,
    isCreatePieceModalOpen,
    // Name-first, disk-first creation (brief-group-physicality W2).
    onCommitGroupCreate: handleCommitGroupCreate
  });

  // Drop-on-pill picker (brief-cross-group-wires S4): wire drags dropped on a
  // collapsed pill resolve via the wireDropOnCollapsedGroup preference.
  const {
    handleWireDragMiss,
    pillDropMenu,
    handlePickPillDropTarget,
    dismissPillDropMenu,
  } = useWireDropOnPill({
    groups,
    getGroupBounds,
    piecesById,
    groupDomain,
    connectionDomain,
    syntaxAdapter,
    persistConnectionSides,
    onSyntaxPendingCreated,
    projectRootPath: projectInstance?.rootPath ?? null,
    stageRef,
    canvasToScreen: viewport.canvasToScreen,
    showToast,
  });

  const interactionDomain = useInteractionDomain({
    adjacency,
    adjacencyMode,
    checkSnap,
    clamp,
    connectionDrag,
    connectionDomain,
    getGroupBounds,
    getGroupSnapDelta,
    groupByPieceId,
    groupDrag,
    groups,
    history,
    isFiniteNumber,
    lasso,
    minScale,
    maxScale,
    modifiers,
    movePiecesAction,
    onPieceGroupDrop: handlePieceGroupDrop,
    onGroupStructureDrop: handleGroupStructureDrop,
    // Empty-group drag commit: seedBounds translation at drag end.
    onGroupSeedTranslate: handleTranslateGroupSeed,
    pieceHeight: PIECE_HEIGHT,
    pieceWidth: PIECE_WIDTH,
    pieces,
    piecesById,
    placement,
    selection,
    selectionDomain,
    pieceDomain,
    setDragDebug,
    setScaffoldFocus,
    setSelectedGroupId,
    clearConnectionSelection: handleClearConnectionSelection,
    stageRef,
    syntaxAdapter,
    projectRoot: projectInstance?.rootPath ?? null,
    onSyntaxPendingCreated,
    persistConnectionSides,
    hiddenPieceIds,
    onWireDragMiss: handleWireDragMiss,
    screenToCanvas: viewport.screenToCanvas,
    startPan: viewport.startPan,
    updatePan: viewport.updatePan,
    endPan: viewport.endPan,
    isPanActive: viewport.isPanActive,
  });
  const {
    handleStageMouseDown,
    handleStageMouseMove,
    handleStageMouseUp,
    handleStageMouseLeave,
    handlePieceDragMove,
    handlePieceDragStart,
    finalizePieceDragWithSnap,
    handleConnectionStart,
    handleGroupPillDragStart,
    handleGroupPillDragMove,
    handleGroupPillDragEnd,
    scaleSelectedPieces
  } = interactionDomain.commands;

  // Drag a canvas node into an editor pane (ADR-017 Phase C node→pane slice):
  // wraps the piece-drag handlers so a drop over the drawer cancels the
  // canvas move and opens the file in the target pane.
  const {
    wrappedPieceDragStart,
    wrappedPieceDragEnd,
    dropTargetPane: editorDropTargetPane
  } = useEditorPaneDrop({
    piecesById,
    selectedIds,
    selectedCount,
    pieceDomain,
    openForPiece,
    isSplit: isEditorSplit,
    paneTabIds,
    handlePieceDragStart,
    finalizePieceDragWithSnap
  });

  const dragOverGroupId = interactionDomain.lifecycle.dragOverGroupId;

  // Subtractive-drag de-emphasis (B3 follow-up + un-nest): while active, the
  // departing piece/child stops counting toward the source chain's boxes.
  // Render consumers get this exclusion-aware variant; the base
  // getGroupBounds keeps feeding the controller (hit testing) — it can't
  // depend on state the controller itself produces.
  const subtractiveDragSource = interactionDomain.lifecycle.subtractiveDragSource;
  const getGroupBoundsForRender = useCallback((group) => {
    if (!subtractiveDragSource) return getGroupBounds(group);
    const exclusions = {
      pieceIds: subtractiveDragSource.pieceId != null ? new Set([subtractiveDragSource.pieceId]) : null,
      groupIds: subtractiveDragSource.childGroupId ? new Set([subtractiveDragSource.childGroupId]) : null,
    };
    return buildGroupBoundsWithDescendants(
      group, groups, piecesById, PIECE_WIDTH, PIECE_HEIGHT, undefined, exclusions
    );
  }, [getGroupBounds, groups, piecesById, subtractiveDragSource]);

  // Interaction mode (ADR-013): drive the status-bar indicator + canvas cursor.
  const interactionMode = interactionDomain.lifecycle.interactionMode;
  const activeSubMode = interactionDomain.lifecycle.activeSubMode;
  const interactionModeDomain = interactionDomain.modeDomain;
  const activeModeToken = interactionDomain.selectors.activeToken();
  const interactionModeLabel = activeModeToken ? `Edit: ${activeModeToken.label}` : null;
  const canvasModeClass = interactionMode === 'edit'
    ? `is-mode-edit is-submode-${activeSubMode}`
    : '';
  // While a drag is active, overlays drop pointer-events so they don't swallow
  // the drag as the cursor crosses them (internals note 2).
  const isDragActive = interactionDomain.lifecycle.isDragActive;
  const dragOverGroupBounds = useMemo(() => {
    if (!dragOverGroupId) return null;
    const group = groups.find((g) => g.id === dragOverGroupId);
    if (!group) return null;
    return getGroupBounds(group);
  }, [dragOverGroupId, getGroupBounds, groups]);

  useAutoPan({
    // Gate on isDragActive (reactive, window-failsafe-cleared) rather than
    // isDraggingPiece (dragStartRef-based). An interrupted / off-window drop
    // clears isDragActive but not dragStartRef, which would otherwise strand
    // the auto-pan RAF loop ON and pan the viewport on every edge-adjacent
    // mousemove with no button pressed (feedback #20). isDragActive also covers
    // group-pill drags, so edge-scroll now works for group moves too (#18).
    isDragging: interactionDomain.lifecycle.isDragActive,
    containerRef: deskRef,
    setOffsetX: viewport.setOffsetX,
    setOffsetY: viewport.setOffsetY,
    stateRef: viewport.stateRef
  });
  const handleTrackpadPan = useCallback(({ deltaX, deltaY }) => {
    const { offsetX, offsetY } = viewport.stateRef.current;
    viewport.setOffsetX(offsetX - deltaX);
    viewport.setOffsetY(offsetY - deltaY);
  }, [viewport.stateRef, viewport.setOffsetX, viewport.setOffsetY]);
  const {
    handleToggleGroupMenu,
    handleDeleteConnection,
    handleGroupPillSelect,
    handleGroupPillDoubleClick
  } = useCanvasUiActions({
    connectionDomain,
    selectionDomain,
    setSelectedGroupId,
    groupDomain,
    pieceDomain,
    groups,
    piecesById,
    setIsGroupMenuOpen,
    syntaxAdapter,
  });
  const {
    showGroupMenu,
    groupMenuStyle,
    groupMenuPanelStyle,
    handleRenameGroupValueChange
  } = useGroupMenuUi({
    selectedCount,
    selectedGroupId,
    anchorBounds: screenAnchorBounds,
    deskWidth,
    deskHeight,
    isGroupMenuOpen,
    isRenameGroupOpen,
    setIsRenameGroupOpen,
    setRenameGroupValue,
    anchorHasCornerControl: Boolean(targetGroup && !targetGroup.isCollapsed),
    viewportScale: viewport.scale
  });

  /* ================================
     Render
  ================================ */
  const {
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
  } = useWorkspaceRenderSelectors({
    connectionsByPiece,
    hiddenPieceIds,
    interactionDomain,
    piecesById,
    pieces,
    groups,
    groupByPieceId,
    // Exclusion-aware during subtractive drags (see getGroupBoundsForRender).
    getGroupBounds: getGroupBoundsForRender,
    themeDomain,
    isPathHidden,
    viewport,
    dirtyPieceIds,
    projectInstance,
    isEditorOpen,
    openTabIds,
    // Route-time hop ownership (ADR-025 §8): loud wires derive from syntax
    // status at the selector layer.
    syntaxConnStatuses,
    PIECE_WIDTH,
    PIECE_HEIGHT,
  });

  const {
    handleStatusBarZoomChange,
    handleNavigateToPiece,
    handleNavigateHome,
    handleStatusBarSelectDirtyTab,
    handleFitContent,
    handleFitSelection,
    handleResetView,
  } = useViewportNavigation({
    viewport,
    deskWidth,
    deskHeight,
    setActiveTab,
    visiblePieces: allVisiblePieces,
    selectedIds,
    piecesById,
    PIECE_WIDTH,
    PIECE_HEIGHT,
  });

  useGlobalShortcuts({
    undo: handleMenuUndo,
    redo: handleMenuRedo,
    fitContent: handleFitContent,
    fitSelection: handleFitSelection,
    toggleNodeSearch: () => setIsNodeSearchOpen((prev) => !prev),
    selectAllVisible: () => selectionDomain.commands.selectMultiple(allVisiblePieces.map((piece) => piece.id)),
    splitEditor,
  });

  // Scaffold file → editor pane drop (ADR-017 Phase C): reuses the scaffold
  // pointer-drag; releasing over a pane opens the file there (creating its
  // piece first when needed) instead of canvas-spawning behind the drawer.
  const handleScaffoldFileDropOnPane = useCallback(async (path, paneId) => {
    const piece = await createPieceFromFile(path);
    if (piece) openForPiece(piece, paneId === 2 ? 2 : 1);
  }, [createPieceFromFile, openForPiece]);

  const { drawers } = useAppDrawers({
    handleOpenCreatePieceModal,
    handleScaffoldOpenEntry,
    handleScaffoldSelectEntry,
    handleToggleScaffoldVisibility,
    hiddenScaffoldPaths,
    listProjectTree,
    projectInstance,
    scaffoldFocusPath: scaffoldFocus?.path,
    scaffoldRefreshToken,
    scaffoldPendingRequest: scaffoldRequest,
    handleScaffoldDrop,
    handleScaffoldFileDropOnPane,
    handleContextRename,
    handleContextDelete,
    handleContextNewFile,
    handleContextNewFolder,
    activeThemeId,
    activeThemeName,
    accentSwatches: THEME_ACCENT_SWATCHES,
    activeAccentColor,
    onSelectAccentColor: handleSelectAccentColor,
    onResetThemeAccent: handleResetThemeAccent,
    themeOptions,
    onSetActiveTheme: handleSetActiveTheme,
    activeThemeTokens: activeTheme?.tokens ?? {},
    onUpdateThemeToken: handleUpdateThemeToken,
    onOpenPreferences: openPreferences,
    onSetFolderColor: handleSetFolderColor,
    getFolderColor
  });

  const topDrawers = useTopDrawers({
    terminalDomain,
    pillDomain,
    projectInstance,
    buildLogDomain,
    buildLogActions,
    logsTab: logsRequest?.tab ?? 'build',
  });

  const {
    handleCreateProjectInstance,
    handleOpenProjectInstance,
    handleOpenFileInstance,
    handleNewFileInstance,
    handleMenuOpenProject,
    handleExitToLauncher
  } = useProjectLaunch({
    applyScaffold,
    rebuildAllAdjacencies,
    setPieces,
    replaceGroups: groupDomain.commands.replaceAll,
    setNextId,
    setNextGroupId,
    bumpScaffoldRefresh,
    createConnectionAndInsert: connectionDomain.commands.createConnectionAndInsert,
    pieceWidth: PIECE_WIDTH,
    pieceHeight: PIECE_HEIGHT,
    setProjectInstance,
    openFileDialog,
    getProjectStorageError,
    setGroups,
    setSelectedGroupId,
    setHiddenScaffoldPaths,
    clearSelection: selectionDomain.commands.clear,
    projectInstance,
    terminalDomain,
    languageSupportDomain,
    showToast,
    setConnections: connections.setConnections,
    setNextConnectionIdValue: connections.setNextConnectionIdValue,
    clearHistory: history.clear,
    guardUnsavedChanges
  });

  const workspaceStageBindings = useWorkspaceStageBindings({
    deskWidth,
    deskHeight,
    stageRef,
    isGroupMenuOpen,
    targetGroupBounds,
    dragOverGroupBounds,
    subtractiveSourceGroupId: subtractiveDragSource?.groupId ?? null,
    renderableWires,
    wireRoutes,
    onSelectConnection: handleSelectConnection,
    onSelectWireBundle: handleSelectWireBundle,
    offCanvasCountByPieceId,
    onOffCanvasBadgeClick: openOffCanvasBadgeMenu,
    paneTagsByPieceId,
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
    piecesById,
    slotColorsByPieceId,
    groupColorByPieceId,
    groupNameByPieceId,
    healthByPieceId,
    frostedPieceIds,
    groupHealthById,
    groupOutlines,
    selectionDomain,
    connectionDomain,
    groupDomain,
    pieceDomain,
    groups,
    handlePieceClick,
    handleConnectionStart,
    handlePieceDragStart: wrappedPieceDragStart,
    handlePieceDragMove,
    finalizePieceDragWithSnap: wrappedPieceDragEnd,
    handlePieceDoubleClick,
    handleStageMouseDown,
    handleStageMouseMove,
    handleStageMouseUp,
    handleStageMouseLeave,
    lasso,
    hoverTarget,
    dragLine,
    activeTheme: canvasTheme,
    viewport,
    handleTrackpadPan,
  });

  const menuBarBindings = useMenuBarBindings({
    // File
    // No in-workspace New Project wizard exists yet (it lives on the
    // launcher) — null disables the item instead of crashing into
    // db_bootstrap_project with no args (same B5-captured session).
    onNewProject: null,
    onOpenProject: handleMenuOpenProject,
    onViewBuildLogs: handleViewBuildLogs,
    onViewCrashLogs: handleViewCrashLogs,
    setScaffoldRequest,
    onNewNode: handleOpenCreatePieceModal,
    saveTab,
    saveAllTabs,
    activeTabId,
    isTabDirty,
    hasDirtyTabs,
    onExitToLauncher: handleExitToLauncher,
    onExit: requestAppClose,
    onOpenPreferences: openPreferences,
    // Edit
    onUndo: handleMenuUndo,
    onRedo: handleMenuRedo,
    canUndo: history.canUndo(),
    canRedo: history.canRedo(),
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
    onFitContent: handleFitContent,
    onFitSelection: handleFitSelection,
    onNavigateHome: handleNavigateHome,
    onZoomChange: handleStatusBarZoomChange,
    viewportScale: viewport.scale,
    minScale,
    maxScale,
    onResetView: handleResetView,
    isMinimapVisible,
    onToggleMinimap: handleToggleMinimap,
    isHudVisible: !canvasHud.isHudHidden,
    onToggleHud: canvasHud.toggleHudHidden,
    interactionMode,
    modeDomain: interactionModeDomain,
    onOpenNodeSearch: () => setIsNodeSearchOpen(true),
    isEditorOpen,
    onOpenEditor: handleEditorLauncherOpen,
    onHideEditor: hideEditorDrawer,
    canOpenEditor: selectedCount > 0 || Boolean(scaffoldFocus?.path),
    onSplitEditor: splitEditor,
    canSplitEditor,
    // Actions (canvas pill mirror)
    singleSelectedPiece,
    isNodeDirty,
    isGroupDirty,
    onSavePiece: handleSavePiece,
    onSaveGroup: handleSaveGroup,
    onSetPieceColor: handleSetPieceColor,
    onSetPieceLabel: handleSetPieceLabel,
    onRenamePieceFile: handleRenamePieceFile,
    renameGroupValue,
    onRenameGroupValueChange: handleRenameGroupValueChange,
    onOpenRenameGroup: handleOpenRenameGroup,
    onConfirmRenameGroup: handleConfirmRenameGroup,
    targetGroupColor: targetGroup?.color ?? null,
    onSetGroupColor: handleSetGroupColor,
    themeOptions,
    targetGroupThemeId,
    onAssignGroupTheme: handleAssignGroupTheme,
    onToggleCollapseGroup: handleToggleCollapseGroup,
    onExpandGroup: handleExpandGroup,
    onCreateFolderGroup: handleCreateFolderGroup,
    handleAddSymbolToConnection,
    // Settings
    activeThemeId,
    onSetActiveTheme: handleSetActiveTheme,
    energyLevel,
    onSetEnergyLevel: setEnergyLevel,
    accentSwatches: THEME_ACCENT_SWATCHES,
    activeAccentColor,
    onSelectAccentColor: handleSelectAccentColor,
    onResetThemeAccent: handleResetThemeAccent,
  });

  if (!projectInstance) {
    return (
      <PlatformProvider>
        <WorkspaceProvider
          pieceDomain={pieceDomain}
          selectionDomain={selectionDomain}
          pieces={pieces}
          selectedIds={selectedIds}
          selectedCount={selectedCount}
        >
          <div className="App">
            {showSplash && <SplashScreen onComplete={dismissSplash} />}
            <LaunchScreen
              onCreateProject={handleCreateProjectInstance}
              onOpenProject={handleOpenProjectInstance}
              onOpenFile={handleOpenFileInstance}
              onNewFile={handleNewFileInstance}
              onExit={closeTauriWindow}
              energyLevel={energyLevel}
              onApplyEnergyLevel={setEnergyLevel}
              recents={recents}
              onPinProject={pinProject}
              onRemoveProject={removeProject}
              crashNotices={crashNotices}
              onCrashNoticesDismissed={dismissCrashNotices}
              buildLogDomain={buildLogDomain}
              buildLogActions={buildLogActions}
            />
          </div>
        </WorkspaceProvider>
      </PlatformProvider>
    );
  }

  return (
    <PlatformProvider>
      <WorkspaceProvider
        pieceDomain={pieceDomain}
        selectionDomain={selectionDomain}
        pieces={pieces}
        selectedIds={selectedIds}
        selectedCount={selectedCount}
        modeDomain={interactionModeDomain}
        interactionMode={interactionMode}
        activeSubMode={activeSubMode}
      >
        <DrawerProvider drawers={drawers}>
        <div className={`App${isDragActive ? ' app-dragging' : ''}`}>
        {showSplash && <SplashScreen onComplete={dismissSplash} />}
        <MenuBar bindings={menuBarBindings} />
      <ProjectBar
        leading={
          <ProjectSwitcher
            currentProjectName={projectInstance.name}
            currentProjectRootPath={projectInstance.rootPath}
            recents={recents}
            onOpen={handleOpenProjectInstance}
          />
        }
      >
        <SearchPill
          pieces={allVisiblePieces}
          onNavigateToPiece={handleNavigateToPiece}
          onNavigateHome={handleNavigateHome}
          isOpen={isNodeSearchOpen}
          setIsOpen={setIsNodeSearchOpen}
        />
      </ProjectBar>
      <CanvasArea ref={deskRef} className={canvasModeClass}>
        <DrawerShell position="left" width={340} />
        <TopDrawerProvider drawers={topDrawers}>
          <TopDrawerShell height={300} />
          <TopDrawerOpenBridge request={logsRequest} />
          <PillNotification
            pillDomain={pillDomain}
            terminalDomain={terminalDomain}
            buildLogActions={buildLogActions}
          />
          <ToastViewport />
        </TopDrawerProvider>
        <EditorLauncherTab
          isVisible={selectedCount > 0 || Boolean(scaffoldFocus?.path)}
          isOpen={isEditorOpen}
          onOpen={handleEditorLauncherOpen}
          label={scaffoldFocus?.path ? `Open ${getBasename(scaffoldFocus.path)}` : undefined}
        />
        <EditorDrawer selectedCount={selectedCount} projectRootPath={projectInstance?.rootPath ?? null} projectId={projectInstance?.instanceId ?? null} syntaxAdapter={syntaxAdapter} dropTargetPane={editorDropTargetPane} />
        {window.CM_DEBUG_DRAG && dragDebug && (
          <div className="drag-debug">
            Drag {dragDebug.type} for #{dragDebug.id}
            {typeof dragDebug.x === 'number' && typeof dragDebug.y === 'number'
              ? ` @ ${dragDebug.x}, ${dragDebug.y}`
              : ''}
          </div>
        )}
        <GroupMenuOverlay
          showGroupMenu={showGroupMenu}
          groupMenuStyle={groupMenuStyle}
          groupMenuPanelStyle={groupMenuPanelStyle}
          isGroupMenuOpen={isGroupMenuOpen}
          onMenuOpenChange={setIsGroupMenuOpen}
          selectedCount={selectedCount}
          targetGroupId={targetGroupId}
          isRenameGroupOpen={isRenameGroupOpen}
          renameGroupValue={renameGroupValue}
          handleToggleGroupMenu={handleToggleGroupMenu}
          handleDeselectAll={handleDeselectAll}
          handleDeleteSelected={handleDeleteSelected}
          handleRemoveFromCanvas={handleRemoveFromCanvas}
          handleCreateFolderGroup={handleCreateFolderGroup}
          mergeTargets={mergeTargets}
          onMergeInto={handleMergeInto}
          handleToggleCollapseGroup={handleToggleCollapseGroup}
          handleExpandGroup={handleExpandGroup}
          handleOpenRenameGroup={handleOpenRenameGroup}
          handleRenameGroupValueChange={handleRenameGroupValueChange}
          handleCancelRenameGroup={handleCancelRenameGroup}
          handleConfirmRenameGroup={handleConfirmRenameGroup}
          themeOptions={themeOptions}
          targetGroupThemeId={targetGroupThemeId}
          handleAssignGroupTheme={handleAssignGroupTheme}
          handleClearGroupTheme={handleClearGroupTheme}
          targetGroupColor={targetGroup?.color ?? null}
          onSetGroupColor={handleSetGroupColor}
          singleSelectedPiece={singleSelectedPiece}
          onSetPieceColor={handleSetPieceColor}
          onSetPieceLabel={handleSetPieceLabel}
          onRenamePieceFile={handleRenamePieceFile}
          onSavePiece={handleSavePiece}
          onSaveGroup={handleSaveGroup}
          isNodeDirty={isNodeDirty}
          isGroupDirty={isGroupDirty}
        />
        <UnsavedChangesPrompt
          isOpen={isExitPromptOpen}
          title="Unsaved Changes Before Exit"
          message="You have unsaved editor changes. Save before exiting Litria?"
          onCancel={handleCancelExitPrompt}
          onDiscard={handleDiscardAndExit}
          onSave={handleSaveAndExit}
        />
        <UnsavedChangesPrompt
          isOpen={unsavedGateKind !== null}
          title={UNSAVED_CHANGES_PROMPT_COPY[unsavedGateKind]?.title}
          message={UNSAVED_CHANGES_PROMPT_COPY[unsavedGateKind]?.message}
          onCancel={handleUnsavedGateCancel}
          onDiscard={handleUnsavedGateDiscard}
          onSave={handleUnsavedGateSave}
        />
        <CreatePieceModal
          isOpen={isCreatePieceModalOpen}
          onCancel={handleCloseCreatePieceModal}
          onCreate={handleCreatePiece}
          validateFilename={validateNewPieceFilename}
        />
        {isPreferencesOpen && (
          <PreferencesPanel
            projectContext={{ name: projectInstance?.name ?? 'This project', path: projectInstance?.rootPath }}
            energyLevel={globalEnergyLevel}
            onApplyEnergyLevel={setEnergyLevel}
            projectEnergyLevel={projectEnergyLevel}
            onSetProjectEnergy={setProjectEnergyOverride}
            themeOptions={themeOptions}
            activeThemeId={activeThemeId}
            onSelectTheme={handleSetActiveTheme}
            activeThemeName={activeThemeName}
            onCreateTheme={handleCreateTheme}
            onRenameTheme={handleRenameActiveTheme}
            onDeleteTheme={handleDeleteActiveTheme}
            canDeleteActiveTheme={canDeleteActiveTheme}
            onClose={closePreferences}
          />
        )}
        {syntaxPickerState && (
          <SyntaxSymbolPicker
            symbols={syntaxPickerState.symbols}
            style={syntaxPickerState.style}
            onPick={handlePickSymbols}
            onDismiss={dismissSyntaxPicker}
          />
        )}
        {wireMenu && !syntaxPickerState && (
          <WireActionMenu
            style={wireMenu.style}
            onAddSymbol={() => handleAddSymbolToConnection(wireMenu.connectionId)}
            onDelete={() => {
              handleDeleteConnection(wireMenu.connectionId);
              handleClearConnectionSelection();
            }}
            onDismiss={handleClearConnectionSelection}
          />
        )}
        {wireBundleState && !syntaxPickerState && (
          <WireBundleMenu
            style={wireBundleState.style}
            entries={wireBundleState.entries}
            onPick={handlePickBundleEntry}
            onDismiss={dismissWireBundle}
          />
        )}
        {offCanvasBadgeMenu && !syntaxPickerState && (
          <WireBundleMenu
            style={offCanvasBadgeMenu.style}
            entries={offCanvasBadgeMenu.entries}
            onPick={handlePlaceOffCanvasImport}
            onDismiss={dismissOffCanvasBadgeMenu}
          />
        )}
        {pillDropMenu && !syntaxPickerState && (
          <WireBundleMenu
            style={pillDropMenu.style}
            entries={pillDropMenu.entries}
            onPick={handlePickPillDropTarget}
            onDismiss={dismissPillDropMenu}
          />
        )}
        <WorkspaceStage {...workspaceStageBindings} ungroupedEdgeColor={projectInstance?.workspaceStyle?.ungroupedEdgeColor ?? null} />
        <CanvasHud
          widgets={canvasHud.widgets}
          hudPosition={canvasHud.hudPosition}
          hudVisibleIds={canvasHud.hudVisibleIds}
          isHudHidden={canvasHud.isHudHidden}
          moveHud={canvasHud.moveHud}
          commitHudPosition={canvasHud.commitHudPosition}
          toggleHudWidget={canvasHud.toggleHudWidget}
          clampPosition={canvasHud.clampPosition}
          spawnGhost={canvasHud.spawnGhost}
          onNewNode={handleOpenCreatePieceModal}
          onNewGroup={canvasHud.startGroupCreate}
          groupNameOverlay={canvasHud.groupNameOverlay}
          onCommitGroupName={canvasHud.commitGroupName}
          onCancelGroupName={canvasHud.cancelGroupName}
          panBy={canvasHud.panBy}
          zoomIn={canvasHud.zoomIn}
          zoomOut={canvasHud.zoomOut}
          onFitContent={handleFitContent}
          resetZoom={canvasHud.resetZoom}
          viewportScale={canvasHud.viewportScale}
        />
        {isMinimapVisible && (
          <Minimap
            pieces={allVisiblePieces}
            pieceWidth={PIECE_WIDTH}
            pieceHeight={PIECE_HEIGHT}
            accentColor={activeAccentColor}
            viewportScale={viewport.scale}
            viewportOffsetX={viewport.offsetX}
            viewportOffsetY={viewport.offsetY}
            containerWidth={deskWidth}
            containerHeight={deskHeight}
            setViewportOffsetX={viewport.setOffsetX}
            setViewportOffsetY={viewport.setOffsetY}
            groupPills={groupPills}
            isDragActive={isDragActive}
          />
        )}
      </CanvasArea>
      <StatusBar
        projectName={projectInstance?.name}
        viewportScale={viewport.scale}
        viewportStateRef={viewport.stateRef}
        deskWidth={deskWidth}
        deskHeight={deskHeight}
        onResetView={handleResetView}
        onZoomChange={handleStatusBarZoomChange}
        tabsById={tabsById}
        hasDirtyTabs={hasDirtyTabs}
        isTabDirty={isTabDirty}
        onSelectDirtyTab={handleStatusBarSelectDirtyTab}
        isMinimapVisible={isMinimapVisible}
        onToggleMinimap={handleToggleMinimap}
        languageSupportDomain={languageSupportDomain}
        pieces={allVisiblePieces}
        onNavigateToPiece={handleNavigateToPiece}
        onNavigateHome={handleNavigateHome}
        interactionModeLabel={interactionModeLabel}
        energyLevel={energyLevel}
        onToggleEnergy={toggleEnergyLevel}
      />
      </div>
      </DrawerProvider>
      </WorkspaceProvider>
    </PlatformProvider>
  );
}

export default App;
