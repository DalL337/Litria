import { createPieceAction, deletePieceAction } from '../history/actions.js';

export function createPieceDomain({
  history,
  setPieces,
  setNextId,
  getSpawnPosition,
  getNextId,
  setTimeoutFn = (callback, delay) => globalThis.setTimeout(callback, delay)
}) {
  const clearSpawnFlag = (pieceId, delayMs = 180) => {
    setTimeoutFn(() => {
      setPieces((prev) =>
        prev.map((piece) =>
          piece.id === pieceId ? { ...piece, isSpawning: false } : piece
        )
      );
    }, delayMs);
  };

  return {
    commands: {
      createPiece({ filename, label, code = '', workingCode = null, id: preassignedId = null, x: explicitX, y: explicitY }) {
        // Explicit coordinates win (caller already computed the spawn point —
        // e.g. usePieceUiActions, which persists the same coords to SQLite so
        // the DB row and the in-memory piece can't diverge). Otherwise anchor
        // at the viewport center, same as before.
        const hasExplicitPosition = typeof explicitX === 'number' && typeof explicitY === 'number';
        const { x, y } = hasExplicitPosition ? { x: explicitX, y: explicitY } : getSpawnPosition();
        const pieceId = preassignedId != null ? preassignedId : getNextId();

        const newPiece = {
          id: pieceId,
          x,
          y,
          filename,
          label,
          color: null,
          code,
          workingCode: typeof workingCode === 'string' ? workingCode : code,
          scale: 1,
          isSpawning: true,
          adjacentTo: { top: null, right: null, bottom: null, left: null },
          references: []
        };

        history.execute(
          createPieceAction({
            piece: newPiece,
            setPieces
          })
        );

        clearSpawnFlag(pieceId);
        if (preassignedId == null) {
          setNextId((id) => id + 1);
        } else {
          // Advance nextId past the preassigned ID so it stays monotonic
          setNextId((id) => Math.max(id, pieceId + 1));
        }
        return newPiece;
      },
      /** Batch-create multiple pieces in a single state update. Returns the created pieces.
       *  Items may specify a pre-assigned `id` (from SQLite); otherwise the client counter is used. */
      createPiecesBatch(items) {
        if (!Array.isArray(items) || items.length === 0) return [];
        let maxAssignedId = 0;
        const newPieces = items.map((item) => {
          const hasExplicitPosition = typeof item.x === 'number' && typeof item.y === 'number';
          const { x, y } = hasExplicitPosition ? { x: item.x, y: item.y } : getSpawnPosition();
          const pieceId = item.id != null ? item.id : getNextId();
          if (item.id == null) setNextId((id) => id + 1);
          maxAssignedId = Math.max(maxAssignedId, pieceId);
          return {
            id: pieceId,
            x,
            y,
            filename: item.filename,
            label: item.label,
            color: null,
            code: item.code ?? '',
            workingCode: typeof item.workingCode === 'string' ? item.workingCode : (item.code ?? ''),
            scale: 1,
            isSpawning: false,
            adjacentTo: { top: null, right: null, bottom: null, left: null },
            references: []
          };
        });

        // Ensure nextId stays ahead of any SQLite-assigned IDs
        setNextId((id) => Math.max(id, maxAssignedId + 1));
        setPieces((prev) => [...prev, ...newPieces]);
        return newPieces;
      },
      deletePieces({ ids, piecesById, pieces, extraActions }) {
        if (!Array.isArray(ids) || !ids.length) return [];
        history.beginGroup('Delete pieces');
        ids.forEach((id) => {
          const piece = piecesById.get(id);
          if (!piece) return;
          history.execute(
            deletePieceAction({
              piece: { ...piece, index: pieces.findIndex((candidate) => candidate.id === id) },
              setPieces
            })
          );
        });
        // Include any extra actions in the same undo group (e.g. filesystem restore)
        if (Array.isArray(extraActions)) {
          for (const action of extraActions) {
            history.execute(action, { skipDo: true });
          }
        }
        history.endGroup();
        return ids;
      },
      updatePieceFilenames(updates) {
        if (!Array.isArray(updates) || updates.length === 0) return;
        const updatesById = new Map(updates.map((entry) => [entry.pieceId, entry.path]));
        setPieces((prev) => prev.map((piece) => {
          const nextPath = updatesById.get(piece.id);
          return nextPath ? { ...piece, filename: nextPath } : piece;
        }));
      },
      normalizeInvalidCoordinates({ fallbackX = 60, fallbackY = 60 } = {}) {
        setPieces((prev) => {
          const hasInvalid = prev.some((piece) => (
            !Number.isFinite(piece.x) || !Number.isFinite(piece.y)
          ));
          if (!hasInvalid) return prev;
          return prev.map((piece) => ({
            ...piece,
            x: Number.isFinite(piece.x) ? piece.x : fallbackX,
            y: Number.isFinite(piece.y) ? piece.y : fallbackY
          }));
        });
      },
      previewMoveSelectedPieces({ isSelected, deltaX, deltaY }) {
        if (!deltaX && !deltaY) return;
        setPieces((prev) =>
          prev.map((piece) =>
            isSelected(piece.id)
              ? { ...piece, x: piece.x + deltaX, y: piece.y + deltaY }
              : piece
          )
        );
      },
      previewMovePiece({ id, x, y }) {
        setPieces((prev) =>
          prev.map((piece) =>
            piece.id === id ? { ...piece, x, y } : piece
          )
        );
      },
      previewMoveSnapshotPieces({ pieceSnapshot, dx, dy }) {
        if (!dx && !dy) return;
        setPieces((prev) => prev.map((piece) => {
          if (!pieceSnapshot.has(piece.id)) return piece;
          const snapshot = pieceSnapshot.get(piece.id);
          return {
            ...piece,
            x: snapshot.x + dx,
            y: snapshot.y + dy
          };
        }));
      },
      replacePieces(nextPieces) {
        setPieces(nextPieces);
      },
      setPieceColor({ id, color }) {
        if (!id) return;
        setPieces((prev) =>
          prev.map((piece) =>
            piece.id === id ? { ...piece, color: color ?? null } : piece
          )
        );
      },
      /** Set a piece's display label (overrides the filename basename in
       *  getPieceDisplayName). Pass '' / null to clear back to the filename.
       *  In-memory only — persistence is the caller's responsibility. */
      setPieceLabel({ id, label }) {
        if (!id) return;
        const nextLabel = typeof label === 'string' && label.trim() ? label.trim() : null;
        setPieces((prev) =>
          prev.map((piece) =>
            piece.id === id ? { ...piece, label: nextLabel } : piece
          )
        );
      },
      /** Batch reposition pieces. positionMap: Map<pieceId, {x, y}> */
      batchMovePieces(positionMap) {
        if (!positionMap || positionMap.size === 0) return;
        setPieces((prev) =>
          prev.map((piece) => {
            const pos = positionMap.get(piece.id);
            return pos ? { ...piece, x: pos.x, y: pos.y } : piece;
          })
        );
      }
    },
    selectors: {
      getPieceById(piecesById, id) {
        return piecesById.get(id) ?? null;
      },
      listPieces(pieces) {
        return [...pieces];
      }
    }
  };
}
