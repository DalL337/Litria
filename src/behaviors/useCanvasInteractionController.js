import { useCallback, useEffect, useRef, useState } from 'react';
import {
  applyDragEndSnap,
  executeInteractionHistoryAction,
  getLassoSelectedIds
} from '../app/interactionHelpers';
import { findInnermostGroupAt, hasCollapsedAncestor, collectSubtreePieceIds } from '../app/selectors/workspaceSelectors';
import { computeWireSeams } from '../utils/wireNudge';
import { guideLinesFor, resolvePlacement, staticObstacles } from '../app/placementResolution';
import { boundsOfRects, pieceRect } from '../utils/spatialGeometry2d';
import { roundToStep } from '../utils/gridGeometry';

export function useCanvasInteractionController({
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
  onPieceGroupDrop = null,
  onGroupStructureDrop = null,
  pieceHeight,
  pieceWidth,
  pieces,
  piecesById,
  placement,
  selection,
  selectionDomain,
  pieceDomain,
  setDragDebug,
  setScaffoldFocus,
  setSelectedGroupId,
  clearConnectionSelection = () => {},
  stageRef,
  syntaxAdapter = null,
  projectRoot = null,
  onSyntaxPendingCreated = null,
  // Persist a manually-drawn connection's anchor sides so they survive a reopen
  // (Phase 1B). Discovery-created connections aren't persisted here — they use
  // the persisted override or geometry. Optional; no-op in tests.
  persistConnectionSides = null,
  // S4 (brief-cross-group-wires): collapsed-group members excluded from wire
  // targeting, and empty-space wire drops routed out for pill handling.
  hiddenPieceIds = null,
  onWireDragMiss = null,
  screenToCanvas = (x, y) => ({ x, y }),
  startPan = () => {},
  updatePan = () => false,
  endPan = () => false,
  isPanActive = () => false,
  // Interaction mode (ADR-013 Phase 3). Structural drag behavior — merge into a
  // group / extract from a group — only happens in edit mode; default mode drag
  // is always a pure spatial move. Defaults keep the controller usable in tests.
  isEditMode = () => false,
  activeActionToken = () => null,
  // Empty-group drag commit: translates seedBounds at drag end when the
  // dragged group has no subtree pieces (its only geometry is the seed).
  onGroupSeedTranslate = null,
  // Structural grid (ADR-030): returns { mode, steps, guides,
  // guideTolerancePx } or null. Read once at drag start — no mid-drag
  // lattice change (brief §5). Null keeps the pre-grid neighbor snap.
  getGridPlacement = null,
  // Current zoom, to turn the screen-space guide tolerance into world units.
  getViewportScale = () => 1,
}) {
  const dragStartRef = useRef(new Map());
  const groupDragStartRef = useRef(null);
  // Grid placement captured at drag start, and the landing it resolves to
  // while the pointer moves (the render layer draws it: brief §5).
  const dragPlacementRef = useRef(null);
  const [placementPreview, setPlacementPreview] = useState(null);
  // Escape during a drag: the drag ends where it began, with no history.
  const cancelDragRef = useRef(false);
  // Piece-to-group drag tracking
  const dragOverGroupRef = useRef(null);
  const dragOverCandidateRef = useRef(null);
  const dragOverTimerRef = useRef(null);
  const lastPointerScreenRef = useRef(null);
  const [dragOverGroupId, setDragOverGroupId] = useState(null);
  // Reactive "a drag is in progress" flag — drives the app-dragging class so
  // overlays can drop pointer-events and not swallow the drag (internals note 2).
  const [isDragActive, setIsDragActive] = useState(false);
  // Subtractive-drag source (B3 follow-up; un-nest per ADR-013 addendum):
  // while an edit+subtractive drag is in flight, the group being LEFT —
  // { groupId, pieceId } for a piece extraction, { groupId, childGroupId }
  // for an un-nest (groupId = the parent). Render layer dims that box and
  // excludes the departing piece/child from its live bounds. Derived on
  // every drag move (the sub-mode can change mid-drag), cleared on drag end.
  const [subtractiveDragSource, setSubtractiveDragSource] = useState(null);
  const subtractiveSourceRef = useRef(null);
  const updateSubtractiveSource = useCallback((next) => {
    const prev = subtractiveSourceRef.current;
    const same = prev === next || (
      prev && next &&
      prev.groupId === next.groupId &&
      prev.pieceId === next.pieceId &&
      prev.childGroupId === next.childGroupId
    );
    if (same) return;
    subtractiveSourceRef.current = next;
    setSubtractiveDragSource(next);
  }, []);

  // Failsafe: a drag can end without Konva's dragend firing (pointer released
  // off-window, drag interrupted, non-finite end coords). If the flag stranded
  // ON, `.app-dragging` keeps `pointer-events: none` on the status bar forever
  // and the minimap toggle (and other overlay controls) go dead. Always clear
  // the flag on a window-level pointer release / focus loss. Functional update
  // so a no-op (already false) doesn't trigger a re-render.
  useEffect(() => {
    const clear = () => setIsDragActive((prev) => (prev ? false : prev));
    window.addEventListener('pointerup', clear);
    window.addEventListener('pointercancel', clear);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('pointerup', clear);
      window.removeEventListener('pointercancel', clear);
      window.removeEventListener('blur', clear);
    };
  }, []);
  const clearSelection = selectionDomain?.commands?.clear ?? selection.clear;
  const selectMultiple = selectionDomain?.commands?.selectMultiple ?? selection.selectMultiple;
  const isSelected = selectionDomain?.selectors?.isSelected ?? selection.isSelected;
  const selectedIds = selectionDomain?.selectors?.getSelectedIds?.() ?? selection.selectedIds;
  const selectedCount = selectionDomain?.selectors?.getCount?.() ?? selection.count;

  const handleStageMouseDown = useCallback((e) => {
    const button = e.evt.button;

    // RMB on empty canvas → start pan candidate
    if (button === 2 && e.target === e.target.getStage()) {
      const rawPos = e.target.getStage().getPointerPosition();
      startPan(rawPos.x, rawPos.y);
      return;
    }

    // LMB only from here
    if (button !== 0) return;

    // Shift+LMB → lasso. Allowed on the bare stage AND over an expanded group's
    // gutter (tagged 'group-gutter'), so Shift+drag keeps rubber-band selecting
    // even when it starts inside a group. Without this, a listening group box
    // would swallow the marquee's initial pointerdown (the original reason the
    // group outline was listening=false).
    const stage = e.target.getStage();
    const overGroupGutter = e.target?.name?.() === 'group-gutter';
    if (modifiers.shift && (e.target === stage || overGroupGutter)) {
      const rawPos = stage.getPointerPosition();
      const pos = screenToCanvas(rawPos.x, rawPos.y);
      lasso.startLasso(pos.x, pos.y);
    }
  }, [lasso, modifiers.shift, screenToCanvas, startPan]);

  const handleStageMouseMove = useCallback((e) => {
    const rawPos = e.target.getStage().getPointerPosition();

    if (isPanActive()) {
      updatePan(rawPos.x, rawPos.y);
      return;
    }

    const pos = screenToCanvas(rawPos.x, rawPos.y);

    if (lasso.isSelecting) {
      lasso.updateLasso(pos.x, pos.y);
    }

    if (connectionDrag.isDragging) {
      connectionDrag.updateDrag(pos.x, pos.y, pieces);
    }
  }, [connectionDrag, isPanActive, lasso, pieces, screenToCanvas, updatePan]);

  const handleStageMouseUp = useCallback((e) => {
    const button = e.evt.button;

    // Always clear pan on any mouseup to prevent stuck pan state
    if (isPanActive()) {
      const wasPanning = endPan();
      if (button === 2 && !wasPanning) {
        clearSelection();
        setSelectedGroupId(null);
        clearConnectionSelection();
        setScaffoldFocus(null);
      }
      if (button === 2) return;
    }

    // LMB release on empty canvas — deselect if nothing else is active
    if (button === 0 && e.target === e.target.getStage() && !lasso.isSelecting && !connectionDrag.isDragging) {
      clearSelection();
      setSelectedGroupId(null);
      clearConnectionSelection();
      setScaffoldFocus(null);
    }

    const rawPos = e.target.getStage().getPointerPosition();
    const pos = screenToCanvas(rawPos.x, rawPos.y);

    if (lasso.isSelecting) {
      const selected = lasso.getItemsInBox(pieces);
      selectMultiple(getLassoSelectedIds(selected));
      lasso.endLasso();
      setSelectedGroupId(null);
    }

    if (connectionDrag.isDragging) {
      // Hidden pieces (collapsed-group members) keep coordinates under the
      // pill — exclude them from targeting so a pill drop is a MISS routed
      // to onWireDragMiss (S4 picker/expand), not a connect to an invisible
      // piece chosen by accident of position.
      const targetablePieces = hiddenPieceIds
        ? pieces.filter((p) => !hiddenPieceIds.has(p.id))
        : pieces;
      const result = connectionDrag.endDrag(pos.x, pos.y, targetablePieces);
      if (result?.miss) {
        onWireDragMiss?.({
          sourceId: result.sourceId,
          sourceSide: result.sourceSide,
          canvasX: pos.x,
          canvasY: pos.y,
        });
        return;
      }
      // Wire-birth nudge (ADR-025 §4 rung 3; wires override adjacency):
      // if either anchored face is buried behind flush neighbors, part them
      // to the minimal approach seam BEFORE creating the wire. The piece
      // move and the connection creation share ONE history group, so a
      // single undo reverts both (D1a). finalizePieces rebuilds adjacency
      // for the moved pieces — stored adjacentTo follows the geometry in
      // both do() and undo(), so adjacency can never overwrite the nudge.
      history.beginGroup('Create connection');
      let connection;
      try {
        connection = connectionDomain.commands.createConnectionFromDrag(result);
        // Dedup/self-connection returns null — nothing was born, nothing
        // parts.
        const nudgeMoves = connection ? computeWireSeams({
          wires: [{
            sourceId: result.sourceId,
            sourceSide: result.sourceSide,
            targetId: result.targetId,
            targetSide: result.targetSide,
          }],
          pieces,
          hiddenPieceIds,
          groupByPieceId,
          pieceWidth,
          pieceHeight,
        }) : null;
        if (nudgeMoves) {
          const deltaById = new Map(nudgeMoves.map((m) => [m.id, m]));
          const movedIds = nudgeMoves.map((m) => m.id);
          const afterPieces = pieces.map((p) => {
            const d = deltaById.get(p.id);
            return d ? { ...p, x: p.x + d.dx, y: p.y + d.dy } : p;
          });
          const nudgeAction = movePiecesAction({
            beforePieces: pieces,
            afterPieces,
            setPieces: pieceDomain.commands.replacePieces,
            ids: movedIds,
            label: 'Nudge pieces',
            finalizePieces: (updated) => {
              const withLocations = placement.updateMultiplePieceLocations(updated, movedIds);
              return adjacency.updateAdjacenciesForPieces(withLocations, movedIds);
            }
          });
          if (nudgeAction) {
            executeInteractionHistoryAction(history, { label: 'Nudge pieces', action: nudgeAction });
          }
        }
      } finally {
        history.endGroup();
      }
      // Persist the user-chosen anchor sides (fire-and-forget). createConnection
      // dedups by direction, so a given pair is only drawn — and persisted — once.
      if (connection && persistConnectionSides) {
        persistConnectionSides(connection);
      }
      // Notify syntaxAdapter so an import stub is written in the target file.
      if (syntaxAdapter && connection && projectRoot) {
        const sourcePiece = piecesById.get(connection.sourceId);
        const targetPiece = piecesById.get(connection.targetId);
        if (sourcePiece?.filename && targetPiece?.filename) {
          const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
          const srcPath = `${root}/${sourcePiece.filename.replace(/^\//, '')}`;
          const tgtPath = `${root}/${targetPiece.filename.replace(/^\//, '')}`;
          // handleConnect is async (it may read/write closed files). The stub
          // write happens in the background; the picker opens once we know the
          // edgeId. Drag flow is not blocked.
          Promise.resolve(syntaxAdapter.handleConnect({
            connectionId: connection.id,
            sourceFilePath: srcPath,
            targetFilePath: tgtPath,
          })).then((connectResult) => {
            if (connectResult?.success && onSyntaxPendingCreated) {
              // Compute canvas midpoint for picker positioning.
              const midX = ((sourcePiece.x ?? 0) + (targetPiece.x ?? 0)) / 2;
              const midY = ((sourcePiece.y ?? 0) + (targetPiece.y ?? 0)) / 2;
              onSyntaxPendingCreated(connection.id, srcPath, midX, midY, connectResult.edgeId);
            }
          }).catch(() => {});
        }
      }
    }
  }, [adjacency, clearSelection, clearConnectionSelection, connectionDomain, connectionDrag, endPan, groupByPieceId, hiddenPieceIds, history, isPanActive, lasso, movePiecesAction, onSyntaxPendingCreated, onWireDragMiss, persistConnectionSides, pieceDomain, pieceHeight, pieceWidth, pieces, piecesById, placement, projectRoot, screenToCanvas, selectMultiple, setScaffoldFocus, setSelectedGroupId, syntaxAdapter]);

  const clearDragOverGroup = useCallback(() => {
    if (dragOverTimerRef.current) {
      clearTimeout(dragOverTimerRef.current);
      dragOverTimerRef.current = null;
    }
    dragOverCandidateRef.current = null;
    dragOverGroupRef.current = null;
    setDragOverGroupId(null);
  }, []);

  const updateDragOverGroup = useCallback((pieceId, centerX, centerY) => {
    const currentGroupId = groupByPieceId?.get(pieceId) ?? null;

    // Subtractive de-emphasis: a single grouped piece dragged under
    // edit+subtractive is LEAVING its group — flag the source so the render
    // layer can dim its box and stop the live bounds chasing the piece.
    const isSubtractiveExtract = isEditMode() && activeActionToken() === 'subtractive'
      && dragStartRef.current.size === 1 && currentGroupId != null;
    updateSubtractiveSource(isSubtractiveExtract ? { groupId: currentGroupId, pieceId } : null);

    // Merge-target highlighting only applies in edit mode's additive sub-mode.
    // Outside it, ensure no stale highlight lingers and skip detection.
    if (!(isEditMode() && activeActionToken() === 'additive')) {
      if (dragOverCandidateRef.current !== null) clearDragOverGroup();
      return;
    }

    // Innermost containing group wins (2026-07-26): with real nesting a
    // parent's bounds contain the child's entire area, and first-match
    // array-order testing made the parent swallow drops aimed at the child.
    // The piece's OWN group stays in as a containment candidate: when the
    // innermost container is the current group, there is no target —
    // otherwise dropping a nested piece inside its own box would merge it
    // upward into the parent.
    const dragGroupsById = new Map(groups.map((g) => [g.id, g]));
    const innermost = findInnermostGroupAt(groups, centerX, centerY, getGroupBounds, (group) => {
      if (group.id === currentGroupId) return false;
      // Ancestor-collapsed groups don't render (D3 — folded into the pill);
      // an invisible box must not be a drop target.
      if (hasCollapsedAncestor(group, dragGroupsById)) return true;
      // Empty manual groups (ADR-018 box-first) are valid drop targets —
      // their seedBounds give them geometry; getGroupBounds returns null
      // for anything genuinely boundless, which containment then skips.
      return !group.pieceIds?.length && !group.seedBounds;
    });
    const hitGroupId = innermost && innermost.id !== currentGroupId ? innermost.id : null;

    if (hitGroupId !== dragOverCandidateRef.current) {
      dragOverCandidateRef.current = hitGroupId;
      setDragOverGroupId(hitGroupId);
      if (dragOverTimerRef.current) {
        clearTimeout(dragOverTimerRef.current);
        dragOverTimerRef.current = null;
      }
      if (hitGroupId) {
        dragOverTimerRef.current = setTimeout(() => {
          dragOverGroupRef.current = hitGroupId;
          dragOverTimerRef.current = null;
        }, 200);
      } else {
        dragOverGroupRef.current = null;
      }
    }
  }, [activeActionToken, clearDragOverGroup, getGroupBounds, groupByPieceId, groups, isEditMode, updateSubtractiveSource]);

  const capturePlacement = useCallback(() => {
    const grid = getGridPlacement?.();
    if (!grid?.steps) return null;
    const zoom = getViewportScale?.() || 1;
    return {
      mode: grid.mode === 'strict' ? 'strict' : 'flex',
      steps: grid.steps,
      guideTolerance: grid.guides ? (grid.guideTolerancePx ?? 0) / zoom : 0,
    };
  }, [getGridPlacement, getViewportScale]);

  // Resolve where a moving set lands. `positionOf(id)` gives each member's
  // current corner; `dockAnchor` is Flex's docking target for the set's
  // corner (or null). Group drags pass occupancy: false.
  const resolveMovingSet = useCallback(({ ids, positionOf, gridPlacement, dockAnchor = null, occupancy = true }) => {
    const members = [];
    for (const id of ids) {
      const piece = piecesById.get(id) ?? pieces.find((entry) => entry.id === id);
      if (piece) members.push({ piece, position: positionOf(id) });
    }
    if (!members.length) return null;
    const obstacles = staticObstacles({
      pieces,
      movingIds: ids,
      hiddenPieceIds,
      baseWidth: pieceWidth,
      baseHeight: pieceHeight,
    });
    const result = resolvePlacement({
      members,
      obstacles,
      steps: gridPlacement.steps,
      mode: gridPlacement.mode,
      dockAnchor: gridPlacement.mode === 'flex' ? dockAnchor : null,
      guideTolerance: gridPlacement.guideTolerance,
      occupancy,
      baseWidth: pieceWidth,
      baseHeight: pieceHeight,
    });
    return { ...result, members, obstacles };
  }, [hiddenPieceIds, pieceHeight, pieceWidth, pieces, piecesById]);

  // Flex docking for the moving set, as today: the single-piece neighbor
  // snap (with its wire seam), or the multi-piece bounds snap.
  const dockAnchorFor = useCallback((ids, positionOf, leadId) => {
    if (ids.length === 1) {
      const piece = piecesById.get(leadId);
      if (!piece) return null;
      const at = positionOf(leadId);
      return checkSnap?.(piece, at.x, at.y) ?? null;
    }
    const delta = getGroupSnapDelta?.(ids);
    if (!delta || (!delta.dx && !delta.dy)) return null;
    const bounds = boundsOfRects(ids.map((pid) => {
      const piece = piecesById.get(pid);
      return piece ? pieceRect(piece, pieceWidth, pieceHeight, positionOf(pid)) : null;
    }));
    return bounds ? { x: bounds.x + delta.dx, y: bounds.y + delta.dy } : null;
  }, [checkSnap, getGroupSnapDelta, pieceHeight, pieceWidth, piecesById]);

  const previewFor = useCallback((ids, resolved) => {
    if (!resolved) return null;
    if (!resolved.positions) return { ids, reason: 'blocked' };
    const landing = boundsOfRects(resolved.members.map(({ piece }) => (
      pieceRect(piece, pieceWidth, pieceHeight, resolved.positions.get(piece.id))
    )));
    return {
      ids,
      positions: resolved.positions,
      reason: resolved.reason,
      anchor: resolved.anchor,
      level: resolved.level,
      guideLines: guideLinesFor(landing, resolved.obstacles),
    };
  }, [pieceHeight, pieceWidth]);

  const handlePieceDragMove = useCallback((id, x, y) => {
    if (connectionDrag.isDragging) return;
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) return;
    if (window.CM_DEBUG_DRAG) {
      setDragDebug({ type: 'move', id, x: Math.round(x), y: Math.round(y), at: Date.now() });
    }

    const gridPlacement = dragPlacementRef.current;
    if (isSelected(id) && selectedCount > 1) {
      const snapshot = dragStartRef.current;
      const leadStart = snapshot.get(id);
      if (!leadStart) return;
      const dx = x - leadStart.x;
      const dy = y - leadStart.y;
      if (!dx && !dy) return;
      pieceDomain.commands.previewMoveSnapshotPieces({
        pieceSnapshot: snapshot,
        dx,
        dy
      });
      if (gridPlacement) {
        const ids = Array.from(snapshot.keys());
        const positionOf = (pid) => {
          const start = snapshot.get(pid);
          return { x: start.x + dx, y: start.y + dy };
        };
        setPlacementPreview(previewFor(ids, resolveMovingSet({
          ids,
          positionOf,
          gridPlacement,
          dockAnchor: dockAnchorFor(ids, positionOf, id),
        })));
      }
    } else {
      pieceDomain.commands.previewMovePiece({ id, x, y });
      if (gridPlacement) {
        const positionOf = () => ({ x, y });
        setPlacementPreview(previewFor([id], resolveMovingSet({
          ids: [id],
          positionOf,
          gridPlacement,
          dockAnchor: dockAnchorFor([id], positionOf, id),
        })));
      }
    }

    // Piece-to-group overlap detection (single piece drag only)
    if (!isSelected(id) || selectedCount <= 1) {
      const piece = piecesById.get(id);
      const scale = piece?.scale ?? 1;
      const cx = x + (pieceWidth * scale) / 2;
      const cy = y + (pieceHeight * scale) / 2;
      updateDragOverGroup(id, cx, cy);
    }
  }, [connectionDrag.isDragging, dockAnchorFor, isFiniteNumber, isSelected, pieceDomain, pieceHeight, pieceWidth, piecesById, previewFor, resolveMovingSet, selectedCount, setDragDebug, updateDragOverGroup]);

  const handlePieceDragStart = useCallback((id) => {
    if (connectionDrag.isDragging) return;
    setIsDragActive(true);
    if (window.CM_DEBUG_DRAG) {
      setDragDebug({ type: 'start', id, at: Date.now() });
    }
    const activeIds = isSelected(id) && selectedCount > 1
      ? selectedIds
      : [id];

    const snapshot = new Map();
    activeIds.forEach(activeId => {
      const piece = pieces.find(p => p.id === activeId);
      if (!piece) return;
      snapshot.set(activeId, {
        ...piece,
        adjacentTo: piece.adjacentTo ? { ...piece.adjacentTo } : piece.adjacentTo,
        references: Array.isArray(piece.references) ? [...piece.references] : piece.references
      });
    });
    dragStartRef.current = snapshot;
    dragPlacementRef.current = capturePlacement();
    cancelDragRef.current = false;
    setPlacementPreview(null);
  }, [capturePlacement, connectionDrag.isDragging, isSelected, pieces, selectedCount, selectedIds, setDragDebug]);

  const handlePieceDragEnd = useCallback((id, x, y) => {
    if (connectionDrag.isDragging) return;
    // Interrupted / off-window drag end with bad coords: bail on the move work,
    // but never strand the drag flag (would freeze the status-bar overlay) or
    // the drag snapshot (would keep isDraggingPiece reporting true). This path
    // already discarded the move, so the snapshot is safe to drop.
    if (!isFiniteNumber(x) || !isFiniteNumber(y)) {
      setIsDragActive(false);
      updateSubtractiveSource(null);
      dragStartRef.current = new Map();
      dragPlacementRef.current = null;
      cancelDragRef.current = false;
      setPlacementPreview(null);
      return;
    }
    if (window.CM_DEBUG_DRAG) {
      setDragDebug({ type: 'end', id, at: Date.now() });
    }

    const dragIds = dragStartRef.current.size
      ? Array.from(dragStartRef.current.keys()).sort((a, b) => a - b)
      : [id];

    const beforePieces = pieces.map(p => {
      const startPiece = dragStartRef.current.get(p.id);
      return startPiece ?? p;
    });

    const gridPlacement = dragPlacementRef.current;
    dragPlacementRef.current = null;
    setPlacementPreview(null);

    // Escape (or a placement with no free spot nearby) ends the drag where it
    // began: the pre-gesture snapshot comes back with no history entry. The
    // position outbox saw the previews, so it records the restored corners.
    const returnToStart = () => {
      const restored = pieces.map((p) => dragStartRef.current.get(p.id) ?? p);
      pieceDomain.commands.replacePieces(restored);
      setIsDragActive(false);
      updateSubtractiveSource(null);
      clearDragOverGroup();
      groupDrag.endGroupDrag();
      dragStartRef.current = new Map();
    };
    if (cancelDragRef.current) {
      cancelDragRef.current = false;
      returnToStart();
      return;
    }

    let nextPieces;
    if (gridPlacement) {
      // Rigid move: every member keeps its offset from the lead's delta.
      const leadStart = dragStartRef.current.get(id);
      const dx = leadStart ? x - leadStart.x : 0;
      const dy = leadStart ? y - leadStart.y : 0;
      const positionOf = (pid) => {
        if (pid === id) return { x, y };
        const start = dragStartRef.current.get(pid);
        return start ? { x: start.x + dx, y: start.y + dy } : { x, y };
      };
      const resolved = resolveMovingSet({
        ids: dragIds,
        positionOf,
        gridPlacement,
        dockAnchor: dockAnchorFor(dragIds, positionOf, id),
      });
      if (!resolved?.positions) {
        returnToStart();
        return;
      }
      nextPieces = pieces.map((p) => {
        const landed = resolved.positions.get(p.id);
        return landed ? { ...p, x: landed.x, y: landed.y } : p;
      });
    } else {
      nextPieces = applyDragEndSnap({
        pieces,
        dragIds,
        draggedPieceId: id,
        dragX: x,
        dragY: y,
        getGroupSnapDelta,
        checkSnap
      });
    }

    // Seam maintenance (ADR-025 §4 as amended 2026-07-31): a settled
    // arrangement must never leave a wire under-passing because adjacency
    // sealed its path — buried faces get air, flush pairs on a wire's path
    // part laterally so the wire drops between them. Folded into the SAME
    // move action: one gesture, one undo, adjacency rebuilt across every
    // moved piece.
    const seamMoves = computeWireSeams({
      wires: connectionDomain.selectors.getAllConnections(),
      pieces: nextPieces,
      hiddenPieceIds,
      groupByPieceId,
      pieceWidth,
      pieceHeight,
    });
    const seamById = seamMoves ? new Map(seamMoves.map((m) => [m.id, m])) : null;
    const settledPieces = seamById
      ? nextPieces.map((p) => {
          const d = seamById.get(p.id);
          return d ? { ...p, x: p.x + d.dx, y: p.y + d.dy } : p;
        })
      : nextPieces;
    const movedIds = seamMoves
      ? [...new Set([...dragIds, ...seamMoves.map((m) => m.id)])]
      : dragIds;

    const moveAction = movePiecesAction({
      beforePieces,
      afterPieces: settledPieces,
      setPieces: pieceDomain.commands.replacePieces,
      ids: movedIds,
      finalizePieces: (updated) => {
        const withLocations = placement.updateMultiplePieceLocations(updated, movedIds);
        return adjacencyMode === 'accurate' || movedIds.length > 1
          ? adjacency.rebuildAllAdjacencies(withLocations)
          : adjacency.updateAdjacenciesForPieces(withLocations, movedIds);
      }
    });

    executeInteractionHistoryAction(history, { label: 'Move pieces', action: moveAction });

    // Structural group changes only happen in edit mode (ADR-013 Phase 3).
    // Default mode drag is always a pure spatial move — no auto-merge-on-drop,
    // no accidental group membership. Edit mode's sub-mode decides the intent:
    //   additive    → dropping over a different group merges into it
    //   subtractive → dropping a grouped piece extracts it from its group
    // (single-piece drags only).
    if (dragIds.length === 1 && onPieceGroupDrop && isEditMode()) {
      const draggedId = dragIds[0];
      const currentGroupId = groupByPieceId?.get(draggedId) ?? null;
      const token = activeActionToken();

      if (token === 'additive') {
        const targetGroupId = dragOverGroupRef.current;
        if (targetGroupId && targetGroupId !== currentGroupId) {
          onPieceGroupDrop({ pieceId: draggedId, fromGroupId: currentGroupId, toGroupId: targetGroupId });
        }
      } else if (token === 'subtractive' && currentGroupId) {
        onPieceGroupDrop({ pieceId: draggedId, fromGroupId: currentGroupId, toGroupId: null });
      }
    }

    setIsDragActive(false);
    updateSubtractiveSource(null);
    clearDragOverGroup();
    groupDrag.endGroupDrag();
    dragStartRef.current = new Map();
  }, [
    activeActionToken,
    adjacency,
    adjacencyMode,
    checkSnap,
    clearDragOverGroup,
    updateSubtractiveSource,
    connectionDomain,
    connectionDrag.isDragging,
    dockAnchorFor,
    getGroupBounds,
    getGroupSnapDelta,
    resolveMovingSet,
    groupByPieceId,
    groupDrag,
    groups,
    hiddenPieceIds,
    history,
    isEditMode,
    isFiniteNumber,
    movePiecesAction,
    onPieceGroupDrop,
    pieceDomain,
    pieceHeight,
    pieceWidth,
    pieces,
    piecesById,
    placement,
    setDragDebug,
  ]);

  const handleConnectionStart = useCallback((piece, e) => {
    if (!e?.evt?.ctrlKey || e?.evt?.button !== 0) return;
    const stage = stageRef.current;
    if (!stage) return;
    const rawPos = stage.getPointerPosition();
    if (!rawPos) return;
    const pos = screenToCanvas(rawPos.x, rawPos.y);
    connectionDrag.startDrag(piece, pos.x, pos.y);
  }, [connectionDrag, screenToCanvas, stageRef]);

  const handleGroupPillDragStart = useCallback((groupId, { detectNest = true } = {}) => {
    const group = groups.find((entry) => entry.id === groupId);
    if (!group) return;
    const bounds = getGroupBounds(group);
    if (!bounds) return;
    setIsDragActive(true);
    // D4 (brief-nested-group-containment, owner-ruled 2026-07-28): the drag
    // carries the WHOLE subtree — a parent's box or pill moves its
    // descendants' pieces with it. The snapshot was direct pieceIds only
    // (gap G2): children sat still while the parent's pieces moved, the
    // re-unioned box "snapped back" around the unmoved child, and the drag
    // read as broken (owner live repro 2026-08-01, post-twins-heal). The
    // preview and commit paths both key off snapshot membership, so the
    // subtree flows through move AND drag-end from this one site.
    const childrenByParent = new Map();
    for (const g of groups) {
      if (g.parentId == null) continue;
      if (!childrenByParent.has(g.parentId)) childrenByParent.set(g.parentId, []);
      childrenByParent.get(g.parentId).push(g);
    }
    const pieceSnapshot = new Map();
    collectSubtreePieceIds(group, childrenByParent).forEach((pieceId) => {
      const piece = piecesById.get(pieceId);
      if (!piece) return;
      pieceSnapshot.set(pieceId, {
        ...piece,
        adjacentTo: piece.adjacentTo ? { ...piece.adjacentTo } : piece.adjacentTo,
        references: Array.isArray(piece.references) ? [...piece.references] : piece.references
      });
    });
    dragPlacementRef.current = capturePlacement();
    cancelDragRef.current = false;
    groupDragStartRef.current = {
      groupId,
      startX: bounds.minX,
      startY: bounds.minY,
      pieceSnapshot,
      // Collapsed pill drags participate in group-overlap detection (nest /
      // un-nest — edit-mode only, gated in drag-move and drag-end). The
      // expanded-group box is a plain MOVE in every mode, so it opts out.
      detectNest
    };
  }, [capturePlacement, getGroupBounds, groups, piecesById]);

  const handleGroupPillDragMove = useCallback((event) => {
    const dragState = groupDragStartRef.current;
    if (!dragState) return;
    const node = event.target;
    // Remember the dragged Konva node so Escape can put it back: a memberless
    // group's node is not bound to any state that a restore would re-render.
    if (!dragState.node) {
      dragState.node = node;
    }
    const nextX = node.x();
    const nextY = node.y();
    if (!Number.isFinite(nextX) || !Number.isFinite(nextY)) return;
    const dx = nextX - dragState.startX;
    const dy = nextY - dragState.startY;
    // Track the latest node position for drag-end: an empty group has no
    // piece snapshot to derive the delta from, only the node's travel.
    dragState.lastX = nextX;
    dragState.lastY = nextY;
    if (!dx && !dy) return;
    pieceDomain.commands.previewMoveSnapshotPieces({
      pieceSnapshot: dragState.pieceSnapshot,
      dx,
      dy
    });

    // Subtractive de-emphasis for un-nest: dragging a nested group under
    // edit+subtractive is LEAVING its parent — flag the parent so its box
    // dims and stops unioning the departing child (applies to both pill and
    // expanded-box drags; the un-nest drop at drag-end has no detectNest
    // gate either).
    const draggedGroup = groups.find((entry) => entry.id === dragState.groupId);
    const parentGroupId = draggedGroup?.parentId ?? null;
    const isSubtractiveUnnest = isEditMode() && activeActionToken() === 'subtractive' && parentGroupId != null;
    updateSubtractiveSource(
      isSubtractiveUnnest ? { groupId: parentGroupId, childGroupId: dragState.groupId } : null
    );

    // Group-to-group overlap detection (nest) — collapsed pill drags only
    // (the expanded box opts out via detectNest === false), and only while
    // edit mode's additive sub-mode is active: structural group changes are
    // mode-gated exactly like piece merges (ADR-013). Outside the mode the
    // drag is a pure move — clear any stale highlight and skip detection.
    if (!dragState.detectNest || !(isEditMode() && activeActionToken() === 'additive')) {
      if (dragOverCandidateRef.current !== null) clearDragOverGroup();
      const nativeEvt = event.evt;
      if (nativeEvt) {
        lastPointerScreenRef.current = { x: nativeEvt.clientX, y: nativeEvt.clientY };
      }
      return;
    }
    const draggedGroupId = dragState.groupId;
    const pillCenterX = nextX + pieceWidth / 2;
    const pillCenterY = nextY + 40; // half of SQUIRCLE_H (80)
    // Innermost containing group wins (2026-07-26) — same rule as piece
    // drags; see findInnermostGroupAt. Self and descendants are excluded
    // (circular nesting), memberless groups aren't pill-nest targets.
    const pillGroupsById = new Map(groups.map((g) => [g.id, g]));
    const innermost = findInnermostGroupAt(groups, pillCenterX, pillCenterY, getGroupBounds, (group) => {
      if (group.id === draggedGroupId) return true;
      if (!group.pieceIds?.length) return true;
      // Ancestor-collapsed groups don't render (D3) — not nest targets.
      if (hasCollapsedAncestor(group, pillGroupsById)) return true;
      let checkId = group.parentId;
      const seen = new Set();
      while (checkId && !seen.has(checkId)) {
        if (checkId === draggedGroupId) return true;
        seen.add(checkId);
        checkId = groups.find((g) => g.id === checkId)?.parentId ?? null;
      }
      return false;
    });
    const hitGroupId = innermost?.id ?? null;
    if (hitGroupId !== dragOverCandidateRef.current) {
      dragOverCandidateRef.current = hitGroupId;
      setDragOverGroupId(hitGroupId);
      if (dragOverTimerRef.current) {
        clearTimeout(dragOverTimerRef.current);
        dragOverTimerRef.current = null;
      }
      if (hitGroupId) {
        dragOverTimerRef.current = setTimeout(() => {
          dragOverGroupRef.current = hitGroupId;
          dragOverTimerRef.current = null;
        }, 200);
      } else {
        dragOverGroupRef.current = null;
      }
    }

    // Capture screen coordinates for popover positioning
    const nativeEvt = event.evt;
    if (nativeEvt) {
      lastPointerScreenRef.current = { x: nativeEvt.clientX, y: nativeEvt.clientY };
    }
  }, [activeActionToken, clearDragOverGroup, getGroupBounds, groups, isEditMode, pieceDomain, pieceWidth, updateSubtractiveSource]);

  const handleGroupPillDragEnd = useCallback((groupId) => {
    const dragState = groupDragStartRef.current;
    if (!dragState || dragState.groupId !== groupId) return;
    const gridPlacement = dragPlacementRef.current;
    dragPlacementRef.current = null;
    const beforePieces = pieces.map((piece) => {
      const snapshot = dragState.pieceSnapshot.get(piece.id);
      return snapshot ?? piece;
    });
    const dragIds = Array.from(dragState.pieceSnapshot.keys()).sort((a, b) => a - b);

    if (cancelDragRef.current) {
      // Escape: members and the dragged node go back; nothing is recorded.
      cancelDragRef.current = false;
      if (dragIds.length) pieceDomain.commands.replacePieces(beforePieces);
      dragState.node?.position?.({ x: dragState.startX, y: dragState.startY });
      setIsDragActive(false);
      updateSubtractiveSource(null);
      clearDragOverGroup();
      groupDragStartRef.current = null;
      return;
    }

    let nextPieces = pieces;
    if (dragIds.length === 0) {
      // Seed-positioned group (no pieces in the snapshot): the gesture's
      // delta lands on seedBounds or the move silently reverts — the Konva
      // node followed the pointer, but state is what the action pill and
      // the reopen position anchor to (owner live repro 2026-08-01:
      // newfolder's action pill "not moving with it"). With the grid, the
      // seed's corner lands on the lattice like any other corner.
      let seedDx = (dragState.lastX ?? dragState.startX) - dragState.startX;
      let seedDy = (dragState.lastY ?? dragState.startY) - dragState.startY;
      const seed = groups.find((entry) => entry.id === groupId)?.seedBounds;
      if (gridPlacement && seed && (seedDx || seedDy)) {
        const strict = gridPlacement.mode === 'strict';
        const stepX = strict ? gridPlacement.steps.majorX : gridPlacement.steps.subX;
        const stepY = strict ? gridPlacement.steps.majorY : gridPlacement.steps.subY;
        seedDx = roundToStep(seed.x + seedDx, stepX) - seed.x;
        seedDy = roundToStep(seed.y + seedDy, stepY) - seed.y;
      }
      if (seedDx || seedDy) onGroupSeedTranslate?.(groupId, seedDx, seedDy);
    } else {
      if (gridPlacement) {
        // A group moves rigidly by its members' corner. Its visible footprint
        // is its box or pill, not its members' rectangles, so no occupancy.
        const positionOf = (pid) => {
          const piece = piecesById.get(pid);
          return { x: piece.x, y: piece.y };
        };
        const resolved = resolveMovingSet({
          ids: dragIds,
          positionOf,
          gridPlacement,
          dockAnchor: dockAnchorFor(dragIds, positionOf, dragIds[0]),
          occupancy: false,
        });
        if (resolved?.positions) {
          nextPieces = pieces.map((p) => {
            const landed = resolved.positions.get(p.id);
            return landed ? { ...p, x: landed.x, y: landed.y } : p;
          });
        }
      } else {
        nextPieces = applyDragEndSnap({
          pieces,
          dragIds,
          draggedPieceId: dragIds[0],
          dragX: 0,
          dragY: 0,
          getGroupSnapDelta
        });
      }
      // Seam maintenance, as for a piece drop (brief §5: group drags had no
      // seam pass). Formal group members never freeform-part, so the seams
      // only move outside neighbors; one gesture, one undo.
      const seamMoves = computeWireSeams({
        wires: connectionDomain.selectors.getAllConnections(),
        pieces: nextPieces,
        hiddenPieceIds,
        groupByPieceId,
        pieceWidth,
        pieceHeight,
      });
      const seamById = seamMoves ? new Map(seamMoves.map((m) => [m.id, m])) : null;
      if (seamById) {
        nextPieces = nextPieces.map((p) => {
          const d = seamById.get(p.id);
          return d ? { ...p, x: p.x + d.dx, y: p.y + d.dy } : p;
        });
      }
      const movedIds = seamMoves
        ? [...new Set([...dragIds, ...seamMoves.map((m) => m.id)])]
        : dragIds;
      if (nextPieces !== pieces) {
        pieceDomain.commands.replacePieces(nextPieces);
      }
      const moveAction = movePiecesAction({
        beforePieces,
        afterPieces: nextPieces,
        setPieces: pieceDomain.commands.replacePieces,
        ids: movedIds,
        label: 'Move group',
        finalizePieces: (updated) => {
          const withLocations = placement.updateMultiplePieceLocations(updated, movedIds);
          return adjacencyMode === 'accurate' || movedIds.length > 1
            ? adjacency.rebuildAllAdjacencies(withLocations)
            : adjacency.updateAdjacenciesForPieces(withLocations, movedIds);
        }
      });
      executeInteractionHistoryAction(history, {
        label: 'Move group',
        action: moveAction,
        skipDo: true
      });
    }

    // Structural group changes are mode-gated exactly like piece drops
    // (ADR-013): additive nests the dropped pill inside the hovered group,
    // subtractive un-nests a child group from its parent. Default-mode pill
    // drags are pure moves.
    if (onGroupStructureDrop && isEditMode()) {
      const token = activeActionToken();
      if (token === 'additive') {
        const nestTargetId = dragState.detectNest ? dragOverGroupRef.current : null;
        if (nestTargetId) {
          onGroupStructureDrop({ groupId, targetGroupId: nestTargetId, intent: 'nest' });
        }
      } else if (token === 'subtractive') {
        const group = groups.find((entry) => entry.id === groupId);
        if (group?.parentId) {
          onGroupStructureDrop({ groupId, targetGroupId: null, intent: 'unnest' });
        }
      }
    }

    setIsDragActive(false);
    updateSubtractiveSource(null);
    clearDragOverGroup();
    groupDragStartRef.current = null;
  }, [activeActionToken, adjacency, adjacencyMode, clearDragOverGroup, connectionDomain, dockAnchorFor, getGroupSnapDelta, groupByPieceId, groups, hiddenPieceIds, history, isEditMode, movePiecesAction, onGroupSeedTranslate, onGroupStructureDrop, pieceDomain, pieceHeight, pieceWidth, pieces, piecesById, placement, resolveMovingSet, updateSubtractiveSource]);

  // Node scale (owner rulings 2026-09-27): each selected node grows or
  // shrinks from its own top-left corner — the grid anchor — so a node on an
  // intersection stays on it and every member of a multi-selection keeps its
  // corner. Growth that seals a wired face opens a seam; the scale and any
  // parted neighbors are one undo step.
  const scaleSelectedPieces = useCallback((targetScale) => {
    if (!selectedCount) return;
    const ids = selectedIds;
    const selected = new Set(ids);

    const scaledPieces = pieces.map((piece) => {
      if (!selected.has(piece.id)) return piece;
      const nextScale = clamp(
        typeof targetScale === 'function' ? targetScale(piece.scale ?? 1) : targetScale,
        minScale,
        maxScale,
      );
      return nextScale === (piece.scale ?? 1) ? piece : { ...piece, scale: nextScale };
    });
    if (scaledPieces.every((piece, index) => piece === pieces[index])) return;

    const seamMoves = computeWireSeams({
      wires: connectionDomain.selectors.getAllConnections(),
      pieces: scaledPieces,
      hiddenPieceIds,
      groupByPieceId,
      pieceWidth,
      pieceHeight,
    });
    const seamById = seamMoves ? new Map(seamMoves.map((m) => [m.id, m])) : null;
    const nextPieces = seamById
      ? scaledPieces.map((p) => {
          const d = seamById.get(p.id);
          return d ? { ...p, x: p.x + d.dx, y: p.y + d.dy } : p;
        })
      : scaledPieces;
    const movedIds = seamMoves
      ? [...new Set([...ids, ...seamMoves.map((m) => m.id)])]
      : ids;

    const moveAction = movePiecesAction({
      beforePieces: pieces,
      afterPieces: nextPieces,
      setPieces: pieceDomain.commands.replacePieces,
      ids: movedIds,
      label: 'Scale pieces',
      finalizePieces: (updated) => {
        const withLocations = placement.updateMultiplePieceLocations(updated, movedIds);
        return adjacencyMode === 'accurate' || movedIds.length > 1
          ? adjacency.rebuildAllAdjacencies(withLocations)
          : adjacency.updateAdjacenciesForPieces(withLocations, movedIds);
      }
    });

    executeInteractionHistoryAction(history, { label: 'Scale pieces', action: moveAction });
  }, [
    adjacency,
    adjacencyMode,
    clamp,
    connectionDomain,
    groupByPieceId,
    hiddenPieceIds,
    history,
    maxScale,
    minScale,
    movePiecesAction,
    pieceDomain,
    pieceHeight,
    pieceWidth,
    pieces,
    placement,
    selectedCount,
    selectedIds,
  ]);

  // Escape during a piece or group drag cancels it: Konva ends the drag,
  // and the drag-end handlers see the flag and restore the start.
  const cancelActiveDrag = useCallback(() => {
    if (dragStartRef.current.size === 0 && !groupDragStartRef.current) return false;
    cancelDragRef.current = true;
    const stage = stageRef?.current;
    const dragging = stage?.find?.((node) => node.isDragging?.()) ?? [];
    if (dragging.length === 0) {
      // Nothing is mid-drag in Konva (the gesture already ended): nothing to undo.
      cancelDragRef.current = false;
      return false;
    }
    dragging.forEach((node) => node.stopDrag());
    return true;
  }, [stageRef]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Escape') return;
      if (cancelActiveDrag()) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [cancelActiveDrag]);

  const handleStageMouseLeave = useCallback(() => {
    if (isPanActive()) {
      endPan();
    }
  }, [endPan, isPanActive]);

  const isDraggingPiece = useCallback(() => dragStartRef.current.size > 0, []);

  return {
    handleStageMouseDown,
    handleStageMouseMove,
    handleStageMouseUp,
    handleStageMouseLeave,
    handlePieceDragMove,
    handlePieceDragStart,
    handlePieceDragEnd,
    handleConnectionStart,
    handleGroupPillDragStart,
    handleGroupPillDragMove,
    handleGroupPillDragEnd,
    scaleSelectedPieces,
    cancelActiveDrag,
    isDraggingPiece,
    isDragActive,
    dragOverGroupId,
    subtractiveDragSource,
    placementPreview
  };
}
