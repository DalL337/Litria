// ConnectionLine.jsx
// Renders a bezier wire between connected pieces when they're not adjacent.
// Wires connect at edge midpoints (no tabs/slots in glass tile model) and leave
// each node perpendicular to the chosen edge (normal-launch control points).
//
// Geometry (the point list) and drawing (the bezier through it) are kept as two
// separate functions in ../utils/wireGeometry — see the Architectural Seam in
// docs/plans/ideas/brief-bezier-wire-refactor.md. Do not inline curve math here.
//
// Appearance follows the wire visual language (ADR-025 §5, resolved by
// ../utils/wireAppearance): healthy wires rest thin + neutral (topology);
// unhealthy wires rest popped in their status color (exception-based status —
// broken/orphaned red, drifted/pending amber, unused yellow); hover pops any
// wire to its status color + glow while every other wire drops a half-step
// (global focus swap, lifted to WorkspaceStage); selection holds the pop.
// Hover is paint-only — no appearance state feeds geometry.

import { Circle, Group, Path, Text } from 'react-konva';
import { PIECE_WIDTH, PIECE_HEIGHT } from './PuzzlePiece';
import { clamp } from '../utils/math';
import { computeWirePoints, buildWireCurve, anchorEdgePoint } from '../utils/wireGeometry';
import { resolveWireAppearance, adjacencyFadeFactor } from '../utils/wireAppearance';
import WireChevron from './WireChevron';

// Determine connection health from both anchors. Piece anchors carry the
// piece's status; pill anchors carry none and default to valid.
function getConnectionStatus(sourceAnchor, targetAnchor) {
  const sourceStatus = sourceAnchor?.status || 'valid';  // Default to valid for now
  const targetStatus = targetAnchor?.status || 'valid';

  // If either has an error, connection is red
  if (sourceStatus === 'error' || sourceStatus === 'empty' ||
      targetStatus === 'error' || targetStatus === 'empty') {
    return 'error';
  }

  // If either has a warning, connection is yellow
  if (sourceStatus === 'warning' || targetStatus === 'warning') {
    return 'warning';
  }

  // Both valid = green
  return 'valid';
}

