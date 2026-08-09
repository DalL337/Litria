// useViewport.js
// Viewport coordinate transform and pan/zoom for infinite canvas.

import { useState, useCallback, useRef } from 'react';

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 3.0;
const PAN_THRESHOLD = 4;

export function useViewport(containerWidth, containerHeight) {
  const [scale, setScale] = useState(1);
  const [offsetX, setOffsetX] = useState(0);
  const [offsetY, setOffsetY] = useState(0);

  // Ref mirrors current state for use in callbacks without stale closures.
  const stateRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
  stateRef.current = { scale, offsetX, offsetY };

  // Pan tracking ref — null when not panning.
  const panRef = useRef(null);

  const screenToCanvas = useCallback((screenX, screenY) => ({
    x: (screenX - offsetX) / scale,
    y: (screenY - offsetY) / scale
  }), [scale, offsetX, offsetY]);

  const canvasToScreen = useCallback((canvasX, canvasY) => ({
    x: canvasX * scale + offsetX,
    y: canvasY * scale + offsetY
  }), [scale, offsetX, offsetY]);

  const getVisibleBounds = useCallback(() => ({
    x: -offsetX / scale,
    y: -offsetY / scale,
    width: containerWidth / scale,
    height: containerHeight / scale
  }), [scale, offsetX, offsetY, containerWidth, containerHeight]);

  // Zoom toward cursor — keeps pointer position fixed in canvas space.
  const zoomAtPoint = useCallback((screenX, screenY, deltaY) => {
    const { scale: s, offsetX: ox, offsetY: oy } = stateRef.current;
    const direction = deltaY > 0 ? -1 : 1;
    const newScale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, s * (1 + direction * 0.1)));
    if (newScale === s) return;
    const canvasX = (screenX - ox) / s;
    const canvasY = (screenY - oy) / s;
    setScale(newScale);
    setOffsetX(screenX - canvasX * newScale);
    setOffsetY(screenY - canvasY * newScale);
  }, []);

  // Global mouseup safety net — clears pan if the Konva stage misses the event
  // (e.g., cursor over a drawer or outside the window when button released).
  const globalMouseUpRef = useRef(null);

  const clearGlobalPanListener = useCallback(() => {
    if (globalMouseUpRef.current) {
      window.removeEventListener('mouseup', globalMouseUpRef.current);
      globalMouseUpRef.current = null;
    }
  }, []);

  // Begin pan candidate — defers clear-selection to mouseUp.
  const startPan = useCallback((screenX, screenY) => {
    const { offsetX: ox, offsetY: oy } = stateRef.current;
    panRef.current = {
      startScreenX: screenX, startScreenY: screenY,
      startOffsetX: ox, startOffsetY: oy,
      committed: false
    };
    // Register a global safety net so pan is always cleared on mouseup,
    // even if the cursor is outside the Konva stage.
    clearGlobalPanListener();
    const handler = () => {
      panRef.current = null;
      clearGlobalPanListener();
    };
    globalMouseUpRef.current = handler;
    window.addEventListener('mouseup', handler, { once: true });
  }, [clearGlobalPanListener]);

  // Move pan — returns true once committed (movement > threshold).
  const updatePan = useCallback((screenX, screenY) => {
    const pan = panRef.current;
    if (!pan) return false;
    const dx = screenX - pan.startScreenX;
    const dy = screenY - pan.startScreenY;
    if (!pan.committed) {
      if (Math.abs(dx) < PAN_THRESHOLD && Math.abs(dy) < PAN_THRESHOLD) return false;
      pan.committed = true;
    }
    setOffsetX(pan.startOffsetX + dx);
    setOffsetY(pan.startOffsetY + dy);
    return true;
  }, []);

  // End pan — returns true if was committed (user actually panned > threshold).
  const endPan = useCallback(() => {
    const pan = panRef.current;
    panRef.current = null;
    clearGlobalPanListener();
    return pan?.committed ?? false;
  }, [clearGlobalPanListener]);

  // Check if pan candidate or active pan is in progress.
  const isPanActive = useCallback(() => panRef.current != null, []);

  // Fit a canvas-space bounding box into the container with padding.
  const fitToBounds = useCallback((bounds, containerW, containerH, padding = 60) => {
    if (!bounds) {
      setScale(1);
      setOffsetX(0);
      setOffsetY(0);
      return;
    }
    const { minX, minY, maxX, maxY } = bounds;
    const contentW = maxX - minX;
    const contentH = maxY - minY;
    if (contentW <= 0 || contentH <= 0) return;
    const availW = containerW - padding * 2;
    const availH = containerH - padding * 2;
    const s = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.min(availW / contentW, availH / contentH)));
    setScale(s);
    setOffsetX(padding + (availW - contentW * s) / 2 - minX * s);
    setOffsetY(padding + (availH - contentH * s) / 2 - minY * s);
  }, []);

  return {
    scale, offsetX, offsetY,
    setScale, setOffsetX, setOffsetY,
    screenToCanvas, canvasToScreen, getVisibleBounds,
    stateRef,
    zoomAtPoint, startPan, updatePan, endPan, isPanActive, fitToBounds
  };
}
