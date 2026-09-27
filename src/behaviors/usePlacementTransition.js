import { useCallback, useEffect, useState } from 'react';
import { createPlacementTransition, transitionDone } from '../utils/placementTransition.js';

/**
 * usePlacementTransition — runs the settle slide (ADR-030, brief §5).
 *
 * `begin(from, to)` starts a finite transition from release positions to the
 * committed ones. It ticks on animation frames, then clears. A new drag
 * (`isDragActive`), any history change (undo, redo, a new action) and a
 * project switch (`resetKey`) cancel a running slide, so authoritative state
 * always wins. Reduced motion or a zero duration never starts one.
 */
export function usePlacementTransition({ durationMs, easing, reduceMotion, isDragActive, history, resetKey }) {
  const [transition, setTransition] = useState(null);
  const [now, setNow] = useState(0);

  const cancel = useCallback(() => setTransition(null), []);

  const begin = useCallback((from, to) => {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const next = createPlacementTransition({ from, to, start, durationMs, easing, reduceMotion });
    setNow(start);
    setTransition(next);
  }, [durationMs, easing, reduceMotion]);

  useEffect(() => {
    if (!transition) return undefined;
    let frame = 0;
    const tick = (time) => {
      if (transitionDone(transition, time)) {
        setTransition(null);
        return;
      }
      setNow(time);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [transition]);

  useEffect(() => {
    if (isDragActive) setTransition(null);
  }, [isDragActive]);

  useEffect(() => {
    setTransition(null);
  }, [resetKey]);

  useEffect(() => {
    if (!history?.subscribe) return undefined;
    // An undo or redo replaces state; the slide must not replay stale frames.
    // (The settling action itself is pushed before begin(), so this never
    // cancels the slide it belongs to.)
    return history.subscribe(() => setTransition(null));
  }, [history]);

  return { transition, now, begin, cancel, isSettling: Boolean(transition) };
}
