// usePiecePlacement.js
// Formerly tracked desk/artboard piece locations.
// Now a no-op: all pieces live on the flat canvas.

import { useCallback } from 'react';

function usePiecePlacement() {
  const updateMultiplePieceLocations = useCallback((pieces) => pieces, []);

  return {
    updateMultiplePieceLocations
  };
}

export default usePiecePlacement;
