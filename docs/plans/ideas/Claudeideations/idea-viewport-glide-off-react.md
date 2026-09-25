# Idea: Move the viewport glide off React state

> **Status:** Parked (2026-09-24). Measure before touching. Only act if profiling shows jank.

## The itch

`animateViewport` (`src/utils/viewportNavigation.js`) drives the
**navigate-to-piece** and **Home** glides (callers are in
`src/app/useViewportNavigation.js`). Every animation frame it calls `setScale`,
`setOffsetX`, and `setOffsetY`. React batches these, but it still re-renders the
canvas tree about 60 times per second for the 300ms glide.

The rest of Litria already avoids this pattern:
- StatusBar X/Y coordinates write `textContent` through refs in a rAF loop
- The spawn pop-in is a native Konva tween
- The LED pulse was removed specifically to protect the canvas frame budget

## Possible shape

Animate the Konva Stage directly (`stage.scale()` / `stage.position()` +
`batchDraw`) during the glide, then commit the final values to React state
**once** at the end. Cancel semantics (`cancelAnimRef`) must also commit the
mid-glide position so state never drifts from what's on screen.

## Before this becomes a brief

- Profile a large project (100+ nodes, several groups) with navigate-to-piece
  and Home. Is there visible jank? Use `measure:drag-latency` style sampling or
  the React DevTools performance tracks.
- Check what else subscribes to viewport state during the glide (minimap,
  StatusBar zoom %, HUD readout) and how they stay in sync if state only updates
  at the end.
- If nobody can see a difference, close this idea.
