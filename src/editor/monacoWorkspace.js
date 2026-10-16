import monaco from './monacoSetup';
import {
  getLanguageFromFilename,
  getLspLanguageIdFromFilename,
  getManagedSessionLanguageFromFilename
} from './editorLanguage';
import { listenLspEvents } from '../lsp/lspClient';
import { updateFileDiagnostics, clearFileDiagnostics, normalizeUri } from '../lsp/diagnosticStore';
import { didOpen as lspDidOpen, didChange as lspDidChange, didClose as lspDidClose } from '../lsp/documentSync';
import { registerPythonLspProviders } from '../lsp/pythonLspProviders';
import { registerTypescriptLspProviders } from '../lsp/typescriptLspProviders';
import { registerManagedLspProviders } from '../lsp/managedLspProviders';
import { toProjectAbsPath } from '../utils/path';

/**
 * Monaco workspace — the single-owner side of the editor (ADR-017).
 *
 * With split panes there are up to two <EditorMonacoPane> instances, but the
 * following must exist exactly ONCE per app:
 *   - the text-model registry (models are keyed by cm://tab/{tabId} URI —
 *     Monaco throws on duplicate URIs, and a pane-to-pane MOVE must re-parent
 *     the existing model via setModel, never recreate it)
 *   - LSP document tracking (didOpen/didClose bookkeeping per tab)
 *   - LSP provider registration (monaco.languages providers are global;
 *     registering per-instance double-registers completions/hover)
 *   - LSP event subscription + the marker→LED feed
 *
 * (The built-in-TS diagnostics enable/disable dance is gone: the worker's
 * diagnostics are silenced permanently in monacoSetup.js, before any model
 * can exist — the session-start toggle left a race window that stamped
 * stale 17004 markers on models attached during LSP spawn.)
 *
 * Panes call acquireModel/getModel/notifyChange; the EditorMonaco container
 * owns the lifecycle calls (releaseClosedTabs, subscriptions, the session edit
 * mirror). Everything here stays behind the EditorMonaco lazy boundary so
 * Monaco never enters the initial bundle.
 *
 * A model's URI names its file (`cm://tab/{tabId}/{filename}`), and the LSP
 * providers, the pane's hover and the marker feed all read the file from it.
 * A renamed tab therefore gets a NEW model under its new name, and its LSP
 * documents move with it (Project API build plan W1).
 */

const models = new Map(); // tabId → ITextModel
// tabId → { uri, filename } for Python tabs open with the LSP server
const openLspTabs = new Map();
// tabId → { uri, filename, languageId } for TS/JS tabs open with the LSP server
const openTsLspTabs = new Map();
// tabId → { uri, filename, sessionLanguageId, lspLanguageId } for managed
// registry languages (ADR-005 Slice 6: rust, cpp). sessionLanguageId keys
// the LSP session; lspLanguageId is the textDocument.languageId ('c'/'cpp').
const openManagedLspTabs = new Map();
// tabId → absolutePath registered with syntaxAdapter (needed for onFileClosed)
const openSyntaxTabs = new Map();
// tabId → the filename its model was created for (its URI names it).
const modelFilenames = new Map();
// The session's text setter, registered by the container: edits made to a
// model no editor shows reach the session through it (see trackModel).
let sessionEditMirror = null;
// True while applySessionText edits a model: the change is the session's
// own, so neither the pane's onChange nor the mirror sends it back.
let applyingSessionText = false;
let providersRegistered = false;

