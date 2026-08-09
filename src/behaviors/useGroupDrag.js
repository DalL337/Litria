// useGroupDrag.js
// Handles dragging multiple selected pieces as a group
// Pure logic - works with any selection system

import { useState, useCallback } from 'react';

function useGroupDrag() {
  const [dragStart, setDragStart] = useState(null);

  // Call when starting to drag a piece that's part of a selection
  const startGroupDrag = useCallback((pieceX, pieceY) => {
    setDragStart({ x: pieceX, y: pieceY });
  }, []);

  // Calculate how far we've moved from drag start
  const getDelta = useCallback((currentX, currentY) => {
    if (!dragStart) return { deltaX: 0, deltaY: 0 };
    
    return {
      deltaX: currentX - dragStart.x,
      deltaY: currentY - dragStart.y
    };
  }, [dragStart]);

  // End the drag operation
  const endGroupDrag = useCallback(() => {
    setDragStart(null);
  }, []);

  // Helper: Apply delta to an array of pieces
  // Returns NEW array with updated positions (doesn't mutate)
  const applyDeltaToPieces = useCallback((pieces, selectedIds, deltaX, deltaY) => {
    return pieces.map(piece => 
      selectedIds.includes(piece.id)
        ? { ...piece, x: piece.x + deltaX, y: piece.y + deltaY }
        : piece
    );
  }, []);

  // Helper: Check if a piece is being dragged as part of a group
  const isDraggingGroup = dragStart !== null;

  return {
    // State
    dragStart,
    isDraggingGroup,
    
    // Actions
    startGroupDrag,
    getDelta,
    endGroupDrag,
    
    // Helpers
    applyDeltaToPieces
  };
}

export default useGroupDrag;