import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Eye, EyeOff, FolderPlus, SquarePlus } from 'lucide-react';
import { useDrawers } from './DrawerContext';
import useScaffoldDrag from '../behaviors/useScaffoldDrag';
import ScaffoldContextMenu from '../components/ScaffoldContextMenu';
import { usePlatformConfig } from '../platform/usePlatformConfig';
import { normalizePath, findReservedDeviceSegment } from '../utils/path';

const FILE_TYPE_LABELS = {
  dir: 'Folder',
  file: 'File'
};

function buildTree(entries) {
  const root = { name: '', path: '', type: 'dir', children: [] };
  const byPath = new Map([['', root]]);

  entries.forEach((entry) => {
    const parts = entry.path.split('/').filter(Boolean);
    let currentPath = '';
    let parent = root;
    parts.forEach((part, index) => {
      currentPath = currentPath ? `${currentPath}/${part}` : part;
      if (!byPath.has(currentPath)) {
        const isLeaf = index === parts.length - 1;
        const nodeType = isLeaf ? entry.entryType : 'dir';
        const node = {
          name: part,
          path: currentPath,
          type: nodeType,
          children: []
        };
        byPath.set(currentPath, node);
        parent.children.push(node);
      }
      parent = byPath.get(currentPath);
    });
  });

  const sortTree = (node) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });
    node.children.forEach(sortTree);
  };
  sortTree(root);
  return root;
}

function getNameFromPath(path) {
  if (!path) return '';
  const parts = path.split('/');
  return parts[parts.length - 1] || '';
}

function hasInvalidChars(name) {
  return /[/\\]/.test(name);
}

function InlineNameInput({ defaultValue, onConfirm, onCancel, depth }) {
  const inputRef = useRef(null);
  const [value, setValue] = useState(defaultValue ?? '');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, []);

  const handleConfirm = () => {
    const trimmed = value.trim();
    if (!trimmed) {
      setError('Name cannot be empty');
      return;
    }
    if (hasInvalidChars(trimmed)) {
      setError('Name cannot contain / or \\');
      return;
    }
    if (findReservedDeviceSegment(trimmed)) {
      setError(`"${trimmed}" is a reserved name on Windows`);
      return;
    }
    onConfirm(trimmed);
  };

  return (
    <div className="scaffold-tree-row-header scaffold-inline-input-row">
      <span className="scaffold-tree-toggle-spacer" />
      <div className="scaffold-inline-input-wrap" style={{ paddingLeft: `${8 + (depth ?? 1) * 12}px` }}>
        <input
          ref={inputRef}
          className={`scaffold-inline-input ${error ? 'is-invalid' : ''}`}
          type="text"
          value={value}
          onChange={(e) => { setValue(e.target.value); setError(null); }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleConfirm(); }
            if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            e.stopPropagation();
          }}
          onBlur={onCancel}
          spellCheck={false}
        />
        {error && <div className="scaffold-inline-error">{error}</div>}
      </div>
    </div>
  );
}

