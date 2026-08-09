import { useRef, useCallback } from 'react';

/**
 * Hook that distinguishes tap (click) from long-press (hold) on a pointer target.
 *
 * @param {Object} options
 * @param {Function} options.onLongPress  — fired after holding for `delay` ms
 * @param {Function} options.onClick      — fired on release before `delay` elapses
 * @param {number}   [options.delay=400]  — hold duration threshold in ms
 * @param {number}   [options.moveThreshold=5] — pixels of movement that cancel the press
 * @returns {{ onPointerDown, onPointerUp, onPointerLeave, onPointerMove }}
 */
export function useLongPress({ onLongPress, onClick, delay = 400, moveThreshold = 5 }) {
  const timerRef = useRef(null);
  const firedRef = useRef(false);
  const startPosRef = useRef(null);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onPointerDown = useCallback((e) => {
    firedRef.current = false;
    startPosRef.current = { x: e.clientX, y: e.clientY };
    cancel();
    timerRef.current = setTimeout(() => {
      firedRef.current = true;
      timerRef.current = null;
      onLongPress?.(e);
    }, delay);
  }, [cancel, delay, onLongPress]);

  const onPointerMove = useCallback((e) => {
    if (!startPosRef.current) return;
    const dx = e.clientX - startPosRef.current.x;
    const dy = e.clientY - startPosRef.current.y;
    if (Math.sqrt(dx * dx + dy * dy) > moveThreshold) {
      cancel();
      startPosRef.current = null;
    }
  }, [cancel, moveThreshold]);

  const onPointerUp = useCallback((e) => {
    cancel();
    startPosRef.current = null;
    if (!firedRef.current) {
      onClick?.(e);
    }
  }, [cancel, onClick]);

  const onPointerLeave = useCallback(() => {
    cancel();
    startPosRef.current = null;
  }, [cancel]);

  return { onPointerDown, onPointerUp, onPointerLeave, onPointerMove };
}
