// useScaffoldDrag.js
// Manages drag-and-drop state for the scaffold tree.
// Tracks dragged item, drop target, drop position, and ghost coordinates.

import { useState, useCallback, useRef, useMemo } from 'react';

const DRAG_THRESHOLD = 4; // px before drag activates

function isDescendantPath(parentPath, childPath) {
  if (!parentPath || !childPath) return false;
  return childPath.startsWith(parentPath + '/');
}

function useScaffoldDrag() {
  // Drag source
  const [dragItem, setDragItem] = useState(null); // { path, type, depth }
  const [isDragging, setIsDragging] = useState(false);

  // Drop target
  const [dropTarget, setDropTarget] = useState(null); // { path, position: 'before'|'inside'|'after' }

  // Ghost position (viewport coords)
  const [ghostPos, setGhostPos] = useState(null); // { x, y }

  // Track mousedown origin to apply threshold
  const startPosRef = useRef(null);
  const pendingItemRef = useRef(null);
  const activatedRef = useRef(false);

  const [isPending, setIsPending] = useState(false);

  const startPendingDrag = useCallback((item, clientX, clientY) => {
    pendingItemRef.current = item;
    startPosRef.current = { x: clientX, y: clientY };
    activatedRef.current = false;
    setIsPending(true);
  }, []);

  const updatePendingDrag = useCallback((clientX, clientY) => {
    if (activatedRef.current) {
      // Already dragging — update ghost
      setGhostPos({ x: clientX, y: clientY });
      return true;
    }
    if (!startPosRef.current || !pendingItemRef.current) return false;

    const dx = clientX - startPosRef.current.x;
    const dy = clientY - startPosRef.current.y;
    if (Math.abs(dx) < DRAG_THRESHOLD && Math.abs(dy) < DRAG_THRESHOLD) {
      return false; // Below threshold
    }

    // Threshold met — activate drag
    activatedRef.current = true;
    setIsPending(false);
    setDragItem(pendingItemRef.current);
    setIsDragging(true);
    setGhostPos({ x: clientX, y: clientY });
    return true;
  }, []);

  const computeDropTarget = useCallback((clientY, rowElement, rowItem) => {
    if (!isDragging || !dragItem || !rowElement || !rowItem) {
      setDropTarget(null);
      return;
    }

    // Can't drop on self
    if (rowItem.path === dragItem.path) {
      setDropTarget(null);
      return;
    }

    // Can't drop into own descendant (for folders)
    if (dragItem.type === 'dir' && isDescendantPath(dragItem.path, rowItem.path)) {
      setDropTarget(null);
      return;
    }

    const rect = rowElement.getBoundingClientRect();
    const relativeY = clientY - rect.top;
    const ratio = relativeY / rect.height;

    let position;
    if (rowItem.type === 'dir') {
      // Folder: top 25% = before, middle 50% = inside, bottom 25% = after
      if (ratio < 0.25) {
        position = 'before';
      } else if (ratio > 0.75) {
        position = 'after';
      } else {
        position = 'inside';
      }
    } else {
      // File: top 50% = before, bottom 50% = after
      position = ratio < 0.5 ? 'before' : 'after';
    }

    setDropTarget({ path: rowItem.path, type: rowItem.type, position });
  }, [isDragging, dragItem]);

  const endDrag = useCallback(() => {
    const result = isDragging && dragItem && dropTarget
      ? { source: dragItem, target: dropTarget }
      : null;

    setDragItem(null);
    setIsDragging(false);
    setIsPending(false);
    setDropTarget(null);
    setGhostPos(null);
    startPosRef.current = null;
    pendingItemRef.current = null;
    activatedRef.current = false;

    return result;
  }, [isDragging, dragItem, dropTarget]);

  const cancelDrag = useCallback(() => {
    setDragItem(null);
    setIsDragging(false);
    setIsPending(false);
    setDropTarget(null);
    setGhostPos(null);
    startPosRef.current = null;
    pendingItemRef.current = null;
    activatedRef.current = false;
  }, []);

  return {
    // State
    dragItem,
    isDragging,
    isPending,
    dropTarget,
    ghostPos,

    // Actions
    startPendingDrag,
    updatePendingDrag,
    computeDropTarget,
    endDrag,
    cancelDrag
  };
}

export default useScaffoldDrag;
