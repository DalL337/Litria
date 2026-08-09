// ScaffoldContextMenu.jsx
// Right-click context menu for scaffold tree items.
// Uses a portal with fixed positioning at cursor coordinates.
// Styled with cm-context-* classes for consistent CM design.

import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const SWATCH_COLORS = [
  '#ef5350', '#ec407a', '#ab47bc', '#7e57c2',
  '#5c6bc0', '#42a5f5', '#26c6da', '#26a69a',
  '#66bb6a', '#9ccc65', '#ffa726', '#ff7043',
];

function ScaffoldContextMenu({
  position,    // { x, y } — viewport coords from contextmenu event
  target,      // { path, type } — what was right-clicked
  onOpen,      // (path) => void — open file in editor
  onRename,    // (path, type) => void — start inline rename
  onDelete,    // (path, type) => void — delete with confirmation
  onNewFile,   // (parentPath) => void — create file inside folder
  onNewFolder, // (parentPath) => void — create folder inside folder
  onSetFolderColor, // (path, color) => void — set edge assignment color
  folderColor, // string|null — current color for the target folder
  onClose      // () => void — dismiss menu
}) {
  const menuRef = useRef(null);

  // Click-outside and Escape dismiss
  useEffect(() => {
    if (!position || !target) return;

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
  }, [position, target, onClose]);

  const handleSelect = useCallback((action) => (e) => {
    e.stopPropagation();
    action();
    onClose?.();
  }, [onClose]);

  if (!position || !target) return null;

  const isFile = target.type === 'file';
  const isDir = target.type === 'dir';
  const isRoot = target.path === '';

  return createPortal(
    <div
      ref={menuRef}
      className="cm-context-content"
      style={{
        position: 'fixed',
        left: position.x,
        top: position.y,
        zIndex: 55,
      }}
      role="menu"
    >
      {isFile && (
        <>
          <button
            className="cm-context-item"
            role="menuitem"
            onClick={handleSelect(() => onOpen?.(target.path))}
          >
            Open
          </button>
          <button
            className="cm-context-item"
            role="menuitem"
            onClick={handleSelect(() => onRename?.(target.path, 'file'))}
          >
            Rename
          </button>
          <button
            className="cm-context-item"
            role="menuitem"
            data-variant="destructive"
            onClick={handleSelect(() => onDelete?.(target.path, 'file'))}
          >
            Delete
          </button>
        </>
      )}
      {isDir && !isRoot && (
        <>
          <button
            className="cm-context-item"
            role="menuitem"
            onClick={handleSelect(() => onNewFile?.(target.path))}
          >
            New File
          </button>
          <button
            className="cm-context-item"
            role="menuitem"
            onClick={handleSelect(() => onNewFolder?.(target.path))}
          >
            New Folder
          </button>
          <button
            className="cm-context-item"
            role="menuitem"
            onClick={handleSelect(() => onRename?.(target.path, 'dir'))}
          >
            Rename
          </button>
          <button
            className="cm-context-item"
            role="menuitem"
            data-variant="destructive"
            onClick={handleSelect(() => onDelete?.(target.path, 'dir'))}
          >
            Delete
          </button>
          {onSetFolderColor && (
            <>
              <div className="cm-context-divider" />
              <div className="cm-context-swatch-row" role="group" aria-label="Folder color">
                {SWATCH_COLORS.map((color) => (
                  <button
                    key={color}
                    type="button"
                    className={`cm-context-swatch${folderColor === color ? ' is-active' : ''}`}
                    style={{ backgroundColor: color }}
                    aria-label={`Set color ${color}`}
                    onClick={handleSelect(() => onSetFolderColor?.(target.path, color))}
                  />
                ))}
                {folderColor && (
                  <button
                    type="button"
                    className="cm-context-swatch is-clear"
                    aria-label="Clear color"
                    onClick={handleSelect(() => onSetFolderColor?.(target.path, null))}
                  >
                    ×
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
      {isDir && isRoot && (
        <>
          <button
            className="cm-context-item"
            role="menuitem"
            onClick={handleSelect(() => onNewFile?.(''))}
          >
            New File
          </button>
          <button
            className="cm-context-item"
            role="menuitem"
            onClick={handleSelect(() => onNewFolder?.(''))}
          >
            New Folder
          </button>
        </>
      )}
    </div>,
    document.body
  );
}

export default ScaffoldContextMenu;
