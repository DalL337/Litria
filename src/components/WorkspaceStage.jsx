import { useCallback, useRef, useState } from 'react';
import { Stage, Layer, Rect, Line, Group, Shape, Text, Circle } from 'react-konva';

import PuzzlePiece, { PIECE_WIDTH, PIECE_HEIGHT } from './PuzzlePiece';
import ConnectionLine from './ConnectionLine';
import LassoBox from './LassoBox';
import Desk from './Desk';
import EdgeGlow from './EdgeGlow';
import CanvasGrid from './CanvasGrid';
import GridChevrons from './GridChevrons';
import { computeGridLayout, getTierCapacity, getMaxTier } from '../utils/gridLayout';
import { resolveNodeEdgeColor, GROUP_OUTLINE_PAD, GROUP_NEST_PAD } from '../app/selectors/workspaceSelectors';
import { worstSyntaxStatus } from '../utils/wireStatus';

const GROUP_LED_COLORS = {
  empty: 'rgba(180, 180, 190, 0.5)',
  blue: 'rgba(60, 140, 255, 0.95)',
  green: 'rgba(50, 205, 100, 0.9)',
  amber: 'rgba(240, 180, 40, 0.9)',
  red: 'rgba(240, 60, 60, 0.95)'
};

function clampValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDashForDistance(distance) {
  const dash = clampValue(distance / 22, 6, 18);
  const gap = clampValue(distance / 44, 4, 12);
  return [dash, gap];
}

