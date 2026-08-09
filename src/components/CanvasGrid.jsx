import { Rect, Shape } from 'react-konva';

/**
 * CanvasGrid — renders a subtle reference grid inside the Konva Layer.
 *
 * Drawn inside the canvas (not CSS) so that the glass backdrop-blur pipeline
 * has actual pixel content to sample and frost against. Without this, nodes
 * blur against a transparent canvas and the glass effect is invisible.
 *
 * Uses a large fixed-size background fill + grid. The Stage viewport transform
 * handles panning/zooming — this draws in world-space coordinates.
 *
 * Performance: draws once and relies on Konva's internal caching. The grid
 * extends ±5000px which covers most practical canvas usage. For extreme
 * zoom-outs, the grid simply ends — acceptable since the glass effect only
 * matters at readable zoom levels.
 */

const GRID_SMALL = 20;
const GRID_LARGE = 100;
const EXTENT = 5000;
const SIZE = EXTENT * 2;

function CanvasGrid({ gridOpacity = 0.03, gridAccentOpacity = 0.06 }) {
  const minorAlpha = Number(gridOpacity) || 0.03;
  const majorAlpha = Number(gridAccentOpacity) || 0.06;

  return (
    <>
      {/* Dark background fill — ensures canvas isn't transparent */}
      <Rect
        x={-EXTENT}
        y={-EXTENT}
        width={SIZE}
        height={SIZE}
        fill="#0d0f14"
        listening={false}
      />
      {/* Grid lines */}
      <Shape
        listening={false}
        sceneFunc={(ctx) => {
          // Minor grid (20px spacing)
          ctx.strokeStyle = `rgba(255, 255, 255, ${minorAlpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          for (let x = -EXTENT; x <= EXTENT; x += GRID_SMALL) {
            ctx.moveTo(x, -EXTENT);
            ctx.lineTo(x, EXTENT);
          }
          for (let y = -EXTENT; y <= EXTENT; y += GRID_SMALL) {
            ctx.moveTo(-EXTENT, y);
            ctx.lineTo(EXTENT, y);
          }
          ctx.stroke();

          // Major grid (100px spacing)
          ctx.strokeStyle = `rgba(255, 255, 255, ${majorAlpha})`;
          ctx.beginPath();
          for (let x = -EXTENT; x <= EXTENT; x += GRID_LARGE) {
            ctx.moveTo(x, -EXTENT);
            ctx.lineTo(x, EXTENT);
          }
          for (let y = -EXTENT; y <= EXTENT; y += GRID_LARGE) {
            ctx.moveTo(-EXTENT, y);
            ctx.lineTo(EXTENT, y);
          }
          ctx.stroke();
        }}
      />
    </>
  );
}

export default CanvasGrid;
