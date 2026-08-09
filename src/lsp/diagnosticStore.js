/**
 * diagnosticStore.js
 *
 * Lightweight per-file diagnostic accumulator for the Glass Material System.
 * Receives LSP diagnostic events and stores error/warning counts per file URI.
 * The useNodeHealth hook reads from this store to drive corner LED state.
 *
 * This is intentionally a simple module-level Map, not a domain or Zustand store.
 * Diagnostic events fire frequently and the data is transient — it doesn't need
 * persistence, undo, or command/query separation.
 */

/** @type {Map<string, { errors: number, warnings: number }>} */
const diagnosticsByUri = new Map();

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * Normalize a file URI or path to a consistent key.
 * LSP sends file:// URIs, pieces use relative paths.
 * We store by decoded URI path (forward slashes, no protocol prefix).
 *
 * Exported because callers outside the store also need to compare LSP-returned
 * URIs (which tsserver percent-encodes and lowercases on Windows) against
 * URIs we built ourselves via `tabToLspUri` (raw, original case). Strict
 * string equality fails for the same logical file; normalized comparison
 * succeeds.
 */
export function normalizeUri(uri) {
  if (typeof uri !== 'string') return '';
  let path = uri;
  // Strip file:// protocol. file:/// URIs eat their third slash on slice(8),
  // which is correct for Windows (where the drive letter is the root) but
  // wrong for Unix (where the leading / IS the root). We re-prepend below.
  let strippedTriple = false;
  if (path.startsWith('file:///')) {
    path = path.slice(8);
    strippedTriple = true;
  } else if (path.startsWith('file://')) {
    path = path.slice(7);
  }
  // Decode URI components (%20 → space, %3A → :, etc.).
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep as-is if malformed
  }
  // For file:/// URIs: re-prepend the root slash for non-Windows paths.
  // Detect Windows by drive-letter pattern at the start.
  if (strippedTriple && !/^[a-zA-Z]:/.test(path)) {
    path = '/' + path;
  }
  // Normalize slashes
  return path.replace(/\\/g, '/').toLowerCase();
}

/**
 * Convert a piece filename (relative to project root) to the same key format.
 * @param {string} filename - Relative path like "src/App.tsx"
 * @param {string} projectRoot - Absolute project root like "C:/projects/myapp"
 */
export function pieceFileToKey(filename, projectRoot) {
  if (!filename || !projectRoot) return '';
  const root = projectRoot.replace(/\\/g, '/').replace(/\/$/, '');
  const file = filename.replace(/\\/g, '/').replace(/^\//, '');
  return `${root}/${file}`.toLowerCase();
}

/**
 * Update diagnostic counts for a file. Called from the LSP event listener.
 * @param {string} uri - File URI from LSP diagnostic event
 * @param {Array} diagnostics - Raw LSP diagnostic objects
 */
export function updateFileDiagnostics(uri, diagnostics) {
  const key = normalizeUri(uri);
  if (!key) return;

  const diags = Array.isArray(diagnostics) ? diagnostics : [];
  let errors = 0;
  let warnings = 0;

  for (const d of diags) {
    const severity = d?.severity ?? 1;
    // LSP severity: 1=Error, 2=Warning, 3=Information, 4=Hint
    if (severity === 1) errors++;
    else if (severity === 2) warnings++;
  }

  const prev = diagnosticsByUri.get(key);
  // Skip update if counts haven't changed (avoid unnecessary re-renders)
  if (prev && prev.errors === errors && prev.warnings === warnings) return;

  diagnosticsByUri.set(key, { errors, warnings });
  notifyListeners();
}

/**
 * Clear all diagnostics for a specific file (e.g., on file close or delete).
 */
export function clearFileDiagnostics(uri) {
  const key = normalizeUri(uri);
  if (!key || !diagnosticsByUri.has(key)) return;
  diagnosticsByUri.delete(key);
  notifyListeners();
}

/**
 * Clear all stored diagnostics (e.g., on project close).
 */
export function clearAllDiagnostics() {
  if (diagnosticsByUri.size === 0) return;
  diagnosticsByUri.clear();
  notifyListeners();
}

/**
 * Get diagnostic counts for a file by piece filename + project root.
 * @returns {{ errors: number, warnings: number } | null}
 */
export function getDiagnosticsForFile(filename, projectRoot) {
  const key = pieceFileToKey(filename, projectRoot);
  if (!key) return null;
  return diagnosticsByUri.get(key) ?? null;
}

/**
 * Get diagnostic counts by normalized URI key directly.
 * @returns {{ errors: number, warnings: number } | null}
 */
export function getDiagnosticsByKey(key) {
  return diagnosticsByUri.get(key) ?? null;
}

/**
 * Subscribe to diagnostic changes. Returns an unsubscribe function.
 * Used by React hooks (useNodeHealth) to trigger re-renders.
 */
export function subscribeToDiagnostics(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners() {
  for (const fn of listeners) {
    try { fn(); } catch { /* swallow */ }
  }
}