function WorkspaceStage({
  deskWidth,
  deskHeight,
  stageRef,
  isGroupMenuOpen,
  targetGroupBounds,
  dragOverGroupBounds,
  // Group being LEFT by an in-flight subtractive drag — its box/pill dims
  // (opacity 0.35) so the source reads as releasing the piece/child.
  subtractiveSourceGroupId,
  renderableWires,
  wireRoutes,
  piecesById,
  onSelectConnection,
  onSelectWireBundle,
  offCanvasCountByPieceId,
  onOffCanvasBadgeClick,
  paneTagsByPieceId,
  selectedConnectionId,
  syntaxConnStatuses,
  groupPills,
  handleGroupPillSelect,
  handleGroupPillDoubleClick,
  handleGroupPillDragStart,
  handleGroupPillDragMove,
  handleGroupPillDragEnd,
  selectedGroupId,
  visiblePieces,
  isPieceSelected,
  getTabsForPiece,
  getSlotsForPiece,
  slotColorsByPieceId,
  groupColorByPieceId,
  groupNameByPieceId,
  healthByPieceId,
  frostedPieceIds,
  groupHealthById,
  groups,
  groupDomain,
  pieceDomain,
  groupOutlines,
  handlePieceClick,
  handleConnectionStart,
  handlePieceDragStart,
  handlePieceDragMove,
  finalizePieceDragWithSnap,
  handlePieceDoubleClick,
  lassoSelectionBox,
  hoverTarget,
  dragLine,
  handleStageMouseDown,
  handleStageMouseMove,
  handleStageMouseUp,
  handleStageMouseLeave,
  theme,
  viewportScale = 1,
  viewportOffsetX = 0,
  viewportOffsetY = 0,
  onZoomAtPoint,
  onTrackpadPan,
  ungroupedEdgeColor = null,
}) {
  // Background layer (grid only) — the ONLY canvas the glass backdrop
  // samples (brief-glass-backdrop-sampling S2). Semantic content (wires,
  // pills, pieces, LEDs) lives on the content layer above and can never
  // ghost into a piece's glass. Bonus: the background repaints only on
  // pan/zoom, so sampling reads a stable canvas during drags.
  const backgroundLayerRef = useRef(null);
  const handleWheel = useCallback((e) => {
    e.evt.preventDefault();
    const evt = e.evt;
    // Trackpad pan: two-finger scroll sends both deltaX and deltaY without ctrlKey.
    // Trackpad pinch: browser synthesises ctrlKey + deltaY (no deltaX).
    // Mouse wheel: sends deltaY only (deltaX === 0), no ctrlKey.
    // Heuristic: non-zero deltaX without ctrlKey → trackpad pan. Everything else → zoom.
    const isTrackpadPan = !evt.ctrlKey && evt.deltaX !== 0;
    if (isTrackpadPan) {
      if (onTrackpadPan) {
        onTrackpadPan({ deltaX: evt.deltaX, deltaY: evt.deltaY });
      }
    } else {
      const pointer = e.target.getStage().getPointerPosition();
      if (pointer && onZoomAtPoint) {
        onZoomAtPoint(pointer.x, pointer.y, evt.deltaY);
      }
    }
  }, [onTrackpadPan, onZoomAtPoint]);
  const themeTokens = theme?.tokens ?? {};
  const groupPillFill = themeTokens.groupPillFill ?? 'rgba(30, 30, 30, 0.75)';
  const groupPillStroke = themeTokens.groupPillStroke ?? '#5c6bc0';
  const groupPillSelectedStroke = themeTokens.groupPillSelectedStroke ?? '#2979ff';
  const groupPillText = themeTokens.groupPillText ?? '#e6e6e6';
  const groupPillHoverStroke = themeTokens.groupPillHoverStroke ?? '#7986cb';
  const groupPillHoverGlow = themeTokens.groupPillHoverGlow ?? 'rgba(121, 134, 203, 0.30)';
  const groupPillSelectedFill = themeTokens.groupPillSelectedFill ?? 'rgba(41, 121, 255, 0.08)';
  const groupPillSelectedGlow = themeTokens.groupPillSelectedGlow ?? 'rgba(41, 121, 255, 0.35)';
  const groupPillDivider = themeTokens.groupPillDivider ?? 'rgba(92, 107, 192, 0.4)';
  const groupPillCountText = themeTokens.groupPillCountText ?? '#7986cb';
  const dragLineColor = themeTokens.connectionStroke ?? '#42a5f5';
  const edgeGlowColor = themeTokens.connectionStroke ?? '#42a5f5';
  const selectionGroupOutline = themeTokens.selectionGroupOutline ?? 'rgba(120, 180, 255, 0.7)';
  const groupOutlineStroke = themeTokens.groupOutlineStroke ?? 'rgba(92, 107, 192, 0.25)';
  const groupOutlineFill = themeTokens.groupOutlineFill ?? 'rgba(92, 107, 192, 0.04)';
  // Imported from the selector layer — shared with the wire router's
  // border discipline (ADR-025 S5).

  const SQUIRCLE_W = PIECE_WIDTH;
  const SQUIRCLE_H = 80;
  const SQUIRCLE_RADIUS = 14;
  const DIVIDER_W = SQUIRCLE_W * 0.4;

  const [hoveredPillId, setHoveredPillId] = useState(null);
  // Hovered wire, lifted from ConnectionLine so the GLOBAL focus swap can
  // reach every wire (ADR-025 §5): the hovered wire pops, all others drop a
  // half-step. Paint state only — geometry never reads it. The leave handler
  // passes its own id so a stale leave (A→B where B's enter already landed)
  // can't clear B's hover.
  const [hoveredWireId, setHoveredWireId] = useState(null);
  const handleWireHover = useCallback((id, leavingId = null) => {
    setHoveredWireId((prev) => (id != null ? id : prev === leavingId ? null : prev));
  }, []);

  return (
    <Desk>
      <Stage
        width={deskWidth}
        height={deskHeight}
        ref={stageRef}
        scaleX={viewportScale}
        scaleY={viewportScale}
        x={viewportOffsetX}
        y={viewportOffsetY}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
        onMouseLeave={handleStageMouseLeave}
        onWheel={handleWheel}
        onContextMenu={(e) => e.evt.preventDefault()}
      >
        <Layer ref={backgroundLayerRef} listening={false}>
          <CanvasGrid
            gridOpacity={Number(themeTokens.canvasGridOpacity) || 0.03}
            gridAccentOpacity={Number(themeTokens.canvasGridAccentOpacity) || 0.06}
          />
        </Layer>
        <Layer>
          {Array.isArray(groupOutlines) && groupOutlines.map((outline) => {
            const pad = outline.parentId ? GROUP_OUTLINE_PAD + GROUP_NEST_PAD : GROUP_OUTLINE_PAD;
            const isSelected = selectedGroupId === outline.id;
            const stroke = isSelected
              ? selectionGroupOutline
              : (outline.color ? `${outline.color}40` : groupOutlineStroke);
            const fill = outline.color ? `${outline.color}0A` : groupOutlineFill;
            const boxW = outline.bounds.maxX - outline.bounds.minX + pad * 2;
            const boxH = outline.bounds.maxY - outline.bounds.minY + pad * 2;
            const tabH = 20;
            const tabLabel = outline.name || 'Group';
            const tabW = Math.min(180, Math.max(56, tabLabel.length * 7 + 22));
            // Interactive group box: a draggable Group anchored at the bounds
            // origin (so the drag delta matches handleGroupPillDragStart's
            // startX/Y). The interior + tab are tagged 'group-gutter' so a
            // Shift+drag starts a marquee instead of being swallowed (see the
            // lasso-start broadening). Rendered BEHIND the piece nodes, so a
            // node click hits the node and a gutter click hits the group.
            return (
              <Group
                key={`group-box-${outline.id}`}
                x={outline.bounds.minX}
                y={outline.bounds.minY}
                opacity={outline.id === subtractiveSourceGroupId ? 0.35 : 1}
                draggable
                onClick={(e) => { if (e.evt?.shiftKey) return; handleGroupPillSelect(outline.id, e); }}
                onTap={(e) => handleGroupPillSelect(outline.id, e)}
                onDragStart={(e) => {
                  if (e.evt?.shiftKey) { e.target.stopDrag(); return; }
                  handleGroupPillDragStart(outline.id, { detectNest: false });
                }}
                onDragMove={handleGroupPillDragMove}
                onDragEnd={() => handleGroupPillDragEnd(outline.id)}
              >
                <Rect
                  name="group-gutter"
                  x={-pad}
                  y={-pad}
                  width={boxW}
                  height={boxH}
                  stroke={stroke}
                  strokeWidth={isSelected ? 2 : 1}
                  // Nested folder groups dash [4,4] (parent-child cue). The
                  // manual-group [2,5] dot retired with the physicality
                  // ruling (DP5) — every persistent group is on disk now.
                  dash={outline.parentId ? [4, 4] : undefined}
                  cornerRadius={12}
                  fill={fill}
                />
                {/* Header tab — group name + select affordance (feedback #13) */}
                <Rect
                  name="group-gutter"
                  x={-pad + 8}
                  y={-pad - tabH + 1}
                  width={tabW}
                  height={tabH}
                  cornerRadius={[8, 8, 0, 0]}
                  fill={outline.color ? `${outline.color}26` : 'rgba(40, 40, 40, 0.92)'}
                  stroke={stroke}
                  strokeWidth={1}
                />
                <Text
                  text={tabLabel}
                  x={-pad + 16}
                  y={-pad - tabH + 6}
                  width={tabW - 16}
                  fontSize={14}
                  fill={isSelected ? '#ffffff' : '#cfd3e0'}
                  wrap="none"
                  ellipsis
                  listening={false}
                />
                {/* Collapse affordance (owner request 2026-07-22): one click
                    folds the box to its pill without the action-pill round
                    trip. Centered ON the outline's top-right corner — nodes
                    live inside the content bounds, so the corner is
                    structurally node-free (owner refinement: the first cut sat
                    inside the box and the rightmost node covered it).
                    cancelBubble on mousedown/click keeps it off drag+select. */}
                <Group
                  x={-pad + boxW - 9}
                  y={-pad - 9}
                  onClick={(e) => {
                    e.cancelBubble = true;
                    groupDomain.commands.toggleCollapse(outline.id);
                  }}
                  onTap={(e) => {
                    e.cancelBubble = true;
                    groupDomain.commands.toggleCollapse(outline.id);
                  }}
                  onMouseDown={(e) => { e.cancelBubble = true; }}
                >
                  <Circle x={9} y={9} radius={9} fill="rgba(13, 15, 20, 0.85)" stroke={stroke} strokeWidth={1} />
                  <Line points={[4.5, 9, 13.5, 9]} stroke="#dfe3ee" strokeWidth={1.5} lineCap="round" />
                </Group>
              </Group>
            );
          })}
          {isGroupMenuOpen && targetGroupBounds && (
            <Rect
              x={targetGroupBounds.minX - 8}
              y={targetGroupBounds.minY - 8}
              width={targetGroupBounds.maxX - targetGroupBounds.minX + 16}
              height={targetGroupBounds.maxY - targetGroupBounds.minY + 16}
              stroke={selectionGroupOutline}
              strokeWidth={2}
              dash={[6, 6]}
              cornerRadius={10}
              listening={false}
            />
          )}
          {dragOverGroupBounds && (
            <Rect
              x={dragOverGroupBounds.minX - 6}
              y={dragOverGroupBounds.minY - 6}
              width={dragOverGroupBounds.maxX - dragOverGroupBounds.minX + 12}
              height={dragOverGroupBounds.maxY - dragOverGroupBounds.minY + 12}
              stroke={groupPillSelectedStroke}
              strokeWidth={2}
              cornerRadius={8}
              listening={false}
            />
          )}

          {/* Paint order: hovered (then selected) wires render last so the
              popped wire draws over its neighbors — top of the wire stack,
              still beneath tiles (ADR-025 §5, hover is paint-only). Stable
              sort keeps rest order untouched. */}
          {[...renderableWires]
            .sort((a, b) => {
              const rank = (w) => (
                w.connection.id === hoveredWireId ? 2
                  : w.connections.some((c) => c.id === selectedConnectionId) ? 1
                    : 0
              );
              return rank(a) - rank(b);
            })
            .map((wire) => (
            <ConnectionLine
              key={wire.connection.id}
              connection={wire.connection}
              sourceAnchor={wire.sourceAnchor}
              targetAnchor={wire.targetAnchor}
              sourceSide={wire.sourceSide}
              targetSide={wire.targetSide}
              // Aggregated wires open their member list; single wires select
              // directly (brief-cross-group-wires D2).
              onSelect={wire.count > 1 ? () => onSelectWireBundle?.(wire) : onSelectConnection}
              isSelected={wire.connections.some((c) => c.id === selectedConnectionId)}
              isHovered={hoveredWireId === wire.connection.id}
              isFocusDimmed={hoveredWireId != null}
              onHoverChange={handleWireHover}
              route={wireRoutes?.get(wire.connection.id)}
              themeTokens={themeTokens}
              syntaxStatus={worstSyntaxStatus(wire.connections.map((c) => syntaxConnStatuses?.get(c.id)))}
              viewportScale={viewportScale}
              count={wire.count}
              countEnd={wire.countEnd}
            />
          ))}

          {groupPills.map((pill) => {
            const t = pill.themeTokens && typeof pill.themeTokens === 'object'
              ? pill.themeTokens
              : themeTokens;
            const isSelected = selectedGroupId === pill.id;
            const isHovered = hoveredPillId === pill.id;
            const fill = isSelected
              ? (t.groupPillSelectedFill ?? groupPillSelectedFill)
              : (t.groupPillFill ?? groupPillFill);
            const stroke = isSelected
              ? (t.groupPillSelectedStroke ?? groupPillSelectedStroke)
              : isHovered
                ? (t.groupPillHoverStroke ?? groupPillHoverStroke)
                : (t.groupPillStroke ?? groupPillStroke);
            const glowColor = isSelected
              ? (t.groupPillSelectedGlow ?? groupPillSelectedGlow)
              : isHovered
                ? (t.groupPillHoverGlow ?? groupPillHoverGlow)
                : 'rgba(0,0,0,0.4)';
            const nameColor = t.groupPillText ?? groupPillText;
            const countColor = t.groupPillCountText ?? groupPillCountText;
            const dividerColor = t.groupPillDivider ?? groupPillDivider;
            const countLabel = pill.pieceCount === 1 ? '1 file' : `${pill.pieceCount} files`;
            const groupHealth = groupHealthById?.get(pill.id) ?? 'empty';
            const groupLedColor = GROUP_LED_COLORS[groupHealth] ?? GROUP_LED_COLORS.empty;
            return (
            <Group
              key={pill.id}
              x={pill.x}
              y={pill.y}
              opacity={pill.id === subtractiveSourceGroupId ? 0.35 : 1}
              draggable
              onClick={(e) => handleGroupPillSelect(pill.id, e)}
              onTap={(e) => handleGroupPillSelect(pill.id, e)}
              onDblClick={() => handleGroupPillDoubleClick(pill.id)}
              onDragStart={() => handleGroupPillDragStart(pill.id)}
              onDragMove={handleGroupPillDragMove}
              onDragEnd={() => handleGroupPillDragEnd(pill.id)}
              onMouseEnter={() => setHoveredPillId(pill.id)}
              onMouseLeave={() => setHoveredPillId((prev) => prev === pill.id ? null : prev)}
            >
              {/* Hit area for pointer events */}
              <Rect
                width={SQUIRCLE_W}
                height={SQUIRCLE_H}
                cornerRadius={SQUIRCLE_RADIUS}
                fill="transparent"
              />
              {/* Glass squircle surface */}
              <Shape
                width={SQUIRCLE_W}
                height={SQUIRCLE_H}
                sceneFunc={(ctx) => {
                  const w = SQUIRCLE_W;
                  const h = SQUIRCLE_H;
                  const r = SQUIRCLE_RADIUS;
                  const rimW = Number(themeTokens.glassRimWidth) || 1.5;
                  const rimC = themeTokens.glassRimColor ?? 'rgba(255, 255, 255, 0.15)';
                  const alpha = Number(themeTokens.nodeSurfaceAlpha) || 0;
                  const tint = themeTokens.nodeSurfaceTint ?? '#141824';
                  const ri = Number(themeTokens.glassRefractiveIndex) || 1.5;

                  // Rounded rect path
                  ctx.beginPath();
                  ctx.moveTo(r, 0);
                  ctx.lineTo(w - r, 0); ctx.arcTo(w, 0, w, r, r);
                  ctx.lineTo(w, h - r); ctx.arcTo(w, h, w - r, h, r);
                  ctx.lineTo(r, h); ctx.arcTo(0, h, 0, h - r, r);
                  ctx.lineTo(0, r); ctx.arcTo(0, 0, r, 0, r);
                  ctx.closePath();

                  // Shadow
                  ctx.save();
                  ctx.shadowColor = 'rgba(0,0,0,' + (isSelected ? 0.5 : 0.3) + ')';
                  ctx.shadowBlur = isSelected || isHovered ? 10 : 4;
                  ctx.fillStyle = 'rgba(0,0,0,0.01)';
                  ctx.fill();
                  ctx.restore();

                  // Tint
                  if (alpha > 0) {
                    ctx.save();
                    ctx.globalAlpha = alpha;
                    ctx.fillStyle = tint;
                    ctx.fill();
                    ctx.restore();
                  }

                  // Rim — assigned group color tints it (collapsed folder carries
                  // its color), else the default glass rim.
                  ctx.strokeStyle = isSelected
                    ? (t.groupPillSelectedStroke ?? '#2979ff')
                    : (pill.color || rimC);
                  ctx.lineWidth = isSelected ? 2 : (pill.color ? Math.max(rimW, 1.5) : rimW);
                  ctx.stroke();

                  // Snell corners
                  const sa = Math.min(1, (ri - 1.0) * 0.6 + 0.1);
                  if (sa > 0.02) {
                    ctx.save();
                    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
                    ctx.lineWidth = rimW * 0.8;
                    ctx.lineCap = 'round';
                    ctx.globalAlpha = sa;
                    ctx.beginPath(); ctx.arc(w - r, r, r, -Math.PI / 2, 0); ctx.stroke();
                    ctx.beginPath(); ctx.arc(r, r, r, Math.PI, -Math.PI / 2); ctx.stroke();
                    ctx.globalAlpha = sa * 0.6;
                    ctx.beginPath(); ctx.arc(w - r, h - r, r, 0, Math.PI / 2); ctx.stroke();
                    ctx.globalAlpha = sa * 0.4;
                    ctx.beginPath(); ctx.arc(r, h - r, r, Math.PI / 2, Math.PI); ctx.stroke();
                    ctx.restore();
                  }
                }}
                listening={false}
              />
              <Text
                text={pill.name}
                x={0}
                y={SQUIRCLE_H * 0.15}
                width={SQUIRCLE_W}
                align="center"
                fontSize={14}
                fill={nameColor}
                shadowColor="black"
                shadowBlur={6}
                shadowOpacity={0.7}
                listening={false}
              />
              <Line
                points={[
                  (SQUIRCLE_W - DIVIDER_W) / 2, SQUIRCLE_H * 0.52,
                  (SQUIRCLE_W + DIVIDER_W) / 2, SQUIRCLE_H * 0.52
                ]}
                stroke={dividerColor}
                strokeWidth={1}
                listening={false}
              />
              <Text
                text={countLabel}
                x={0}
                y={SQUIRCLE_H * 0.62}
                width={SQUIRCLE_W}
                align="center"
                fontSize={10}
                fill={countColor}
                shadowColor="black"
                shadowBlur={4}
                shadowOpacity={0.6}
                listening={false}
              />
              {/* Group aggregate LED — worst-case health of children */}
              <Shape
                x={SQUIRCLE_W - 20}
                y={6}
                width={14}
                height={14}
                sceneFunc={(ctx) => {
                  const cx = 7;
                  const cy = 7;
                  const radius = 5;
                  const grad = ctx.createRadialGradient(
                    cx - 1, cy - 1, 0,
                    cx, cy, radius * 1.6
                  );
                  grad.addColorStop(0, groupLedColor);
                  grad.addColorStop(0.5, groupLedColor.replace(/[\d.]+\)$/, '0.3)'));
                  grad.addColorStop(1, 'transparent');
                  ctx.beginPath();
                  ctx.arc(cx, cy, radius * 1.6, 0, Math.PI * 2);
                  ctx.fillStyle = grad;
                  ctx.fill();
                }}
                listening={false}
              />
              {/* Expand affordance (owner request 2026-07-22): beside the
                  aggregate LED — one click reopens the group through the same
                  expand-with-layout path as the pill double-click. cancelBubble
                  keeps it off pill select/drag. */}
              <Group
                x={SQUIRCLE_W - 38}
                y={6}
                onClick={(e) => {
                  e.cancelBubble = true;
                  handleGroupPillDoubleClick(pill.id);
                }}
                onTap={(e) => {
                  e.cancelBubble = true;
                  handleGroupPillDoubleClick(pill.id);
                }}
                onDblClick={(e) => { e.cancelBubble = true; }}
                onMouseDown={(e) => { e.cancelBubble = true; }}
              >
                <Circle x={7} y={7} radius={8} fill="rgba(13, 15, 20, 0.85)" stroke={pill.color || 'rgba(255, 255, 255, 0.35)'} strokeWidth={1} />
                <Line points={[3.5, 7, 10.5, 7]} stroke="#dfe3ee" strokeWidth={1.5} lineCap="round" />
                <Line points={[7, 3.5, 7, 10.5]} stroke="#dfe3ee" strokeWidth={1.5} lineCap="round" />
              </Group>
            </Group>
            );
          })}

          {visiblePieces.map((piece) => (
            <PuzzlePiece
              key={piece.id}
              piece={piece}
              isSelected={isPieceSelected(piece.id)}
              healthState={healthByPieceId?.get(piece.id) ?? 'empty'}
              edgeColor={resolveNodeEdgeColor(piece, groupColorByPieceId, ungroupedEdgeColor ?? themeTokens.nodeUngroupedEdgeColor ?? null)}
              sublabel={groupNameByPieceId?.get(piece.id) ?? null}
              isFrosted={frostedPieceIds?.has(piece.id) ?? false}
              backgroundLayerRef={backgroundLayerRef}
              offCanvasImportCount={offCanvasCountByPieceId?.get(piece.id) ?? 0}
              onOffCanvasBadgeClick={onOffCanvasBadgeClick}
              paneTag={paneTagsByPieceId?.get(piece.id) ?? null}
              themeTokens={themeTokens}
              onClick={handlePieceClick}
              onConnectionStart={handleConnectionStart}
              onDragStart={handlePieceDragStart}
              onDragMove={handlePieceDragMove}
              onDragEnd={finalizePieceDragWithSnap}
              onDoubleClick={handlePieceDoubleClick}
            />
          ))}

          {/* Grid chevrons for expanded folder groups */}
          {Array.isArray(groups) && groups
            .filter((g) => !g.isCollapsed && g.pieceIds.length > 0)
            .map((g) => {
              const tierIndex = g.gridTier ?? 0;
              const fileCount = g.pieceIds.length;
              const capacity = getTierCapacity(tierIndex);
              const showMore = fileCount > capacity && tierIndex < getMaxTier();
              const showLess = tierIndex > 0;
              if (!showMore && !showLess) return null;

              // Compute layout to get chevron position.
              const firstPiece = piecesById.get(g.pieceIds[0]);
              if (!firstPiece) return null;
              const layout = computeGridLayout({
                filePieceIds: g.pieceIds,
                subfolderGroupIds: [],
                tierIndex,
                originX: firstPiece.x,
                originY: firstPiece.y
              });

              return (
                <GridChevrons
                  key={`chevrons-${g.id}`}
                  x={layout.chevronX}
                  y={layout.chevronY}
                  showLess={showLess}
                  showMore={showMore}
                  onLess={() => {
                    const newTier = Math.max(0, tierIndex - 1);
                    groupDomain.commands.setGridTier(g.id, newTier);
                    // Re-layout pieces at new tier.
                    const sorted = [...g.pieceIds].sort((a, b) => {
                      const pa = piecesById.get(a);
                      const pb = piecesById.get(b);
                      return (pa?.filename ?? '').localeCompare(pb?.filename ?? '', undefined, { sensitivity: 'base' });
                    });
                    const newLayout = computeGridLayout({
                      filePieceIds: sorted,
                      subfolderGroupIds: [],
                      tierIndex: newTier,
                      originX: firstPiece.x,
                      originY: firstPiece.y
                    });
                    pieceDomain.commands.batchMovePieces(newLayout.piecePositions);
                  }}
                  onMore={() => {
                    const newTier = Math.min(getMaxTier(), tierIndex + 1);
                    groupDomain.commands.setGridTier(g.id, newTier);
                    const sorted = [...g.pieceIds].sort((a, b) => {
                      const pa = piecesById.get(a);
                      const pb = piecesById.get(b);
                      return (pa?.filename ?? '').localeCompare(pb?.filename ?? '', undefined, { sensitivity: 'base' });
                    });
                    const newLayout = computeGridLayout({
                      filePieceIds: sorted,
                      subfolderGroupIds: [],
                      tierIndex: newTier,
                      originX: firstPiece.x,
                      originY: firstPiece.y
                    });
                    pieceDomain.commands.batchMovePieces(newLayout.piecePositions);
                  }}
                />
              );
            })}

          <LassoBox box={lassoSelectionBox} />
          {hoverTarget && <EdgeGlow piece={hoverTarget.piece} edge={hoverTarget.edge} glowColor={edgeGlowColor} />}

          {dragLine && (
            <Line
              points={[dragLine.startX, dragLine.startY, dragLine.endX, dragLine.endY]}
              stroke={dragLineColor}
              strokeWidth={2}
              dash={getDashForDistance(
                Math.hypot(
                  dragLine.endX - dragLine.startX,
                  dragLine.endY - dragLine.startY
                )
              )}
              listening={false}
            />
          )}
        </Layer>
      </Stage>
    </Desk>
  );
}

export default WorkspaceStage;
