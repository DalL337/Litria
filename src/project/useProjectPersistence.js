import { useCallback, useEffect, useRef } from 'react';
import {
  dbSaveEditorState,
  dbSaveViewport,
  dbUpdatePiece,
  dbBatchMovePieces,
  dbCreateConnection
} from './dbStorage.js';
import { normalizePath } from '../utils/path.js';
import { buildPiecesByFolder, deriveGroupPieceIds } from '../utils/groupFolders.js';
import {
  diffPositions,
  mergeIntoPending,
  computeFlushDelay,
  flushPositionOutbox
} from './positionOutbox.js';
// ADR-026 decision 3: a read-only workspace hydrates and navigates normally
// but every write below is skipped (canPersist), so no failure is generated
// for the pill to report twice.
import { canPersist } from './persistenceNotices.js';
import { emitPersistenceWriteFailure } from './persistenceFailures.js';
import { getWorkspaceEpoch } from './dbStorage.js';
import {
  applySavedPieceBaseline,
  noSaveTargetOutcome,
  resolveSaveOutcome
} from './saveOutcome.js';

/**
 * useProjectPersistence — hydrates canvas state from the SQLite workspace DB
 * attached to `projectInstance._dbState` and persists granular state changes
 * back to the DB via Tauri commands.
 *
 * Hydration: reads `projectInstance._dbState` (populated by db_open_project /
 * db_bootstrap_project) and feeds it into piece/group/connection/viewport state.
 * No JSON manifest involvement at all.
 *
 * Persistence: debounced viewport + editor state writes. Piece/group mutations
 * are persisted by the consumer hooks (usePieceUiActions, useGroupMenuActions,
 * filesystemWriteManager, etc.) via direct dbStorage calls.
 */
