import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { Pin, PinOff } from 'lucide-react';
import monaco from '../editor/monacoSetup';
import { getLanguageFromFilename } from '../editor/editorLanguage';
import { lspRequest } from '../lsp/lspClient';
import { managedSessionLanguageForMonacoLanguage } from '../lsp/managedLspProviders';
import { parsePythonSymbols } from '../editor/pythonLocalIntelligence';
import { acquireModel, getModel, notifyChange, ensureLspProviders } from '../editor/monacoWorkspace';

/**
 * One editor pane (ADR-017). Instance-scoped: the Monaco editor widget, its
 * hover card, and buffer sync for THIS pane's active tab. Everything shared
 * across panes (model registry, LSP document tracking, provider registration,
 * event subscriptions) lives in editor/monacoWorkspace.js and is owned by the
 * EditorMonaco container — a pane only acquires models and reports edits.
 */
function EditorMonacoPane({
  activeTab,
  onChange,
  onFocus,
  projectRootPath = null,
  projectId = null,
  syntaxAdapter = null,
  showFocusRing = false,
  isDropTarget = false
}) {
  const editorRef = useRef(null);
  const shellRef = useRef(null);
  const monacoRef = useRef(null);
  const syncingRef = useRef(false);

  const hoverTimerRef = useRef(null);
  const suggestTimerRef = useRef(null);
  const clearDelayRef = useRef(null);
  const cardRef = useRef(null);
  const lastMousePosRef = useRef({ x: 0, y: 0 });
  const pinnedRef = useRef(false);
  // Monotonic counter to discard stale async hover results after mouse moves away.
  const showHoverIdRef = useRef(0);
  // Mirror of props for use inside async callbacks and onMount closures.
  const projectIdRef = useRef(projectId);
  const projectRootPathRef = useRef(projectRootPath);
  const [isMonacoReady, setIsMonacoReady] = useState(false);
  const [hoverCard, setHoverCard] = useState(null);
  const [pinned, setPinned] = useState(false);

  useEffect(() => {
    projectIdRef.current = projectId;
    projectRootPathRef.current = projectRootPath;
  }, [projectId, projectRootPath]);

  // Map LSP severity (1-4) to Monaco MarkerSeverity.
  // Track global mouse position so we can check if mouse is over the card
  useEffect(() => {
    const track = (e) => { lastMousePosRef.current = { x: e.clientX, y: e.clientY }; };
    document.addEventListener('mousemove', track, { passive: true });
    return () => document.removeEventListener('mousemove', track);
  }, []);

  // Keyboard shortcuts while card is visible:
  //   P        — toggle pin (prevents 'p' from reaching Monaco only while card shows)
  //   Escape   — force dismiss regardless of pin state
  // Gated on THIS pane's card being visible, so with two panes only the pane
  // showing a card responds.
  useEffect(() => {
    if (!hoverCard) return undefined;
    const handler = (e) => {
      if (e.key === 'Escape') {
        clearHoverCard(true);
      } else if (e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        togglePin();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [hoverCard]);

  const isMouseOverCard = () => {
    const card = cardRef.current;
    if (!card) return false;
    const { x, y } = lastMousePosRef.current;
    const r = card.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  // force=true bypasses pin and position checks (View Problem, Escape, tab close)
  const clearHoverCard = (force = false) => {
    if (!force && (pinnedRef.current || isMouseOverCard())) return;
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    if (clearDelayRef.current) { clearTimeout(clearDelayRef.current); clearDelayRef.current = null; }
    pinnedRef.current = false;
    setPinned(false);
    setHoverCard(null);
  };

  // Schedules a clear after `delay`ms, respecting pin and position
  const scheduleClear = (delay = 300) => {
    if (clearDelayRef.current) clearTimeout(clearDelayRef.current);
    clearDelayRef.current = setTimeout(() => {
      clearDelayRef.current = null;
      clearHoverCard();
    }, delay);
  };

  const togglePin = () => {
    const next = !pinnedRef.current;
    pinnedRef.current = next;
    setPinned(next);
  };

  const getSeverityLabel = (severity) => {
    const markerSeverity = monacoRef.current?.MarkerSeverity;
    if (!markerSeverity) return 'Error';
    if (severity === markerSeverity.Warning) return 'Warning';
    if (severity === markerSeverity.Info) return 'Info';
    if (severity === markerSeverity.Hint) return 'Hint';
    return 'Error';
  };

  const markerContainsPosition = (marker, lineNumber, column) => {
    if (!marker) return false;
    const startsBefore = (
      marker.startLineNumber < lineNumber
      || (marker.startLineNumber === lineNumber && marker.startColumn <= column)
    );
    const endsAfter = (
      marker.endLineNumber > lineNumber
      || (marker.endLineNumber === lineNumber && marker.endColumn >= column)
    );
    return startsBefore && endsAfter;
  };

  const normalizeMarkerCode = (marker) => {
    const rawCode = marker?.code;
    if (typeof rawCode === 'string' && rawCode.trim().length) return rawCode.trim();
    if (typeof rawCode === 'number') return String(rawCode);
    if (rawCode && typeof rawCode === 'object' && typeof rawCode.value === 'string' && rawCode.value.trim().length) {
      return rawCode.value.trim();
    }
    if (typeof marker?.source === 'string' && marker.source.trim().length) {
      return `${marker.source.trim()}.diagnostic`;
    }
    return 'diagnostic';
  };

  const normalizeDiagnosticMessage = (message) => {
    if (typeof message !== 'string') return 'Diagnostic reported';
    const normalized = message
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    return normalized || 'Diagnostic reported';
  };

  const getSeverityWeight = (severityLabel) => {
    if (severityLabel === 'Error') return 4;
    if (severityLabel === 'Warning') return 3;
    if (severityLabel === 'Info') return 2;
    if (severityLabel === 'Hint') return 1;
    return 0;
  };

  const getHoverItems = (markers, maxItems = 8) => {
    const deduped = [];
    const seen = new Set();
    markers
      .map((marker) => ({
        startLineNumber: marker.startLineNumber ?? 1,
        startColumn: marker.startColumn ?? 1,
        endLineNumber: marker.endLineNumber ?? marker.startLineNumber ?? 1,
        endColumn: marker.endColumn ?? marker.startColumn ?? 1,
        severity: getSeverityLabel(marker.severity),
        code: normalizeMarkerCode(marker),
        message: normalizeDiagnosticMessage(marker.message)
      }))
      .sort((a, b) => {
        const severityDelta = getSeverityWeight(b.severity) - getSeverityWeight(a.severity);
        if (severityDelta !== 0) return severityDelta;
        if (a.startLineNumber !== b.startLineNumber) return a.startLineNumber - b.startLineNumber;
        if (a.startColumn !== b.startColumn) return a.startColumn - b.startColumn;
        return a.message.localeCompare(b.message);
      })
      .forEach((item) => {
        const key = [
          item.severity,
          item.code,
          item.message,
          item.startLineNumber,
          item.startColumn,
          item.endLineNumber,
          item.endColumn
        ].join('|');
        if (seen.has(key)) return;
        seen.add(key);
        deduped.push({
          ...item,
          id: `${item.code}-${item.startLineNumber}-${item.startColumn}-${deduped.length}`
        });
      });
    return {
      items: deduped.slice(0, maxItems),
      total: deduped.length
    };
  };

  // Unified hover — diagnostics first, then LSP hover, then local symbol fallback.
  // Async because the LSP hover request must await a round-trip to pyright.
  const showHover = async (lineNumber, column, clientX, clientY) => {
    if (pinnedRef.current) return; // pinned card is locked — don't override or clear it
    const hoverId = ++showHoverIdRef.current; // stale-check token for async gap
    const editor = editorRef.current;
    const model = editor?.getModel?.();
    if (!editor || !model || !shellRef.current || !monacoRef.current) return;

    const shellBounds = shellRef.current.getBoundingClientRect();
    const maxWidth = 460;
    const maxHeight = 280;
    const horizontalPadding = 14;
    const verticalPadding = 12;
    const rawX = clientX - shellBounds.left + horizontalPadding;
    const rawY = clientY - shellBounds.top + verticalPadding;
    const clampedX = Math.min(Math.max(12, rawX), Math.max(12, shellBounds.width - maxWidth - 12));
    const clampedY = Math.min(Math.max(12, rawY), Math.max(12, shellBounds.height - maxHeight - 12));

    // --- Diagnostics (sync — no stale-check needed yet) ---
    const allMarkers = monacoRef.current.editor
      .getModelMarkers({ resource: model.uri })
      .filter((marker) => typeof marker.message === 'string' && marker.message.trim().length > 0);
    const rangeMatchedMarkers = allMarkers.filter((marker) => markerContainsPosition(marker, lineNumber, column));
    const lineMatchedMarkers = allMarkers.filter((marker) => marker.startLineNumber === lineNumber);
    const candidateMarkers = rangeMatchedMarkers.length ? rangeMatchedMarkers : lineMatchedMarkers;
    const { items, total } = getHoverItems(candidateMarkers, 8);

    if (items.length) {
      const lineIssueCount = getHoverItems(lineMatchedMarkers, Number.MAX_SAFE_INTEGER).total;
      setHoverCard({
        kind: 'diagnostic',
        x: clampedX,
        y: clampedY,
        lineNumber,
        column,
        totalIssues: total,
        lineIssueCount,
        hiddenCount: Math.max(0, total - items.length),
        items
      });
      return;
    }

    const buildLspUri = (uriStr) => {
      const root = typeof projectRootPathRef.current === 'string'
        ? projectRootPathRef.current.replace(/\\/g, '/').replace(/\/$/, '') : '';
      const fnMatch = uriStr.match(/^cm:\/\/tab\/[^/]+\/(.+)$/);
      if (!fnMatch || !root) return null;
      const f = decodeURIComponent(fnMatch[1]).replace(/\\/g, '/').replace(/^\//, '');
      const full = `${root}/${f}`;
      return /^[a-zA-Z]:/.test(full) ? `file:///${full}` : `file://${full}`;
    };

    // --- LSP hover (TypeScript / JavaScript, async) ---
    const tsLang = model.getLanguageId();
    if (tsLang === 'typescript' || tsLang === 'javascript') {
      const pid = projectIdRef.current;
      const lspUri = buildLspUri(model.uri.toString());

      if (pid && lspUri) {
        try {
          const result = await lspRequest('typescript', pid, 'textDocument/hover', {
            textDocument: { uri: lspUri },
            position: { line: lineNumber - 1, character: column - 1 },
          }, 3000);

          if (pinnedRef.current || showHoverIdRef.current !== hoverId) return;

          if (result?.contents) {
            const raw = result.contents;
            const value = typeof raw === 'string' ? raw
              : Array.isArray(raw) ? raw.map((c) => (typeof c === 'string' ? c : (c.value ?? ''))).join('\n\n')
              : (raw.value ?? '');
            if (value.trim()) {
              setHoverCard({
                kind: 'symbol',
                x: clampedX,
                y: clampedY,
                lineNumber,
                column,
                signature: value,
                doc: null,
                symbolKind: 'hover'
              });
              return;
            }
          }
        } catch {
          // LSP not available — fall through.
        }
        if (pinnedRef.current || showHoverIdRef.current !== hoverId) return;
      }
    }

    // --- LSP hover (managed languages: rust / cpp / c, async) ---
    const managedSessionLang = managedSessionLanguageForMonacoLanguage(model.getLanguageId());
    if (managedSessionLang) {
      const pid = projectIdRef.current;
      const lspUri = buildLspUri(model.uri.toString());

      if (pid && lspUri) {
        try {
          const result = await lspRequest(managedSessionLang, pid, 'textDocument/hover', {
            textDocument: { uri: lspUri },
            position: { line: lineNumber - 1, character: column - 1 },
          }, 3000);

          if (pinnedRef.current || showHoverIdRef.current !== hoverId) return;

          if (result?.contents) {
            const raw = result.contents;
            const value = typeof raw === 'string' ? raw
              : Array.isArray(raw) ? raw.map((c) => (typeof c === 'string' ? c : (c.value ?? ''))).join('\n\n')
              : (raw.value ?? '');
            if (value.trim()) {
              setHoverCard({
                kind: 'symbol',
                x: clampedX,
                y: clampedY,
                lineNumber,
                column,
                signature: value,
                doc: null,
                symbolKind: 'hover'
              });
              return;
            }
          }
        } catch {
          // LSP not available (server not installed yet) — fall through.
        }
        if (pinnedRef.current || showHoverIdRef.current !== hoverId) return;
      }
    }

    // --- LSP hover (Python only, async) ---
    if (model.getLanguageId() === 'python') {
      const pid = projectIdRef.current;
      const lspUri = buildLspUri(model.uri.toString());

      if (pid && lspUri) {
        try {
          const result = await lspRequest('python', pid, 'textDocument/hover', {
            textDocument: { uri: lspUri },
            position: { line: lineNumber - 1, character: column - 1 },
          }, 3000);

          // Discard if mouse moved or pin changed while we awaited.
          if (pinnedRef.current || showHoverIdRef.current !== hoverId) return;

          if (result?.contents) {
            const raw = result.contents;
            const value = typeof raw === 'string' ? raw
              : Array.isArray(raw) ? raw.map((c) => (typeof c === 'string' ? c : (c.value ?? ''))).join('\n\n')
              : (raw.value ?? '');
            if (value.trim()) {
              setHoverCard({
                kind: 'symbol',
                x: clampedX,
                y: clampedY,
                lineNumber,
                column,
                signature: value,
                doc: null,
                symbolKind: 'hover'
              });
              return;
            }
          }
        } catch {
          // LSP not available — fall through to local provider.
        }
        if (pinnedRef.current || showHoverIdRef.current !== hoverId) return;
      }

      // --- Local symbol fallback ---
      const word = model.getWordAtPosition({ lineNumber, column });
      if (word?.word) {
        const symbols = parsePythonSymbols(model.getValue());
        const symbol = symbols.get(word.word);
        if (symbol) {
          setHoverCard({
            kind: 'symbol',
            x: clampedX,
            y: clampedY,
            lineNumber,
            column,
            signature: symbol.signature,
            doc: symbol.doc ?? null,
            symbolKind: symbol.kind
          });
          return;
        }
      }
    }

    setHoverCard(null);
  };

  // Attach this pane's active tab: get-or-create through the shared registry
  // (idempotent — a MOVE from the other pane re-parents the same model).
  useEffect(() => {
    if (!isMonacoReady || !monacoRef.current || !activeTab) return;
    const model = acquireModel(activeTab, { projectId, projectRootPath, syntaxAdapter });
    if (editorRef.current?.getModel() !== model) {
      editorRef.current?.setModel(model);
    }
    // Disable Monaco's built-in hover for Python and TS/JS — CM card handles it
    const fileLang = getLanguageFromFilename(activeTab.filename);
    const useCmCard = fileLang === 'python' || fileLang === 'typescript' || fileLang === 'javascript';
    editorRef.current?.updateOptions({ hover: { enabled: !useCmCard } });
  }, [activeTab, isMonacoReady, projectId, projectRootPath, syntaxAdapter]);

  useEffect(() => {
    if (!activeTab && editorRef.current) {
      editorRef.current.setModel(null);
      clearHoverCard(true);
    }
  }, [activeTab]);

  useEffect(() => {
    if (!activeTab) return;
    const model = getModel(activeTab.id);
    if (!model) return;
    const currentValue = model.getValue();
    if (currentValue !== (activeTab.workingCode ?? '')) {
      syncingRef.current = true;
      model.setValue(activeTab.workingCode ?? '');
      syncingRef.current = false;
    }
  }, [activeTab?.id, activeTab?.workingCode]);

  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
      if (suggestTimerRef.current) { clearTimeout(suggestTimerRef.current); suggestTimerRef.current = null; }
      if (clearDelayRef.current) { clearTimeout(clearDelayRef.current); clearDelayRef.current = null; }
    };
  }, []);

  return (
    <div className={`editor-monaco-shell${showFocusRing ? ' is-focused-pane' : ''}${isDropTarget ? ' is-drop-target' : ''}`} ref={shellRef}>
      <Editor
        className="editor-buffer"
        theme="cm-vs-dark"
        monaco={monaco}
        options={{
          minimap: { enabled: false },
          fontFamily: 'Consolas, monospace',
          fontSize: 13,
          lineHeight: 18,
          'semanticHighlighting.enabled': true,
          quickSuggestions: {
            other: true,
            comments: false,
            strings: false
          },
          quickSuggestionsDelay: 60,
          suggestOnTriggerCharacters: true,
          wordBasedSuggestions: 'currentDocument',
          suggest: {
            showMethods: true,
            showFunctions: true,
            showClasses: true,
            showVariables: true,
            showModules: true,
            showKeywords: true
          },
          wordWrap: 'on',
          smoothScrolling: true,
          scrollBeyondLastLine: false,
          scrollbar: {
            verticalScrollbarSize: 8,
            horizontalScrollbarSize: 8
          }
        }}
        onMount={(editor, monacoInstance) => {
          editorRef.current = editor;
          monacoRef.current = monacoInstance;
          setIsMonacoReady(true);
          // Providers are global — the workspace registers them exactly once
          // regardless of how many panes mount.
          ensureLspProviders();
          editor.addCommand(monacoInstance.KeyMod.CtrlCmd | monacoInstance.KeyCode.Space, () => {
            editor.getAction('editor.action.triggerSuggest')?.run();
          });
          // Focus follows the pane the user is typing in.
          editor.onDidFocusEditorText(() => { onFocus?.(); });
          editor.onDidChangeModelContent((event) => {
            const model = editor.getModel();
            if (!model) return;
            const lang = model.getLanguageId();
            const isLspLang = lang === 'python' || lang === 'typescript' || lang === 'javascript';
            if (!isLspLang) return;
            const lastChange = event.changes[event.changes.length - 1];
            const insertedText = typeof lastChange?.text === 'string' ? lastChange.text : '';
            if (!insertedText) return;
            const lastChar = insertedText.slice(-1);
            if (!/[A-Za-z_$]/.test(lastChar)) return;
            if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
            suggestTimerRef.current = setTimeout(() => {
              editor.getAction('editor.action.triggerSuggest')?.run();
            }, 40);
          });
          editor.onDidType((text) => {
            const model = editor.getModel();
            if (!model) return;
            const lang = model.getLanguageId();
            const isLspLang = lang === 'python' || lang === 'typescript' || lang === 'javascript';
            if (!isLspLang) return;
            const lastChar = typeof text === 'string' ? text.slice(-1) : '';
            if (!/[A-Za-z_$]/.test(lastChar)) return;
            editor.getAction('editor.action.triggerSuggest')?.run();
          });
          editor.onMouseMove((event) => {
            if (clearDelayRef.current) { clearTimeout(clearDelayRef.current); clearDelayRef.current = null; }
            const position = event.target?.position;
            if (!position) {
              scheduleClear(300);
              return;
            }
            if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
            hoverTimerRef.current = setTimeout(() => {
              showHover(
                position.lineNumber,
                position.column,
                event.event.browserEvent.clientX,
                event.event.browserEvent.clientY
              );
            }, 180);
          });
          editor.onMouseLeave(() => { scheduleClear(300); });
          editor.onDidBlurEditorText(() => { clearHoverCard(true); });
        }}
        onChange={(value) => {
          if (!activeTab) return;
          if (syncingRef.current) return;
          onChange?.(activeTab.id, value ?? '');
          // Push the edit to LSP servers + syntax adapter via the workspace.
          notifyChange(activeTab.id, value ?? '', { projectId, syntaxAdapter });
        }}
      />
      {hoverCard && (
        <div
          ref={cardRef}
          className={`cm-hover-card${pinned ? ' is-pinned' : ''}`}
          style={{ left: `${hoverCard.x}px`, top: `${hoverCard.y}px` }}
          onMouseEnter={() => {
            if (clearDelayRef.current) { clearTimeout(clearDelayRef.current); clearDelayRef.current = null; }
          }}
          onMouseLeave={() => { scheduleClear(200); }}
        >
          {hoverCard.kind === 'diagnostic' && (
            <>
              <div className="cm-hover-card-header">
                <span className="cm-hover-card-title">Diagnostics</span>
                <div className="cm-hover-card-header-end">
                  <button
                    className={`cm-hover-pin-btn${pinned ? ' is-pinned' : ''}`}
                    onClick={togglePin}
                    title={pinned ? 'Unpin — P or Esc' : 'Pin card — P'}
                  >
                    {pinned ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                  <span className="cm-hover-card-meta">L{hoverCard.lineNumber}:C{hoverCard.column}</span>
                </div>
              </div>
              <div className="cm-hover-card-subtitle">
                {hoverCard.lineIssueCount} issue{hoverCard.lineIssueCount === 1 ? '' : 's'} on this line
                {hoverCard.hiddenCount > 0 ? ` • +${hoverCard.hiddenCount} more` : ''}
              </div>
              <div className="cm-hover-card-body">
                {hoverCard.items.map((item) => (
                  <div key={item.id} className="cm-hover-item">
                    <div className="cm-hover-item-meta">
                      <span className={`cm-hover-item-severity is-${item.severity.toLowerCase()}`}>{item.severity}</span>
                      <span className="cm-hover-item-code">{item.code}</span>
                    </div>
                    <div className="cm-hover-item-message">{item.message}</div>
                    <button
                      className="cm-hover-item-action"
                      onClick={() => {
                        const ed = editorRef.current;
                        if (!ed) return;
                        const pos = { lineNumber: item.startLineNumber, column: item.startColumn };
                        ed.setPosition(pos);
                        ed.revealPositionInCenter(pos);
                        ed.focus();
                        clearHoverCard(true);
                      }}
                    >
                      View Problem →
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          {hoverCard.kind === 'symbol' && (
            <>
              <div className="cm-hover-card-header">
                <span className="cm-hover-card-title">{hoverCard.symbolKind.toUpperCase()}</span>
                <div className="cm-hover-card-header-end">
                  <button
                    className={`cm-hover-pin-btn${pinned ? ' is-pinned' : ''}`}
                    onClick={togglePin}
                    title={pinned ? 'Unpin — P or Esc' : 'Pin card — P'}
                  >
                    {pinned ? <PinOff size={12} /> : <Pin size={12} />}
                  </button>
                  <span className="cm-hover-card-meta">L{hoverCard.lineNumber}:C{hoverCard.column}</span>
                </div>
              </div>
              <div className="cm-hover-card-body">
                <div className="cm-hover-item">
                  <code className="cm-hover-item-sig">{hoverCard.signature}</code>
                  {hoverCard.doc && (
                    <div className="cm-hover-item-message">{hoverCard.doc}</div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default EditorMonacoPane;
