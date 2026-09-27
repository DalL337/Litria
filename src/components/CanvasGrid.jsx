import { memo, useCallback } from 'react';
import { Rect, Shape } from 'react-konva';
import { lineIndexRange } from '../utils/gridGeometry';
import { CANVAS_BACKGROUND, gridStrokeStyle } from '../theme/gridPaint';

/**
 * CanvasGrid — the structural grid (ADR-030), drawn on the background layer
 * that glass nodes sample, so frosted nodes blur against real pixels.
 *
 * Draws the applied lattice for the visible world area plus one major step
 * of margin, at any coordinate including negative ones; zoom changes how it
 * is drawn, never which coordinates exist. Each location is drawn once, at
 * its strongest level. Sub, then minor lines fade out as their on-screen
 * spacing drops below about ten pixels; at far zoom only every 2nd, 4th, …
 * major line is drawn, while the snap lattice stays whole. Lines are one
 * device pixel, snapped to the pixel grid, in the theme's ink.
 *
 * Memoized: node drags never change these props, so the background layer
 * does not repaint while nodes move.
 */

// On-screen spacing (CSS px) at which a level starts fading, and the span
// over which it fades in.
const FADE_START_PX = 4;
const FADE_SPAN_PX = 6;
// Majors thin out below this on-screen spacing.
const MIN_MAJOR_SPACING_PX = 12;
// Line budget per axis per level; a level that would exceed it is skipped.
const MAX_LINES_PER_AXIS = 1200;

const fadeFor = (spacingPx) => Math.min(1, Math.max(0, (spacingPx - FADE_START_PX) / FADE_SPAN_PX));

function CanvasGrid({
  steps,
  paint,
  levels,
  viewportScale = 1,
  viewportOffsetX = 0,
  viewportOffsetY = 0,
  width = 0,
  height = 0,
}) {
  const scale = viewportScale > 0 ? viewportScale : 1;
  // Visible world rectangle, with one major step of margin.
  const marginX = steps.majorX;
  const marginY = steps.majorY;
  const worldX0 = -viewportOffsetX / scale - marginX;
  const worldY0 = -viewportOffsetY / scale - marginY;
  const worldX1 = (width - viewportOffsetX) / scale + marginX;
  const worldY1 = (height - viewportOffsetY) / scale + marginY;

  const sceneFunc = useCallback((context, shape) => {
    const raw = context._context;
    const pixelRatio = shape.getLayer()?.getCanvas()?.getPixelRatio?.() ?? 1;
    // Draw in device pixels so every line is exactly one pixel wide.
    raw.save();
    raw.setTransform(1, 0, 0, 1, 0, 0);
    raw.lineWidth = Math.max(1, Math.round(pixelRatio));
    const toDeviceX = (x) => Math.round((x * scale + viewportOffsetX) * pixelRatio) + 0.5;
    const toDeviceY = (y) => Math.round((y * scale + viewportOffsetY) * pixelRatio) + 0.5;
    const deviceWidth = width * pixelRatio;
    const deviceHeight = height * pixelRatio;

    const stroke = (alpha, stepX, stepY, skipX, skipY) => {
      if (!(alpha > 0.001)) return;
      const xs = lineIndexRange(worldX0, worldX1, stepX);
      const ys = lineIndexRange(worldY0, worldY1, stepY);
      if (xs.last - xs.first > MAX_LINES_PER_AXIS || ys.last - ys.first > MAX_LINES_PER_AXIS) return;
      raw.strokeStyle = gridStrokeStyle(paint.color, alpha);
      raw.beginPath();
      for (let i = xs.first; i <= xs.last; i++) {
        if (skipX(i)) continue;
        const x = toDeviceX(i * stepX);
        raw.moveTo(x, 0);
        raw.lineTo(x, deviceHeight);
      }
      for (let j = ys.first; j <= ys.last; j++) {
        if (skipY(j)) continue;
        const y = toDeviceY(j * stepY);
        raw.moveTo(0, y);
        raw.lineTo(deviceWidth, y);
      }
      raw.stroke();
    };

    const minorDivX = Math.round(steps.majorX / steps.minorX);
    const minorDivY = Math.round(steps.majorY / steps.minorY);
    const subDivX = Math.round(steps.minorX / steps.subX);
    const subDivY = Math.round(steps.minorY / steps.subY);

    const subAlpha = levels.sub ? paint.sub * fadeFor(Math.min(steps.subX, steps.subY) * scale) : 0;
    const minorAlpha = levels.minor ? paint.minor * fadeFor(Math.min(steps.minorX, steps.minorY) * scale) : 0;
    const majorAlpha = levels.major ? paint.major : 0;
    let majorEvery = 1;
    while (Math.min(steps.majorX, steps.majorY) * scale * majorEvery < MIN_MAJOR_SPACING_PX) majorEvery *= 2;

    // Sub lines skip minor positions, minor lines skip major positions: each
    // location is drawn once, at its strongest level.
    stroke(subAlpha, steps.subX, steps.subY, (i) => i % subDivX === 0, (j) => j % subDivY === 0);
    stroke(minorAlpha, steps.minorX, steps.minorY, (i) => i % minorDivX === 0, (j) => j % minorDivY === 0);
    stroke(majorAlpha, steps.majorX * majorEvery, steps.majorY * majorEvery, () => false, () => false);
    raw.restore();
  }, [height, levels.major, levels.minor, levels.sub, paint, scale, steps, viewportOffsetX, viewportOffsetY, width, worldX0, worldX1, worldY0, worldY1]);

  return (
    <>
      {/* The canvas background: glass needs real pixels to frost against. */}
      <Rect
        x={worldX0}
        y={worldY0}
        width={worldX1 - worldX0}
        height={worldY1 - worldY0}
        fill={CANVAS_BACKGROUND}
        listening={false}
      />
      <Shape listening={false} sceneFunc={sceneFunc} />
    </>
  );
}

export default memo(CanvasGrid);
