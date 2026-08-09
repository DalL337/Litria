import { createContext, useCallback, useContext, useMemo, useReducer, useRef, useState } from 'react';
import {
  editorSessionReducer,
  initialEditorSessionState,
  areEditorTextsEqual,
  getPaneTabIds,
  isSplit as isSplitSelector,
  getFocusedActiveTabId,
  canSplit as canSplitSelector,
  getPaneTagsByPieceId,
  serializeTabPaneAssignments,
  applyPaneAssignments,
  clampPaneRatio,
  PANE_RATIO_DEFAULT,
  MAX_OPEN_TABS,
  MAIN_PANE,
  SIDE_PANE
} from './editorSessionDomain.js';

const EditorSessionContext = createContext(null);

export function EditorSessionProvider({ children }) {
  const [state, dispatch] = useReducer(editorSessionReducer, initialEditorSessionState);
  // Divider position (ADR-017 Phase C): pane 1's fraction of the split row.
  // Geometry, not session semantics — lives beside the reducer, persisted
  // per-project like the viewport. Committed once per drag (release), never
  // per pointermove, so Monaco panes don't re-render mid-drag.
  const [paneSplitRatio, setPaneSplitRatioRaw] = useState(PANE_RATIO_DEFAULT);
  const setPaneSplitRatio = useCallback((value) => {
    setPaneSplitRatioRaw(clampPaneRatio(value));
  }, []);
  const persistenceRef = useRef({
    onSaveTab: null,
    onSaveAllTabs: null,
    onWorkingCodeChange: null,
    onResolveUntitledSave: null
  });
  const projectInstanceIdRef = useRef(null);

  const openFromSelection = useCallback((pieces) => {
    if (!pieces?.length) return;
    dispatch({ type: 'OPEN_FROM_SELECTION', pieces });
  }, []);

  // paneId optional: undefined targets the focused pane (existing callers
  // keep today's behavior); MAIN_PANE/SIDE_PANE target explicitly (split
  // entry paths). An already-open piece is MOVED, never duplicated.
  const openForPiece = useCallback((piece, paneId) => {
    if (!piece) return;
    dispatch({ type: 'OPEN_FOR_PIECE', piece, paneId });
  }, []);

  // Shift+double-click entry point (ADR-017 Phase B): open in whichever pane
  // is NOT focused — splits when single-pane, sends across when split.
  const openForPieceInOtherPane = useCallback((piece) => {
    if (!piece) return;
    dispatch({ type: 'OPEN_IN_OTHER_PANE', piece });
  }, []);

  // paneAssignments: persisted residency string (Phase B), applied here so
  // callers outside the editor domain pass it through opaquely.
  const openFromSnapshot = useCallback((tabs, activeTabId, paneAssignments) => {
    if (!tabs?.length) return;
    dispatch({
      type: 'OPEN_FROM_SNAPSHOT',
      tabs: applyPaneAssignments(tabs, paneAssignments),
      activeTabId
    });
  }, []);

  const setActiveTab = useCallback((tabId) => {
    dispatch({ type: 'SET_ACTIVE_TAB', tabId });
  }, []);

  const sendToPane = useCallback((tabId, paneId) => {
    dispatch({ type: 'SEND_TO_PANE', tabId, paneId });
  }, []);

  const setFocusedPane = useCallback((paneId) => {
    dispatch({ type: 'SET_FOCUSED_PANE', paneId });
  }, []);

  // Generic View > Split Editor verb (Ctrl+\).
  const splitEditor = useCallback(() => {
    dispatch({ type: 'SPLIT_NEXT' });
  }, []);

  const updateWorkingCode = useCallback((tabId, workingCode) => {
    const tab = state.tabsById[tabId];
    if (tab) {
      persistenceRef.current?.onWorkingCodeChange?.(tab, workingCode);
    }
    dispatch({ type: 'UPDATE_WORKING_CODE', tabId, workingCode });
  }, [state.tabsById]);

  const closeTab = useCallback((tabId) => {
    dispatch({ type: 'CLOSE_TAB', tabId });
  }, []);

  const saveTab = useCallback((tabId) => {
    const tab = state.tabsById[tabId];
    if (!tab) return null;
    // Untitled session (launcher New File): the resolver owns the disk write —
    // Save As dialog until a root exists. Unlike the normal optimistic path
    // below, the tab is only marked clean on confirmed success: a canceled
    // dialog or failed write must leave it dirty.
    const resolveUntitledSave = persistenceRef.current?.onResolveUntitledSave;
    if (resolveUntitledSave) {
      // savedCode = the snapshot the resolver writes; edits typed during the
      // async dialog/write must stay dirty (the reducer diffs against it).
      const savedCode = tab.workingCode ?? '';
      return Promise.resolve(resolveUntitledSave(tab)).then((saved) => {
        if (saved) dispatch({ type: 'SAVE_TAB', tabId, savedCode });
        return saved;
      });
    }
    const result = persistenceRef.current?.onSaveTab?.(tab) ?? null;
    dispatch({ type: 'SAVE_TAB', tabId });
    return result;
  }, [state.tabsById]);

  const discardTab = useCallback((tabId) => {
    dispatch({ type: 'DISCARD_TAB', tabId });
  }, []);

  const saveAllTabs = useCallback(() => {
    const dirtyTabs = Object.values(state.tabsById)
      .filter((tab) => !areEditorTextsEqual(tab.workingCode, tab.code));
    // Untitled session: route each dirty tab through the resolver
    // sequentially — a tab may need its own Save As dialog, and the first
    // success materializes the root the later tabs write into. Tabs are
    // marked clean individually so a mid-sequence cancel keeps the rest dirty.
    const resolveUntitledSave = persistenceRef.current?.onResolveUntitledSave;
    if (resolveUntitledSave) {
      return (async () => {
        let allSaved = true;
        for (const tab of dirtyTabs) {
          const savedCode = tab.workingCode ?? '';
          const saved = await resolveUntitledSave(tab);
          if (saved) dispatch({ type: 'SAVE_TAB', tabId: tab.id, savedCode });
          else allSaved = false;
        }
        return allSaved;
      })();
    }
    const result = persistenceRef.current?.onSaveAllTabs?.(dirtyTabs) ?? null;
    dispatch({ type: 'SAVE_ALL' });
    return result;
  }, [state.tabsById]);

  const updateTabFilename = useCallback((tabId, filename) => {
    dispatch({ type: 'UPDATE_TAB_FILENAME', tabId, filename });
  }, []);

  const discardAllTabs = useCallback(() => {
    dispatch({ type: 'DISCARD_ALL' });
  }, []);

  const isTabDirty = useCallback((tabId) => {
    const tab = state.tabsById[tabId];
    if (!tab) return false;
    return !areEditorTextsEqual(tab.workingCode, tab.code);
  }, [state.tabsById]);

  const hasDirtyTabs = useMemo(() => {
    return Object.values(state.tabsById).some((tab) => !areEditorTextsEqual(tab.workingCode, tab.code));
  }, [state.tabsById]);

  // Set of piece IDs with unsaved changes — used by canvas corner LEDs.
  const dirtyPieceIds = useMemo(() => {
    const ids = new Set();
    for (const tab of Object.values(state.tabsById)) {
      if (!areEditorTextsEqual(tab.workingCode, tab.code)) {
        ids.add(tab.pieceId);
      }
    }
    return ids;
  }, [state.tabsById]);

  const hideDrawer = useCallback(() => {
    dispatch({ type: 'HIDE_DRAWER' });
  }, []);

  const showDrawer = useCallback(() => {
    dispatch({ type: 'SHOW_DRAWER' });
  }, []);

  const configurePersistence = useCallback((config) => {
    persistenceRef.current = {
      ...persistenceRef.current,
      ...config
    };
  }, []);

  const setProjectInstanceId = useCallback((instanceId) => {
    if (projectInstanceIdRef.current === instanceId) return;
    projectInstanceIdRef.current = instanceId;
    dispatch({ type: 'RESET_SESSION' });
    setPaneSplitRatioRaw(PANE_RATIO_DEFAULT);
  }, []);

  /* ── Pane derivations (ADR-017) ── */
  const paneTabIds = useMemo(() => ({
    [MAIN_PANE]: getPaneTabIds(state, MAIN_PANE),
    [SIDE_PANE]: getPaneTabIds(state, SIDE_PANE)
  }), [state]);
  const isSplit = isSplitSelector(state);
  const canSplitEditor = canSplitSelector(state);
  // Back-compat alias: "the active tab" = the focused pane's active tab.
  // Existing consumers (save shortcuts, persistence, viewport nav, menubar
  // Save gating) keep working against the focused pane, which matches the
  // focus-follows-intent rule.
  const activeTabId = getFocusedActiveTabId(state);
  // Persistence shape for pane residency (Phase B): value-stable string, so
  // the debounced editor-state save fires on placement changes, not keystrokes.
  const tabPaneAssignments = useMemo(() => serializeTabPaneAssignments(state), [state]);
  // Canvas "where is it open" tags — null unless split (nodes stay untagged
  // in single-pane mode).
  const paneTagsByPieceId = useMemo(() => getPaneTagsByPieceId(state), [state]);

  const value = useMemo(() => ({
    ...state,
    activeTabId,
    paneTabIds,
    isSplit,
    canSplitEditor,
    tabPaneAssignments,
    paneTagsByPieceId,
    paneSplitRatio,
    setPaneSplitRatio,
    maxOpenTabs: MAX_OPEN_TABS,
    openFromSelection,
    openForPiece,
    openForPieceInOtherPane,
    openFromSnapshot,
    setActiveTab,
    sendToPane,
    setFocusedPane,
    splitEditor,
    updateWorkingCode,
    isTabDirty,
    hasDirtyTabs,
    dirtyPieceIds,
    closeTab,
    saveTab,
    discardTab,
    saveAllTabs,
    updateTabFilename,
    discardAllTabs,
    hideDrawer,
    showDrawer,
    configurePersistence,
    setProjectInstanceId
  }), [
    state,
    activeTabId,
    paneTabIds,
    isSplit,
    canSplitEditor,
    tabPaneAssignments,
    paneTagsByPieceId,
    paneSplitRatio,
    setPaneSplitRatio,
    openFromSelection,
    openForPiece,
    openForPieceInOtherPane,
    openFromSnapshot,
    setActiveTab,
    sendToPane,
    setFocusedPane,
    splitEditor,
    updateWorkingCode,
    isTabDirty,
    hasDirtyTabs,
    dirtyPieceIds,
    closeTab,
    saveTab,
    discardTab,
    saveAllTabs,
    updateTabFilename,
    discardAllTabs,
    hideDrawer,
    showDrawer,
    configurePersistence,
    setProjectInstanceId
  ]);

  return (
    <EditorSessionContext.Provider value={value}>
      {children}
    </EditorSessionContext.Provider>
  );
}

export function useEditorSession() {
  const context = useContext(EditorSessionContext);
  if (!context) {
    throw new Error('useEditorSession must be used within EditorSessionProvider.');
  }
  return context;
}
