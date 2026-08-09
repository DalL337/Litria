import { useCallback, useRef } from 'react';

import { computeCenterOnPiece, computeHomeViewport, animateViewport } from '../utils/viewportNavigation';
import { buildBoundsForPieces, buildBoundsForPieceIds } from './selectors/workspaceSelectors';

/**
 * useViewportNavigation — owns the user-initiated viewport-motion handlers
 * App.jsx used to declare inline. Extracted in Session 4 Group M of the
 * app-shell extraction refactor; the fit/reset family joined in the Tier 1
 * debt cleanup (they were previously duplicated five ways across the menu
 * callbacks, the status bar, and the Ctrl+0 / Ctrl+Shift+0 shortcuts).
 *
 * Pure consolidation: every handler is a verbatim move from App.jsx.
 * The internal `cancelAnimRef` lives here because it's only consumed by
 * handleNavigateToPiece and handleNavigateHome (it cancels an in-flight
 * animation when a new one starts, so animations don't stack).
 *
 * The fit/reset handlers read their inputs (visible pieces, selection,
 * desk size) from a per-render ref so the returned callbacks are stable —
 * useGlobalShortcuts attaches them to a mount-once window listener and
 * must see fresh values at event time, not mount-time closures.
 *
 * PIECE_WIDTH / PIECE_HEIGHT are passed in (rather than imported from
 * src/components/PuzzlePiece) so this hook stays inside the domain
 * layer per the architecture guard.
 */
export function useViewportNavigation({
  viewport,
  deskWidth,
  deskHeight,
  setActiveTab,
  visiblePieces,
  selectedIds,
  piecesById,
  PIECE_WIDTH,
  PIECE_HEIGHT,
}) {
  const cancelAnimRef = useRef(null);

  const fitInputsRef = useRef({});
  fitInputsRef.current = {
    visiblePieces,
    selectedIds,
    piecesById,
    deskWidth,
    deskHeight,
    fitToBounds: viewport.fitToBounds,
  };

  const handleFitContent = useCallback(() => {
    const { visiblePieces: vp, deskWidth: dw, deskHeight: dh, fitToBounds: fit } = fitInputsRef.current;
    fit(buildBoundsForPieces(vp, PIECE_WIDTH, PIECE_HEIGHT), dw, dh);
  }, [PIECE_WIDTH, PIECE_HEIGHT]);

  const handleFitSelection = useCallback(() => {
    const { selectedIds: sIds, piecesById: pById, visiblePieces: vp,
            deskWidth: dw, deskHeight: dh, fitToBounds: fit } = fitInputsRef.current;
    const bounds = sIds.length
      ? buildBoundsForPieceIds(sIds, pById, PIECE_WIDTH, PIECE_HEIGHT)
      : buildBoundsForPieces(vp, PIECE_WIDTH, PIECE_HEIGHT);
    fit(bounds, dw, dh);
  }, [PIECE_WIDTH, PIECE_HEIGHT]);

  const handleResetView = useCallback(() => {
    const { visiblePieces: vp, deskWidth: dw, deskHeight: dh, fitToBounds: fit } = fitInputsRef.current;
    if (vp && vp.length > 0) {
      fit(buildBoundsForPieces(vp, PIECE_WIDTH, PIECE_HEIGHT), dw, dh);
    } else {
      fit(null);
    }
  }, [PIECE_WIDTH, PIECE_HEIGHT]);

  const handleStatusBarZoomChange = useCallback((newScale) => {
    viewport.setScale(newScale);
  }, [viewport.setScale]);

  const handleNavigateToPiece = useCallback((piece) => {
    if (cancelAnimRef.current) cancelAnimRef.current();
    const from = { scale: viewport.scale, offsetX: viewport.offsetX, offsetY: viewport.offsetY };
    const to = computeCenterOnPiece(piece, deskWidth, deskHeight, PIECE_WIDTH, PIECE_HEIGHT, 0.85);
    cancelAnimRef.current = animateViewport({
      from, to, duration: 300,
      setScale: viewport.setScale,
      setOffsetX: viewport.setOffsetX,
      setOffsetY: viewport.setOffsetY
    });
  }, [deskWidth, deskHeight, viewport.scale, viewport.offsetX, viewport.offsetY, viewport.setScale, viewport.setOffsetX, viewport.setOffsetY]);

  const handleNavigateHome = useCallback(() => {
    if (cancelAnimRef.current) cancelAnimRef.current();
    const from = { scale: viewport.scale, offsetX: viewport.offsetX, offsetY: viewport.offsetY };
    const to = computeHomeViewport(deskWidth, deskHeight);
    cancelAnimRef.current = animateViewport({
      from, to, duration: 300,
      setScale: viewport.setScale,
      setOffsetX: viewport.setOffsetX,
      setOffsetY: viewport.setOffsetY
    });
  }, [deskWidth, deskHeight, viewport.scale, viewport.offsetX, viewport.offsetY, viewport.setScale, viewport.setOffsetX, viewport.setOffsetY]);

  const handleStatusBarSelectDirtyTab = useCallback((tabId) => {
    setActiveTab?.(tabId);
  }, [setActiveTab]);

  return {
    handleStatusBarZoomChange,
    handleNavigateToPiece,
    handleNavigateHome,
    handleStatusBarSelectDirtyTab,
    handleFitContent,
    handleFitSelection,
    handleResetView,
  };
}
