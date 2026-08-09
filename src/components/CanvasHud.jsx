import { useCallback, useEffect, useRef, useState } from 'react';

// Canvas quick-action HUD (ADR-018 Phase A): screen-anchored glass cluster
// floating over the canvas. The pill is permanent chrome (drag grip + menu
// trigger); sections and the checkbox menu are both generated from the
// widget registry (hudState.HUD_WIDGETS) passed in as `widgets`.
//
// Phase A ships the Create section (New Node). Renderers for Phase B/C
// widgets (pan/zoom dial, help) slot into WIDGET_RENDERERS by id.

function CreateSection({ onNewNode, onNewGroup }) {
  return (
    <div className="hud-create-buttons">
      <button type="button" className="hud-new-node" onClick={onNewNode}>
        + Node
      </button>
      <button type="button" className="hud-new-group" onClick={onNewGroup}>
        + Group
      </button>
    </div>
  );
}

const PAN_HOLD_SPEED = 8; // px per frame while a wedge is held

// Pan & Zoom dial (ADR-018 Phase B): one circle carved into four wedge
// sectors wrapping a split Fit/1:1 hub, a zoom arc crowning the top.
// Geometry ported from the signed-off prototype. Hold-to-glide is
// user-driven rAF only — the no-ambient-animation perf lock holds.
function PanZoomSection({ panBy, zoomIn, zoomOut, onFitContent, resetZoom, viewportScale }) {
  const rafRef = useRef(null);

  const stopGlide = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const startGlide = useCallback((dx, dy) => (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    stopGlide();
    const step = () => {
      panBy(dx, dy);
      rafRef.current = requestAnimationFrame(step);
    };
    step();
  }, [panBy, stopGlide]);

  useEffect(() => stopGlide, [stopGlide]);

  const wedge = (cls, title, glyph, dx, dy) => (
    <button
      type="button"
      className={`hud-pz-wedge ${cls}`}
      title={title}
      onPointerDown={startGlide(dx, dy)}
      onPointerUp={stopGlide}
      onPointerCancel={stopGlide}
      onLostPointerCapture={stopGlide}
    >
      {glyph}
    </button>
  );

  return (
    <div className="hud-pz-cluster">
      <div className="hud-pz-ring">
        <button type="button" className="hud-pz-arc hud-pz-arc-l" title="Zoom out" onClick={zoomOut}>−</button>
        <button type="button" className="hud-pz-arc hud-pz-arc-r" title="Zoom in" onClick={zoomIn}>+</button>
      </div>
      <div className="hud-pz-dial">
        {wedge('hud-pz-n', 'Pan up (hold to glide)', '▲', 0, PAN_HOLD_SPEED)}
        {wedge('hud-pz-e', 'Pan right (hold to glide)', '▶', -PAN_HOLD_SPEED, 0)}
        {wedge('hud-pz-s', 'Pan down (hold to glide)', '▼', 0, -PAN_HOLD_SPEED)}
        {wedge('hud-pz-w', 'Pan left (hold to glide)', '◀', PAN_HOLD_SPEED, 0)}
        <div className="hud-pz-seams" aria-hidden="true" />
        <div className="hud-pz-hub">
          <button type="button" title="Fit all content" onClick={onFitContent}>Fit</button>
          <button type="button" title="Reset to 100%" onClick={resetZoom}>1:1</button>
        </div>
      </div>
      <span className="hud-pz-readout">{Math.round((viewportScale ?? 1) * 100)}%</span>
    </div>
  );
}

// Help — shortcuts (ADR-018 Phase C). Curation rule: gestures-first,
// non-duplicative. The menubar teaches command accelerators next to menu
// items; this widget covers what menus structurally can't — gestures —
// plus the few keys with NO menu row (modal/chord-only). Menu-covered
// accelerators (Ctrl+P, Ctrl+0, save, undo, …) are deliberately absent.
// Subsections are INTERNAL content — they don't exist in the container
// contract. Rows are hand-maintained (the shortcut registry doesn't
// model gestures yet — see docs/plans/ideas/shortcut-registry.md); every
// row must describe a real, shipped interaction.
const HELP_SUBSECTIONS = [
  { title: 'Drag', rows: [
    ['Empty canvas', 'Pan the view'],
    ['Node / group', 'Move it'],
    ['Node → group', 'Add to group'],
    ['Node → editor pane', 'Open it there'],
    ['HUD glass', 'Move the HUD'],
  ] },
  { title: 'Mouse + Keyboard', rows: [
    ['Wheel', 'Zoom to cursor'],
    ['Shift + Drag', 'Lasso select'],
    ['Dbl-click node', 'Open in editor'],
    ['Dbl-click group pill', 'Expand group'],
    ['Hold dial wedge', 'Glide the view'],
  ] },
  { title: 'Canvas Keys', rows: [
    ['E', 'Toggle edit mode'],
    ['Ctrl (tap)', 'Additive sub-mode'],
    ['Alt (tap)', 'Subtractive sub-mode'],
    ['← ↑ → ↓', 'Pan the view'],
    ['H', 'Show / hide HUD'],
  ] },
];

