import { useCallback, useEffect, useMemo, useState } from 'react';

/**
 * useSyntaxPickerActions — owns the syntax symbol picker and the wire action
 * menu: which wire is selected, where the picker/menu anchor on screen, and
 * how picked symbols get resolved through the syntax adapter. Extracted from
 * App.jsx in the Tier 1 debt cleanup — this was the last inline async
 * business logic in the shell (picker state, path munging, midpoint math,
 * and the JSX onPick handler all lived there since the discovery-canvas arc).
 *
 * Verbatim behavior moves, one shared helper: both the picker and the wire
 * menu convert a canvas midpoint to a screen anchor via the stage transform;
 * that conversion was previously duplicated.
 *
 * `showToast` is injected (same pattern as useGroupMenuActions) so this hook
 * stays inside the domain layer per the architecture guard.
 */
export function useSyntaxPickerActions({
  syntaxDomain,
  syntaxAdapter,
  connections,
  piecesById,
  projectRootPath,
  stageRef,
  canvasToScreen,
  selectionDomain,
  setSelectedGroupId,
  selectedIds,
  selectedGroupId,
  showToast,
  PIECE_WIDTH,
  PIECE_HEIGHT,
}) {
  // null | { connectionId, edgeId, symbols, style: { left, top } }
  const [syntaxPickerState, setSyntaxPickerState] = useState(null);
  const [selectedConnectionId, setSelectedConnectionId] = useState(null);
  // null | { entries: [{ connectionId, label }], style } — member list for an
  // AGGREGATED wire (brief-cross-group-wires D2). Picking an entry selects
  // that member connection, which surfaces the standard wire menu.
  const [wireBundleState, setWireBundleState] = useState(null);

  // Canvas midpoint → screen anchor via the viewport transform. Falls back to
  // canvas coords when the stage isn't mounted yet.
  const toScreenAnchor = useCallback((midCanvasX, midCanvasY) => {
    const stage = stageRef.current;
    let left = midCanvasX;
    let top = midCanvasY;
    if (stage) {
      const screenPos = canvasToScreen(midCanvasX, midCanvasY);
      const rect = stage.container().getBoundingClientRect();
      left = screenPos.x + rect.left;
      top = screenPos.y + rect.top;
    }
    return { left, top };
  }, [stageRef, canvasToScreen]);

  const onSyntaxPendingCreated = useCallback((connectionId, srcPath, midCanvasX, midCanvasY, edgeId, { explicit = false } = {}) => {
    // Use all definitions (not just exports) filtered by what's already on the edge.
    const symbols = edgeId
      ? syntaxDomain.selectors.getAvailableSymbolsForEdge(srcPath, edgeId)
      : syntaxDomain.selectors.getDefinitionsForFile(srcPath);

    // Languages without a symbol layer (Python, Markdown, …): zero symbols
    // means "none POSSIBLE", not "all imported" — the old 'Already connected'
    // toast was a lie for every fresh Python wire. The wire appearing is its
    // own feedback on a draw; only an explicit add-symbol request gets a
    // toast, and an accurate one.
    if (edgeId && symbols.length === 0 && !syntaxDomain.selectors.supportsSymbols?.(srcPath)) {
      if (explicit) {
        showToast('No importable symbols for this file type yet', { severity: 'info' });
      }
      return;
    }

    // Edge already exists with every symbol imported (e.g. redrawing a
    // discovered/saved connection): nothing left to offer. Give clear feedback
    // instead of opening an empty picker.
    if (edgeId && symbols.length === 0) {
      showToast('Already connected', { severity: 'info' });
      return;
    }

    // Always surface the picker when there IS something to import — including
    // the single-symbol case. (It used to auto-resolve one symbol silently, so
    // drawing an edge from a default-only file wrote an import with no visible
    // confirmation or way to decline.) The picker pre-selects a lone symbol, so
    // it stays a one-click confirm; handlePickSymbols does the actual resolve.
    setSyntaxPickerState({ connectionId, edgeId, symbols, style: toScreenAnchor(midCanvasX, midCanvasY) });
  }, [syntaxDomain, toScreenAnchor, showToast]);

  /* ================================
     Modeless wire interactions (Phase 3)
  ================================ */
  const handleSelectConnection = useCallback((connectionId) => {
    setSelectedConnectionId(connectionId);
    setWireBundleState(null);
    selectionDomain.commands.clear();
    setSelectedGroupId(null);
  }, [selectionDomain, setSelectedGroupId]);

  const handleClearConnectionSelection = useCallback(() => {
    setSelectedConnectionId(null);
    setWireBundleState(null);
  }, []);

  // Clicking an AGGREGATED wire opens its member list instead of selecting a
  // single connection (there is no single connection to select).
  const handleSelectWireBundle = useCallback((wire) => {
    const basename = (piece) => {
      const normalized = String(piece?.filename ?? '').replace(/\\/g, '/');
      return normalized.split('/').pop() || '?';
    };
    const entries = (wire?.connections ?? []).map((conn) => ({
      id: conn.id,
      label: `${basename(piecesById.get(conn.sourceId))} → ${basename(piecesById.get(conn.targetId))}`,
    }));
    if (!entries.length) return;
    const midX = (wire.sourceAnchor.x + wire.sourceAnchor.width / 2
      + wire.targetAnchor.x + wire.targetAnchor.width / 2) / 2;
    const midY = (wire.sourceAnchor.y + wire.sourceAnchor.height / 2
      + wire.targetAnchor.y + wire.targetAnchor.height / 2) / 2;
    setSelectedConnectionId(null);
    setSelectedGroupId(null);
    selectionDomain.commands.clear();
    setWireBundleState({ entries, style: toScreenAnchor(midX, midY) });
  }, [piecesById, toScreenAnchor, selectionDomain, setSelectedGroupId]);

  const handlePickBundleEntry = useCallback((connectionId) => {
    setWireBundleState(null);
    handleSelectConnection(connectionId);
  }, [handleSelectConnection]);

  const dismissWireBundle = useCallback(() => {
    setWireBundleState(null);
  }, []);

  // Mutual exclusivity: selecting a piece or group dismisses the wire menu
  // and the bundle list.
  useEffect(() => {
    if ((selectedConnectionId || wireBundleState) && (selectedIds.length > 0 || selectedGroupId)) {
      setSelectedConnectionId(null);
      setWireBundleState(null);
    }
  }, [selectedIds, selectedGroupId, selectedConnectionId, wireBundleState]);

  // Add-symbol on an existing wire: reopen the picker against the edge the wire
  // already represents. Reuses onSyntaxPendingCreated, which opens the picker
  // when symbols remain or toasts "Already connected" when none do.
  const handleAddSymbolToConnection = useCallback((connectionId) => {
    const conn = connections.find((c) => c.id === connectionId);
    if (!conn) return;
    const sourcePiece = piecesById.get(conn.sourceId);
    const targetPiece = piecesById.get(conn.targetId);
    if (!sourcePiece?.filename || !projectRootPath) return;
    const root = projectRootPath.replace(/\\/g, '/').replace(/\/$/, '');
    const srcPath = `${root}/${sourcePiece.filename.replace(/^\//, '')}`;
    const edgeId = syntaxDomain.selectors.getEdgeIdForConnection(connectionId);
    const midX = ((sourcePiece.x ?? 0) + (targetPiece?.x ?? 0)) / 2;
    const midY = ((sourcePiece.y ?? 0) + (targetPiece?.y ?? 0)) / 2;
    setSelectedConnectionId(null); // hand off to the picker
    // explicit: the user asked for symbols from the wire menu — a no-symbol
    // outcome deserves feedback here (unlike a fresh draw, where the wire is).
    onSyntaxPendingCreated(connectionId, srcPath, midX, midY, edgeId, { explicit: true });
  }, [connections, piecesById, projectRootPath, syntaxDomain, onSyntaxPendingCreated]);

  // Screen-space anchor for the wire action menu (selected wire's midpoint).
  const wireMenu = useMemo(() => {
    if (!selectedConnectionId) return null;
    const conn = connections.find((c) => c.id === selectedConnectionId);
    if (!conn) return null;
    const s = piecesById.get(conn.sourceId);
    const t = piecesById.get(conn.targetId);
    if (!s || !t) return null;
    const midCanvasX = ((s.x ?? 0) + (t.x ?? 0)) / 2 + PIECE_WIDTH / 2;
    const midCanvasY = ((s.y ?? 0) + (t.y ?? 0)) / 2 + PIECE_HEIGHT / 2;
    return { connectionId: selectedConnectionId, style: toScreenAnchor(midCanvasX, midCanvasY) };
  }, [selectedConnectionId, connections, piecesById, toScreenAnchor, PIECE_WIDTH, PIECE_HEIGHT]);

  // Handlers are async (they may read/write closed files). Toast the
  // genuine no-op (symbol already imported+exported) and read errors;
  // a successful write is its own visible feedback (the import line).
  const handlePickSymbols = useCallback((symbolIds) => {
    if (!syntaxPickerState) return;
    const { edgeId, connectionId } = syntaxPickerState;
    const notify = (res) => {
      if (res?.status === 'noop') showToast('Already imported', { severity: 'info' });
      else if (res?.status === 'error') showToast("Couldn't write import — file unreadable", { severity: 'error' });
    };
    if (edgeId && symbolIds.length) {
      Promise.resolve(syntaxAdapter?.handleResolveMultipleSymbols({ edgeId, symbolIds })).then(notify).catch(() => {});
    } else if (connectionId && symbolIds.length === 1) {
      Promise.resolve(syntaxAdapter?.handleResolveSymbol({ connectionId, symbolId: symbolIds[0] })).then(notify).catch(() => {});
    }
    setSyntaxPickerState(null);
  }, [syntaxPickerState, syntaxAdapter, showToast]);

  const dismissSyntaxPicker = useCallback(() => {
    setSyntaxPickerState(null);
  }, []);

  return {
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
  };
}
