import { useCallback } from 'react';

import { validateFilename } from '../utils/pieceValidation';
import { getHeaderCommentForFilename } from '../editor/editorHeaders';
import { dbCreatePiece } from '../project/dbStorage.js';
import { isPrimaryModifier } from '../platform/modifierKeys';

export function usePieceUiActions({
  addPiece,
  pieces,
  projectRootPath,
  writeProjectFile,
  bumpScaffoldRefresh,
  pillDomain,
  projectInstanceId,
  selectionDomain,
  setSelectedGroupId,
  setScaffoldFocus,
  piecesById,
  openForPiece,
  openForPieceInOtherPane,
  setIsCreatePieceModalOpen,
  getSpawnPosition
}) {
  const handleOpenCreatePieceModal = useCallback(() => {
    setIsCreatePieceModalOpen(true);
  }, [setIsCreatePieceModalOpen]);

  const handleCloseCreatePieceModal = useCallback(() => {
    setIsCreatePieceModalOpen(false);
  }, [setIsCreatePieceModalOpen]);

  const handleCreatePiece = useCallback(async ({ filename, label }) => {
    const initialCode = getHeaderCommentForFilename(filename) ?? '';
    const rootPath = typeof projectRootPath === 'string' ? projectRootPath.trim() : '';
    const cleanPath = typeof filename === 'string' ? filename.trim() : '';

    // Compute the spawn point once and hand the same coordinates to both the
    // SQLite row and the in-memory piece. The DB row used to hardcode 0,0
    // while the canvas spawned at the viewport center — the node silently
    // teleported to the origin on reload.
    const spawn = typeof getSpawnPosition === 'function' ? getSpawnPosition() : { x: 0, y: 0 };

    if (rootPath && cleanPath) {
      // Write the file to disk first (via the filesystem write manager).
      // A failed write must NOT fall through to piece creation: the old
      // fire-and-forget call left a SQLite row + canvas node pointing at a
      // file that never existed.
      const written = await writeProjectFile(rootPath, cleanPath, initialCode);
      if (written !== true) {
        pillDomain?.commands?.addPill({
          projectId: projectInstanceId,
          message: `Failed to create "${cleanPath}" on disk`,
          severity: 'error'
        });
        setIsCreatePieceModalOpen(false);
        return;
      }
      // Create in SQLite to get the authoritative piece ID
      let dbId = null;
      try {
        dbId = await dbCreatePiece({
          filePath: cleanPath,
          label,
          x: spawn.x,
          y: spawn.y,
          color: null
        });
      } catch (e) {
        console.warn('[piece] dbCreatePiece failed:', e);
      }
      if (dbId == null) {
        // DB insert failed: the file exists on disk but has no authoritative
        // SQLite ID. Do NOT fabricate a client-side ID — it would collide with
        // the next AUTOINCREMENT value SQLite hands out, putting two canvas
        // pieces on the same id. Surface the file via the scaffold tree (it's
        // on disk) and bail; the user can reopen it. Mirrors the abort in
        // useScaffoldActions' dbCreatePiecesBatch path.
        bumpScaffoldRefresh();
        setIsCreatePieceModalOpen(false);
        return;
      }
      // Create the in-memory piece with the SQLite ID and the same coords
      addPiece({
        id: dbId,
        filename: cleanPath,
        label,
        code: initialCode,
        workingCode: initialCode,
        x: spawn.x,
        y: spawn.y
      });
      bumpScaffoldRefresh();
    } else {
      // No rootPath (single-file "open file" mode) — fall back to client ID only
      addPiece({ filename, label, code: initialCode, workingCode: initialCode, x: spawn.x, y: spawn.y });
    }
    setIsCreatePieceModalOpen(false);
  }, [
    addPiece,
    bumpScaffoldRefresh,
    getSpawnPosition,
    pillDomain,
    projectInstanceId,
    projectRootPath,
    setIsCreatePieceModalOpen,
    writeProjectFile
  ]);

  const validateNewPieceFilename = useCallback(
    (filename) => validateFilename(filename, pieces),
    [pieces]
  );

  const handlePieceClick = useCallback((id, e) => {
    const shift = e?.evt?.shiftKey;
    if (shift || isPrimaryModifier(e)) {
      selectionDomain.commands.toggle(id);
    } else {
      selectionDomain.commands.select(id);
    }
    setSelectedGroupId(null);
    setScaffoldFocus(null);
  }, [selectionDomain, setScaffoldFocus, setSelectedGroupId]);

  const handlePieceDoubleClick = useCallback((id, e) => {
    const piece = piecesById.get(id);
    if (!piece) return;
    selectionDomain.commands.select(id);
    // Shift+double-click = open in the OTHER pane (ADR-017 Phase B entry
    // point): splits when single-pane, sends across when already split.
    // Shift is the only free chord on a node — Ctrl+mousedown starts a wire
    // drag before dblclick can fire, and Alt is the ADR-013 subtractive
    // token (plus the Windows menu-focus hazard). The shift-click selection
    // toggles en route are neutralized by the explicit select() above.
    if (e?.evt?.shiftKey && typeof openForPieceInOtherPane === 'function') {
      openForPieceInOtherPane(piece);
      return;
    }
    openForPiece(piece);
  }, [openForPiece, openForPieceInOtherPane, piecesById, selectionDomain]);

  return {
    handleOpenCreatePieceModal,
    handleCloseCreatePieceModal,
    handleCreatePiece,
    validateNewPieceFilename,
    handlePieceClick,
    handlePieceDoubleClick
  };
}