export function toLspUri(projectRootPath, filename) {
  const root = typeof projectRootPath === 'string' ? projectRootPath.replace(/\\/g, '/').replace(/\/$/, '') : '';
  if (!root || !filename) return null;
  const file = filename.replace(/\\/g, '/').replace(/^\//, '');
  const full = `${root}/${file}`;
  return /^[a-zA-Z]:/.test(full) ? `file:///${full}` : `file://${full}`;
}

function lspSeverityToMonaco(severity) {
  const ms = monaco.MarkerSeverity;
  if (severity === 1) return ms.Error;
  if (severity === 2) return ms.Warning;
  if (severity === 3) return ms.Info;
  return ms.Hint;
}

// A pane unmount disposes its attached model behind the registry's back
// (@monaco-editor/react keepCurrentModel default). Within a project the
// EditorMonaco tree stays mounted so this never used to matter — but Exit to
// Launcher unmounts the whole workspace before the releaseClosedTabs effect
// can run, leaving disposed models in the map. Reopening the SAME project
// reuses the same tab ids, so every registry read must treat a disposed
// entry as absent or it serves the corpse (B5-captured crash, 2026-07-10:
// "Model is disposed!" in EditorMonacoPane's sync effect).
function getLiveModel(tabId) {
  const model = models.get(tabId);
  if (!model) return null;
  if (model.isDisposed()) {
    models.delete(tabId);
    return null;
  }
  return model;
}

export function getModel(tabId) {
  return getLiveModel(tabId);
}

// Register LSP-backed language providers (completion, signatureHelp) exactly
// once per app lifetime. Providers read projectId/root from module context
// kept current via setLspProviderContext/setTsLspProviderContext.
export function ensureLspProviders() {
  if (providersRegistered) return;
  providersRegistered = true;
  registerPythonLspProviders(monaco);
  registerTypescriptLspProviders(monaco);
  registerManagedLspProviders(monaco);
}

/**
 * The session's text setter, `(tabId, text) => void`, for edits made to a
 * model while no editor shows it. Returns the unregister function.
 */
export function setSessionEditMirror(mirror) {
  const registered = typeof mirror === 'function' ? mirror : null;
  sessionEditMirror = registered;
  return () => {
    if (sessionEditMirror === registered) sessionEditMirror = null;
  };
}

/**
 * Create a tab's model and keep the session in step with it. An editor
 * showing the model mirrors typing through its own onChange (the pane); an
 * edit made while no editor shows it — the canvas-wire path writes open
 * files' models directly — would otherwise reach neither the session nor the
 * language servers, and the pane's sync would revert it on the next
 * activation (reproduced live 2026-10-11, build plan W1).
 */
function createTabModel(tabId, filename, text, context) {
  const uri = monaco.Uri.parse(`cm://tab/${tabId}/${filename}`);
  const model = monaco.editor.createModel(text, getLanguageFromFilename(filename), uri);
  models.set(tabId, model);
  modelFilenames.set(tabId, filename);
  model.onDidChangeContent(() => {
    if (applyingSessionText || model.isDisposed() || model.isAttachedToEditor()) return;
    const value = model.getValue();
    sessionEditMirror?.(tabId, value);
    notifyChange(tabId, value, context);
  });
  return model;
}

/** Track a tab's document with its language server and send didOpen. */
function trackLsp(tabId, filename, text, { projectId, projectRootPath }) {
  const tabLang = getLanguageFromFilename(filename);
  const lspUri = toLspUri(projectRootPath, filename);
  if (!lspUri) return;
  if (tabLang === 'python') {
    openLspTabs.set(tabId, { uri: lspUri, filename });
    if (projectId) lspDidOpen('python', projectId, lspUri, 'python', text);
  } else if (tabLang === 'typescript' || tabLang === 'javascript') {
    // The LSP textDocument.languageId needs the JSX-aware value
    // ('typescriptreact'/'javascriptreact') for .tsx/.jsx files —
    // otherwise typescript-language-server emits error 17004 and
    // refuses to parse JSX.
    const tabLspLang = getLspLanguageIdFromFilename(filename);
    openTsLspTabs.set(tabId, { uri: lspUri, filename, languageId: tabLspLang });
    if (projectId) lspDidOpen('typescript', projectId, lspUri, tabLspLang, text);
  } else {
    // Managed registry languages (rust, cpp). Tracked even while no
    // session exists — the onSessionStarted handler replays didOpen once
    // the server is installed/started, so a file opened pre-install
    // lights up without reopening.
    const managedLang = getManagedSessionLanguageFromFilename(filename);
    if (!managedLang) return;
    const tabLspLang = getLspLanguageIdFromFilename(filename);
    openManagedLspTabs.set(tabId, {
      uri: lspUri,
      filename,
      sessionLanguageId: managedLang,
      lspLanguageId: tabLspLang
    });
    if (projectId) lspDidOpen(managedLang, projectId, lspUri, tabLspLang, text);
  }
}

/** Close a tab's language-server documents and clear what they published. */
function untrackLsp(tabId, model, projectId) {
  if (!model.isDisposed()) {
    monaco.editor.setModelMarkers(model, 'python-lsp', []);
    monaco.editor.setModelMarkers(model, 'typescript-lsp', []);
  }
  const lspEntry = openLspTabs.get(tabId);
  if (lspEntry && projectId) {
    lspDidClose('python', projectId, lspEntry.uri);
    clearFileDiagnostics(lspEntry.uri);
  }
  openLspTabs.delete(tabId);
  const tsEntry = openTsLspTabs.get(tabId);
  if (tsEntry && projectId) {
    lspDidClose('typescript', projectId, tsEntry.uri);
    clearFileDiagnostics(tsEntry.uri);
  }
  openTsLspTabs.delete(tabId);
  const managedEntry = openManagedLspTabs.get(tabId);
  if (managedEntry) {
    if (!model.isDisposed()) {
      monaco.editor.setModelMarkers(model, `${managedEntry.sessionLanguageId}-lsp`, []);
    }
    if (projectId) {
      lspDidClose(managedEntry.sessionLanguageId, projectId, managedEntry.uri);
      clearFileDiagnostics(managedEntry.uri);
    }
  }
  openManagedLspTabs.delete(tabId);
}

/**
 * A renamed tab: a new model under the new name, holding the same text; the
 * old name's LSP documents closed and the new name's opened; the syntax
 * adapter moved to the new path and handed the new model. The old model is
 * disposed, and the pane's attach effect shows the new one. Undo history
 * does not cross a rename (the engine cannot move it between models).
 */
function renameModel(tab, model, context) {
  const { projectId, projectRootPath, syntaxAdapter } = context;
  const text = model.getValue();
  untrackLsp(tab.id, model, projectId);
  const next = createTabModel(tab.id, tab.filename, text, context);
  trackLsp(tab.id, tab.filename, text, context);
  const oldPath = openSyntaxTabs.get(tab.id);
  const newPath = toProjectAbsPath(projectRootPath, tab.filename);
  if (syntaxAdapter && newPath) {
    if (oldPath) {
      syntaxAdapter.onFileRenamed(oldPath, newPath, next);
    } else {
      syntaxAdapter.onFileOpened(newPath, text, next);
    }
    openSyntaxTabs.set(tab.id, newPath);
  }
  model.dispose();
  return next;
}

/**
 * Get-or-create the model for a tab (idempotent — either pane may call it,
 * including mid-MOVE). Creation registers the file with the syntax adapter
 * and sends the LSP didOpen; a tab whose filename changed gets a new model
 * under the new name (renameModel).
 */
export function acquireModel(tab, context) {
  const { projectRootPath, syntaxAdapter } = context;
  let model = getLiveModel(tab.id);
  if (!model) {
    const text = tab.workingCode ?? '';
    model = createTabModel(tab.id, tab.filename, text, context);
    // Register with syntaxAdapter for export parsing + patch plan application.
    const absPath = toProjectAbsPath(projectRootPath, tab.filename);
    if (syntaxAdapter && absPath) {
      openSyntaxTabs.set(tab.id, absPath);
      syntaxAdapter.onFileOpened(absPath, text, model);
    }
    // Register with the LSP server (fire-and-forget; the session may not be
    // active yet — onSessionStarted re-sends didOpen when it is ready).
    trackLsp(tab.id, tab.filename, text, context);
  } else if (modelFilenames.get(tab.id) !== tab.filename) {
    model = renameModel(tab, model, context);
  } else {
    const nextLanguage = getLanguageFromFilename(tab.filename);
    if (model.getLanguageId() !== nextLanguage) {
      monaco.editor.setModelLanguage(model, nextLanguage);
    }
    // The same file under another absolute path (the project root moved).
    const absPath = toProjectAbsPath(projectRootPath, tab.filename);
    const storedPath = openSyntaxTabs.get(tab.id);
    if (syntaxAdapter && absPath && storedPath && storedPath !== absPath) {
      openSyntaxTabs.set(tab.id, absPath);
      syntaxAdapter.onFileRenamed(storedPath, absPath);
    }
  }
  return model;
}

/** Whether the current model change is the session's own (applySessionText). */
export function isApplyingSessionText() {
  return applyingSessionText;
}

/**
 * Put the session's text into a tab's live model, if it has one — the engine
 * side of compare-and-apply (Project API build plan W1b). One undoable edit
 * over the changed span only, so cursors outside it stay put; no echo back
 * into the session; the language servers and the syntax index are notified
 * once. Returns whether a live model exists.
 */
export function applySessionText(tabId, text, context) {
  const model = getLiveModel(tabId);
  if (!model) return false;
  const current = model.getValue();
  if (current === text) return true;
  const span = changedSpan(current, text);
  const from = model.getPositionAt(span.start);
  const to = model.getPositionAt(span.endBefore);
  applyingSessionText = true;
  try {
    // Its own undo step (T3a): never merged into the person's last typing,
    // so one undo takes back exactly this text (an agent's edit, or a version
    // from disk) and leaves what was there before.
    model.pushStackElement();
    model.pushEditOperations(
      [],
      [{
        range: {
          startLineNumber: from.lineNumber,
          startColumn: from.column,
          endLineNumber: to.lineNumber,
          endColumn: to.column
        },
        text: text.slice(span.start, span.endAfter)
      }],
      () => null
    );
    model.pushStackElement();
  } finally {
    applyingSessionText = false;
  }
  notifyChange(tabId, text, context);
  return true;
}

/**
 * The span that differs between two texts: the shared prefix and suffix are
 * left alone. Offsets are UTF-16, as the engine counts them; a surrogate pair
 * is never split.
 */
function changedSpan(before, after) {
  const isLowSurrogate = (unit) => unit >= 0xdc00 && unit <= 0xdfff;
  let start = 0;
  const limit = Math.min(before.length, after.length);
  while (start < limit && before.charCodeAt(start) === after.charCodeAt(start)) start += 1;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before.charCodeAt(endBefore - 1) === after.charCodeAt(endAfter - 1)) {
    endBefore -= 1;
    endAfter -= 1;
  }
  if (start > 0 && start < before.length && isLowSurrogate(before.charCodeAt(start))) start -= 1;
  if (endBefore < before.length && isLowSurrogate(before.charCodeAt(endBefore))) {
    endBefore += 1;
    endAfter += 1;
  }
  return { start, endBefore, endAfter };
}

