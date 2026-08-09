// useLassoSelection.js
// Handles lasso/marquee box selection behavior
// Pure logic - no visual rendering

import { useState, useCallback, useEffect } from 'react';
import { PIECE_WIDTH, PIECE_HEIGHT } from '../components/PuzzlePiece';

function useLassoSelection() {
  const [selectionBox, setSelectionBox] = useState(null);
  const [isSelecting, setIsSelecting] = useState(false);

  // Start a new lasso selection at given position
  const startLasso = useCallback((x, y) => {
    setIsSelecting(true);
    setSelectionBox({
      x: x,
      y: y,
      width: 0,
      height: 0,
      startX: x,
      startY: y
    });
  }, []);

  // Update lasso box as mouse moves
  const updateLasso = useCallback((x, y) => {
    if (!isSelecting) return;
    
    setSelectionBox(prev => {
      if (!prev) return null;
      
      const x1 = prev.startX;
      const y1 = prev.startY;
      const x2 = x;
      const y2 = y;
      
      return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
        startX: x1,
        startY: y1
      };
    });
  }, [isSelecting]);

  // End lasso selection and return final box
  const endLasso = useCallback(() => {
    setIsSelecting(false);
    const finalBox = selectionBox;
    setSelectionBox(null);
    return finalBox;
  }, [selectionBox]);

  // Cancel lasso without selecting
  const cancelLasso = useCallback(() => {
    setIsSelecting(false);
    setSelectionBox(null);
  }, []);

  // Failsafe: the stage only sees mouseup while the pointer is over it. A
  // marquee released over a DOM overlay (drawers/HUD keep pointer-events
  // during a lasso — app-dragging only drops them for piece/group drags) or
  // released off-window strands isSelecting, so the box keeps stretching on
  // mousemove with no button held and the next canvas mouseup commits a
  // surprise selection (PRD-GNM-001 §10.3). Cancel on any window-level
  // release or focus loss. window mouseup fires in the SAME bubble dispatch
  // as the stage's own mouseup handler, after it — an in-stage release
  // commits its selection first and this cancel is a no-op.
  useEffect(() => {
    if (!isSelecting) return undefined;
    window.addEventListener('mouseup', cancelLasso);
    window.addEventListener('pointercancel', cancelLasso);
    window.addEventListener('blur', cancelLasso);
    return () => {
      window.removeEventListener('mouseup', cancelLasso);
      window.removeEventListener('pointercancel', cancelLasso);
      window.removeEventListener('blur', cancelLasso);
    };
  }, [isSelecting, cancelLasso]);

  // Helper: Find items within the selection box
  // Pass in array of items with {id, x, y}
  // Optional overrides for item dimensions if needed
  const getItemsInBox = useCallback((items, itemWidth = PIECE_WIDTH, itemHeight = PIECE_HEIGHT) => {
    if (!selectionBox || selectionBox.width < 5 || selectionBox.height < 5) {
      return [];
    }

    return items.filter(item => {
      return (
        item.x >= selectionBox.x &&
        item.x + itemWidth <= selectionBox.x + selectionBox.width &&
        item.y >= selectionBox.y &&
        item.y + itemHeight <= selectionBox.y + selectionBox.height
      );
    });
  }, [selectionBox]);

  return {
    // State
    selectionBox,
    isSelecting,
    
    // Actions
    startLasso,
    updateLasso,
    endLasso,
    cancelLasso,
    
    // Helpers
    getItemsInBox,
    
    // Quick check
    hasActiveBox: selectionBox !== null && selectionBox.width > 5 && selectionBox.height > 5
  };
}

export default useLassoSelection;