import { useCallback, useRef, useState } from 'react';

const MINIMAP_SIZE = 240;
const MINIMAP_PADDING = 8;

const SQUIRCLE_W = 140;
const SQUIRCLE_H = 80;

// Drag gain. 1.0 = viewport box pinned exactly under the cursor (intuitive but
// slow to traverse); >1 lets the box lead the cursor so less hand-movement
// covers more ground. Tune to taste.
const PAN_SENSITIVITY = 1.4;

export default function Minimap({
  pieces,
  pieceWidth,
  pieceHeight,
  accentColor,
  viewportScale,
  viewportOffsetX,
  viewportOffsetY,
  containerWidth,
  containerHeight,
  setViewportOffsetX,
  setViewportOffsetY,
  groupPills = [],
  isDragActive = false
}) {
  const svgRef = useRef(null);
  const layoutRef = useRef(null);
  const containerRef = useRef(null);
  const dragRef = useRef(null);
  // Snapshot of the map transform (scale + origin) captured just before a canvas
  // drag begins, so the map can hold that transform steady for the drag's
  // duration (feedback #22) instead of rescaling as the dragged piece pushes the
  // content bounds outward.
  const dragLayoutRef = useRef(null);
  // Active viewport-pan gesture. Holds a frozen layout snapshot so the map
  // doesn't rescale mid-drag, plus the grab offset for relative dragging.
  const panRef = useRef(null);
  const [position, setPosition] = useState({ x: null, y: null });
  const [collapsed, setCollapsed] = useState(false);
  // "Driving" the minimap — panning the viewport or repositioning the widget.
  // Only while active does the frame pick up the electric-blue glow.
  const [isActive, setIsActive] = useState(false);

  const contentBounds = computeContentBounds(pieces, pieceWidth, pieceHeight, groupPills);

  if (contentBounds) {
    const viewLeft = -viewportOffsetX / viewportScale;
    const viewTop = -viewportOffsetY / viewportScale;
    const viewWidth = containerWidth / viewportScale;
    const viewHeight = containerHeight / viewportScale;

    // During a canvas drag, reuse the frozen transform (mapScale + origin) so the
    // map doesn't rescale/reposition under the cursor. Pieces and the viewport
    // rect still render live through it — only the whole-map zoom is held. The
    // rescale reapplies on the first post-drop render (dragLayoutRef refreshes in
    // the else branch). Falls through to a live recompute if no snapshot exists.
    const frozen = isDragActive ? dragLayoutRef.current : null;
    if (frozen) {
      layoutRef.current = {
        mapScale: frozen.mapScale,
        allMinX: frozen.allMinX,
        allMinY: frozen.allMinY,
        viewLeft, viewTop, viewWidth, viewHeight
      };
    } else {
      const allMinX = Math.min(contentBounds.minX, viewLeft);
      const allMinY = Math.min(contentBounds.minY, viewTop);
      const allMaxX = Math.max(contentBounds.maxX, viewLeft + viewWidth);
      const allMaxY = Math.max(contentBounds.maxY, viewTop + viewHeight);

      const worldWidth = allMaxX - allMinX || 1;
      const worldHeight = allMaxY - allMinY || 1;
      const innerW = MINIMAP_SIZE - MINIMAP_PADDING * 2;
      const innerH = MINIMAP_SIZE - MINIMAP_PADDING * 2;

      layoutRef.current = {
        mapScale: Math.min(innerW / worldWidth, innerH / worldHeight),
        allMinX, allMinY,
        viewLeft, viewTop, viewWidth, viewHeight
      };
      // Keep the freeze source current so the next drag starts from this layout.
      dragLayoutRef.current = layoutRef.current;
    }
  }

  // --- Pan via the SVG. The gesture works off a frozen layout snapshot taken
  //     on press, so the map can't rescale under the cursor while dragging. ---
  const applyPan = useCallback((e) => {
    const svg = svgRef.current;
    const pan = panRef.current;
    if (!svg || !pan) return;
    const { snapshot, worldX0, worldY0, centerX0, centerY0 } = pan;
    const rect = svg.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const worldX = (mx - MINIMAP_PADDING) / snapshot.mapScale + snapshot.allMinX;
    const worldY = (my - MINIMAP_PADDING) / snapshot.mapScale + snapshot.allMinY;
    // Move the view by the cursor delta from the grab origin, amplified by the
    // sensitivity gain. At the origin this is a no-op (no teleport on grab).
    const centerX = centerX0 + (worldX - worldX0) * PAN_SENSITIVITY;
    const centerY = centerY0 + (worldY - worldY0) * PAN_SENSITIVITY;
    setViewportOffsetX(-(centerX - snapshot.viewWidth / 2) * viewportScale);
    setViewportOffsetY(-(centerY - snapshot.viewHeight / 2) * viewportScale);
  }, [setViewportOffsetX, setViewportOffsetY, viewportScale]);

  const handleMapPointerDown = useCallback((e) => {
    const live = layoutRef.current;
    if (!live) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const rect = e.currentTarget.getBoundingClientRect();
    const worldX = (e.clientX - rect.left - MINIMAP_PADDING) / live.mapScale + live.allMinX;
    const worldY = (e.clientY - rect.top - MINIMAP_PADDING) / live.mapScale + live.allMinY;
    const insideViewport =
      worldX >= live.viewLeft && worldX <= live.viewLeft + live.viewWidth &&
      worldY >= live.viewTop && worldY <= live.viewTop + live.viewHeight;
    // Inside the viewport box → grab it where it is (no jump). Outside → recenter
    // on the cursor first, then drag relative from there.
    const centerX0 = insideViewport ? live.viewLeft + live.viewWidth / 2 : worldX;
    const centerY0 = insideViewport ? live.viewTop + live.viewHeight / 2 : worldY;
    panRef.current = { snapshot: { ...live }, worldX0: worldX, worldY0: worldY, centerX0, centerY0 };
    setIsActive(true);
    applyPan(e);
  }, [applyPan]);

  const handleMapPointerMove = useCallback((e) => {
    if (!panRef.current || e.buttons !== 1) return;
    applyPan(e);
  }, [applyPan]);

  const handleMapPointerUp = useCallback(() => {
    panRef.current = null;
    setIsActive(false);
  }, []);

  // --- Drag the minimap widget by its title bar ---
  const handleTitlePointerDown = useCallback((e) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    dragRef.current = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top };
    e.currentTarget.setPointerCapture(e.pointerId);
    setIsActive(true);
  }, []);

  const handleTitlePointerMove = useCallback((e) => {
    if (!dragRef.current || e.buttons !== 1) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setPosition({ x: dragRef.current.origX + dx, y: dragRef.current.origY + dy });
  }, []);

  const handleTitlePointerUp = useCallback(() => {
    dragRef.current = null;
    setIsActive(false);
  }, []);

  const toggleCollapse = useCallback(() => setCollapsed((prev) => !prev), []);

  // Fail-visible: the widget always renders its frame while toggled on. An empty
  // or not-yet-loaded workspace shows an "empty" interior instead of vanishing —
  // a silent `return null` made the toggle look broken and the map "disappear".
  // While panning, render from the frozen snapshot so the map holds still and
  // only the viewport rectangle moves.
  const layout = panRef.current
    ? panRef.current.snapshot
    : (contentBounds ? layoutRef.current : null);
  const toMapX = (wx) => MINIMAP_PADDING + (wx - layout.allMinX) * layout.mapScale;
  const toMapY = (wy) => MINIMAP_PADDING + (wy - layout.allMinY) * layout.mapScale;

  const positionStyle = position.x != null
    ? { position: 'fixed', left: position.x, top: position.y, bottom: 'auto', right: 'auto' }
    : {};

  return (
    <div
      className={`minimap-container${isActive ? ' is-active' : ''}`}
      ref={containerRef}
      style={positionStyle}
    >
      <div
        className="minimap-titlebar"
        onPointerDown={handleTitlePointerDown}
        onPointerMove={handleTitlePointerMove}
        onPointerUp={handleTitlePointerUp}
      >
        <span className="minimap-title">Minimap</span>
        <button className="minimap-collapse-btn" onClick={toggleCollapse} title={collapsed ? 'Expand' : 'Collapse'}>
          {collapsed ? '▴' : '▾'}
        </button>
      </div>
      {!collapsed && (
        <svg
          ref={svgRef}
          className="minimap-svg"
          width={MINIMAP_SIZE}
          height={MINIMAP_SIZE}
          onPointerDown={layout ? handleMapPointerDown : undefined}
          onPointerMove={layout ? handleMapPointerMove : undefined}
          onPointerUp={layout ? handleMapPointerUp : undefined}
        >
          {layout ? (
            <>
              {groupPills.map((pill) => (
                <rect
                  key={`pill-${pill.id}`}
                  className="mm-group"
                  x={toMapX(pill.x)}
                  y={toMapY(pill.y)}
                  width={Math.max(2, SQUIRCLE_W * layout.mapScale)}
                  height={Math.max(2, SQUIRCLE_H * layout.mapScale)}
                  rx={Math.max(1, 4 * layout.mapScale)}
                />
              ))}
              {pieces.map((piece) => {
                const ps = piece.scale ?? 1;
                return (
                  <rect
                    key={piece.id}
                    className="mm-piece"
                    x={toMapX(piece.x)}
                    y={toMapY(piece.y)}
                    width={Math.max(1, pieceWidth * ps * layout.mapScale)}
                    height={Math.max(1, pieceHeight * ps * layout.mapScale)}
                    fill={piece.color || accentColor || 'var(--cm-electric-blue)'}
                    rx={Math.max(0.5, 1.5 * layout.mapScale)}
                  />
                );
              })}
              <rect
                className="mm-viewport"
                x={toMapX(layout.viewLeft)}
                y={toMapY(layout.viewTop)}
                width={Math.max(2, layout.viewWidth * layout.mapScale)}
                height={Math.max(2, layout.viewHeight * layout.mapScale)}
                rx={2}
              />
            </>
          ) : (
            <text
              className="mm-empty-label"
              x={MINIMAP_SIZE / 2}
              y={MINIMAP_SIZE / 2}
              textAnchor="middle"
              dominantBaseline="middle"
            >
              No nodes yet
            </text>
          )}
        </svg>
      )}
    </div>
  );
}

function computeContentBounds(pieces, pieceWidth, pieceHeight, groupPills = []) {
  if (!pieces.length && !groupPills.length) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const piece of pieces) {
    if (!Number.isFinite(piece.x) || !Number.isFinite(piece.y)) continue;
    const ps = piece.scale ?? 1;
    minX = Math.min(minX, piece.x);
    minY = Math.min(minY, piece.y);
    maxX = Math.max(maxX, piece.x + pieceWidth * ps);
    maxY = Math.max(maxY, piece.y + pieceHeight * ps);
  }
  for (const pill of groupPills) {
    if (!Number.isFinite(pill.x) || !Number.isFinite(pill.y)) continue;
    minX = Math.min(minX, pill.x);
    minY = Math.min(minY, pill.y);
    maxX = Math.max(maxX, pill.x + SQUIRCLE_W);
    maxY = Math.max(maxY, pill.y + SQUIRCLE_H);
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}
