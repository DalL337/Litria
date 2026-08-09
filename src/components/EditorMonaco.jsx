import { Fragment, useEffect, useRef } from 'react';
import { setLspProviderContext } from '../lsp/pythonLspProviders';
import { setTsLspProviderContext } from '../lsp/typescriptLspProviders';
import { setManagedLspProviderContext } from '../lsp/managedLspProviders';
import {
  releaseClosedTabs,
  recomputeLspUris,
  subscribeLspEvents,
  subscribeMarkerFeed
} from '../editor/monacoWorkspace';
import EditorMonacoPane from './EditorMonacoPane';

/**
 * Editor container (ADR-017 split panes): renders one EditorMonacoPane per
 * pane and owns the single-instance workspace lifecycle — model disposal for
 * closed tabs, LSP provider context, LSP event subscription, and the
 * marker→LED feed. Pane-local concerns (editor widget, hover card, buffer
 * sync) live in EditorMonacoPane; shared mutable state lives in
 * editor/monacoWorkspace.js.
 *
 * Stays the default export at the same path so EditorDrawer's lazy import
 * boundary (Monaco out of the initial bundle) is unchanged.
 */
function EditorMonaco({
  panes,
  openTabIds,
  onChange,
  onPaneFocus,
  projectRootPath = null,
  projectId = null,
  syntaxAdapter = null,
  paneSplitRatio = 0.5,
  onPaneSplitRatioChange = null
}) {
  const projectRootPathRef = useRef(projectRootPath);
  // Divider drag (ADR-017 Phase C): pane widths mutate through these refs
  // during the drag — React state commits ONCE on release, so the Monaco
  // panes never re-render mid-drag (@monaco-editor/react's automaticLayout
  // absorbs the width changes).
  const rowRef = useRef(null);
  const slotRefs = useRef({});
  const dragRatioRef = useRef(null);

  const applySlotWidths = (ratio) => {
    const first = slotRefs.current[1];
    const second = slotRefs.current[2];
    if (first) first.style.flexGrow = String(ratio);
    if (second) second.style.flexGrow = String(1 - ratio);
  };

  const handleDividerPointerDown = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRatioRef.current = paneSplitRatio;
  };

  const handleDividerPointerMove = (e) => {
    if (dragRatioRef.current == null || !rowRef.current) return;
    const rect = rowRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const raw = (e.clientX - rect.left) / rect.width;
    const ratio = Math.max(0.2, Math.min(0.8, raw));
    dragRatioRef.current = ratio;
    applySlotWidths(ratio);
  };

  const handleDividerPointerUp = (e) => {
    if (dragRatioRef.current == null) return;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const ratio = dragRatioRef.current;
    dragRatioRef.current = null;
    onPaneSplitRatioChange?.(ratio);
  };

  // Keep provider context + tracked LSP URIs in sync with the project.
  useEffect(() => {
    projectRootPathRef.current = projectRootPath;
    setLspProviderContext(projectId, projectRootPath);
    setTsLspProviderContext(projectId, projectRootPath);
    setManagedLspProviderContext(projectId, projectRootPath);
    recomputeLspUris(projectRootPath);
  }, [projectId, projectRootPath]);

  // Dispose models + close LSP/syntax documents for tabs that left the set.
  useEffect(() => {
    releaseClosedTabs(openTabIds, { projectId, syntaxAdapter });
  }, [openTabIds, projectId, syntaxAdapter]);

  // Server-push events (session restart replay, diagnostics → markers).
  useEffect(() => {
    return subscribeLspEvents(projectId);
  }, [projectId]);

  // Monaco's global marker bus → corner-LED diagnostic store.
  useEffect(() => {
    return subscribeMarkerFeed(() => projectRootPathRef.current);
  }, []);

  const isSplitRow = panes.length === 2;

  return (
    <div className={`editor-monaco-row${isSplitRow ? ' is-split' : ''}`} ref={rowRef}>
      {panes.map((pane, index) => (
        <Fragment key={pane.paneId}>
          {index === 1 && (
            <div
              className="editor-pane-divider"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
              onPointerCancel={handleDividerPointerUp}
              onDoubleClick={() => onPaneSplitRatioChange?.(0.5)}
              title="Drag to resize — double-click to reset"
            />
          )}
          <div
            className="editor-pane-slot"
            ref={(el) => { slotRefs.current[pane.paneId] = el; }}
            style={{ flexGrow: isSplitRow ? (pane.paneId === 1 ? paneSplitRatio : 1 - paneSplitRatio) : 1 }}
            data-pane-drop={pane.paneId}
          >
            <EditorMonacoPane
              activeTab={pane.activeTab}
              onChange={onChange}
              onFocus={() => onPaneFocus?.(pane.paneId)}
              projectRootPath={projectRootPath}
              projectId={projectId}
              syntaxAdapter={syntaxAdapter}
              showFocusRing={pane.showFocusRing}
              isDropTarget={pane.isDropTarget}
            />
          </div>
        </Fragment>
      ))}
    </div>
  );
}

export default EditorMonaco;
