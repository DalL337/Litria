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
 * owns the lifecycle calls (releaseClosedTabs, subscriptions). Everything
 * here stays behind the EditorMonaco lazy boundary so Monaco never enters
 * the initial bundle.
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
let providersRegistered = false;

export function toLspUri(projectRootPath, filename) {
  const root = typeof projectRootPath === 'string' ? projectRootPath.replace(/\\/g, '/').replace(/\/$/, '') : '';
  if (!root || !filename) return null;
  const file = filename.replace(/\\/g, '/').replace(/^\//, '');
  const full = `${root}/${file}`;
  return /^[a-zA-Z]:/.test(full) ? `file:///${full}` : `file://${full}`;
}

export function toAbsPath(projectRootPath, filename) {
  const root = typeof projectRootPath === 'string' ? projectRootPath.replace(/\\/g, '/').replace(/\/$/, '') : '';
  if (!root || !filename) return null;
  const file = filename.replace(/\\/g, '/').replace(/^\//, '');
  return `${root}/${file}`;
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
 * Get-or-create the model for a tab (idempotent — either pane may call it,
 * including mid-MOVE). Creation registers the file with the syntax adapter
 * and sends the LSP didOpen; re-acquire handles language changes and
 * rename/move detection.
 */
export function acquireModel(tab, { projectId, projectRootPath, syntaxAdapter }) {
  let model = getLiveModel(tab.id);
  if (!model) {
    const uri = monaco.Uri.parse(`cm://tab/${tab.id}/${tab.filename}`);
    model = monaco.editor.createModel(
      tab.workingCode ?? '',
      getLanguageFromFilename(tab.filename),
      uri
    );
    models.set(tab.id, model);
    // Register with syntaxAdapter for export parsing + patch plan application.
    const absPath = toAbsPath(projectRootPath, tab.filename);
    if (syntaxAdapter && absPath) {
      openSyntaxTabs.set(tab.id, absPath);
      syntaxAdapter.onFileOpened(absPath, tab.workingCode ?? '', model);
    }
    // Register with LSP server (fire-and-forget; session may not be active yet —
    // the onSessionStarted handler will re-send didOpen when the session is ready).
    const tabLang = getLanguageFromFilename(tab.filename);
    if (tabLang === 'python') {
      const lspUri = toLspUri(projectRootPath, tab.filename);
      if (lspUri) {
        openLspTabs.set(tab.id, { uri: lspUri, filename: tab.filename });
        if (projectId) {
          lspDidOpen('python', projectId, lspUri, 'python', tab.workingCode ?? '');
        }
      }
    } else if (tabLang === 'typescript' || tabLang === 'javascript') {
      const lspUri = toLspUri(projectRootPath, tab.filename);
      if (lspUri) {
        // The LSP textDocument.languageId needs the JSX-aware value
        // ('typescriptreact'/'javascriptreact') for .tsx/.jsx files —
        // otherwise typescript-language-server emits error 17004 and
        // refuses to parse JSX.
        const tabLspLang = getLspLanguageIdFromFilename(tab.filename);
        openTsLspTabs.set(tab.id, { uri: lspUri, filename: tab.filename, languageId: tabLspLang });
        if (projectId) {
          lspDidOpen('typescript', projectId, lspUri, tabLspLang, tab.workingCode ?? '');
        }
      }
    } else {
      // Managed registry languages (rust, cpp). Tracked even while no
      // session exists — the onSessionStarted handler replays didOpen once
      // the server is installed/started, so a file opened pre-install
      // lights up without reopening.
      const managedLang = getManagedSessionLanguageFromFilename(tab.filename);
      if (managedLang) {
        const lspUri = toLspUri(projectRootPath, tab.filename);
        if (lspUri) {
          const tabLspLang = getLspLanguageIdFromFilename(tab.filename);
          openManagedLspTabs.set(tab.id, {
            uri: lspUri,
            filename: tab.filename,
            sessionLanguageId: managedLang,
            lspLanguageId: tabLspLang
          });
          if (projectId) {
            lspDidOpen(managedLang, projectId, lspUri, tabLspLang, tab.workingCode ?? '');
          }
        }
      }
    }
  } else {
    const nextLanguage = getLanguageFromFilename(tab.filename);
    if (model.getLanguageId() !== nextLanguage) {
      monaco.editor.setModelLanguage(model, nextLanguage);
    }
    // Detect file rename/move: stored path differs from current filename.
    const absPath = toAbsPath(projectRootPath, tab.filename);
    const storedPath = openSyntaxTabs.get(tab.id);
    if (syntaxAdapter && absPath && storedPath && storedPath !== absPath) {
      openSyntaxTabs.set(tab.id, absPath);
      syntaxAdapter.onFileRenamed(storedPath, absPath);
    }
  }
  return model;
}

/** Dispose models + close LSP/syntax docs for tabs that left the open set. */
export function releaseClosedTabs(openTabIds, { projectId, syntaxAdapter }) {
  const openSet = new Set(openTabIds);
  models.forEach((model, tabId) => {
    if (openSet.has(tabId)) return;
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
    // Notify syntaxAdapter that the file is closed.
    const syntaxPath = openSyntaxTabs.get(tabId);
    if (syntaxAdapter && syntaxPath) {
      syntaxAdapter.onFileClosed(syntaxPath);
    }
    openSyntaxTabs.delete(tabId);
    if (!model.isDisposed()) model.dispose();
    models.delete(tabId);
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

