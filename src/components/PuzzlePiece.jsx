import { useEffect, useRef } from 'react';
import Konva from 'konva';
import { Circle, Group, Rect, Shape, Text } from 'react-konva';
import { getPieceDisplayName } from '../utils/pieceDisplay';
import { parseColorToRgb, pastelizeColor } from '../utils/color';
import { computeBackdropSampleRect } from '../utils/backdropSampling';

// Restrict Konva node dragging to the left mouse button only. Without this,
// Konva's default (`[0, 1, 2]`) lets right- and middle-button drags move
// pieces/group pills — right-button is the canvas pan gesture, so a right-drag
// was both panning and dragging the selection (canvas-internals note 6 / feedback #19).
Konva.dragButtons = [0];

// Canonical values live in utils/pieceDimensions (node-testable);
// imported INTO local scope (this component uses them) and re-exported
// for the many existing component-side imports. NB: a bare
// `export { X } from '...'` re-export does NOT create a local binding —
// that exact mistake shipped once and broke every PuzzlePiece render.
import { PIECE_WIDTH, PIECE_HEIGHT } from '../utils/pieceDimensions';
export { PIECE_WIDTH, PIECE_HEIGHT };

function clampTokenNumber(raw, min, max, fallback) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function getRelativeLuminance({ r, g, b }) {
  const toLinear = (channel) => {
    const normalized = channel / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

function getAutoContrastTextColor(backgroundColor, fallback) {
  const rgb = parseColorToRgb(backgroundColor);
  if (!rgb) return fallback;
  const luminance = getRelativeLuminance(rgb);
  return luminance >= 0.45 ? '#101317' : '#f3f6ff';
}

// LED color lookup by health state
const LED_COLORS = {
  empty: 'rgba(180, 180, 190, 0.5)',
  blue: 'rgba(60, 140, 255, 0.95)',
  green: 'rgba(50, 205, 100, 0.9)',
  amber: 'rgba(240, 180, 40, 0.9)',
  red: 'rgba(240, 60, 60, 0.95)'
};

function PuzzlePiece({
  piece,
  isSelected,
  healthState,
  edgeColor,
  sublabel,
  isFrosted,
  backgroundLayerRef,
  offCanvasImportCount = 0,
  onOffCanvasBadgeClick,
  paneTag = null,
  themeTokens,
  onClick,
  onConnectionStart,
  onDragStart,
  onDragMove,
  onDragEnd,
  onDoubleClick
}) {
  const handleClick = (e) => {
    e.cancelBubble = true;
    onClick?.(piece.id, e);
  };

  const handleMouseDown = (e) => {
    if (e.evt.button === 0 && e.evt.ctrlKey) {
      e.cancelBubble = true;
      e.evt.preventDefault();
      onConnectionStart?.(piece, e);
      return;
    }
    e.cancelBubble = true;
  };

  const activeThemeTokens = themeTokens && typeof themeTokens === 'object' ? themeTokens : {};
  const displayName = getPieceDisplayName(piece);
  const contentRef = useRef(null);
  const ledRef = useRef(null);

  // ── Material dispatch (option b) ──
  // 'glass' = frosted blur + refraction rim + Snell highlights.
  // 'matte'  = flat opaque fill + solid border, no light effects.
  // Any surface/edge/accent hue is rendered *through* this finish (color ⊥ material).
  const material = activeThemeTokens.nodeMaterial === 'matte' ? 'matte' : 'glass';

  // ── Node surface tokens ──
  const surfaceTint = activeThemeTokens.nodeSurfaceTint ?? '#141824';
  const frostedAlpha = clampTokenNumber(activeThemeTokens.glassFrostedAlpha, 0, 1, 0.75);
  // Matte is opaque (default alpha 1) and ignores the frosted-editor dissolve so
  // an open editor never washes the node out. Glass keeps the frosted behavior.
  const surfaceAlpha = material === 'matte'
    ? clampTokenNumber(activeThemeTokens.nodeSurfaceAlpha, 0, 1, 1)
    : (isFrosted ? frostedAlpha : clampTokenNumber(activeThemeTokens.nodeSurfaceAlpha, 0, 1, 0));
  const cornerRadius = clampTokenNumber(activeThemeTokens.nodeCornerRadius, 2, 24, 12);
  const rimWidth = clampTokenNumber(activeThemeTokens.glassRimWidth, 0.5, 3, 1.5);
  const rimColor = activeThemeTokens.glassRimColor ?? 'rgba(255, 255, 255, 0.15)';
  const blurRadius = clampTokenNumber(activeThemeTokens.glassBlurRadius, 0, 30, 6);
  // ── Matte material tokens ──
  const matteBorderColor = activeThemeTokens.matteBorderColor ?? 'rgba(255, 255, 255, 0.14)';
  const matteBorderWidth = clampTokenNumber(activeThemeTokens.matteBorderWidth, 0, 4, 1.5);
  const selectionStroke = activeThemeTokens.nodeSelectedStroke ?? '#00BFFF';

  // ── Text tokens ──
  const textMode = activeThemeTokens.nodeTextMode === 'manual' ? 'manual' : 'auto';
  const fallbackTextColor = activeThemeTokens.nodeText ?? '#f3f6ff';
  const textColor = textMode === 'manual'
    ? fallbackTextColor
    : getAutoContrastTextColor(surfaceTint, fallbackTextColor);
  const textShadowBlur = clampTokenNumber(activeThemeTokens.nodeTextShadowBlur, 0, 20, 8);

  // ── Corner LED tokens ──
  const ledStyle = activeThemeTokens.nodeLedStyle === 'arc' ? 'arc' : 'dot';
  const ledSize = clampTokenNumber(activeThemeTokens.nodeLedSize, 12, 50, 28);
  const health = healthState ?? 'empty';
  const ledColor = activeThemeTokens['led' + health.charAt(0).toUpperCase() + health.slice(1)]
    ?? LED_COLORS[health]
    ?? LED_COLORS.empty;

  // ── Rim refraction tokens ──
  const refractiveIndex = clampTokenNumber(activeThemeTokens.glassRefractiveIndex, 1.0, 2.0, 1.5);

  // ── Edge assignment tokens ──
  // Edge assignment is a LEFT-edge accent (ADR-014 amendment 2026-06-13).
  // edgeThickness = bar width; edgeInset = vertical inset from the rounded corners.
  const edgeThickness = clampTokenNumber(activeThemeTokens.edgeAssignmentHeight, 1, 6, 2);
  const edgeInset = clampTokenNumber(activeThemeTokens.edgeAssignmentInset, 4, 40, 16);
  // Live/Calm energy axis (static, ADR-014). Live = identity (scales of 1);
  // Calm desaturates + lightens the resolved edge color into a soft pastel.
  const edgeSaturationScale = clampTokenNumber(activeThemeTokens.nodeEdgeSaturation, 0, 1, 1);
  const edgeLightnessScale = clampTokenNumber(activeThemeTokens.nodeEdgeLightness, 1, 2, 1);
  const edgeMaxLightness = clampTokenNumber(activeThemeTokens.nodeEdgeMaxLightness, 0, 1, 1);
  const paintedEdgeColor = edgeColor
    ? pastelizeColor(edgeColor, {
      saturationScale: edgeSaturationScale,
      lightnessScale: edgeLightnessScale,
      maxLightness: edgeMaxLightness
    })
    : edgeColor;

  // ── Spawn animation ──
  useEffect(() => {
    if (!piece?.isSpawning || !contentRef.current) return;

    const node = contentRef.current;
    node.setAttrs({
      scaleX: 0.92,
      scaleY: 0.92,
      opacity: 0.75,
      y: 6
    });

    node.to({
      scaleX: 1,
      scaleY: 1,
      opacity: 1,
      y: 0,
      duration: 0.16,
      easing: Konva.Easings.EaseOut
    });
  }, [piece?.isSpawning]);

  // LED is rendered statically — no continuous animation. The earlier
  // pulse used a Konva.Animation tied to the LED's layer, which forced
  // a 60fps redraw on every red or blue (dirty) LED and shared the
  // canvas main-thread frame budget with drag/pan/zoom interactions.
  // Color alone (red / amber / green / blue / empty) is a sufficient
  // signal for now; if a more attention-grabbing affordance is needed
  // later, render it as a DOM overlay outside the Konva render path
  // rather than reintroducing canvas-thread animation.

  return (
    <Group
      x={piece.x}
      y={piece.y}
      scaleX={piece.scale ?? 1}
      scaleY={piece.scale ?? 1}
      draggable
      onClick={handleClick}
      onTap={handleClick}
      onDblClick={(e) => onDoubleClick?.(piece.id, e)}
      onDblTap={(e) => onDoubleClick?.(piece.id, e)}
      onMouseDown={handleMouseDown}
      onDragStart={(e) => {
        if (e.evt?.ctrlKey) {
          e.target.stopDrag();
          return;
        }
        onDragStart?.(piece.id);
      }}
      onDragMove={(e) =>
        onDragMove?.(piece.id, e.target.x(), e.target.y())
      }
      onDragEnd={(e) =>
        onDragEnd?.(piece.id, e.target.x(), e.target.y())
      }
    >
      <Group ref={contentRef}>
        {/* Invisible hit area — receives all pointer events for the piece.
            Required because all visual shapes below have listening={false}. */}
        <Rect
          width={PIECE_WIDTH}
          height={PIECE_HEIGHT}
          cornerRadius={cornerRadius}
          fill="transparent"
        />

        {/* Glass surface — sceneFunc for direct Canvas 2D access.
            Draws: rounded rect fill (with tint alpha), rim stroke.
            Architecture supports future backdrop-blur injection. */}
        <Shape
          width={PIECE_WIDTH}
          height={PIECE_HEIGHT}
          sceneFunc={(ctx, shape) => {
            const w = PIECE_WIDTH;
            const h = PIECE_HEIGHT;
            const r = Math.min(cornerRadius, w / 2, h / 2);

            // ── Rounded rect path helper ──
            const tracePath = () => {
              ctx.beginPath();
              ctx.moveTo(r, 0);
              ctx.lineTo(w - r, 0);
              ctx.arcTo(w, 0, w, r, r);
              ctx.lineTo(w, h - r);
              ctx.arcTo(w, h, w - r, h, r);
              ctx.lineTo(r, h);
              ctx.arcTo(0, h, 0, h - r, r);
              ctx.lineTo(0, r);
              ctx.arcTo(0, 0, r, 0, r);
              ctx.closePath();
            };

            // ── Shadow (depth on the glass pane) ──
            tracePath();
            ctx.save();
            ctx.shadowColor = 'rgba(0, 0, 0, ' + (isSelected ? 0.5 : 0.3) + ')';
            ctx.shadowBlur = isSelected ? 12 : 4;
            ctx.fillStyle = 'rgba(0, 0, 0, 0.01)';
            ctx.fill();
            ctx.restore();

            // ── Matte material: flat opaque fill + solid border ──
            // The color passes through the matte finish; no blur, rim, or Snell
            // highlights are drawn (option-b dispatch — this branch is exactly
            // what suppresses the Snell floor a token-only flat surface would leak).
            if (material === 'matte') {
              if (surfaceAlpha > 0) {
                tracePath();
                ctx.save();
                ctx.globalAlpha = surfaceAlpha;
                ctx.fillStyle = surfaceTint;
                ctx.fill();
                ctx.restore();
              }
              if (matteBorderWidth > 0) {
                tracePath();
                ctx.strokeStyle = matteBorderColor;
                ctx.lineWidth = matteBorderWidth;
                ctx.stroke();
              }
              return;
            }

            // ── Backdrop-blur (sample the BACKGROUND layer behind the piece,
            //    blur, clip). Sampling only the grid layer — never the content
            //    layer — is what keeps wires/LEDs/neighbors out of the glass
            //    (brief-glass-backdrop-sampling S2). ──
            if (blurRadius > 0 && backgroundLayerRef?.current) {
              try {
                const layer = backgroundLayerRef.current;
                const layerCanvas = layer.getCanvas()._canvas;
                // getAbsolutePosition/getAbsoluteScale already include stage
                // pan + zoom, and the backing canvas is device-px — the rect
                // helper owns that coordinate contract (do not reintroduce a
                // stage-scale multiply here; that double-applied zoom).
                const abs = shape.getAbsolutePosition();
                const absScale = shape.getAbsoluteScale();
                const rect = computeBackdropSampleRect({
                  absX: abs.x,
                  absY: abs.y,
                  absScaleX: absScale.x,
                  absScaleY: absScale.y,
                  pixelRatio: layer.getCanvas().getPixelRatio(),
                  canvasWidth: layerCanvas.width,
                  canvasHeight: layerCanvas.height,
                  width: w,
                  height: h,
                });

                if (rect) {
                  // Draw sampled region into the piece shape with blur.
                  ctx.save();
                  tracePath();
                  ctx.clip();
                  ctx.filter = 'blur(' + blurRadius + 'px)';
                  // drawImage from the layer canvas, source region → dest region.
                  ctx.drawImage(layerCanvas, rect.sx, rect.sy, rect.sw, rect.sh, rect.dx, rect.dy, rect.dw, rect.dh);
                  ctx.filter = 'none';
                  ctx.restore();
                }
              } catch {
                // Silently skip blur if layer access fails — glass still renders without it.
              }
            }

            // ── Glass fill (tint at surface alpha) ──
            if (surfaceAlpha > 0) {
              tracePath();
              ctx.save();
              ctx.globalAlpha = surfaceAlpha;
              ctx.fillStyle = surfaceTint;
              ctx.fill();
              ctx.restore();
            }

            // ── Rim stroke (glass edge — straight segments, dimmer) ──
            tracePath();
            ctx.strokeStyle = rimColor;
            ctx.lineWidth = rimWidth;
            ctx.stroke();

            // ── Snell-inspired corner highlights (curvature → brightness) ──
            const snellAlpha = Math.min(1, (refractiveIndex - 1.0) * 0.6 + 0.1);
            if (snellAlpha > 0.02) {
              ctx.save();
              ctx.globalAlpha = snellAlpha;
              ctx.strokeStyle = 'rgba(255, 255, 255, 0.5)';
              ctx.lineWidth = rimWidth * 0.8;
              ctx.lineCap = 'round';

              // Top-right corner (primary — light source convention)
              ctx.beginPath();
              ctx.arc(w - r, r, r, -Math.PI / 2, 0);
              ctx.stroke();

              // Top-left corner
              ctx.beginPath();
              ctx.arc(r, r, r, Math.PI, -Math.PI / 2);
              ctx.stroke();

              // Bottom-right corner (dimmer — farther from light)
              ctx.globalAlpha = snellAlpha * 0.6;
              ctx.beginPath();
              ctx.arc(w - r, h - r, r, 0, Math.PI / 2);
              ctx.stroke();

              // Bottom-left corner (dimmest)
              ctx.globalAlpha = snellAlpha * 0.4;
              ctx.beginPath();
              ctx.arc(r, h - r, r, Math.PI / 2, Math.PI);
              ctx.stroke();

              ctx.restore();
            }
          }}
          listening={false}
        />

        {/* Selection outline */}
        {isSelected && (
          <Rect
            x={-1}
            y={-1}
            width={PIECE_WIDTH + 2}
            height={PIECE_HEIGHT + 2}
            cornerRadius={cornerRadius + 1}
            fillEnabled={false}
            stroke={selectionStroke}
            strokeWidth={2}
            listening={false}
          />
        )}

        {/* Corner LED — health indicator */}
        <Shape
          ref={ledRef}
          x={PIECE_WIDTH - ledSize - 6}
          y={6}
          width={ledSize}
          height={ledSize}
          sceneFunc={(ctx) => {
            if (ledStyle === 'arc') {
              // Arc (L-shaped catchpoint following corner radius)
              const armLen = ledSize;
              const r = Math.min(cornerRadius, armLen);
              ctx.beginPath();
              // Horizontal arm (top)
              ctx.moveTo(0, 0);
              ctx.lineTo(armLen - r, 0);
              // Corner arc
              ctx.arcTo(armLen, 0, armLen, r, r);
              // Vertical arm (right)
              ctx.lineTo(armLen, armLen);
              ctx.strokeStyle = ledColor;
              ctx.lineWidth = 2.5;
              ctx.lineCap = 'round';
              ctx.lineJoin = 'round';
              ctx.stroke();
            } else {
              // Dot (radial ball)
              const cx = ledSize / 2;
              const cy = ledSize / 2;
              const radius = ledSize / 3;
              const gradient = ctx.createRadialGradient(
                cx - radius * 0.3, cy - radius * 0.3, 0,
                cx, cy, radius * 1.8
              );
              gradient.addColorStop(0, ledColor);
              gradient.addColorStop(0.5, ledColor.replace(/[\d.]+\)$/, '0.35)'));
              gradient.addColorStop(1, 'transparent');
              ctx.beginPath();
              ctx.arc(cx, cy, radius * 1.8, 0, Math.PI * 2);
              ctx.fillStyle = gradient;
              ctx.fill();
            }
          }}
          listening={false}
        />

        {/* Edge assignment — left-edge accent (ADR-014 amendment 2026-06-13).
            Resolved color comes from resolveNodeEdgeColor (ad-hoc → inherited →
            ungrouped default). Static, vertical, faded at the ends so it clears
            the rounded corners. */}
        {edgeColor && (
          <Shape
            sceneFunc={(ctx) => {
              const gradH = PIECE_HEIGHT - edgeInset * 2;
              if (gradH <= 0) return;
              const grad = ctx.createLinearGradient(0, edgeInset, 0, edgeInset + gradH);
              grad.addColorStop(0, 'transparent');
              grad.addColorStop(0.15, paintedEdgeColor);
              grad.addColorStop(0.5, paintedEdgeColor);
              grad.addColorStop(0.85, paintedEdgeColor);
              grad.addColorStop(1, 'transparent');
              ctx.fillStyle = grad;
              ctx.fillRect(0, edgeInset, edgeThickness, gradH);
            }}
            listening={false}
          />
        )}

        {/* Sublabel (auto-populated from parent group name) — bottom-left, above filename */}
        {sublabel && (
          <Text
            text={sublabel.toUpperCase()}
            x={14}
            y={PIECE_HEIGHT - 32}
            fontSize={9}
            fill="rgba(160, 165, 180, 0.6)"
            fontStyle="normal"
            letterSpacing={0.8}
            shadowColor="black"
            shadowBlur={6}
            shadowOpacity={0.7}
            listening={false}
          />
        )}

        {/* Off-canvas import badge (brief-cross-group-wires S3): this piece
            imports N files that have no canvas piece yet. Click lists them;
            picking one places the piece and wires the import. Bottom-right —
            clear of the corner LED (top-right) and labels (bottom-left). */}
        {offCanvasImportCount > 0 && (
          <Group
            x={PIECE_WIDTH - 22}
            y={PIECE_HEIGHT - 22}
            onClick={(e) => {
              e.cancelBubble = true;
              onOffCanvasBadgeClick?.(piece);
            }}
            onTap={(e) => {
              e.cancelBubble = true;
              onOffCanvasBadgeClick?.(piece);
            }}
          >
            <Circle
              radius={10}
              fill="rgba(13, 15, 20, 0.92)"
              stroke="rgba(240, 180, 40, 0.9)"
              strokeWidth={1.5}
            />
            <Text
              text={String(offCanvasImportCount)}
              x={-10}
              y={-5.5}
              width={20}
              align="center"
              fontSize={11}
              fontStyle="600"
              fill="#f0e0b0"
              listening={false}
            />
          </Group>
        )}

        {/* Pane residency tag (ADR-017 sign-off: "where is it open"). Only
            rendered while the editor is split — single-pane mode has nothing
            to disambiguate. Top-left: clear of the corner LED (top-right),
            labels (bottom-left), and the off-canvas badge (bottom-right).
            Pure indicator, never interactive. */}
        {paneTag != null && (
          <Group x={8} y={8} listening={false}>
            <Rect
              width={26}
              height={15}
              cornerRadius={7.5}
              fill="rgba(13, 15, 20, 0.85)"
              stroke={paneTag === 2 ? 'rgba(168, 130, 255, 0.85)' : 'rgba(80, 170, 255, 0.85)'}
              strokeWidth={1}
            />
            <Text
              text={`P${paneTag}`}
              x={0}
              y={3.5}
              width={26}
              align="center"
              fontSize={9}
              fontStyle="600"
              fill="#e8ecf8"
            />
          </Group>
        )}

        {/* Filename label — bottom-left justified */}
        <Text
          text={displayName}
          x={14}
          y={PIECE_HEIGHT - 18}
          width={PIECE_WIDTH - 60}
          fontSize={12}
          fontStyle="500"
          fill={textColor}
          shadowColor="black"
          shadowBlur={textShadowBlur}
          shadowOpacity={0.8}
          shadowOffset={{ x: 0, y: 1 }}
          ellipsis={true}
          wrap="none"
          listening={false}
        />
      </Group>
    </Group>
  );
}

export default PuzzlePiece;