function HelpSection() {
  return (
    <div className="hud-help">
      {HELP_SUBSECTIONS.map((sub) => (
        <div key={sub.title} className="hud-help-sub">
          <div className="hud-help-sub-title">{sub.title}</div>
          {sub.rows.map(([keys, what]) => (
            <div key={keys} className="hud-help-row">
              <span className="hud-help-keys">{keys}</span>
              <span className="hud-help-what">{what}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const WIDGET_RENDERERS = {
  create: CreateSection,
  panzoom: PanZoomSection,
  help: HelpSection,
};

export default function CanvasHud({
  widgets,
  hudPosition,
  hudVisibleIds,
  isHudHidden,
  moveHud,
  commitHudPosition,
  toggleHudWidget,
  clampPosition,
  spawnGhost,
  onNewNode,
  onNewGroup,
  groupNameOverlay,
  onCommitGroupName,
  onCancelGroupName,
  panBy,
  zoomIn,
  zoomOut,
  onFitContent,
  resetZoom,
  viewportScale,
}) {
  const rootRef = useRef(null);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const dragRef = useRef(null);

  // Stable identity so React runs this only on mount/unmount of the name
  // input. An inline `ref={(el) => el?.select()}` re-fires on EVERY render
  // (new function each time), re-selecting the text — so the next keystroke
  // replaced everything typed so far.
  const selectOnMount = useCallback((el) => { el?.select(); }, []);

  const handlePointerDown = useCallback((e) => {
    // Any non-interactive glass drags; buttons/inputs/menu stay clickable.
    if (e.target.closest('button, input, label, .hud-menu')) return;
    e.preventDefault();
    const el = rootRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      originX: hudPosition.x,
      originY: hudPosition.y,
      size: { width: el.offsetWidth, height: el.offsetHeight },
      moved: false,
    };
  }, [hudPosition]);

  const handlePointerMove = useCallback((e) => {
    const drag = dragRef.current;
    if (!drag) return;
    drag.moved = true;
    moveHud(clampPosition({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    }, drag.size));
  }, [clampPosition, moveHud]);

  const handlePointerUp = useCallback((e) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag || !drag.moved) return;
    commitHudPosition(clampPosition({
      x: drag.originX + (e.clientX - drag.startX),
      y: drag.originY + (e.clientY - drag.startY),
    }, drag.size));
  }, [clampPosition, commitHudPosition]);

  // Close the menu on any pointerdown outside the HUD.
  useEffect(() => {
    if (!isMenuOpen) return;
    const onDocPointerDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setIsMenuOpen(false);
    };
    document.addEventListener('pointerdown', onDocPointerDown);
    return () => document.removeEventListener('pointerdown', onDocPointerDown);
  }, [isMenuOpen]);

  return (
    <>
      {spawnGhost && (
        <div
          className="hud-spawn-ghost"
          style={{
            left: spawnGhost.left,
            top: spawnGhost.top,
            width: spawnGhost.width,
            height: spawnGhost.height,
          }}
          aria-hidden="true"
        />
      )}
      {groupNameOverlay?.box && (
        // Name-first preview (W2): the box is not a group yet — a screen-space
        // outline stands in until the name commits and the folder exists.
        <div
          className="hud-group-preview-box"
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: groupNameOverlay.box.left,
            top: groupNameOverlay.box.top,
            width: groupNameOverlay.box.width,
            height: groupNameOverlay.box.height,
            border: '1.5px dashed rgba(179, 157, 219, 0.8)',
            borderRadius: 14,
            pointerEvents: 'none',
          }}
        />
      )}
      {groupNameOverlay && (
        <div
          className="hud-group-name-overlay"
          style={{ left: groupNameOverlay.left, top: groupNameOverlay.top }}
        >
          <input
            defaultValue={groupNameOverlay.name}
            spellCheck={false}
            ref={selectOnMount}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') onCommitGroupName?.(e.currentTarget.value);
              else if (e.key === 'Escape') onCancelGroupName?.();
            }}
            onBlur={(e) => onCommitGroupName?.(e.currentTarget.value)}
          />
        </div>
      )}
      {!isHudHidden && (
        <div
          ref={rootRef}
          className="canvas-hud"
          style={{ left: hudPosition.x, top: hudPosition.y }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          <div className="hud-pill">
            <span className="hud-pill-grip" aria-hidden="true">
              <i /><i /><i /><i /><i /><i />
            </span>
            <span className="hud-pill-title">Quick Actions</span>
            <button
              type="button"
              className="hud-menu-btn"
              title="Compose HUD"
              aria-label="Compose HUD"
              aria-expanded={isMenuOpen}
              onClick={() => setIsMenuOpen((open) => !open)}
            >
              ☰
            </button>
            {isMenuOpen && (
              <div className="hud-menu">
                <div className="hud-menu-heading">Widgets</div>
                {widgets.map((widget) => (
                  <label key={widget.id}>
                    <input
                      type="checkbox"
                      checked={hudVisibleIds.includes(widget.id)}
                      onChange={() => toggleHudWidget(widget.id)}
                    />
                    {widget.title}
                  </label>
                ))}
                <div className="hud-menu-hint">Press H to hide the whole HUD.</div>
              </div>
            )}
          </div>
          {widgets.map((widget) => {
            if (!hudVisibleIds.includes(widget.id)) return null;
            const Renderer = WIDGET_RENDERERS[widget.id];
            if (!Renderer) return null;
            return (
              <div key={widget.id} className="hud-section">
                <div className="hud-section-title">{widget.title}</div>
                <Renderer
                  onNewNode={onNewNode}
                  onNewGroup={onNewGroup}
                  panBy={panBy}
                  zoomIn={zoomIn}
                  zoomOut={zoomOut}
                  onFitContent={onFitContent}
                  resetZoom={resetZoom}
                  viewportScale={viewportScale}
                />
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