/** Dispose models + close LSP/syntax docs for tabs that left the open set. */
export function releaseClosedTabs(openTabIds, { projectId, syntaxAdapter }) {
  const openSet = new Set(openTabIds);
  models.forEach((model, tabId) => {
    if (openSet.has(tabId)) return;
    untrackLsp(tabId, model, projectId);
    // Notify syntaxAdapter that the file is closed.
    const syntaxPath = openSyntaxTabs.get(tabId);
    if (syntaxAdapter && syntaxPath) {
      syntaxAdapter.onFileClosed(syntaxPath);
    }
    openSyntaxTabs.delete(tabId);
    if (!model.isDisposed()) model.dispose();
    models.delete(tabId);
    modelFilenames.delete(tabId);
  });
}

// When projectId/root changes, recompute URIs for all tracked LSP tabs so the
// onSessionStarted handler can re-send didOpen with correct paths.
export function recomputeLspUris(projectRootPath) {
  const updated = new Map();
  openLspTabs.forEach(({ filename }, tabId) => {
    const lspUri = toLspUri(projectRootPath, filename);
    if (lspUri) updated.set(tabId, { uri: lspUri, filename });
  });
  openLspTabs.clear();
  updated.forEach((value, key) => openLspTabs.set(key, value));

  const tsUpdated = new Map();
  openTsLspTabs.forEach(({ filename, languageId }, tabId) => {
    const lspUri = toLspUri(projectRootPath, filename);
    if (lspUri) tsUpdated.set(tabId, { uri: lspUri, filename, languageId });
  });
  openTsLspTabs.clear();
  tsUpdated.forEach((value, key) => openTsLspTabs.set(key, value));

  const managedUpdated = new Map();
  openManagedLspTabs.forEach(({ filename, sessionLanguageId, lspLanguageId }, tabId) => {
    const lspUri = toLspUri(projectRootPath, filename);
    if (lspUri) managedUpdated.set(tabId, { uri: lspUri, filename, sessionLanguageId, lspLanguageId });
  });
  openManagedLspTabs.clear();
  managedUpdated.forEach((value, key) => openManagedLspTabs.set(key, value));
}

