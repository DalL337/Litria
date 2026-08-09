import { Line } from 'react-konva';
import { chevronPoints } from '../utils/wireChevronGeometry.js';

/**
 * WireChevron — directional indicator on a connection wire (bezier Phase 2).
 *
 * A single open `>` chevron shown ONLY while the wire is hovered or selected,
 * placed ~60% along the curve (toward the target — reads better than the
 * midpoint on an S-curve) and oriented to the curve's tangent there, so it
 * always points source → target. This disambiguates overlapping A→B / B→A wires.
 *
 * It is a decoration decoupled from the wire's geometry/drawing: it only asks
 * the curve for "point + tangent at t" (buildWireCurve's `pointAt`, computed
 * from the SAME control points the wire is drawn with) and renders itself.
 * Removing or restyling it must not touch the wire code.
 *
 * Sized in screen space (constant on-screen regardless of zoom) — only one or a
 * few render at a time, so this is cheap.
 */
const CHEVRON_SIZE_PX = 11;    // on-screen extent of the chevron
const CHEVRON_STROKE_PX = 2;   // on-screen stroke width
const CHEVRON_T = 0.6;         // position along the curve, toward the target

export default function WireChevron({ curve, color, viewportScale = 1, active }) {
  if (!active || typeof curve?.pointAt !== 'function') return null;

  const scale = Number.isFinite(viewportScale) && viewportScale > 0 ? viewportScale : 1;
  // Half-size in canvas units so the on-screen size stays constant under zoom.
  const half = CHEVRON_SIZE_PX / scale / 2;

  return (
    <Line
      points={chevronPoints(curve.pointAt(CHEVRON_T), half)}
      stroke={color}
      strokeWidth={CHEVRON_STROKE_PX / scale}
      lineCap="round"
      lineJoin="round"
      listening={false}
    />
  );
}
