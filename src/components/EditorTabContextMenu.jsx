// EditorTabContextMenu.jsx
// Right-click context menu for editor tabs (ADR-017 split panes).
// State-aware items: "Open in New Pane" creates the split, "Send to Pane 1/2"
// targets an existing pane. Degenerate guard: a pane's only tab gets no
// "Open in New Pane" — there is nothing to split away from.
// Same portal + cm-context-* pattern as ScaffoldContextMenu.

import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

function EditorTabContextMenu({
  menu,          // { x, y, tabId, paneId } | null
  isSplit,       // split currently active
  canOpenInNewPane, // degenerate guard already applied by the caller
  onSendToPane,  // (tabId, paneId) => void
  onCloseTab,    // (tabId) => void
  onClose        // () => void — dismiss menu
}) {
  const menuRef = useRef(null);

  useEffect(() => {
    if (!menu) return undefined;
    const handlePointerDown = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        onClose?.();
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') onClose?.();
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menu, onClose]);

  const handleSelect = useCallback((action) => (e) => {
    e.stopPropagation();
    action();
    onClose?.();
  }, [onClose]);

  if (!menu) return null;

  return createPortal(
    <div
      ref={menuRef}
      className="cm-context-content"
      style={{
        position: 'fixed',
        left: menu.x,
        top: menu.y,
        zIndex: 60,
      }}
      role="menu"
    >
      {!isSplit && canOpenInNewPane && (
        <button
          className="cm-context-item"
          type="button"
          role="menuitem"
          onClick={handleSelect(() => onSendToPane(menu.tabId, 2))}
        >
          Open in New Pane
        </button>
      )}
      {isSplit && (
        <>
          <button
            className="cm-context-item"
            type="button"
            role="menuitem"
            onClick={handleSelect(() => onSendToPane(menu.tabId, 1))}
          >
            Send to Pane 1
          </button>
          <button
            className="cm-context-item"
            type="button"
            role="menuitem"
            onClick={handleSelect(() => onSendToPane(menu.tabId, 2))}
          >
            Send to Pane 2
          </button>
        </>
      )}
      {(isSplit || canOpenInNewPane) && <div className="cm-context-divider" />}
      <button
        className="cm-context-item"
        type="button"
        role="menuitem"
        data-variant="destructive"
        onClick={handleSelect(() => onCloseTab(menu.tabId))}
      >
        Close
      </button>
    </div>,
    document.body
  );
}

export default EditorTabContextMenu;