/** Forward a buffer edit to LSP servers + the syntax adapter. */
export function notifyChange(tabId, value, { projectId, syntaxAdapter }) {
  const lspEntry = openLspTabs.get(tabId);
  if (lspEntry && projectId) {
    lspDidChange('python', projectId, lspEntry.uri, value ?? '');
  }
  const tsEntry = openTsLspTabs.get(tabId);
  if (tsEntry && projectId) {
    lspDidChange('typescript', projectId, tsEntry.uri, value ?? '');
  }
  const managedEntry = openManagedLspTabs.get(tabId);
  if (managedEntry && projectId) {
    lspDidChange(managedEntry.sessionLanguageId, projectId, managedEntry.uri, value ?? '');
  }
  const syntaxPath = openSyntaxTabs.get(tabId);
  if (syntaxAdapter && syntaxPath) {
    syntaxAdapter.onFileChanged(syntaxPath, value ?? '');
  }
}

/**
 * Subscribe to LSP server-push events (single subscription for all panes).
 * onSessionStarted — re-open all tracked tabs (session may have restarted);
 *                    for TypeScript also suppress Monaco's built-in TS worker.
 * onSessionEnded   — restore Monaco's built-in TS worker when tsserver stops.
 * onDiagnostics    — convert and apply markers to the matching model.
 */
