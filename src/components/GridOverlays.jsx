import { memo, useCallback } from 'react';
import { Circle, Group, Line, Rect, Shape } from 'react-konva';
import { pieceRect, pieceScale } from '../utils/spatialGeometry2d';
import { gridStrokeStyle } from '../theme/gridPaint';

/**
 * Structural-grid overlays (ADR-030 playground-review rulings). Neither is on
 * the background layer, so glass never samples them.
 *
 * GridGuides — smart guides while dragging: thin translucent lines in the
 * theme's selection color, one device pixel wide, at most one per axis. They
 * draw ABOVE the nodes, as in Illustrator: under the nodes, a guide along two
 * docked nodes' shared edges was hidden entirely, and a guide in a gap was
 * lost among grid lines of a similar hue (owner smoke test, 2026-09-27).
 *
 * GridMarks — the dashed landing outline for the dragged set, and the
 * origin marker at (0, 0) in the grid's ink. No reticle and no label: the
 * landing coordinate is in the status bar.
 */

// Guide opacity and overshoot past the aligned nodes (screen px). The
// playground's 0.6 read in its empty canvas but not over the app's grid
// and group boxes.
const GUIDE_ALPHA = 0.85;
const GUIDE_OVERSHOOT_PX = 12;

function GridGuidesImpl({ lines, color, viewportScale = 1, viewportOffsetX = 0, viewportOffsetY = 0 }) {
  const sceneFunc = useCallback((context, shape) => {
    if (!lines?.length) return;
    const raw = context._context;
    const pixelRatio = shape.getLayer()?.getCanvas()?.getPixelRatio?.() ?? 1;
    const toDevice = (value, offset) => (value * viewportScale + offset) * pixelRatio;
    const overshoot = GUIDE_OVERSHOOT_PX * pixelRatio;
    raw.save();
    raw.setTransform(1, 0, 0, 1, 0, 0);
    raw.globalAlpha = GUIDE_ALPHA;
    raw.strokeStyle = color;
    raw.lineWidth = Math.max(1, Math.round(pixelRatio));
    raw.beginPath();
    for (const line of lines) {
      if (line.axis === 'x') {
        const x = Math.round(toDevice(line.value, viewportOffsetX)) + 0.5;
        raw.moveTo(x, toDevice(line.lo, viewportOffsetY) - overshoot);
        raw.lineTo(x, toDevice(line.hi, viewportOffsetY) + overshoot);
      } else {
        const y = Math.round(toDevice(line.value, viewportOffsetY)) + 0.5;
        raw.moveTo(toDevice(line.lo, viewportOffsetX) - overshoot, y);
        raw.lineTo(toDevice(line.hi, viewportOffsetX) + overshoot, y);
      }
    }
    raw.stroke();
    raw.restore();
  }, [color, lines, viewportOffsetX, viewportOffsetY, viewportScale]);

  if (!lines?.length) return null;
  return <Shape listening={false} sceneFunc={sceneFunc} />;
}

export const GridGuides = memo(GridGuidesImpl);

function GridMarksImpl({
  preview,
  piecesById,
  outlineColor,
  cornerRadius = 12,
  showOrigin = true,
  originColor = null,
  viewportScale = 1,
}) {
  const scale = viewportScale > 0 ? viewportScale : 1;
  const landing = preview?.positions ?? null;
  return (
    <Group listening={false}>
      {landing && [...landing.entries()].map(([id, position]) => {
        const piece = piecesById?.get(id);
        if (!piece) return null;
        const rect = pieceRect(piece, undefined, undefined, position);
        return (
          <Rect
            key={`landing-${id}`}
            x={rect.x}
            y={rect.y}
            width={rect.width}
            height={rect.height}
            cornerRadius={cornerRadius * pieceScale(piece)}
            stroke={outlineColor}
            strokeWidth={1.5}
            strokeScaleEnabled={false}
            dash={[6, 4]}
            opacity={0.75}
          />
        );
      })}
      {showOrigin && originColor && (
        <Group x={0} y={0}>
          <Circle radius={7 / scale} stroke={originColor} strokeWidth={1.25} strokeScaleEnabled={false} />
          <Line points={[-14 / scale, 0, 14 / scale, 0]} stroke={originColor} strokeWidth={1.25} strokeScaleEnabled={false} />
          <Line points={[0, -14 / scale, 0, 14 / scale]} stroke={originColor} strokeWidth={1.25} strokeScaleEnabled={false} />
        </Group>
      )}
    </Group>
  );
}

export const GridMarks = memo(GridMarksImpl);

/** The origin marker's ink: the grid's own color, as a stroke style. */
export const originInk = (paint) => (paint ? gridStrokeStyle(paint.color, 0.8) : null);
