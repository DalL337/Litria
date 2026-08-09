// useConnectionDrag.js
// Handles Shift + Right-click drag to create connections between pieces
//
// Flow:
// 1. User Shift+right-clicks on a piece and starts dragging
// 2. Drag direction determines which side the tab comes FROM
// 3. While dragging, a temporary line shows the pending connection
// 4. Edge detection shows which edge the connection will attach TO (with glow)
// 5. Dropping on another piece completes the connection
// 6. Dropping on empty space cancels

import { useState, useCallback } from 'react';
import { PIECE_WIDTH, PIECE_HEIGHT } from '../components/PuzzlePiece';

// ============================================
// EDGE DETECTION CONFIG
// ============================================

// How much of the piece (from each side) counts as that edge's zone
// 0.25 = 25% from each edge, leaving 50% center dead zone
const EDGE_ZONE_RATIO = 0.25;

function useConnectionDrag() {
  // State for the drag operation
  const [isDragging, setIsDragging] = useState(false);
  const [dragState, setDragState] = useState(null);
  // {
  //   sourcePieceId: number,
  //   startX: number,        // Where the drag started (piece center)
  //   startY: number,
  //   currentX: number,      // Current mouse position
  //   currentY: number,
  //   sourceSide: string,    // 'top', 'right', 'bottom', 'left' (determined by drag direction)
  //   sourcePiece: object    // Reference to the source piece for position calculations
  // }

  // State for hover target (which piece/edge we're over)
  const [hoverTarget, setHoverTarget] = useState(null);
  // {
  //   pieceId: number,
  //   piece: object,
  //   edge: string          // 'top', 'right', 'bottom', 'left', or null if in center
  // }

  // Threshold before we determine source direction (pixels)
  const DIRECTION_THRESHOLD = 15;

  // ============================================
  // EDGE DETECTION HELPERS
  // ============================================

  /**
   * Detect which edge of a piece the cursor is over
   * Uses edge zones (25% from each side) for precise detection
   * Handles corners by picking the closer edge
   */
  const detectEdge = useCallback((cursorX, cursorY, piece) => {
    if (!piece) return null;

    // Get cursor position relative to the piece's top-left corner
    const relativeX = cursorX - piece.x;
    const relativeY = cursorY - piece.y;

    // Check if cursor is even inside the piece bounds
    if (relativeX < 0 || relativeX > PIECE_WIDTH || 
        relativeY < 0 || relativeY > PIECE_HEIGHT) {
      return null;
    }

    // Calculate edge zone thresholds
    const leftThreshold = PIECE_WIDTH * EDGE_ZONE_RATIO;
    const rightThreshold = PIECE_WIDTH * (1 - EDGE_ZONE_RATIO);
    const topThreshold = PIECE_HEIGHT * EDGE_ZONE_RATIO;
    const bottomThreshold = PIECE_HEIGHT * (1 - EDGE_ZONE_RATIO);

    // Determine which zone(s) the cursor is in
    const inLeftZone = relativeX < leftThreshold;
    const inRightZone = relativeX > rightThreshold;
    const inTopZone = relativeY < topThreshold;
    const inBottomZone = relativeY > bottomThreshold;

    // Handle corners - pick the edge the cursor is closest to
    if ((inLeftZone || inRightZone) && (inTopZone || inBottomZone)) {
      const distToLeft = relativeX;
      const distToRight = PIECE_WIDTH - relativeX;
      const distToTop = relativeY;
      const distToBottom = PIECE_HEIGHT - relativeY;

      const horizontalDist = inLeftZone ? distToLeft : distToRight;
      const verticalDist = inTopZone ? distToTop : distToBottom;

      if (horizontalDist < verticalDist) {
        return inLeftZone ? 'left' : 'right';
      } else {
        return inTopZone ? 'top' : 'bottom';
      }
    }

    // Single edge zones (not in a corner)
    if (inLeftZone) return 'left';
    if (inRightZone) return 'right';
    if (inTopZone) return 'top';
    if (inBottomZone) return 'bottom';

    // Cursor is in the center dead zone - no edge detected
    return null;
  }, []);

  // ============================================
  // GENERAL HELPERS
  // ============================================

  // Determine which side of the SOURCE piece based on drag direction from center
  const getSideFromDirection = useCallback((startX, startY, currentX, currentY) => {
    const deltaX = currentX - startX;
    const deltaY = currentY - startY;

    // Not enough movement yet
    if (Math.abs(deltaX) < DIRECTION_THRESHOLD && Math.abs(deltaY) < DIRECTION_THRESHOLD) {
      return null;
    }

    // Determine primary direction
    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      return deltaX > 0 ? 'right' : 'left';
    } else {
      return deltaY > 0 ? 'bottom' : 'top';
    }
  }, []);

  // Get the edge point of a piece for a given side (for drawing the line)
  const getEdgePoint = useCallback((piece, side) => {
    const centerX = piece.x + PIECE_WIDTH / 2;
    const centerY = piece.y + PIECE_HEIGHT / 2;

    switch (side) {
      case 'right':
        return { x: piece.x + PIECE_WIDTH, y: centerY };
      case 'left':
        return { x: piece.x, y: centerY };
      case 'top':
        return { x: centerX, y: piece.y };
      case 'bottom':
        return { x: centerX, y: piece.y + PIECE_HEIGHT };
      default:
        return { x: centerX, y: centerY };
    }
  }, []);

  // Get the opposite side
  const getOppositeSide = useCallback((side) => {
    const opposites = {
      left: 'right',
      right: 'left',
      top: 'bottom',
      bottom: 'top'
    };
    return opposites[side] || 'left';
  }, []);

  // Check if a point is inside a piece
  const isPointInPiece = useCallback((x, y, piece) => {
    return (
      x >= piece.x &&
      x <= piece.x + PIECE_WIDTH &&
      y >= piece.y &&
      y <= piece.y + PIECE_HEIGHT
    );
  }, []);

  // Find which piece (if any) is under a point
  const findPieceAtPoint = useCallback((x, y, pieces, excludeId = null) => {
    // Search in reverse order (top pieces first, assuming later = higher z-index)
    for (let i = pieces.length - 1; i >= 0; i--) {
      const piece = pieces[i];
      if (piece.id === excludeId) continue;
      if (isPointInPiece(x, y, piece)) {
        return piece;
      }
    }
    return null;
  }, [isPointInPiece]);

  // ============================================
  // ACTIONS
  // ============================================

  // Start a connection drag
  const startDrag = useCallback((piece, mouseX, mouseY) => {
    const centerX = piece.x + PIECE_WIDTH / 2;
    const centerY = piece.y + PIECE_HEIGHT / 2;

    setIsDragging(true);
    setDragState({
      sourcePieceId: piece.id,
      startX: centerX,
      startY: centerY,
      currentX: mouseX,
      currentY: mouseY,
      sourceSide: null,
      sourcePiece: piece
    });
    setHoverTarget(null);
  }, []);

  // Update drag position and hover target
  const updateDrag = useCallback((mouseX, mouseY, pieces = []) => {
    if (!isDragging || !dragState) return;

    // Update drag state
    setDragState(prev => {
      let sourceSide = prev.sourceSide;
      if (!sourceSide) {
        sourceSide = getSideFromDirection(prev.startX, prev.startY, mouseX, mouseY);
      }

      return {
        ...prev,
        currentX: mouseX,
        currentY: mouseY,
        sourceSide
      };
    });

    // Update hover target using edge detection
    const targetPiece = findPieceAtPoint(mouseX, mouseY, pieces, dragState.sourcePieceId);
    
    if (targetPiece) {
      const edge = detectEdge(mouseX, mouseY, targetPiece);
      setHoverTarget({
        pieceId: targetPiece.id,
        piece: targetPiece,
        edge  // Could be null if cursor is in center dead zone
      });
    } else {
      setHoverTarget(null);
    }
  }, [isDragging, dragState, getSideFromDirection, findPieceAtPoint, detectEdge]);

  // End the drag - returns connection info if valid, null if cancelled
  const endDrag = useCallback((mouseX, mouseY, pieces) => {
    if (!isDragging || !dragState) {
      setIsDragging(false);
      setDragState(null);
      setHoverTarget(null);
      return null;
    }

    const { sourcePieceId, sourceSide } = dragState;

    // Must have determined a source side
    if (!sourceSide) {
      setIsDragging(false);
      setDragState(null);
      setHoverTarget(null);
      return null;
    }

    // Find target piece under mouse
    const targetPiece = findPieceAtPoint(mouseX, mouseY, pieces, sourcePieceId);

    if (!targetPiece) {
      // Dropped on empty space — no piece target. Return a MISS descriptor
      // (not null) carrying the drag's source info so the caller can route
      // drops on non-piece targets (collapsed-group pills, S4) — the caller
      // treats anything with `miss` as "no connection to create".
      setIsDragging(false);
      setDragState(null);
      setHoverTarget(null);
      return { miss: true, sourceId: sourcePieceId, sourceSide };
    }

    // Use edge detection for precise target side
    const targetSide = detectEdge(mouseX, mouseY, targetPiece);

    // If cursor is in center dead zone, fall back to closest edge
    const finalTargetSide = targetSide || getFallbackSide(mouseX, mouseY, targetPiece);

    // Clean up state
    setIsDragging(false);
    setDragState(null);
    setHoverTarget(null);

    // Return connection info
    return {
      sourceId: sourcePieceId,
      sourceSide: sourceSide,
      targetId: targetPiece.id,
      targetSide: finalTargetSide
    };
  }, [isDragging, dragState, findPieceAtPoint, detectEdge]);

  // Fallback: if cursor is in center, pick closest edge (old behavior)
  const getFallbackSide = useCallback((mouseX, mouseY, piece) => {
    const centerX = piece.x + PIECE_WIDTH / 2;
    const centerY = piece.y + PIECE_HEIGHT / 2;
    
    const deltaX = mouseX - centerX;
    const deltaY = mouseY - centerY;

    if (Math.abs(deltaX) > Math.abs(deltaY)) {
      return deltaX > 0 ? 'right' : 'left';
    } else {
      return deltaY > 0 ? 'bottom' : 'top';
    }
  }, []);

  // Cancel drag without creating connection
  const cancelDrag = useCallback(() => {
    setIsDragging(false);
    setDragState(null);
    setHoverTarget(null);
  }, []);

  // ============================================
  // RENDER HELPERS
  // ============================================

  // Get line coordinates for rendering the drag line
  const getDragLine = useCallback(() => {
    if (!isDragging || !dragState) return null;

    const { sourcePiece, sourceSide, currentX, currentY } = dragState;

    // If side isn't determined yet, draw from center
    if (!sourceSide) {
      return {
        startX: dragState.startX,
        startY: dragState.startY,
        endX: currentX,
        endY: currentY
      };
    }

    // Draw from the edge of the piece
    const edgePoint = getEdgePoint(sourcePiece, sourceSide);
    return {
      startX: edgePoint.x,
      startY: edgePoint.y,
      endX: currentX,
      endY: currentY
    };
  }, [isDragging, dragState, getEdgePoint]);

  // Get hover target info (for rendering edge glow)
  const getHoverTarget = useCallback(() => {
    return hoverTarget;
  }, [hoverTarget]);

  return {
    // State
    isDragging,
    dragState,
    hoverTarget,

    // Actions
    startDrag,
    updateDrag,
    endDrag,
    cancelDrag,

    // Render helpers
    getDragLine,
    getHoverTarget,

    // Utilities (exposed for flexibility)
    findPieceAtPoint,
    getOppositeSide,
    getEdgePoint,
    detectEdge
  };
}

export default useConnectionDrag;