export function subscribeLspEvents(projectId) {
  if (!projectId) return () => {};
  let cleanupFn = null;
  let disposed = false;
  listenLspEvents({
    onSessionStarted: (payload) => {
      if (payload.projectId !== projectId) return;
      if (payload.languageId === 'python') {
        openLspTabs.forEach(({ uri }, tabId) => {
          const model = getLiveModel(tabId);
          if (!model) return;
          lspDidOpen('python', projectId, uri, 'python', model.getValue());
        });
      } else if (payload.languageId === 'typescript') {
        openTsLspTabs.forEach(({ uri, languageId }, tabId) => {
          const model = getLiveModel(tabId);
          if (!model) return;
          lspDidOpen('typescript', projectId, uri, languageId, model.getValue());
        });
      } else {
        // Managed languages: replay didOpen for the tabs this session serves.
        openManagedLspTabs.forEach(({ uri, sessionLanguageId, lspLanguageId }, tabId) => {
          if (sessionLanguageId !== payload.languageId) return;
          const model = getLiveModel(tabId);
          if (!model) return;
          lspDidOpen(sessionLanguageId, projectId, uri, lspLanguageId, model.getValue());
        });
      }
    },
    onSessionEnded: () => {
      // Built-in TS diagnostics stay silenced (monacoSetup.js) — restoring
      // them on session end used to re-arm the project-blind 17004 noise.
    },
    onDiagnostics: (payload) => {
      if (payload.projectId !== projectId) return;
      const lspUri = payload.uri;
      // Feed the diagnostic store for corner LED health indicators
      updateFileDiagnostics(lspUri, payload.diagnostics);
      // tsserver / pyright return URIs in a normalized form (lowercased
      // drive letter, percent-encoded colon) that does not strict-equal the
      // URI we sent in didOpen — compare via the diagnosticStore's
      // normalization so the lookup succeeds.
      const normLsp = normalizeUri(lspUri);
      const applyMarkers = (tabMap, owner, fallbackCode) => {
        let targetTabId = null;
        tabMap.forEach(({ uri }, tabId) => {
          if (normalizeUri(uri) === normLsp) targetTabId = tabId;
        });
        if (targetTabId === null) return;
        const targetModel = getLiveModel(targetTabId);
        if (!targetModel) return;
        const diags = Array.isArray(payload.diagnostics) ? payload.diagnostics : [];
        const markers = diags.map((d) => ({
          startLineNumber: (d.range?.start?.line ?? 0) + 1,
          startColumn: (d.range?.start?.character ?? 0) + 1,
          endLineNumber: (d.range?.end?.line ?? 0) + 1,
          endColumn: (d.range?.end?.character ?? 0) + 1,
          message: typeof d.message === 'string' ? d.message : 'Diagnostic',
          code: d.code != null ? String(d.code) : fallbackCode,
          severity: lspSeverityToMonaco(d.severity ?? 1),
          source: owner,
        }));
        monaco.editor.setModelMarkers(targetModel, owner, markers);
      };
      if (payload.languageId === 'python') {
        applyMarkers(openLspTabs, 'python-lsp', 'python.lsp');
      } else if (payload.languageId === 'typescript') {
        applyMarkers(openTsLspTabs, 'typescript-lsp', 'typescript.lsp');
      } else {
        // Managed languages (rust, cpp): marker owner keyed by session id.
        // URIs are unique per tab, so matching across the shared map is safe.
        applyMarkers(openManagedLspTabs, `${payload.languageId}-lsp`, `${payload.languageId}.lsp`);
      }
    },
  }).then((fn) => {
    if (disposed) fn?.();
    else cleanupFn = fn;
  });
  return () => {
    disposed = true;
    cleanupFn?.();
  };
}

