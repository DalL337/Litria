/**
 * lspClient.js — Tauri invoke wrappers for the generic LSP transport commands.
 *
 * Each function maps 1-to-1 to a Rust Tauri command defined in commands.rs.
 * Event subscriptions are collected via listenLspEvents().
 */

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ---------------------------------------------------------------------------
// Invoke wrappers
// ---------------------------------------------------------------------------

/**
 * Detect prerequisites for a language pack.
 * Returns LspPrerequisitesPayload: { languageId, allMet, probes: [...] }
 */
export async function lspDetectPrerequisites(languageId) {
  return invoke('lsp_detect_prerequisites', { languageId });
}

/**
 * Start an LSP session for (languageId, projectId, projectRoot).
 * Returns LspSessionStartedPayload: { sessionId, languageId, projectId, timestamp }
 */
export async function lspStartSession(languageId, projectId, projectRoot) {
  return invoke('lsp_start_session', { languageId, projectId, projectRoot });
}

/**
 * Stop the active LSP session for (languageId, projectId).
 * Returns LspSessionEndedPayload: { sessionId, languageId, projectId, timestamp }
 */
export async function lspStopSession(languageId, projectId) {
  return invoke('lsp_stop_session', { languageId, projectId });
}

/**
 * Send a JSON-RPC request on an active session and wait for the response.
 * @param {string} languageId
 * @param {string} projectId
 * @param {string} method  - LSP method name (e.g. 'textDocument/hover')
 * @param {object} params  - JSON-serialisable params
 * @param {number} [timeoutMs=5000]
 */
export async function lspRequest(languageId, projectId, method, params, timeoutMs = 5000) {
  return invoke('lsp_request', { languageId, projectId, method, params, timeoutMs });
}

/**
 * Language-server inventory for the settings surface (ADR-005 Slice 7).
 * Returns ServerInventoryPayload: { rows: [...], managedTotalBytes }.
 */
export async function lspServerInventory() {
  return invoke('lsp_server_inventory');
}

/**
 * Staged, verified install of a registry server (class-1). Also the update
 * path: installing the current registry pin beside an older version flips
 * the receipt's `current` pointer.
 */
export async function lspInstallServer(languageId, customUrl = null) {
  return invoke('lsp_install_server', { languageId, customUrl });
}

/**
 * Remove a managed server install (stops its sessions first).
 * Returns UninstallResultPayload: { languageId, server, freedBytes, stoppedSessions }.
 */
export async function lspUninstallServer(languageId) {
  return invoke('lsp_uninstall_server', { languageId });
}

/**
 * Re-hash the active managed binary against its install-time baseline.
 * Returns ReverifyResultPayload: { status, expectedSha256, actualSha256, ... }.
 */
export async function lspReverifyServer(languageId) {
  return invoke('lsp_reverify_server', { languageId });
}

/**
 * Enumerate installed Python interpreters (ADR-020 Slice 1).
 * Not an LSP transport command, but it lives here so all language-support
 * IPC coupling stays in this one module boundary (see createLspAdapters).
 * Returns PythonProbeReport: { interpreters: [...], excluded: [...] } —
 * interpreters sorted best-first, first entry = recommended default.
 */
export async function detectPythonInterpreters() {
  return invoke('detect_python_interpreters');
}

/**
 * Send a JSON-RPC notification on an active session (fire-and-forget).
 * Errors are silently swallowed — the session may not be active yet.
 * @param {string} languageId
 * @param {string} projectId
 * @param {string} method  - LSP method name (e.g. 'textDocument/didOpen')
 * @param {object} params  - JSON-serialisable params
 */
export async function lspNotify(languageId, projectId, method, params) {
  try {
    await invoke('lsp_notify', { languageId, projectId, method, params });
  } catch {
    // Session may not be active — ignore.
  }
}

// ---------------------------------------------------------------------------
// Event subscriptions
// ---------------------------------------------------------------------------

/**
 * Subscribe to all lsp:* Tauri events.
 *
 * @param {object} handlers
 * @param {function} [handlers.onSessionStarted]  (payload: LspSessionStartedPayload) => void
 * @param {function} [handlers.onSessionEnded]    (payload: LspSessionEndedPayload) => void
 * @param {function} [handlers.onError]           (payload: LspErrorEvent) => void
 * @param {function} [handlers.onDiagnostics]     (payload: DiagnosticsPayload) => void
 * @param {function} [handlers.onLogMessage]      (payload: LogMessagePayload) => void
 *
 * @returns {Promise<function>} Async cleanup function — call it to unsubscribe all listeners.
 */
export async function listenLspEvents({
  onSessionStarted,
  onSessionEnded,
  onError,
  onDiagnostics,
  onLogMessage,
} = {}) {
  const unlisten = await Promise.all([
    onSessionStarted
      ? listen('lsp:session-started', (e) => onSessionStarted(e.payload))
      : Promise.resolve(() => {}),
    onSessionEnded
      ? listen('lsp:session-ended', (e) => onSessionEnded(e.payload))
      : Promise.resolve(() => {}),
    onError
      ? listen('lsp:error', (e) => onError(e.payload))
      : Promise.resolve(() => {}),
    onDiagnostics
      ? listen('lsp:diagnostics', (e) => onDiagnostics(e.payload))
      : Promise.resolve(() => {}),
    onLogMessage
      ? listen('lsp:log-message', (e) => onLogMessage(e.payload))
      : Promise.resolve(() => {}),
  ]);

  return () => unlisten.forEach((fn) => fn());
}