function ConnectionLine({
  connection,
  sourceAnchor,
  targetAnchor,
  sourceSide,
  targetSide,
  onSelect,
  themeTokens,
  syntaxStatus,
  viewportScale = 1,
  isSelected = false,
  // Hover state lives in WorkspaceStage (global focus swap needs every wire
  // to know when any wire is hovered) — paint state only, never geometry.
  isHovered = false,
  isFocusDimmed = false,
  onHoverChange,
  // Routed point list from the selector-layer routing pass (ADR-025 §1).
  // When absent (defensive fallback), the component computes the straight
  // pair itself — identical output for un-routed wires.
  route = null,
  count = 1,
  countEnd = 'target',
}) {
  if (!sourceAnchor || !targetAnchor) return null;
  if (!Number.isFinite(sourceAnchor.x) || !Number.isFinite(sourceAnchor.y)) return null;
  if (!Number.isFinite(targetAnchor.x) || !Number.isFinite(targetAnchor.y)) return null;

  // Edge midpoint for an anchor rect (pieces OR collapsed-group pill stubs,
  // brief-cross-group-wires D1) — shared with the routing pass via
  // wireGeometry.anchorEdgePoint, single source of truth.
  const sourcePoint = anchorEdgePoint(sourceAnchor, sourceSide, PIECE_WIDTH, PIECE_HEIGHT);
  const targetPoint = anchorEdgePoint(targetAnchor, targetSide, PIECE_WIDTH, PIECE_HEIGHT);
  if (!Number.isFinite(sourcePoint.x) || !Number.isFinite(sourcePoint.y)) return null;
  if (!Number.isFinite(targetPoint.x) || !Number.isFinite(targetPoint.y)) return null;

  // Calculate distance between connection points
  const distance = Math.sqrt(
    Math.pow(targetPoint.x - sourcePoint.x, 2) +
    Math.pow(targetPoint.y - sourcePoint.y, 2)
  );

  // Adjacency fade band (ADR-025 §4, D1c): contact expresses the
  // relationship with no ink; the wire fades in over a band as the
  // endpoints separate — no binary reveal cliff.
  const fadeFactor = adjacencyFadeFactor(distance);
  if (fadeFactor === 0) {
    return null;
  }

  // Status color — syntaxStatus takes priority over piece health.
  const status = getConnectionStatus(sourceAnchor, targetAnchor);
  const activeThemeTokens = themeTokens && typeof themeTokens === 'object' ? themeTokens : {};
  const lineColorByStatus = {
    valid: activeThemeTokens.connectionValid ?? '#4CAF50',
    warning: activeThemeTokens.connectionWarning ?? '#FFC107',
    error: activeThemeTokens.connectionError ?? '#F44336',
    empty: activeThemeTokens.connectionError ?? '#F44336'
  };
  const syntaxLineColor =
    syntaxStatus === 'broken'   ? '#F44336' :  // red — symbol definition removed
    syntaxStatus === 'orphaned' ? '#F44336' :  // red — export references non-existent def
    syntaxStatus === 'drifted'  ? '#FF9800' :  // amber — symbol renamed (fuzzy match)
    syntaxStatus === 'unused'   ? '#FFC107' :  // yellow — imported but not referenced
    syntaxStatus === 'pending'  ? '#FF9800' :  // amber — stub inserted, symbol not picked
    syntaxStatus === 'resolved' ? '#4CAF50' :  // green — import fully resolved
    null;
  const statusColor = syntaxLineColor ?? lineColorByStatus[status] ?? lineColorByStatus.valid;

  // Appearance from the visual-language resolver (ADR-025 §5); the neutral
  // rest color is a theme token so custom themes can tune it.
  const appearance = resolveWireAppearance({
    syntaxStatus: syntaxStatus ?? null,
    healthStatus: status,
    isHovered,
    isSelected,
    isFocusDimmed,
    // D4 (ADR-025 §9): unroutable wires de-emphasize and pass beneath —
    // the existing z-order (wires under pieces) renders the under-pass.
    isUnrouted: route ? route.routed === false : false,
  });
  const lineColor = appearance.useStatusColor
    ? statusColor
    : (activeThemeTokens.connectionNeutral ?? '#6b7386');

  // --- Seam: geometry (point list) then drawing (bezier through it). The
  // point list comes from the global routing pass when provided; the local
  // computation is the defensive fallback and produces the same straight
  // pair the router emits for an unrouted wire. ---
  const points = Array.isArray(route?.points) && route.points.length >= 2
    ? route.points
    : computeWirePoints(sourcePoint, sourceSide, targetPoint, targetSide);
  const curve = buildWireCurve(points, {
    hops: route?.hops,
    // D4 fallbacks draw the direct segment — the cubic loops on the
    // inverted-face arrangements that cause fallbacks in the first place.
    straight: route ? route.routed === false : false,
  });
  if (!curve) return null;

  // --- Gauge + zoom clamp. Wires are canvas-space and scale with zoom, but
  // the on-screen stroke is clamped to the resolver's floor/cap. We back the
  // clamped on-screen width out of zoom so the Konva (canvas-space) value
  // renders at the intended on-screen px after the stage scale is applied.
  const scale = Number.isFinite(viewportScale) && viewportScale > 0 ? viewportScale : 1;
  const onScreenPx = clamp(appearance.gauge * scale, appearance.minPx, appearance.maxPx);
  const strokeWidth = onScreenPx / scale;

  // Soft outer glow on hover + selection (not extra width), matching the
  // glass aesthetic. Sized in screen space so it reads consistently across
  // zoom.
  const glowProps = appearance.glow
    ? {
        shadowColor: lineColor,
        shadowBlur: 12 / scale,
        shadowOpacity: 0.9,
        shadowOffset: { x: 0, y: 0 },
      }
    : {};

  // Modeless select: a left-click selects the wire (like selecting a node).
  // cancelBubble stops the stage's background click from immediately clearing
  // the selection. Delete / add-symbol are actions on the selection (wire menu),
  // replacing the old Shift+right-click delete chord.
  const handleClick = (e) => {
    if (e?.evt?.button !== 0) return;
    e.cancelBubble = true;
    onSelect?.(connection.id);
  };

  // A wider transparent hit path so the thin wire is easy to click/select.
  // Screen-space floor is independent of drawn gauge — thin neutral wires
  // stay exactly as grabbable as popped ones (ADR-025 §5).
  const HIT_STROKE = Math.max(strokeWidth, 14 / scale);

  return (
    <Group opacity={appearance.opacity * fadeFactor}>
      <Path
        data={curve.data}
        stroke={lineColor}
        strokeWidth={strokeWidth}
        hitStrokeWidth={HIT_STROKE}
        lineCap="round"
        lineJoin="round"
        listening
        onClick={handleClick}
        onTap={handleClick}
        onMouseEnter={() => onHoverChange?.(connection.id)}
        onMouseLeave={() => onHoverChange?.(null, connection.id)}
        {...glowProps}
      />
      <WireChevron
        curve={curve}
        color={lineColor}
        viewportScale={scale}
        active={isHovered || isSelected}
      />
      {count > 1 && (() => {
        // Aggregated wire (brief-cross-group-wires D2): a count chip near the
        // pill end. Screen-space sized like the chevron so it stays legible
        // across zoom. Non-listening — clicks land on the wire's hit path.
        const chipPos = curve.pointAt(countEnd === 'source' ? 0.18 : 0.82);
        const r = 10 / scale;
        return (
          <Group x={chipPos.x} y={chipPos.y} listening={false}>
            <Circle
              radius={r}
              fill="rgba(13, 15, 20, 0.92)"
              stroke={lineColor}
              strokeWidth={1.5 / scale}
            />
            <Text
              text={String(count)}
              x={-r}
              y={-5.5 / scale}
              width={r * 2}
              align="center"
              fontSize={11 / scale}
              fontStyle="600"
              fill="#e8ebf5"
            />
          </Group>
        );
      })()}
    </Group>
  );
}

export default ConnectionLine;