/**
 * Feed the LED diagnostic store from Monaco's global marker bus. Closes the
 * source-coverage gap for .json/.css/.html files whose diagnostics come from
 * Monaco's built-in language services and never reach LSP publishDiagnostics.
 * For LSP-backed files this is redundant with the direct feed above
 * (skipEqual dedupes), but it correctly aggregates multi-owner URIs.
 */
export function subscribeMarkerFeed(getProjectRoot) {
  const disposable = monaco.editor.onDidChangeMarkers((uris) => {
    for (const uri of uris) {
      const cmStr = uri.toString();
      // Tab models use scheme cm://tab/<tabId>/<filename> — skip anything else.
      const match = cmStr.match(/^cm:\/\/tab\/[^/]+\/(.+)$/);
      if (!match) continue;
      const filename = decodeURIComponent(match[1]);
      const fileUri = toLspUri(getProjectRoot(), filename);
      if (!fileUri) continue;
      const markers = monaco.editor.getModelMarkers({ resource: uri });
      const synthDiags = markers.map((m) => ({
        severity: m.severity === monaco.MarkerSeverity.Error ? 1
          : m.severity === monaco.MarkerSeverity.Warning ? 2
          : 3,
      }));
      updateFileDiagnostics(fileUri, synthDiags);
    }
  });
  return () => disposable.dispose();
}

