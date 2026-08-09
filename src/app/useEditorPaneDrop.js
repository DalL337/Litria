import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveEditorDrop } from './editorDropGeometry';

/**
 * Drag a canvas node into an editor pane (ADR-017 Phase C, node→pane slice).
 *
 * The dragged node is a Konva shape UNDER the DOM drawer overlay — no
 * z-index can lift it above (different rendering worlds), so this hook
 * supplies the missing affordances instead:
 *  - a DOM ghost pill that follows the cursor ABOVE the drawer while the
 *    cursor is over it (imperative DOM, no per-frame React renders)
 *  - a drop-target pane signal for highlight chrome in EditorDrawer
 *  - drop handling that CANCELS the canvas move (the piece snaps home) and
 *    opens the file in the target pane instead
 *
 * It wraps the WorkspaceStage piece-drag handlers rather than touching
 * interactionDomain: the cancel rides the hardened non-finite bail in
 * handlePieceDragEnd (clears drag flags + snapshot without committing —
 * the feedback #20 path), then restores preview positions via
 * previewMovePiece, which writes no history entry.
 *
 * Single-piece drags only; multi-select drags pass through untouched.
 */
export function useEditorPaneDrop({
  piecesById,
  selectedIds,
  selectedCount,
  pieceDomain,
  openForPiece,
  isSplit,
  paneTabIds,
  handlePieceDragStart,
  finalizePieceDragWithSnap
}) {
  // { pieceId, label, restore: [{id, x, y}] } while a single-piece drag runs.
  const dragRef = useRef(null);
  const ghostRef = useRef(null);
  const dropRef = useRef(null);
  const [isPieceDragging, setIsPieceDragging] = useState(false);
  const [dropTargetPane, setDropTargetPane] = useState(null); // 1 | 2 | 'side' | null

  const clearGhost = () => {
    ghostRef.current?.remove();
    ghostRef.current = null;
  };

  const setDrop = useCallback((next) => {
    dropRef.current = next;
    setDropTargetPane((prev) => (prev === next ? prev : next));
  }, []);

  const wrappedPieceDragStart = useCallback((id) => {
    const piece = piecesById.get(id);
    const isMulti = selectedIds.includes(id) && selectedCount > 1;
    // Only single nodes with a real file can drop into a pane.
    dragRef.current = (!isMulti && piece?.filename)
      ? {
        pieceId: id,
        label: piece.label || piece.filename,
        restore: [{ id, x: piece.x, y: piece.y }]
      }
      : null;
    setIsPieceDragging(Boolean(dragRef.current));
    handlePieceDragStart(id);
  }, [handlePieceDragStart, piecesById, selectedCount, selectedIds]);

  const wrappedPieceDragEnd = useCallback((id, x, y) => {
    const drop = dropRef.current;
    const drag = dragRef.current;
    if (drop != null && drag && drag.pieceId === id) {
      // Abort the move through the existing interrupted-drag path (clears
      // isDragActive + the drag snapshot without committing), then put the
      // preview positions back — previewMovePiece writes no history.
      finalizePieceDragWithSnap(id, NaN, NaN);
      drag.restore.forEach((p) => {
        pieceDomain.commands.previewMovePiece({ id: p.id, x: p.x, y: p.y });
      });
      const piece = piecesById.get(id);
      if (piece) {
        // Degenerate guard: sending the file into the side zone when it is
        // already pane 1's only tab would empty pane 1 and collapse — treat
        // it as a plain pane-1 drop (focus) instead.
        const soleMainTab = !isSplit
          && paneTabIds[1].length === 1
          && paneTabIds[1][0] === id;
        const targetPane = drop === 'side' ? (soleMainTab ? 1 : 2) : drop;
        openForPiece(piece, targetPane);
      }
    } else {
      finalizePieceDragWithSnap(id, x, y);
    }
    dragRef.current = null;
    setIsPieceDragging(false);
    setDrop(null);
    clearGhost();
  }, [finalizePieceDragWithSnap, isSplit, openForPiece, paneTabIds, pieceDomain, piecesById, setDrop]);

  // While a candidate drag runs, track the cursor against the drawer rects.
  useEffect(() => {
    if (!isPieceDragging) return undefined;

    const onMove = (event) => {
      const drawerEl = document.querySelector('.editor-drawer.is-open');
      if (!drawerEl) {
        setDrop(null);
        clearGhost();
        return;
      }
      const shells = Array.from(document.querySelectorAll('.editor-monaco-row .editor-monaco-shell'));
      const target = resolveEditorDrop({
        x: event.clientX,
        y: event.clientY,
        drawerRect: drawerEl.getBoundingClientRect(),
        bodyRect: drawerEl.querySelector('.editor-drawer-body')?.getBoundingClientRect() ?? null,
        shellRects: shells.map((el) => el.getBoundingClientRect()),
        isSplit
      });
      setDrop(target?.paneId ?? null);

      if (target) {
        if (!ghostRef.current) {
          const el = document.createElement('div');
          el.className = 'editor-drop-ghost';
          el.textContent = dragRef.current?.label ?? '';
          document.body.appendChild(el);
          ghostRef.current = el;
        }
        ghostRef.current.style.left = `${event.clientX}px`;
        ghostRef.current.style.top = `${event.clientY}px`;
      } else {
        clearGhost();
      }
    };

    window.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      clearGhost();
    };
  }, [isPieceDragging, isSplit, setDrop]);

  return {
    wrappedPieceDragStart,
    wrappedPieceDragEnd,
    dropTargetPane
  };
}
