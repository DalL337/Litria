/**
 * documentSync.js — LSP textDocument synchronization helpers.
 *
 * Tracks open documents (URI → version counter) and fires
 * textDocument/didOpen, textDocument/didChange, textDocument/didClose
 * notifications through lspNotify.
 *
 * SyncKind.Full is used — the full file text is sent on every change.
 * Version numbers increment monotonically so the server can detect gaps.
 *
 * All functions are fire-and-forget: lspNotify swallows errors when the
 * session is not active, so callers never need to guard the session state.
 */

import { lspNotify } from './lspClient.js';

// URI → version counter map.  Survives for the lifetime of the app.
const _versions = new Map();

// Per-URI pending debounce timer IDs.
const _debounceTimers = new Map();

const CHANGE_DEBOUNCE_MS = 150;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Notify the server that a document was opened.
 *
 * @param {string} languageId    - LSP language id (e.g. 'python')
 * @param {string} projectId     - CM project id (session key)
 * @param {string} uri           - file:///... URI passed to the server
 * @param {string} lspLanguageId - textDocument language id (e.g. 'python')
 * @param {string} text          - full file content
 */
export function didOpen(languageId, projectId, uri, lspLanguageId, text) {
  const version = _nextVersion(uri);
  lspNotify(languageId, projectId, 'textDocument/didOpen', {
    textDocument: { uri, languageId: lspLanguageId, version, text },
  });
}

/**
 * Notify the server that a document changed (debounced 150 ms).
 *
 * @param {string} languageId  - LSP language id for session lookup
 * @param {string} projectId
 * @param {string} uri
 * @param {string} text        - full new content
 */
export function didChange(languageId, projectId, uri, text) {
  if (_debounceTimers.has(uri)) {
    clearTimeout(_debounceTimers.get(uri));
  }
  const timer = setTimeout(() => {
    _debounceTimers.delete(uri);
    const version = _nextVersion(uri);
    lspNotify(languageId, projectId, 'textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
  }, CHANGE_DEBOUNCE_MS);
  _debounceTimers.set(uri, timer);
}

/**
 * Notify the server that a document was closed and clean up local state.
 *
 * @param {string} languageId
 * @param {string} projectId
 * @param {string} uri
 */
export function didClose(languageId, projectId, uri) {
  // Cancel any pending change notification.
  if (_debounceTimers.has(uri)) {
    clearTimeout(_debounceTimers.get(uri));
    _debounceTimers.delete(uri);
  }
  _versions.delete(uri);
  lspNotify(languageId, projectId, 'textDocument/didClose', {
    textDocument: { uri },
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _nextVersion(uri) {
  const v = (_versions.get(uri) ?? 0) + 1;
  _versions.set(uri, v);
  return v;
}
