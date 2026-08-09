import { useEffect, cloneElement, isValidElement } from 'react';
import { X } from 'lucide-react';
import { useTopDrawers } from './TopDrawerContext';

function TopDrawerShell({ height = 300 }) {
  const { drawers, activeId, isOpen, toggleDrawer, closeDrawer } = useTopDrawers();
  const activeDrawer = drawers.find((d) => d.id === activeId);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        closeDrawer();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, closeDrawer]);

  return (
    <div
      className="top-drawer-root"
      style={{ '--top-drawer-height': `${height}px` }}
    >
      <div className={`top-drawer-rail ${isOpen ? 'is-obscured' : ''}`}>
        {drawers.map((drawer) => {
          const Icon = drawer.icon;
          const isActive = drawer.id === activeId && isOpen;
          return (
            <button
              key={drawer.id}
              className={`top-drawer-tab ${isActive ? 'is-active' : ''}`}
              type="button"
              onClick={() => toggleDrawer(drawer.id)}
              title={drawer.label}
              aria-pressed={isActive}
            >
              {Icon && <Icon size={20} />}
            </button>
          );
        })}
      </div>

      <div
        className={`top-drawer-scrim ${isOpen ? 'is-open' : ''}`}
        onClick={closeDrawer}
        aria-hidden="true"
      />

      <aside className={`top-drawer-panel ${isOpen ? 'is-open' : ''}`}>
        <div className="top-drawer-header">
          <div className="top-drawer-title">
            {activeDrawer ? activeDrawer.label : ''}
          </div>
          <button
            className="top-drawer-close"
            type="button"
            onClick={closeDrawer}
            aria-label="Close panel"
          >
            <X size={14} />
          </button>
        </div>
        <div className="top-drawer-content">
          {drawers.map((drawer) => {
            if (!isValidElement(drawer.content)) return null;
            const isActive = drawer.id === activeId;
            // contentKey (set by useTopDrawers) forces this wrapper to remount
            // when the underlying per-project resource changes, e.g. project
            // switch. The remount unmounts the old DrawerContentTerminal subtree
            // (running its cleanup effects) and mounts a fresh one for the new
            // project. See docs/plans/persistence/project-switch-crash-investigation.md.
            const wrapperKey = drawer.contentKey
              ? `${drawer.id}::${drawer.contentKey}`
              : drawer.id;
            return (
              <div
                key={wrapperKey}
                style={{ display: isActive ? 'contents' : 'none' }}
              >
                {cloneElement(drawer.content, { isVisible: isActive && isOpen })}
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

export default TopDrawerShell;
