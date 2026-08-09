import { useEffect, useState } from 'react';
import { List, X, Pin, PinOff } from 'lucide-react';

/**
 * LauncherRecentsDrawer — left-anchored slide-out drawer for the launcher's
 * recent projects. Mirrors the canvas drawer visual language (left rail tab,
 * slide-in panel, electric-blue leading edge, header close on the right) but is
 * self-contained and auto-sizes its width to the longest entry so the list
 * never needs a horizontal scrollbar. Opens from the left; closes from the
 * right (header X), the scrim, or Escape.
 *
 * Renders nothing when there are no recents — the tab only appears once there's
 * something to reopen.
 */
export default function LauncherRecentsDrawer({
  recents = [],
  onOpenRecent,
  onPinProject,
  onRemoveProject,
  disabled = false,
}) {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => { if (e.key === 'Escape') setIsOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen]);

  if (!Array.isArray(recents) || recents.length === 0) return null;

  const handleOpen = (rootPath) => {
    if (disabled) return;
    setIsOpen(false);
    onOpenRecent?.(rootPath);
  };

  return (
    <div className="launch-drawer">
      <div
        className={`launch-drawer-scrim ${isOpen ? 'is-open' : ''}`}
        onClick={() => setIsOpen(false)}
        aria-hidden="true"
      />
      <button
        className={`launch-drawer-tab ${isOpen ? 'is-active' : ''}`}
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        title="Recent projects"
        aria-label="Recent projects"
        aria-pressed={isOpen}
      >
        <List size={18} />
      </button>

      <aside className={`launch-drawer-panel ${isOpen ? 'is-open' : ''}`}>
        <div className="launch-drawer-header">
          <div className="launch-drawer-title">Recent</div>
          <button
            className="launch-drawer-close"
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="Close recent projects"
          >
            <X size={16} />
          </button>
        </div>
        <div className="launch-drawer-content">
          {recents.map((entry) => (
            <div className="launch-recent" key={entry.rootPath}>
              <button
                className="launch-recent-open"
                type="button"
                onClick={() => handleOpen(entry.rootPath)}
                disabled={disabled}
                title={entry.rootPath}
              >
                <span className="launch-recent-name">
                  {entry.pinned && (
                    <Pin className="launch-recent-pin-badge" size={12} aria-hidden="true" />
                  )}
                  {entry.name}
                </span>
                <span className="launch-recent-path">{entry.rootPath}</span>
              </button>
              <div className="launch-recent-actions">
                <button
                  className="launch-recent-icon"
                  type="button"
                  onClick={() => onPinProject?.(entry.rootPath, !entry.pinned)}
                  disabled={typeof onPinProject !== 'function'}
                  title={entry.pinned ? 'Unpin' : 'Pin'}
                  aria-label={entry.pinned ? 'Unpin project' : 'Pin project'}
                >
                  {entry.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                </button>
                <button
                  className="launch-recent-icon"
                  type="button"
                  onClick={() => onRemoveProject?.(entry.rootPath)}
                  disabled={typeof onRemoveProject !== 'function'}
                  title="Forget"
                  aria-label="Forget project"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}
