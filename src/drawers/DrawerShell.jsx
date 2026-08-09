import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useDrawers } from './DrawerContext';

function clamp(value, min, max) {
  if (min > max) return 0;
  return Math.max(min, Math.min(max, value));
}

function DrawerShell({
  position = 'left',
  width = 320,
  showHeader = true,
  allowRailDragFromButtons = false,
  scrimCloses = true
}) {
  const { drawers, activeId, isOpen, toggleDrawer, closeDrawer } = useDrawers();
  const activeDrawer = drawers.find(d => d.id === activeId);

  const rootRef = useRef(null);
  const railRef = useRef(null);
  const dragState = useRef({ dragging: false, startY: 0, startOffset: 0 });
  const [railOffset, setRailOffset] = useState(0);
  const [railBounds, setRailBounds] = useState({ min: -200, max: 200 });

  useLayoutEffect(() => {
    const root = rootRef.current;
    const rail = railRef.current;
    if (!root || !rail) return;

    const rootHeight = root.offsetHeight;
    const railHeight = rail.offsetHeight;
    const padding = 48;
    const half = rootHeight / 2;
    const min = -(half - padding);
    const max = half - railHeight - padding;
    setRailBounds({ min, max });
    setRailOffset(offset => clamp(offset, min, max));
  }, [drawers.length, isOpen]);

  useEffect(() => {
    const handleMove = (e) => {
      if (!dragState.current.dragging) return;
      const delta = e.clientY - dragState.current.startY;
      const next = dragState.current.startOffset + delta;
      setRailOffset(clamp(next, railBounds.min, railBounds.max));
    };

    const handleUp = () => {
      dragState.current.dragging = false;
    };

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [railBounds.min, railBounds.max]);

  const handleRailMouseDown = (e) => {
    if (!allowRailDragFromButtons && e.target.closest('button')) return;
    dragState.current = {
      dragging: true,
      startY: e.clientY,
      startOffset: railOffset
    };
  };

  return (
    <div
      ref={rootRef}
      className={`drawer-root drawer-${position}`}
      style={{ '--drawer-width': `${width}px`, '--rail-offset': `${railOffset}px` }}
    >
      <div
        className={`drawer-scrim ${isOpen ? 'is-open' : ''}`}
        onClick={scrimCloses ? closeDrawer : undefined}
        aria-hidden="true"
      />
      <div
        ref={railRef}
        className={`drawer-rail ${isOpen ? 'is-obscured' : ''}`}
        onMouseDown={handleRailMouseDown}
      >
        {drawers.map(drawer => {
          const Icon = drawer.icon;
          const isActive = drawer.id === activeId && isOpen;
          return (
            <button
              key={drawer.id}
              className={`drawer-tab ${isActive ? 'is-active' : ''}`}
              type="button"
              onClick={() => toggleDrawer(drawer.id)}
              title={drawer.label}
              aria-pressed={isActive}
            >
              {Icon && <Icon size={18} />}
            </button>
          );
        })}
      </div>

      <aside className={`drawer-panel ${isOpen ? 'is-open' : ''}`}>
        {showHeader && (
          <div className="drawer-header">
            <div className="drawer-title">{activeDrawer ? activeDrawer.label : 'Drawer'}</div>
            <button
              className="drawer-close"
              type="button"
              onClick={closeDrawer}
              aria-label="Close drawer"
            >
              <X size={16} />
            </button>
          </div>
        )}
        {activeDrawer && (
          <button
            className="drawer-midtab"
            type="button"
            onClick={closeDrawer}
            aria-label={`Close ${activeDrawer.label} drawer`}
          >
            {activeDrawer.icon && <activeDrawer.icon size={18} />}
          </button>
        )}
        <div className={`drawer-content ${showHeader ? '' : 'drawer-content-full'}`}>
          {activeDrawer ? activeDrawer.content : null}
        </div>
      </aside>
    </div>
  );
}

export default DrawerShell;
