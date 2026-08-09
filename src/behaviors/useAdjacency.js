// useAdjacency.js
// Tracks adjacency relationships between pieces
// "Who is snapped to my top/right/bottom/left?"
// 
// This is VISUAL organization, not code relationships.
// Code relationships (imports/calls) will be handled by references later.

import { useCallback } from 'react';
import { PIECE_WIDTH, PIECE_HEIGHT } from '../utils/pieceDimensions.js';

function useAdjacency() {
  
  // Determine which direction piece A is relative to piece B
  // Returns: 'left', 'right', 'top', 'bottom', or null
  const getSnapDirection = useCallback((pieceA, pieceB, tolerance = 5) => {
    // A is to the LEFT of B (A's right edge touches B's left edge)
    if (
      Math.abs((pieceA.x + PIECE_WIDTH) - pieceB.x) < tolerance &&
      Math.abs((pieceA.y + PIECE_HEIGHT / 2) - (pieceB.y + PIECE_HEIGHT / 2)) < tolerance
    ) {
      return 'left';
    }

    // A is to the RIGHT of B (A's left edge touches B's right edge)
    if (
      Math.abs(pieceA.x - (pieceB.x + PIECE_WIDTH)) < tolerance &&
      Math.abs((pieceA.y + PIECE_HEIGHT / 2) - (pieceB.y + PIECE_HEIGHT / 2)) < tolerance
    ) {
      return 'right';
    }

    // A is ABOVE B (A's bottom edge touches B's top edge)
    if (
      Math.abs((pieceA.y + PIECE_HEIGHT) - pieceB.y) < tolerance &&
      Math.abs((pieceA.x + PIECE_WIDTH / 2) - (pieceB.x + PIECE_WIDTH / 2)) < tolerance
    ) {
      return 'top';
    }

    // A is BELOW B (A's top edge touches B's bottom edge)
    if (
      Math.abs(pieceA.y - (pieceB.y + PIECE_HEIGHT)) < tolerance &&
      Math.abs((pieceA.x + PIECE_WIDTH / 2) - (pieceB.x + PIECE_WIDTH / 2)) < tolerance
    ) {
      return 'bottom';
    }

    return null;
  }, []);

  // Get the opposite direction
  const getOppositeDirection = useCallback((direction) => {
    const opposites = {
      left: 'right',
      right: 'left',
      top: 'bottom',
      bottom: 'top'
    };
    return opposites[direction] || null;
  }, []);

  // Build adjacency map for a single piece against all others
  const getAdjacencies = useCallback((piece, allPieces) => {
    const adjacentTo = {
      top: null,
      right: null,
      bottom: null,
      left: null
    };

    for (const other of allPieces) {
      if (other.id === piece.id) continue;

      const direction = getSnapDirection(other, piece);
      if (direction) {
        adjacentTo[direction] = other.id;
      }
    }

    return adjacentTo;
  }, [getSnapDirection]);

  // Rebuild all adjacencies for all pieces (returns new array)
  const rebuildAllAdjacencies = useCallback((pieces) => {
    return pieces.map(piece => ({
      ...piece,
      adjacentTo: getAdjacencies(piece, pieces)
    }));
  }, [getAdjacencies]);

  // Update adjacencies for specific pieces (more efficient for single moves)
  const updateAdjacenciesForPiece = useCallback((pieces, pieceId) => {
    const targetPiece = pieces.find(p => p.id === pieceId);
    if (!targetPiece) return pieces;

    // Get new adjacencies for the moved piece
    const newAdjacencies = getAdjacencies(targetPiece, pieces);

    // Update the moved piece and any pieces that might now be adjacent (or no longer adjacent)
    return pieces.map(piece => {
      if (piece.id === pieceId) {
        // Update the moved piece
        return { ...piece, adjacentTo: newAdjacencies };
      } else {
        // Check if this piece's adjacency to the moved piece changed
        const directionToMoved = getSnapDirection(targetPiece, piece);
        const currentAdjacentTo = piece.adjacentTo || { top: null, right: null, bottom: null, left: null };
        
        // Check all directions for changes
        const updatedAdjacentTo = { ...currentAdjacentTo };
        
        // If the moved piece is now adjacent, add it
        if (directionToMoved) {
          updatedAdjacentTo[directionToMoved] = pieceId;
        } else {
          // If the moved piece WAS adjacent but isn't anymore, remove it
          for (const dir of ['top', 'right', 'bottom', 'left']) {
            if (updatedAdjacentTo[dir] === pieceId) {
              updatedAdjacentTo[dir] = null;
            }
          }
        }

        return { ...piece, adjacentTo: updatedAdjacentTo };
      }
    });
  }, [getAdjacencies, getSnapDirection]);

  // Update adjacencies for multiple moved pieces (group drag)
  const updateAdjacenciesForPieces = useCallback((pieces, pieceIds) => {
    if (!Array.isArray(pieceIds) || pieceIds.length === 0) return pieces;
    return pieceIds.reduce(
      (nextPieces, id) => updateAdjacenciesForPiece(nextPieces, id),
      pieces
    );
  }, [updateAdjacenciesForPiece]);

  // Get all pieces connected to a piece (chain/cluster)
  const getConnectedCluster = useCallback((startPieceId, pieces) => {
    const visited = new Set();
    const queue = [startPieceId];

    while (queue.length > 0) {
      const currentId = queue.shift();
      if (visited.has(currentId)) continue;
      
      visited.add(currentId);
      
      const currentPiece = pieces.find(p => p.id === currentId);
      if (currentPiece?.adjacentTo) {
        const neighbors = Object.values(currentPiece.adjacentTo).filter(id => id !== null);
        for (const neighborId of neighbors) {
          if (!visited.has(neighborId)) {
            queue.push(neighborId);
          }
        }
      }
    }

    return Array.from(visited);
  }, []);

  // Check if two pieces are in the same cluster
  const areInSameCluster = useCallback((pieceIdA, pieceIdB, pieces) => {
    const cluster = getConnectedCluster(pieceIdA, pieces);
    return cluster.includes(pieceIdB);
  }, [getConnectedCluster]);

  // Count total connections across all pieces
  const countConnections = useCallback((pieces) => {
    let count = 0;
    for (const piece of pieces) {
      if (piece.adjacentTo) {
        count += Object.values(piece.adjacentTo).filter(id => id !== null).length;
      }
    }
    // Divide by 2 because each connection is counted twice (A→B and B→A)
    return count / 2;
  }, []);

  return {
    // Core detection
    getSnapDirection,
    getOppositeDirection,
    getAdjacencies,

    // Batch updates
    rebuildAllAdjacencies,
    updateAdjacenciesForPiece,
    updateAdjacenciesForPieces,

    // Cluster operations (for future group behavior)
    getConnectedCluster,
    areInSameCluster,

    // Utilities
    countConnections
  };
}

export default useAdjacency;