export function useProjectPersistence({
  projectInstance,
  pieces,
  setPieces,
  piecesById,
  setGroups,
  setNextGroupId,
  setNextId,
  setHiddenScaffoldPaths,
  rebuildAllAdjacencies,
  openTabIds,
  activeTabId,
  // Value-stable JSON map of pieceId → paneId (EditorSessionContext derives
  // it via serializeTabPaneAssignments) — ADR-017 Phase B pane persistence.
  tabPaneAssignments,
  // Divider position (ADR-017 Phase C) — committed once per drag release.
  paneSplitRatio,
  setPaneSplitRatio,
  openFromSnapshot,
  closeTab,
  configurePersistence,
  setProjectInstanceId,
  projectDomain,
  viewportScale,
  viewportOffsetX,
  viewportOffsetY,
  setViewportScale,
  setViewportOffsetX,
  setViewportOffsetY,
  setConnections,
  setNextConnectionIdValue,
  // Manager-backed content writer (useManagerFileWriter): tab saves route
  // through the filesystem write manager like every other project write.
  writeProjectFile,
  // Launcher "New File" flow: non-null only while the session is untitled
  // (useUntitledSaveAs pre-gates it) — editor saves then route through this
  // Save As resolver instead of onSaveTab.
  resolveUntitledSave = null
}) {
  const snapshotTimerRef = useRef(null);
  const viewportTimerRef = useRef(null);
  const hasLoadedPiecesRef = useRef(false);
  // ADR-032 D1: the workspace the pending moves belong to, captured when the
  // outbox starts filling. The flush runs from an effect cleanup, after the
  // NEXT project has opened, so it cannot ask which workspace is current.
  const pendingEpochRef = useRef(null);
  const hasRestoredEditorSessionRef = useRef(false);

  const normalizeId = useCallback((value) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return value;
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? numeric : trimmed;
    }
    return value;
  }, []);
  const sameId = useCallback((left, right) => normalizeId(left) === normalizeId(right), [normalizeId]);

  // State follows disk: capture one snapshot, attempt the write, and advance
  // the piece baseline only after explicit success. The live workingCode is
  // preserved so keystrokes made while the write is in flight remain dirty.
  const persistSavedTab = useCallback(async (tab) => {
    if (!tab) return false;
    const savedCode = typeof tab.workingCode === 'string' ? tab.workingCode : '';
    const rootPath = projectInstance?.rootPath;
    const normalizedPieceId = normalizeId(tab.pieceId);
    const relativePath = piecesById.get(tab.pieceId)?.filename
      ?? piecesById.get(normalizedPieceId)?.filename
      ?? tab.filename;

    if (!rootPath || !relativePath) {
      const outcome = noSaveTargetOutcome(relativePath);
      console.warn('[persistence] tab disk write failed:', outcome.failure.error);
      emitPersistenceWriteFailure(outcome.failure);
      return false;
    }

    let outcome;
    try {
      projectDomain.commands.clearLastStorageError?.();
      const managerResult = await writeProjectFile(rootPath, relativePath, savedCode);
      outcome = resolveSaveOutcome({
        managerResult,
        relativePath,
        storageError: projectDomain.commands.getLastStorageError?.() ?? null
      });
    } catch (error) {
      outcome = resolveSaveOutcome({ thrownError: error, relativePath });
    }

    if (!outcome.saved) {
      console.warn('[persistence] tab disk write failed:', relativePath, outcome.failure.error);
      emitPersistenceWriteFailure(outcome.failure);
      return false;
    }

    setPieces((prev) => applySavedPieceBaseline(prev, tab.pieceId, savedCode, sameId));
    return true;
  }, [normalizeId, piecesById, projectDomain.commands, projectInstance?.rootPath, sameId, setPieces, writeProjectFile]);

  const persistSavedTabs = useCallback(async (tabs) => {
    if (!tabs?.length) return [];
    const results = [];
    for (const tab of tabs) {
      const savedCode = typeof tab?.workingCode === 'string' ? tab.workingCode : '';
      const saved = await persistSavedTab(tab);
      results.push({ tabId: tab.id, saved, savedCode });
    }
    return results;
  }, [persistSavedTab]);

  useEffect(() => {
    configurePersistence({
      onSaveTab: persistSavedTab,
      onSaveAllTabs: persistSavedTabs,
      // Only present while untitled — once the first Save As materializes the
      // root, this reconfigures to null and saves take the normal path above.
      onResolveUntitledSave: resolveUntitledSave,
      onWorkingCodeChange: (tab, workingCode) => {
        setPieces((prev) => (
          prev.map((piece) => (
            sameId(piece.id, tab.pieceId)
              ? { ...piece, workingCode }
              : piece
          ))
        ));
      }
    });
  }, [configurePersistence, persistSavedTab, persistSavedTabs, resolveUntitledSave, sameId, setPieces]);

  useEffect(() => {
    setProjectInstanceId(projectInstance?.instanceId ?? null);
    hasRestoredEditorSessionRef.current = false;
  }, [projectInstance?.instanceId, setProjectInstanceId]);

  // ─── Hydration from SQLite ProjectState ──────────────────────────────────
  useEffect(() => {
    if (!projectInstance?.rootPath || !projectInstance?.instanceId) return;
    // Single-file "Open File" flow: no workspace DB attached, nothing to load
    if (projectInstance.manifestPath === null) {
      hasLoadedPiecesRef.current = true;
      return;
    }

    hasLoadedPiecesRef.current = false;
    let isMounted = true;

    const dbState = projectInstance._dbState;
    if (!dbState) {
      // No pre-loaded state — nothing to hydrate (should not happen in normal flow)
      hasLoadedPiecesRef.current = true;
      return;
    }

    const hydratedPieces = (dbState.pieces || []).map((p) => ({
      id: p.id,
      x: p.x,
      y: p.y,
      filename: p.filePath,
      label: p.label,
      color: p.color || null,
      code: '',
      workingCode: '',
      scale: p.scale || 1,
      adjacentTo: { top: null, right: null, bottom: null, left: null },
      references: [],
      isSpawning: false,
      isHidden: p.isHidden || false
    }));

    // Group membership is folder-derived: a folder-backed group's members are the
    // pieces whose files live in its folder (the same source of truth the runtime
    // folder=group reconciliation uses, via the shared buildPiecesByFolder). This
    // stops a stale/incomplete group_pieces row from resurrecting an old
    // membership on reopen. The group_pieces cache is read only as a fallback for
    // any group without a folderPath ("manual" groups). See src/utils/groupFolders.js.
    const membershipByGroup = new Map();
    for (const gp of (dbState.groupPieces || [])) {
      if (!membershipByGroup.has(gp.groupId)) {
        membershipByGroup.set(gp.groupId, []);
      }
      membershipByGroup.get(gp.groupId).push(gp.pieceId);
    }

    const piecesByFolder = buildPiecesByFolder(hydratedPieces, normalizePath);

    const hydratedGroups = (dbState.groups || []).map((g) => {
      const folderDerived = deriveGroupPieceIds(g, piecesByFolder, normalizePath);
      // Seed geometry for memberless manual groups (ADR-018 box-first) —
      // only meaningful when all four columns are present.
      const seedBounds = [g.seedX, g.seedY, g.seedW, g.seedH].every(Number.isFinite)
        ? { x: g.seedX, y: g.seedY, width: g.seedW, height: g.seedH }
        : null;
      return {
        id: g.id,
        name: g.name,
        pieceIds: folderDerived ?? (membershipByGroup.get(g.id) || []),
        isCollapsed: g.isCollapsed ?? true,
        folderPath: g.folderPath || null,
        parentId: g.parentId || null,
        themeId: g.themeId || null,
        color: g.color || null,
        seedBounds
      };
    });

    // Canvas connections are NOT restored here — discovery is the sole creator on
    // load (imports-authoritative; see project_discovery_canvas_sync). It re-derives
    // each edge from the imports and anchors it, consulting the PERSISTED sides
    // (dbState.connections, built into a per-pair map in App.jsx) as an override,
    // falling back to geometry. Restoring connections here too would double-create
    // them and starve discovery's syntax-edge link (dedup skips handleConnect).
    //
    // But we MUST clear the previous project's connections: piece ids are
    // per-project autoincrement (they overlap across projects), so a stale
    // connection referencing e.g. (3,5) would render as a GHOST wire between the
    // new project's pieces 3 and 5. Discovery rebuilds this project's edges from
    // scratch below, so clearing first is safe and leaves exactly one set.
    setConnections([]);

    const withAdjacency = typeof rebuildAllAdjacencies === 'function'
      ? rebuildAllAdjacencies(hydratedPieces)
      : hydratedPieces;

    const nextId = withAdjacency.reduce((max, p) =>
      Number.isFinite(p.id) ? Math.max(max, p.id) : max, 0) + 1;
    const nextGroupId = hydratedGroups.reduce((max, g) => {
      const match = typeof g.id === 'string' ? g.id.match(/\d+/) : null;
      return match ? Math.max(max, parseInt(match[0], 10)) : max;
    }, 0) + 1;

    setPieces(withAdjacency);
    setNextId(nextId);
    setGroups(hydratedGroups);
    setNextGroupId(nextGroupId);
    setHiddenScaffoldPaths(dbState.hiddenPaths || []);

    if (dbState.viewport) {
      setViewportScale(dbState.viewport.scale || 1);
      setViewportOffsetX(dbState.viewport.x || 0);
      setViewportOffsetY(dbState.viewport.y || 0);
    }

    // Load file contents from disk asynchronously (file contents are not in DB)
    (async () => {
      const readFile = projectDomain.commands.readFile;
      const updated = [];
      for (const piece of withAdjacency) {
        if (!piece.filename) {
          updated.push(piece);
          continue;
        }
        const diskCode = await readFile(projectInstance.rootPath, piece.filename);
        if (typeof diskCode === 'string') {
          updated.push({ ...piece, code: diskCode, workingCode: diskCode });
        } else {
          updated.push(piece);
        }
      }
      if (isMounted && updated.length) {
        setPieces(updated);
      }
      hasLoadedPiecesRef.current = true;
    })();

    return () => { isMounted = false; };
  }, [
    projectInstance?.instanceId,
    projectInstance?.rootPath,
    projectInstance?._dbState,
    projectInstance?.manifestPath,
    rebuildAllAdjacencies,
    setConnections,
    setNextConnectionIdValue,
    setGroups,
    setHiddenScaffoldPaths,
    setNextGroupId,
    setNextId,
    setPieces,
    projectDomain,
    setViewportScale,
    setViewportOffsetX,
    setViewportOffsetY
  ]);

  // ─── Editor session restoration ──────────────────────────────────────────
  useEffect(() => {
    if (!projectInstance?.rootPath || !projectInstance?.instanceId) return;
    if (projectInstance.manifestPath === null) return;
    if (hasRestoredEditorSessionRef.current) return;
    if (!hasLoadedPiecesRef.current) return;
    hasRestoredEditorSessionRef.current = true;
    let isMounted = true;

    (async () => {
      const dbState = projectInstance._dbState;
      if (!dbState?.editorState) return;

      const es = dbState.editorState;
      const rawOpenIds = es.open_tab_piece_ids
        ? JSON.parse(es.open_tab_piece_ids)
        : [];
      const activeId = es.active_tab_piece_id
        ? Number(es.active_tab_piece_id)
        : null;

      const tabs = rawOpenIds
        .filter((id) => piecesById.has(id))
        .slice(0, 8)
        .map((id) => {
          const piece = piecesById.get(id);
          if (!piece) return null;
          return {
            id: piece.id,
            pieceId: piece.id,
            filename: piece.filename || `piece-${piece.id}.txt`,
            code: piece.code || '',
            workingCode: piece.workingCode || piece.code || ''
          };
        })
        .filter(Boolean);

      if (isMounted && tabs.length) {
        // Third arg = persisted pane residency (ADR-017 Phase B), applied
        // by the editor context — an opaque string here, so this project
        // hook never reaches into the editor domain (architecture boundary).
        openFromSnapshot(tabs, activeId, es.tab_pane_ids);
      }
      if (isMounted && es.pane_split_ratio && typeof setPaneSplitRatio === 'function') {
        // The context's setter clamps/defaults — garbage restores to 50/50.
        setPaneSplitRatio(Number(es.pane_split_ratio));
      }
    })();

    return () => { isMounted = false; };
  }, [
    openFromSnapshot,
    piecesById,
    projectInstance?.instanceId,
    projectInstance?.rootPath,
    projectInstance?.manifestPath,
    projectInstance?._dbState
  ]);

  // ─── Debounced viewport persistence ──────────────────────────────────────
  useEffect(() => {
    if (!canPersist(projectInstance)) return;
    if (!hasLoadedPiecesRef.current) return;

    if (viewportTimerRef.current) {
      clearTimeout(viewportTimerRef.current);
    }
    viewportTimerRef.current = window.setTimeout(async () => {
      try {
        await dbSaveViewport(viewportOffsetX, viewportOffsetY, viewportScale);
      } catch (e) {
        console.warn('[persistence] viewport save failed:', e);
      }
    }, 400);

    return () => {
      if (viewportTimerRef.current) {
        clearTimeout(viewportTimerRef.current);
        viewportTimerRef.current = null;
      }
    };
  }, [
    projectInstance?.instanceId,
    projectInstance?.rootPath,
    projectInstance?.manifestPath,
    projectInstance?.readOnly,
    viewportScale,
    viewportOffsetX,
    viewportOffsetY
  ]);

  // ─── Piece position persistence (outbox + debounced batch write) ─────────
  // Detected moves accumulate in a pending outbox that SURVIVES debounce
  // cancellation — the old shape kept them only inside the setTimeout, so any
  // pieces churn within the window (seam maintenance at drag-end, nudge-at-
  // birth, workingCode commits) cancelled the write with the last-seen map
  // already advanced, and the move was unrecoverable: pieces reverted to
  // stale DB positions on reopen (owner repro 2026-08-02; see
  // src/project/positionOutbox.js). Churn now only delays the flush — capped
  // by POSITION_FLUSH_MAX_WAIT_MS. A failed drain is requeued with newer
  // positions winning and retried with capped exponential backoff.
  const lastPositionsRef = useRef(new Map());
  const pendingMovesRef = useRef(new Map());
  const firstPendingAtRef = useRef(null);
  const positionRetryAttemptRef = useRef(0);
  const positionRetryTimerRef = useRef(null);
  const positionFlushInFlightRef = useRef(null);
  const flushPendingMovesRef = useRef(null);

  const flushPendingMoves = useCallback((options = {}) => {
    const allowRetry = options?.allowRetry !== false;

    if (!allowRetry && positionRetryTimerRef.current !== null) {
      window.clearTimeout(positionRetryTimerRef.current);
      positionRetryTimerRef.current = null;
    }
    if (allowRetry && positionRetryTimerRef.current !== null) {
      return Promise.resolve(false);
    }

    // Serialize writes. Moves detected during an in-flight batch stay pending;
    // after success they flush immediately, and after failure they ride the
    // scheduled retry so backoff cannot be bypassed by render churn.
    if (positionFlushInFlightRef.current) {
      return positionFlushInFlightRef.current.then((saved) => {
        if (!allowRetry && pendingMovesRef.current.size > 0) {
          return flushPendingMovesRef.current?.({ allowRetry: false }) ?? false;
        }
        return saved;
      });
    }

    firstPendingAtRef.current = null;
    const scheduleRetry = (delay) => {
      if (positionRetryTimerRef.current !== null) {
        window.clearTimeout(positionRetryTimerRef.current);
      }
      positionRetryTimerRef.current = window.setTimeout(() => {
        positionRetryTimerRef.current = null;
        void flushPendingMovesRef.current?.();
      }, delay);
    };

    let run;
    const epoch = pendingEpochRef.current;
    run = flushPositionOutbox({
      pending: pendingMovesRef.current,
      writeMoves: (moves) => dbBatchMovePieces(moves, { epoch }),
      attempt: positionRetryAttemptRef.current,
      scheduleRetry: allowRetry ? scheduleRetry : null,
      retainOnFailure: allowRetry
    }).then((result) => {
      positionRetryAttemptRef.current = allowRetry ? result.attempt : 0;
      if (result.error) {
        console.warn('[persistence] piece position write failed:', result.error);
      }
      if (
        result.saved
        && allowRetry
        && pendingMovesRef.current.size > 0
        && positionRetryTimerRef.current === null
      ) {
        scheduleRetry(0);
      }
      return result.saved;
    }).finally(() => {
      if (positionFlushInFlightRef.current === run) {
        positionFlushInFlightRef.current = null;
      }
    });

    positionFlushInFlightRef.current = run;
    return run;
  }, []);
  flushPendingMovesRef.current = flushPendingMoves;

  useEffect(() => {
    if (!canPersist(projectInstance) || !hasLoadedPiecesRef.current) return;

    // First gated run after hydration (or after a project switch reset): the
    // last-seen map is empty, so every piece diffs as "moved" — but those are
    // the positions just LOADED from the DB. Seed the map without scheduling
    // a redundant full write-back.
    const isSeedRun = lastPositionsRef.current.size === 0;
    const { moves, next } = diffPositions(lastPositionsRef.current, pieces);
    lastPositionsRef.current = next;

    if (!isSeedRun && moves.length > 0) {
      if (pendingMovesRef.current.size === 0) {
        firstPendingAtRef.current = Date.now();
        pendingEpochRef.current = getWorkspaceEpoch();
      }
      mergeIntoPending(pendingMovesRef.current, moves);
    }
    if (pendingMovesRef.current.size === 0) return;
    if (positionRetryTimerRef.current !== null) return;

    const delay = computeFlushDelay(firstPendingAtRef.current, Date.now());
    const timer = window.setTimeout(flushPendingMoves, delay);
    // Cleanup cancels only the TIMER; the pending outbox rides to the next run.
    return () => clearTimeout(timer);
  }, [pieces, projectInstance?.instanceId, projectInstance?.rootPath, projectInstance?.manifestPath, projectInstance?.readOnly, flushPendingMoves]);

  // Flush on project switch/unmount and reset the last-seen map so
  // the next project's hydration re-seeds instead of diffing against stale
  // entries (piece ids are per-project autoincrement and overlap).
  //
  // ADR-032 D1: this cleanup runs during the commit that installs the NEW
  // project, i.e. AFTER `dbOpenProject` — so the outgoing project's database
  // is emphatically not the one open here, and before the epoch fence this
  // flush wrote project A's moves into project B. It is left fire-and-forget
  // on purpose: the backend now refuses it as `db.workspace_changed`, which
  // is silent and correct. Whatever the debounce had not yet written is lost,
  // which is the pre-existing behavior for an unflushed outbox.
  useEffect(() => {
    return () => {
      void flushPendingMoves({ allowRetry: false });
      positionRetryAttemptRef.current = 0;
      lastPositionsRef.current = new Map();
    };
  }, [projectInstance?.instanceId, flushPendingMoves]);

  // Last-chance flush when the window is closing: a move made inside the
  // debounce window would otherwise ride down with the process. Fire-and-
  // forget — the invoke races shutdown, which is strictly better than the
  // guaranteed loss without it.
  useEffect(() => {
    const flushFinalPositionBatch = () => {
      void flushPendingMoves({ allowRetry: false });
    };
    window.addEventListener('beforeunload', flushFinalPositionBatch);
    return () => window.removeEventListener('beforeunload', flushFinalPositionBatch);
  }, [flushPendingMoves]);

  // Close tabs for deleted pieces
  useEffect(() => {
    if (!openTabIds.length) return;
    const validIds = new Set(pieces.map((piece) => normalizeId(piece.id)));
    const toClose = openTabIds.filter((tabId) => !validIds.has(normalizeId(tabId)));
    if (!toClose.length) return;
    toClose.forEach((tabId) => closeTab(tabId));
  }, [closeTab, normalizeId, openTabIds, pieces]);

  // ─── Debounced editor state persistence ──────────────────────────────────
  useEffect(() => {
    if (!canPersist(projectInstance)) return;
    if (snapshotTimerRef.current) {
      clearTimeout(snapshotTimerRef.current);
    }
    snapshotTimerRef.current = window.setTimeout(async () => {
      const openIds = openTabIds.slice();
      try {
        await dbSaveEditorState('open_tab_piece_ids', JSON.stringify(openIds));
        await dbSaveEditorState(
          'active_tab_piece_id',
          activeTabId != null ? String(activeTabId) : ''
        );
        await dbSaveEditorState('tab_pane_ids', tabPaneAssignments ?? '');
        await dbSaveEditorState(
          'pane_split_ratio',
          Number.isFinite(paneSplitRatio) ? String(paneSplitRatio) : ''
        );
        await dbSaveEditorState('last_session_at', new Date().toISOString());
      } catch (e) {
        console.warn('[persistence] editor state save failed:', e);
      }
    }, 400);

    return () => {
      if (snapshotTimerRef.current) {
        clearTimeout(snapshotTimerRef.current);
        snapshotTimerRef.current = null;
      }
    };
  }, [
    activeTabId,
    openTabIds,
    tabPaneAssignments,
    paneSplitRatio,
    projectInstance?.instanceId,
    projectInstance?.rootPath,
    projectInstance?.manifestPath,
    projectInstance?.readOnly
  ]);

  // Persist a manually-drawn connection's anchor sides so a reopen restores the
  // user's chosen edges. Discovery re-creates the connection from imports and
  // consults these as a per-pair override (see the hydration note above), so we
  // key on the piece pair, not a connection id. Fire-and-forget; on failure the
  // next load just falls back to geometry. createConnection dedups by direction,
  // so a pair is only drawn — and persisted — once (no duplicate rows).
  const persistConnectionSides = useCallback((connection) => {
    if (!connection) return;
    if (!canPersist(projectInstance)) return;
    const { sourceId, targetId, sourceSide, targetSide, type } = connection;
    if (sourceId == null || targetId == null) return;
    Promise.resolve(
      dbCreateConnection(sourceId, targetId, sourceSide ?? null, targetSide ?? null, type ?? null)
    ).catch((e) => {
      // eslint-disable-next-line no-console
      console.warn('[persistence] persist connection sides failed:', e);
    });
  }, [projectInstance]);

  return { persistConnectionSides };
}
