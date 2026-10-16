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
  SIDE_PANE,
  planBufferEdit,
  getSessionDocumentsByPath,
  normalizeEditorText,
  sessionPathOf
} from './editorSessionDomain.js';
import { saveOneTab, saveTabsFromBatch, saveTabsSequentially } from './saveCoordinator.js';
import { applyBufferText } from './engineCapabilities.js';
import { bufferRevision } from '../app/projectApiBridge.js';

const EditorSessionContext = createContext(null);

export function EditorSessionProvider({ children }) {
  const [state, renderDispatch] = useReducer(editorSessionReducer, initialEditorSessionState);
  // The session as of the last action dispatched, including actions this turn
  // that React has not rendered yet. Compare-and-apply reads it (build plan
  // W1b), so an edit sees typing and earlier edits from the same turn. Every
  // action goes through `dispatch`, and the reducer is pure, so this is the
  // state React renders next.
  const latestRef = useRef(initialEditorSessionState);
  const dispatch = useCallback((action) => {
    latestRef.current = editorSessionReducer(latestRef.current, action);
    renderDispatch(action);
  }, []);
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

  /**
   * Compare-and-apply (Project API build plan W1b; contract brief §13): edit
   * a session document only if it is still the revision the caller read. The
   * check and the edit happen in this turn, against the latest session text;
   * the tab's live editor document, if any, takes the same text through the
   * engine. See `planBufferEdit` for the request and every outcome; applied
   * returns `{ outcome: 'applied', revision }`.
   */
  const applyBufferEdit = useCallback((request) => {
    const plan = planBufferEdit(latestRef.current, request, bufferRevision);
    if (plan.outcome !== 'applied') return plan;
    const tab = latestRef.current.tabsById[plan.tabId];
    persistenceRef.current?.onWorkingCodeChange?.(tab, plan.text);
    dispatch({ type: 'UPDATE_WORKING_CODE', tabId: plan.tabId, workingCode: plan.text });
    applyBufferText(plan.tabId, plan.text);
    return { outcome: 'applied', revision: plan.revision };
  }, [dispatch]);

  /**
   * Compare-and-apply's check alone (build plan W2a): the outcome
   * `applyBufferEdit` would have now, against the latest session text, with
   * nothing applied. The Project API checks agent proposals with it.
   */
  const checkBufferEdit = useCallback(
    (request) => planBufferEdit(latestRef.current, request, bufferRevision),
    []
  );

  /**
   * An agent's edit to a file that was not open (Project API build plan W3c;
   * owner ruling: a background tab): the file's piece joins the session with
   * `code` (the disk text the edit was planned on) as its saved baseline and
   * `text` as its unsaved text, in a tab beside the open ones. The active
   * tab, the focused pane and the drawer stay as they are. Only if the session
   * does not hold the file with text of its own (open, or unsaved): then the
   * answer is `conflict` with the revision it holds. Discard reverts the
   * edit; the tab has no editor model to undo into until it is shown.
   */
  /**
   * The revision of the text the session holds for `path` with text of its
   * own — open, or unsaved — or null (build plan W3c: such a document is the
   * user's, and an agent's disk edit must not replace it). Latest state.
   */
  const heldRevision = useCallback((path) => {
    const held = getSessionDocumentsByPath(latestRef.current).get(sessionPathOf({ filename: path }));
    return held && held.state !== 'closedClean' ? bufferRevision(held.text) : null;
  }, []);

  /**
   * Another program changed the file (track T slice T3a): take the version
   * now on disk, `code`, as the tab's saved text. Each text reaches the live
   * editor document as its own undo step, so nothing is lost:
   * - plain (Load theirs, or a reload): the tab shows their version, and one
   *   undo brings back what it showed;
   * - `keepMine`: their version goes in, then the tab's own text on top, so
   *   the tab stays dirty against their version and one undo shows theirs.
   * `onlyIfClean`: a reload, refused if the tab has unsaved changes now.
   * Returns whether it was taken.
   */
  /** T3b: mark the tab's file deleted on disk (the tab stays open), or not. */
  const markTabDiskMissing = useCallback((tabId, missing) => {
    dispatch({ type: 'SET_TAB_DISK_MISSING', tabId, missing });
  }, [dispatch]);

  const takeDiskVersion = useCallback((tabId, { code, keepMine = false, onlyIfClean = false }) => {
    const tab = latestRef.current.tabsById[tabId];
    if (!tab || typeof code !== 'string') return false;
    if (onlyIfClean && !areEditorTextsEqual(tab.workingCode, tab.code)) return false;
    const mine = tab.workingCode;
    const theirs = normalizeEditorText(code);
    dispatch({ type: 'TAKE_DISK_VERSION', tabId, code, workingCode: keepMine ? mine : theirs, onlyIfClean });
    applyBufferText(tabId, theirs);
    if (keepMine) applyBufferText(tabId, mine);
    return true;
  }, [dispatch]);

  const openInBackground = useCallback((piece, { code, text }) => {
    const held = getSessionDocumentsByPath(latestRef.current).get(sessionPathOf(piece));
    if (held && held.state !== 'closedClean') {
      return { outcome: 'conflict', revision: bufferRevision(held.text) };
    }
    dispatch({ type: 'OPEN_IN_BACKGROUND', piece, code, workingCode: text });
    const tab = latestRef.current.tabsById[piece.id];
    persistenceRef.current?.onWorkingCodeChange?.(tab, tab.workingCode);
    return { outcome: 'applied', revision: bufferRevision(tab.workingCode) };
  }, [dispatch]);

  const closeTab = useCallback((tabId) => {
    dispatch({ type: 'CLOSE_TAB', tabId });
  }, []);

  // `diskBase` (T3a): what this one save expects on disk, when the person
  // chose it (keep my version over theirs, or save a deleted file again).
  const saveTab = useCallback((tabId, { diskBase = null } = {}) => {
    const current = state.tabsById[tabId];
    if (!current) return null;
    const tab = diskBase ? { ...current, diskBase } : current;
    // Untitled session (launcher New File): the resolver owns the disk write —
    // Save As dialog until a root exists. The tab is only marked clean on
    // confirmed success: a canceled
    // dialog or failed write must leave it dirty.
    const resolveUntitledSave = persistenceRef.current?.onResolveUntitledSave;
    if (resolveUntitledSave) {
      // savedCode = the snapshot the resolver writes; edits typed during the
      // async dialog/write must stay dirty (the reducer diffs against it).
      return saveOneTab({ tab, persist: resolveUntitledSave, dispatch });
    }
    return saveOneTab({
      tab,
      persist: persistenceRef.current?.onSaveTab,
      dispatch
    });
  }, [state.tabsById]);

  // A discard resets the canvas piece's copy too. updateWorkingCode mirrors
  // every edit onto the piece (onWorkingCodeChange); a discard that reset only
  // the tab left the discarded text on the piece, where a tab rebuilt from it
  // or a session restore brought it back (P2 peer-review finding F4 started
  // there; P4 gate item 7, 2026-10-01).
  const discardTab = useCallback((tabId) => {
    const tab = state.tabsById[tabId];
    if (tab && !areEditorTextsEqual(tab.workingCode, tab.code)) {
      persistenceRef.current?.onWorkingCodeChange?.(tab, tab.code);
    }
    dispatch({ type: 'DISCARD_TAB', tabId });
  }, [state.tabsById]);

  const saveAllTabs = useCallback(() => {
    const dirtyTabs = Object.values(state.tabsById)
      .filter((tab) => !areEditorTextsEqual(tab.workingCode, tab.code));
    // Untitled session: route each dirty tab through the resolver
    // sequentially — a tab may need its own Save As dialog, and the first
    // success materializes the root the later tabs write into. Tabs are
    // marked clean individually so a mid-sequence cancel keeps the rest dirty.
    const resolveUntitledSave = persistenceRef.current?.onResolveUntitledSave;
    if (resolveUntitledSave) {
      return saveTabsSequentially({ tabs: dirtyTabs, persist: resolveUntitledSave, dispatch });
    }
    return saveTabsFromBatch({
      tabs: dirtyTabs,
      persistAll: persistenceRef.current?.onSaveAllTabs,
      dispatch
    });
  }, [state.tabsById]);

  const updateTabFilename = useCallback((tabId, filename) => {
    dispatch({ type: 'UPDATE_TAB_FILENAME', tabId, filename });
  }, []);

  const discardAllTabs = useCallback(() => {
    for (const tab of Object.values(state.tabsById)) {
      if (!areEditorTextsEqual(tab.workingCode, tab.code)) {
        persistenceRef.current?.onWorkingCodeChange?.(tab, tab.code);
      }
    }
    dispatch({ type: 'DISCARD_ALL' });
  }, [state.tabsById]);

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

  // Binds the session to a key and resets it whenever the key changes. The
  // persistence hook passes the project's LOAD (its `_dbState`), so every
  // open starts from that load's saved editor state; see useProjectPersistence.
  const setProjectInstanceId = useCallback((sessionKey) => {
    if (projectInstanceIdRef.current === sessionKey) return;
    projectInstanceIdRef.current = sessionKey;
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
    applyBufferEdit,
    checkBufferEdit,
    heldRevision,
    openInBackground,
    takeDiskVersion,
    markTabDiskMissing,
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
    applyBufferEdit,
    checkBufferEdit,
    heldRevision,
    openInBackground,
    takeDiskVersion,
    markTabDiskMissing,
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
