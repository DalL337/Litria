import { Group, Shape, Text } from 'react-konva';

/**
 * GridChevrons — renders < and > tier control buttons on the canvas.
 * Positioned in the subfolder row area of an expanded group.
 */

const CHEVRON_W = 50;
const CHEVRON_H = 40;
const CHEVRON_GAP = 8;

function ChevronButton({ x, y, direction, onClick, tooltip }) {
  const isLeft = direction === 'left';
  return (
    <Group x={x} y={y}>
      {/* Hit area */}
      <Shape
        width={CHEVRON_W}
        height={CHEVRON_H}
        sceneFunc={(ctx) => {
          const r = 8;
          const w = CHEVRON_W;
          const h = CHEVRON_H;
          // Rounded rect
          ctx.beginPath();
          ctx.moveTo(r, 0);
          ctx.lineTo(w - r, 0); ctx.arcTo(w, 0, w, r, r);
          ctx.lineTo(w, h - r); ctx.arcTo(w, h, w - r, h, r);
          ctx.lineTo(r, h); ctx.arcTo(0, h, 0, h - r, r);
          ctx.lineTo(0, r); ctx.arcTo(0, 0, r, 0, r);
          ctx.closePath();
          // Glass fill
          ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
          ctx.fill();
          ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)';
          ctx.lineWidth = 1;
          ctx.stroke();
          // Chevron arrow
          const cx = w / 2;
          const cy = h / 2;
          const arrowSize = 8;
          ctx.beginPath();
          if (isLeft) {
            ctx.moveTo(cx + arrowSize * 0.4, cy - arrowSize);
            ctx.lineTo(cx - arrowSize * 0.4, cy);
            ctx.lineTo(cx + arrowSize * 0.4, cy + arrowSize);
          } else {
            ctx.moveTo(cx - arrowSize * 0.4, cy - arrowSize);
            ctx.lineTo(cx + arrowSize * 0.4, cy);
            ctx.lineTo(cx - arrowSize * 0.4, cy + arrowSize);
          }
          ctx.strokeStyle = 'rgba(200, 210, 240, 0.7)';
          ctx.lineWidth = 2;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.stroke();
        }}
        onClick={(e) => {
          e.cancelBubble = true;
          onClick?.();
        }}
      />
    </Group>
  );
}

function GridChevrons({ x, y, showLess, showMore, onLess, onMore }) {
  if (!showLess && !showMore) return null;

  return (
    <Group x={x} y={y}>
      {showLess && (
        <ChevronButton
          x={0}
          y={0}
          direction="left"
          onClick={onLess}
          tooltip="Show fewer files"
        />
      )}
      {showMore && (
        <ChevronButton
          x={showLess ? CHEVRON_W + CHEVRON_GAP : 0}
          y={0}
          direction="right"
          onClick={onMore}
          tooltip="Show more files"
        />
      )}
    </Group>
  );
}

export default GridChevrons;
export { CHEVRON_W, CHEVRON_H, CHEVRON_GAP };