function DrawerContentScaffold({
  projectInstance,
  listTree,
  onSelectEntry,
  onOpenEntry,
  onToggleVisibility,
  onScaffoldDrop,
  onFileDropOnPane,
  onContextOpen,
  onContextRename,
  onContextDelete,
  onContextNewFile,
  onContextNewFolder,
  selectedPath,
  hiddenPaths = [],
  refreshToken,
  pendingRequest,
  onSetFolderColor,
  getFolderColor,
  onDragToCanvas,
  onCreateNode
}) {
  const [treeEntries, setTreeEntries] = useState([]);
  const [collapsedDirsLoaded, setCollapsedDirsLoaded] = useState(false);
  const [collapsedDirs, setCollapsedDirs] = useState(() => new Set());
  const [focusedPath, setFocusedPath] = useState(null);
  const treeRef = useRef(null);
  const { isOpen, activeId } = useDrawers();
  const scaffoldDrag = useScaffoldDrag();
  const { hiddenFiles } = usePlatformConfig();

  // Pending canvas drop — set by drag mouseup, consumed by effect.
  const [pendingCanvasDrop, setPendingCanvasDrop] = useState(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState(null); // { position: {x,y}, target: {path,type} }

  // Inline rename state
  const [renameTarget, setRenameTarget] = useState(null); // { path, type }

  // Inline new item state
  const [newItemTarget, setNewItemTarget] = useState(null); // { parentPath, kind: 'file'|'dir' }

  const rootLabel = useMemo(() => {
    if (projectInstance?.name) return projectInstance.name;
    const raw = projectInstance?.rootPath ?? '';
    const normalized = raw.replace(/\\/g, '/').replace(/\/+$/, '');
    return normalized.split('/').pop() || 'Project';
  }, [projectInstance?.name, projectInstance?.rootPath]);
  const rootPath = projectInstance?.rootPath ?? '';

  const isOsHiddenFile = useCallback((name) => {
    return hiddenFiles.some((pattern) => {
      if (pattern.endsWith('*')) return name.startsWith(pattern.slice(0, -1));
      return name === pattern;
    });
  }, [hiddenFiles]);

  const refreshTree = useCallback(async () => {
    if (!projectInstance?.rootPath) return;
    if (typeof listTree !== 'function') return;
    const entries = await listTree(projectInstance.rootPath);
    if (Array.isArray(entries)) {
      const filtered = entries.filter((e) => {
        const name = e.path.replace(/\\/g, '/').split('/').pop();
        return !isOsHiddenFile(name);
      });
      setTreeEntries(filtered);
    }
  }, [listTree, projectInstance?.rootPath, isOsHiddenFile]);

  useEffect(() => {
    refreshTree();
  }, [refreshTree, refreshToken]);

  // ── Persist collapsed dirs in localStorage keyed by project root ──
  const storageKey = rootPath ? `cm:scaffold:collapsed:${rootPath.replace(/\\/g, '/')}` : null;

  // Load saved state or collapse-all on first tree load.
  useEffect(() => {
    if (!treeEntries.length || collapsedDirsLoaded) return;

    if (storageKey) {
      try {
        const saved = localStorage.getItem(storageKey);
        if (saved) {
          const parsed = JSON.parse(saved);
          // Only use saved state if it's a non-empty array (empty = stale pre-fix data).
          if (Array.isArray(parsed) && parsed.length > 0) {
            setCollapsedDirs(new Set(parsed));
            setCollapsedDirsLoaded(true);
            return;
          }
        }
      } catch { /* ignore malformed data */ }
    }

    // No saved state — collapse all directories by default.
    const allDirs = new Set();
    for (const entry of treeEntries) {
      if (entry.entryType === 'dir') {
        allDirs.add(entry.path);
      }
    }
    setCollapsedDirs(allDirs);
    setCollapsedDirsLoaded(true);
  }, [treeEntries, collapsedDirsLoaded, storageKey]);

  // Save collapsed state to localStorage on changes (debounced via effect).
  useEffect(() => {
    if (!storageKey || !collapsedDirsLoaded) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify([...collapsedDirs]));
    } catch { /* quota exceeded — non-critical */ }
  }, [collapsedDirs, storageKey, collapsedDirsLoaded]);

  // Reset collapsed state when project changes.
  useEffect(() => {
    setCollapsedDirsLoaded(false);
    setCollapsedDirs(new Set());
  }, [rootPath]);

  const toggleDir = (path) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  const treeRoot = useMemo(() => buildTree(treeEntries), [treeEntries]);
  const flatTree = useMemo(() => {
    const items = [];
    const parentByPath = new Map();
    const walk = (node, depth = 0, parentPath = null) => {
      node.children.forEach((child) => {
        items.push({
          path: child.path,
          type: child.type,
          depth,
          hasChildren: Boolean(child.children?.length)
        });
        parentByPath.set(child.path, parentPath);
        if (child.children?.length && !collapsedDirs.has(child.path)) {
          walk(child, depth + 1, child.path);
        }
      });
    };
    walk(treeRoot, 1, null);
    return { items, parentByPath };
  }, [collapsedDirs, treeRoot]);

  // Siblings at a given depth for duplicate name validation
  const getSiblingNames = useCallback((parentPath) => {
    const parent = parentPath || '';
    return flatTree.items
      .filter((item) => {
        const itemParent = flatTree.parentByPath.get(item.path) ?? '';
        return itemParent === parent || (parent === '' && itemParent === null);
      })
      .map((item) => getNameFromPath(item.path).toLowerCase());
  }, [flatTree]);

  useEffect(() => {
    if (!selectedPath) return;
    setFocusedPath(selectedPath);
  }, [selectedPath]);

  useEffect(() => {
    if (!isOpen || activeId !== 'scaffold') return;
    if (treeRef.current) {
      treeRef.current.focus();
    }
  }, [activeId, isOpen, treeEntries.length]);

  useEffect(() => {
    if (!isOpen || activeId !== 'scaffold') return;
    if (!selectedPath || !treeRef.current) return;
    const escape = (value) => {
      if (typeof window !== 'undefined' && window.CSS?.escape) {
        return window.CSS.escape(value);
      }
      return value.replace(/["\\]/g, '\\$&');
    };
    const selector = `[data-path="${escape(selectedPath)}"]`;
    const target = treeRef.current.querySelector(selector);
    if (target && typeof target.scrollIntoView === 'function') {
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [activeId, collapsedDirs, isOpen, selectedPath, treeEntries.length]);

  // --- Document-level drag listeners ---
  useEffect(() => {
    if (!scaffoldDrag.isDragging) return;

    const handleMouseMove = (e) => {
      scaffoldDrag.updatePendingDrag(e.clientX, e.clientY);

      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      const rowHeader = elements.find((el) => el.classList?.contains('scaffold-tree-row-header'));
      if (rowHeader) {
        const entryBtn = rowHeader.querySelector('.scaffold-tree-entry');
        const path = entryBtn?.dataset?.path;
        if (path != null) {
          const item = flatTree.items.find((i) => i.path === path);
          if (item) {
            scaffoldDrag.computeDropTarget(e.clientY, rowHeader, item);
            return;
          }
        }
        const isRoot = entryBtn?.classList?.contains('scaffold-tree-root');
        if (isRoot) {
          scaffoldDrag.computeDropTarget(e.clientY, rowHeader, { path: '', type: 'dir' });
          return;
        }
      }
      scaffoldDrag.computeDropTarget(e.clientY, null, null);
    };

    const handleMouseUp = (e) => {
      // Capture the drag item BEFORE endDrag clears it.
      const draggedItem = scaffoldDrag.dragItem;
      const result = scaffoldDrag.endDrag();
      if (result) {
        onScaffoldDrop?.(result);
      } else if (draggedItem) {
        // Editor pane drop (ADR-017 Phase C): a FILE released over a pane
        // strip or editor surface opens there instead of canvas-spawning a
        // piece hidden behind the drawer (the old outside-tree fallback).
        const paneEl = draggedItem.type === 'file' && typeof onFileDropOnPane === 'function'
          ? document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-pane-drop]')
          : null;
        if (paneEl) {
          onFileDropOnPane(draggedItem.path, Number(paneEl.dataset.paneDrop));
          return;
        }
        // No valid scaffold drop target — user dragged outside the tree.
        // Queue a canvas spawn via state (avoids stale closure issues).
        setPendingCanvasDrop({ path: draggedItem.path, entryType: draggedItem.type });
      }
    };

    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        scaffoldDrag.cancelDrag();
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [scaffoldDrag.isDragging, flatTree.items, onScaffoldDrop, onFileDropOnPane, scaffoldDrag]);

  useEffect(() => {
    if (scaffoldDrag.isDragging || !scaffoldDrag.isPending) return;

    const handleMouseMove = (e) => {
      scaffoldDrag.updatePendingDrag(e.clientX, e.clientY);
    };

    const handleMouseUp = () => {
      scaffoldDrag.cancelDrag();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [scaffoldDrag.isDragging, scaffoldDrag.isPending, scaffoldDrag]);

  const handleTreeKeyDown = (event) => {
    if (!flatTree.items.length) return;
    const currentIndex = flatTree.items.findIndex((item) => item.path === focusedPath);
    const safeIndex = currentIndex >= 0 ? currentIndex : 0;
    const current = flatTree.items[safeIndex];
    const moveTo = (nextIndex) => {
      const next = flatTree.items[nextIndex];
      if (!next) return;
      setFocusedPath(next.path);
      onSelectEntry?.({ path: next.path, entryType: next.type });
    };

    switch (event.key) {
      case 'ArrowDown': {
        event.preventDefault();
        moveTo(Math.min(flatTree.items.length - 1, safeIndex + 1));
        break;
      }
      case 'ArrowUp': {
        event.preventDefault();
        moveTo(Math.max(0, safeIndex - 1));
        break;
      }
      case 'ArrowRight': {
        event.preventDefault();
        if (current?.type === 'dir') {
          if (collapsedDirs.has(current.path)) {
            toggleDir(current.path);
          } else if (current.hasChildren) {
            moveTo(Math.min(flatTree.items.length - 1, safeIndex + 1));
          }
        }
        break;
      }
      case 'ArrowLeft': {
        event.preventDefault();
        if (current?.type === 'dir' && !collapsedDirs.has(current.path)) {
          toggleDir(current.path);
          break;
        }
        const parent = flatTree.parentByPath.get(current?.path);
        if (parent) {
          const parentIndex = flatTree.items.findIndex((item) => item.path === parent);
          if (parentIndex >= 0) {
            moveTo(parentIndex);
          }
        }
        break;
      }
      case 'Enter': {
        event.preventDefault();
        if (current?.type === 'file') {
          onOpenEntry?.({ path: current.path, entryType: current.type });
        } else if (current?.type === 'dir') {
          toggleDir(current.path);
        }
        break;
      }
      default:
        break;
    }
  };

  const handleEntryMouseDown = useCallback((e, child) => {
    if (e.button !== 0) return;
    scaffoldDrag.startPendingDrag(
      { path: child.path, type: child.type },
      e.clientX,
      e.clientY
    );
  }, [scaffoldDrag]);

  // ── Process pending canvas drop with fresh callback reference ──
  useEffect(() => {
    if (!pendingCanvasDrop) return;
    setPendingCanvasDrop(null);
    onDragToCanvas?.(pendingCanvasDrop);
  }, [pendingCanvasDrop, onDragToCanvas]);

  // --- Context menu handlers ---
  const handleContextMenu = useCallback((event, child) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      position: { x: event.clientX, y: event.clientY },
      target: { path: child.path, type: child.type }
    });
  }, []);

  const handleContextClose = useCallback(() => {
    setContextMenu(null);
  }, []);

  const handleContextOpenAction = useCallback((path) => {
    onContextOpen?.(path);
    onOpenEntry?.({ path, entryType: 'file' });
  }, [onContextOpen, onOpenEntry]);

  const handleContextRenameAction = useCallback((path, type) => {
    setRenameTarget({ path, type });
  }, []);

  const handleRenameConfirm = useCallback((newName) => {
    if (!renameTarget) return;
    const parentPath = renameTarget.path.includes('/')
      ? renameTarget.path.substring(0, renameTarget.path.lastIndexOf('/'))
      : '';
    const siblings = getSiblingNames(parentPath);
    const oldName = getNameFromPath(renameTarget.path).toLowerCase();
    if (siblings.filter((n) => n !== oldName).includes(newName.toLowerCase())) {
      return; // Duplicate — silently reject (input shows no error since we cancelled)
    }
    onContextRename?.(renameTarget.path, renameTarget.type, newName);
    setRenameTarget(null);
  }, [renameTarget, getSiblingNames, onContextRename]);

  const handleRenameCancel = useCallback(() => {
    setRenameTarget(null);
  }, []);

  const handleContextDeleteAction = useCallback((path, type) => {
    const name = getNameFromPath(path) || 'this item';
    const confirmed = window.confirm(`Delete ${name}? This cannot be undone.`);
    if (confirmed) {
      onContextDelete?.(path, type);
    }
  }, [onContextDelete]);

  const handleContextNewFileAction = useCallback((parentPath) => {
    setNewItemTarget({ parentPath, kind: 'file' });
    // Expand parent folder so the input is visible
    if (parentPath) {
      setCollapsedDirs((prev) => {
        const next = new Set(prev);
        next.delete(parentPath);
        return next;
      });
    }
  }, []);

  const handleContextNewFolderAction = useCallback((parentPath) => {
    setNewItemTarget({ parentPath, kind: 'dir' });
    if (parentPath) {
      setCollapsedDirs((prev) => {
        const next = new Set(prev);
        next.delete(parentPath);
        return next;
      });
    }
  }, []);

  const handleNewItemConfirm = useCallback((name) => {
    if (!newItemTarget) return;
    const siblings = getSiblingNames(newItemTarget.parentPath);
    if (siblings.includes(name.toLowerCase())) {
      return; // Duplicate
    }
    if (newItemTarget.kind === 'file') {
      onContextNewFile?.(newItemTarget.parentPath, name);
    } else {
      onContextNewFolder?.(newItemTarget.parentPath, name);
    }
    setNewItemTarget(null);
  }, [newItemTarget, getSiblingNames, onContextNewFile, onContextNewFolder]);

  const handleNewItemCancel = useCallback(() => {
    setNewItemTarget(null);
  }, []);

  // New Node pill — folds in the former "Create New Piece" flow.
  const handleCreateNode = useCallback(() => {
    onCreateNode?.();
  }, [onCreateNode]);

  // New Group pill — a group is a folder (reconciled into a group on the canvas).
  // Start an inline new-folder input at the project root, expanding root so it's visible.
  const handleCreateGroup = useCallback(() => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      next.delete('__root__');
      return next;
    });
    setNewItemTarget({ parentPath: '', kind: 'dir' });
  }, []);

  // Menu-triggered create (feedback #7): the menu bar bumps pendingRequest's
  // token and we start the same inline name input the context menu uses.
  // Parent derivation compares normalized-to-normalized but keeps the RAW tree
  // path for newItemTarget/collapsedDirs (raw-vs-normalized mismatch was
  // feedback #23). target 'focus' lands beside the focused file, falling back
  // to project root; 'root' is the New Group flow.
  const consumedRequestTokenRef = useRef(0);
  useEffect(() => {
    if (!pendingRequest?.token) return;
    if (pendingRequest.token === consumedRequestTokenRef.current) return;
    consumedRequestTokenRef.current = pendingRequest.token;
    const { kind, target } = pendingRequest;
    if (kind !== 'newFile' && kind !== 'newFolder') return;

    let parentPath = '';
    if (target === 'focus' && selectedPath) {
      const match = treeEntries.find((entry) => normalizePath(entry.path) === selectedPath);
      if (match) {
        parentPath = match.entryType === 'dir'
          ? match.path
          : (match.path.includes('/') ? match.path.slice(0, match.path.lastIndexOf('/')) : '');
      }
    }

    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      next.delete(parentPath || '__root__');
      return next;
    });
    setNewItemTarget({ parentPath, kind: kind === 'newFile' ? 'file' : 'dir' });
  }, [pendingRequest, selectedPath, treeEntries]);

  // --- Drop indicator helpers ---
  const getDropIndicatorClass = (childPath) => {
    if (!scaffoldDrag.isDragging || !scaffoldDrag.dropTarget) return '';
    if (scaffoldDrag.dropTarget.path !== childPath) return '';
    if (scaffoldDrag.dropTarget.position === 'inside') return 'is-drop-inside';
    return '';
  };

  const showDropLineBefore = (childPath) => {
    if (!scaffoldDrag.isDragging || !scaffoldDrag.dropTarget) return false;
    return scaffoldDrag.dropTarget.path === childPath && scaffoldDrag.dropTarget.position === 'before';
  };

  const showDropLineAfter = (childPath) => {
    if (!scaffoldDrag.isDragging || !scaffoldDrag.dropTarget) return false;
    return scaffoldDrag.dropTarget.path === childPath && scaffoldDrag.dropTarget.position === 'after';
  };

  // Compute depth for a new item's parent
  const getDepthForParent = (parentPath) => {
    if (!parentPath) return 2; // Root level children are depth 1, new item inside root = depth 2
    const parentItem = flatTree.items.find((i) => i.path === parentPath);
    return parentItem ? parentItem.depth + 1 : 2;
  };

  const renderTree = (node, depth = 0) => (
    node.children.map((child, index) => {
      const isDragSource = scaffoldDrag.isDragging && scaffoldDrag.dragItem?.path === child.path;
      const isRenaming = renameTarget?.path === child.path;
      // └ elbow eligibility: last sibling with no rendered subtree below it
      // (an expanded folder's rail must keep running through its children —
      // see the depth-rail comment in scaffold.css).
      const rendersSubtree = Boolean(
        (child.children?.length || newItemTarget?.parentPath === child.path) && !collapsedDirs.has(child.path)
      );
      const isElbow = index === node.children.length - 1 && !rendersSubtree;
      // hiddenPaths stores NORMALIZED paths (see handleToggleScaffoldVisibility),
      // but child.path is raw and may carry backslashes / a leading slash. Compare
      // on the same normalized key so the toggle's visual state actually updates
      // (Windows raw-vs-normalized mismatch was feedback #23).
      const isEntryHidden = hiddenPaths.includes(normalizePath(child.path));

      return (
        <div key={child.path} className={`scaffold-tree-row is-${child.type}${isElbow ? ' is-last-child' : ''}`}>
          {showDropLineBefore(child.path) && (
            <div className="scaffold-drop-line" style={{ marginLeft: `${32 + depth * 12}px` }} />
          )}
          <div
            className={`scaffold-tree-row-header ${getDropIndicatorClass(child.path)} ${isDragSource ? 'is-drag-source' : ''}`}
            data-row-path={child.path}
          >
            {child.type === 'dir' && (child.children?.length || newItemTarget?.parentPath === child.path) ? (
              <button
                className="scaffold-tree-toggle"
                type="button"
                onClick={() => toggleDir(child.path)}
                title={collapsedDirs.has(child.path) ? 'Expand folder' : 'Collapse folder'}
                aria-label={collapsedDirs.has(child.path) ? 'Expand folder' : 'Collapse folder'}
              >
                {collapsedDirs.has(child.path) ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
            ) : (
              // Empty dirs get the spacer, not a chevron: an expand affordance
              // on a folder with nothing in it promises hidden contents and
              // toggles nothing — with sibling files directly below, the tree
              // read as if they were inside it (owner misread 2026-07-26).
              <span className="scaffold-tree-toggle-spacer" />
            )}
            {isRenaming ? (
              <div className="scaffold-inline-input-wrap" style={{ paddingLeft: `${8 + depth * 12}px` }}>
                <InlineNameInput
                  defaultValue={child.name}
                  onConfirm={handleRenameConfirm}
                  onCancel={handleRenameCancel}
                  depth={depth}
                />
              </div>
            ) : (
              <button
                className={`scaffold-tree-entry ${isEntryHidden ? 'is-hidden' : ''} ${
                  (selectedPath === child.path || focusedPath === child.path) ? 'is-active' : ''
                }`}
                type="button"
                style={{ paddingLeft: `${8 + depth * 12}px`, '--scaffold-depth': depth }}
                onClick={() => onSelectEntry?.({ path: child.path, entryType: child.type })}
                data-path={child.path}
                onMouseDown={(e) => handleEntryMouseDown(e, child)}
                onDoubleClick={() => {
                  onOpenEntry?.({ path: child.path, entryType: child.type });
                }}
                onContextMenu={(e) => handleContextMenu(e, child)}
                title={`${FILE_TYPE_LABELS[child.type] ?? 'Entry'}: ${child.path}`}
              >
                <span className={`scaffold-tree-dot is-${child.type}`} />
                <span className="scaffold-tree-name">{child.name}</span>
              </button>
            )}
            <button
              className="scaffold-tree-visibility"
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                onToggleVisibility?.({ path: child.path, entryType: child.type });
              }}
              title={isEntryHidden ? 'Show' : 'Hide'}
              aria-label={isEntryHidden ? 'Show' : 'Hide'}
            >
              {isEntryHidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          {showDropLineAfter(child.path) && !child.children?.length && (
            <div className="scaffold-drop-line" style={{ marginLeft: `${32 + depth * 12}px` }} />
          )}
          {(child.children?.length || (newItemTarget?.parentPath === child.path)) && !collapsedDirs.has(child.path) ? (
            <div className="scaffold-tree-children">
              {renderTree(child, depth + 1)}
              {/* New item input inside this folder */}
              {newItemTarget && newItemTarget.parentPath === child.path && (
                <InlineNameInput
                  defaultValue=""
                  onConfirm={handleNewItemConfirm}
                  onCancel={handleNewItemCancel}
                  depth={depth + 1}
                />
              )}
            </div>
          ) : null}
          {showDropLineAfter(child.path) && child.children?.length > 0 && (
            <div className="scaffold-drop-line" style={{ marginLeft: `${32 + depth * 12}px` }} />
          )}
        </div>
      );
    })
  );

  return (
    <div className="drawer-section">
      <div className="scaffold-create-pills">
        <button
          type="button"
          className="scaffold-create-pill scaffold-create-pill--node"
          onClick={handleCreateNode}
          aria-label="Create new node"
        >
          <SquarePlus size={15} />
          <span>New Node</span>
        </button>
        <button
          type="button"
          className="scaffold-create-pill scaffold-create-pill--group"
          onClick={handleCreateGroup}
          aria-label="Create new group"
        >
          <FolderPlus size={15} />
          <span>New Group</span>
        </button>
      </div>

      <div className="drawer-section-title">Project Files</div>
      <div className="scaffold-root">
        <div className="scaffold-root-name">{rootLabel}</div>
        {rootPath && <div className="scaffold-root-path">{rootPath}</div>}
      </div>
      {!treeEntries.length && (
        <div className="drawer-muted">No files found yet.</div>
      )}
      {treeEntries.length > 0 && (
        <div
          className={`scaffold-tree ${scaffoldDrag.isDragging ? 'is-dragging' : ''}`}
          ref={treeRef}
          role="tree"
          tabIndex={0}
          aria-label="Project files"
          onKeyDown={handleTreeKeyDown}
          onContextMenu={(e) => {
            // Right-click on empty space below items
            if (e.target === treeRef.current || e.target.classList?.contains('scaffold-tree-children')) {
              e.preventDefault();
              handleContextMenu(e, { path: '', type: 'dir' });
            }
          }}
        >
          <div className="scaffold-tree-row is-dir">
            <div className="scaffold-tree-row-header">
              <button
                className="scaffold-tree-toggle"
                type="button"
                onClick={() => toggleDir('__root__')}
                title={collapsedDirs.has('__root__') ? 'Expand folder' : 'Collapse folder'}
                aria-label={collapsedDirs.has('__root__') ? 'Expand folder' : 'Collapse folder'}
              >
                {collapsedDirs.has('__root__') ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
              </button>
              <button
                className="scaffold-tree-entry scaffold-tree-root"
                type="button"
                style={{ paddingLeft: 8 }}
                onClick={() => onSelectEntry?.({ path: '', entryType: 'dir' })}
                data-path=""
                onContextMenu={(e) => handleContextMenu(e, { path: '', type: 'dir' })}
                title={`Folder: ${rootLabel}`}
              >
                <span className="scaffold-tree-dot is-dir" />
                <span className="scaffold-tree-name">{rootLabel}</span>
              </button>
            </div>
            {!collapsedDirs.has('__root__') && (
              <div className="scaffold-tree-children">
                {renderTree(treeRoot, 1)}
                {/* New item input at root level */}
                {newItemTarget && newItemTarget.parentPath === '' && (
                  <InlineNameInput
                    defaultValue=""
                    onConfirm={handleNewItemConfirm}
                    onCancel={handleNewItemCancel}
                    depth={1}
                  />
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <ScaffoldContextMenu
          position={contextMenu.position}
          target={contextMenu.target}
          onOpen={handleContextOpenAction}
          onRename={handleContextRenameAction}
          onDelete={handleContextDeleteAction}
          onNewFile={handleContextNewFileAction}
          onNewFolder={handleContextNewFolderAction}
          onSetFolderColor={onSetFolderColor}
          folderColor={contextMenu.target?.type === 'dir' ? getFolderColor?.(contextMenu.target.path) : null}
          onClose={handleContextClose}
        />
      )}

      {/* Drag ghost */}
      {scaffoldDrag.isDragging && scaffoldDrag.ghostPos && scaffoldDrag.dragItem && (
        <div
          className="scaffold-drag-ghost"
          style={{
            position: 'fixed',
            left: scaffoldDrag.ghostPos.x + 12,
            top: scaffoldDrag.ghostPos.y - 10,
            pointerEvents: 'none',
            zIndex: 9999
          }}
        >
          <span className={`scaffold-tree-dot is-${scaffoldDrag.dragItem.type}`} />
          <span className="scaffold-tree-name">{getNameFromPath(scaffoldDrag.dragItem.path)}</span>
        </div>
      )}
    </div>
  );
}

export default DrawerContentScaffold;
