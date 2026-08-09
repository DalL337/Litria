import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { FileCode2, Save, SaveAll, X } from 'lucide-react';
import { useEditorSession } from '../editor/EditorSessionContext';
import { MAIN_PANE, SIDE_PANE } from '../editor/editorSessionDomain';
import { isPrimaryModifier } from '../platform/modifierKeys';
import UnsavedChangesPrompt from './UnsavedChangesPrompt';
import EditorTabContextMenu from './EditorTabContextMenu';

const LazyEditorMonaco = lazy(() => import('./EditorMonaco'));

function EditorDrawer({ selectedCount = 0, projectRootPath = null, projectId = null, syntaxAdapter = null, dropTargetPane = null }) {
  const {
    isOpen,
    openTabIds,
    activeTabId,
    tabsById,
    paneTabIds,
    activeTabIdByPane,
    focusedPaneId,
    isSplit,
    paneSplitRatio,
    setPaneSplitRatio,
    setActiveTab,
    sendToPane,
    setFocusedPane,
    updateWorkingCode,
    isTabDirty,
    hasDirtyTabs,
    closeTab,
    saveTab,
    saveAllTabs,
    discardTab,
    hideDrawer
  } = useEditorSession();
  const [pendingCloseTabId, setPendingCloseTabId] = useState(null);
  // Single-fire latch for the close prompt's Save: the untitled Save As path
  // makes it async, and the prompt buttons stay mounted during the await.
  const [isSavingPendingClose, setIsSavingPendingClose] = useState(false);
  const [tabMenu, setTabMenu] = useState(null); // { x, y, tabId, paneId }
  // Tab drag (ADR-017 Phase C): HTML5 DnD between pane strips — tabs have no
  // pointer-drag system to conflict with (unlike scaffold rows). Custom mime
  // keeps Monaco's own text-drop handling out of the picture.
  const TAB_DRAG_MIME = 'application/x-litria-tab';
  const [draggingTabId, setDraggingTabId] = useState(null);
  const [dragOverPane, setDragOverPane] = useState(null);

  const acceptsTabDrag = (event) => event.dataTransfer?.types?.includes?.(TAB_DRAG_MIME);
  const readDraggedTabId = (event) => {
    const raw = Number(event.dataTransfer?.getData?.(TAB_DRAG_MIME));
    return Number.isFinite(raw) ? raw : null;
  };
  const clearTabDrag = () => {
    setDraggingTabId(null);
    setDragOverPane(null);
  };

  const tabs = useMemo(
    () => openTabIds.map((id) => tabsById[id]).filter(Boolean),
    [openTabIds, tabsById]
  );
  // Panes to render: always pane 1; pane 2 only while split (progressive
  // chrome — single-pane mode shows zero pane UI).
  const paneIds = isSplit ? [MAIN_PANE, SIDE_PANE] : [MAIN_PANE];
  const panes = paneIds.map((paneId) => ({
    paneId,
    tabs: paneTabIds[paneId].map((id) => tabsById[id]).filter(Boolean),
    activeTab: activeTabIdByPane[paneId] != null ? (tabsById[activeTabIdByPane[paneId]] ?? null) : null,
    isFocused: focusedPaneId === paneId
  }));
  const activeTab = activeTabId ? tabsById[activeTabId] : null;
  const activeTabIsDirty = activeTab ? isTabDirty(activeTab.id) : false;
  const [hasInitialized, setHasInitialized] = useState(false);

  useEffect(() => {
    if (isOpen && !hasInitialized) {
      setHasInitialized(true);
    }
  }, [hasInitialized, isOpen]);

  // Cmd/Ctrl+S saves the focused tab; Cmd/Ctrl+Shift+S saves all. Global by
  // design — users jump between canvas, scaffold, and editor, so the save
  // shortcut works wherever focus is, not just inside the editor drawer.
  // Capture phase so it wins over Monaco and the webview's "save page" default.
  // activeTabId is the FOCUSED pane's active tab (focus-follows-intent).
  useEffect(() => {
    const handler = (event) => {
      if (event.key !== 's' && event.key !== 'S') return;
      if (!isPrimaryModifier(event)) return;
      event.preventDefault();
      if (event.shiftKey) {
        if (hasDirtyTabs) saveAllTabs();
      } else if (activeTabId && activeTabIsDirty) {
        saveTab(activeTabId);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [activeTabId, activeTabIsDirty, hasDirtyTabs, saveTab, saveAllTabs]);

  const handleCloseTab = (tabId) => {
    if (!isTabDirty(tabId)) {
      closeTab(tabId);
      return;
    }
    setPendingCloseTabId(tabId);
  };

  const handleTabContextMenu = (event, tab, paneId) => {
    event.preventDefault();
    event.stopPropagation();
    setTabMenu({ x: event.clientX, y: event.clientY, tabId: tab.id, paneId });
  };

  // Degenerate guard: no "Open in New Pane" for a pane's only tab.
  const canOpenInNewPane = tabMenu
    ? paneTabIds[tabMenu.paneId].length > 1
    : false;

  return (
    <aside className={`editor-drawer ${isOpen ? 'is-open' : ''}`}>
      <div className="editor-drawer-header">
        <div className="editor-drawer-title">Code Editor</div>
        <div className="editor-drawer-meta">
          Displaying {tabs.length}/{Math.max(selectedCount, tabs.length)}
        </div>
        <button className="editor-drawer-close" type="button" onClick={hideDrawer}>
          <X size={16} />
        </button>
      </div>

      <div className="editor-toolbar">
        <button
          className="editor-toolbar-button"
          type="button"
          onClick={() => activeTabId && saveTab(activeTabId)}
          disabled={!activeTabId || !activeTabIsDirty}
          title="Save focused file"
        >
          <Save size={14} />
          <span>Save</span>
        </button>
        <button
          className="editor-toolbar-button"
          type="button"
          onClick={() => saveAllTabs()}
          disabled={!hasDirtyTabs}
          title="Save all open files"
        >
          <SaveAll size={14} />
          <span>Save All</span>
        </button>
      </div>

      <div className="editor-pane-strips">
        {panes.map((pane) => (
          <div
            key={pane.paneId}
            className={`editor-pane-strip${isSplit && pane.isFocused ? ' is-focused' : ''}${dropTargetPane === pane.paneId || dragOverPane === pane.paneId ? ' is-drop-target' : ''}`}
            data-pane-drop={pane.paneId}
            onMouseDown={() => setFocusedPane(pane.paneId)}
            onDragOver={(event) => {
              if (!acceptsTabDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDragOverPane(pane.paneId);
            }}
            onDragLeave={() => {
              setDragOverPane((prev) => (prev === pane.paneId ? null : prev));
            }}
            onDrop={(event) => {
              if (!acceptsTabDrag(event)) return;
              event.preventDefault();
              const tabId = readDraggedTabId(event);
              if (tabId != null) sendToPane(tabId, pane.paneId);
              clearTabDrag();
            }}
          >
            {isSplit && (
              <div className="editor-pane-head">
                <span className="editor-pane-head-dot" />
                Pane {pane.paneId}
              </div>
            )}
            <div className="editor-tabs">
              {pane.tabs.map((tab) => {
                const dirty = isTabDirty(tab.id);
                return (
                  <div
                    key={tab.id}
                    className={`editor-tab ${tab.id === activeTabIdByPane[pane.paneId] ? 'is-active' : ''}`}
                    onClick={() => setActiveTab(tab.id)}
                    onContextMenu={(event) => handleTabContextMenu(event, tab, pane.paneId)}
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData(TAB_DRAG_MIME, String(tab.id));
                      event.dataTransfer.effectAllowed = 'move';
                      setDraggingTabId(tab.id);
                    }}
                    onDragEnd={clearTabDrag}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setActiveTab(tab.id);
                      }
                    }}
                  >
                    <span className={`editor-tab-name ${dirty ? 'is-dirty' : ''}`}>
                      {dirty && <span className="editor-tab-dot" />}
                      {tab.filename}
                    </span>
                    <button
                      className="editor-tab-close"
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handleCloseTab(tab.id);
                      }}
                      aria-label={`Close ${tab.filename}`}
                    >
                      x
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <button
        className="editor-midtab"
        type="button"
        onClick={hideDrawer}
        aria-label="Close editor drawer"
      >
        <FileCode2 size={18} />
      </button>

      <div className="editor-drawer-body">
        {!activeTab && (
          <div className="editor-empty">
            Select a piece and open the editor.
          </div>
        )}
        {dropTargetPane === 'side' && (
          <div className="editor-split-preview">
            <span>Open in new pane</span>
          </div>
        )}
        {/* Tab-drag split zone (ADR-017 Phase C): dragging a tab while
            single-pane offers the right edge as "open in new pane". Hidden
            for a pane's only tab — the same degenerate guard as the context
            menu (moving it would self-heal into no split at all). */}
        {draggingTabId != null && !isSplit && paneTabIds[MAIN_PANE].length > 1 && (
          <div
            className="editor-split-dropzone"
            onDragOver={(event) => {
              if (!acceptsTabDrag(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
            }}
            onDrop={(event) => {
              if (!acceptsTabDrag(event)) return;
              event.preventDefault();
              const tabId = readDraggedTabId(event);
              if (tabId != null) sendToPane(tabId, SIDE_PANE);
              clearTabDrag();
            }}
          >
            <span>Open in new pane</span>
          </div>
        )}
        {hasInitialized && (
          <Suspense fallback={<div className="editor-empty">Loading editor...</div>}>
            <LazyEditorMonaco
              panes={panes.map((pane) => ({
                paneId: pane.paneId,
                activeTab: pane.activeTab,
                showFocusRing: isSplit && pane.isFocused,
                isDropTarget: dropTargetPane === pane.paneId
              }))}
              openTabIds={openTabIds}
              onChange={updateWorkingCode}
              onPaneFocus={setFocusedPane}
              projectRootPath={projectRootPath}
              projectId={projectId}
              syntaxAdapter={syntaxAdapter}
              paneSplitRatio={paneSplitRatio}
              onPaneSplitRatioChange={setPaneSplitRatio}
            />
          </Suspense>
        )}
      </div>
      <EditorTabContextMenu
        menu={tabMenu}
        isSplit={isSplit}
        canOpenInNewPane={canOpenInNewPane}
        onSendToPane={sendToPane}
        onCloseTab={handleCloseTab}
        onClose={() => setTabMenu(null)}
      />
      <UnsavedChangesPrompt
        isOpen={Boolean(pendingCloseTabId)}
        title="Unsaved Changes"
        message="This tab has unsaved changes. Save before closing?"
        onCancel={() => {
          if (isSavingPendingClose) return;
          setPendingCloseTabId(null);
        }}
        onDiscard={() => {
          if (!pendingCloseTabId || isSavingPendingClose) return;
          discardTab(pendingCloseTabId);
          closeTab(pendingCloseTabId);
          setPendingCloseTabId(null);
        }}
        onSave={async () => {
          if (!pendingCloseTabId || isSavingPendingClose) return;
          setIsSavingPendingClose(true);
          try {
            // Untitled session: saveTab resolves false when the Save As dialog
            // is canceled (or the write fails) — keep the dirty tab open then.
            // Normal saves resolve non-false, preserving today's optimistic close.
            const saved = await Promise.resolve(saveTab(pendingCloseTabId));
            if (saved === false) {
              setPendingCloseTabId(null);
              return;
            }
            closeTab(pendingCloseTabId);
            setPendingCloseTabId(null);
          } finally {
            setIsSavingPendingClose(false);
          }
        }}
      />
    </aside>
  );
}

export default EditorDrawer;
