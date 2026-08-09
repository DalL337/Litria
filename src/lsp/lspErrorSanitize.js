/**
 * lspErrorSanitize.js — scrub backend IPC errors before they leave the LSP
 * adapter layer (audit #9).
 *
 * Rust `CommandError` serializes as `{ category, code, message }`; the `message`
 * can carry absolute paths / spawn details (e.g. "Project root 'C:\\Users\\…' is
 * not accessible"). These helpers keep the stable machine-readable `code` but
 * strip filesystem locations out of the human message so they never reach UI
 * error text. Pure (no Tauri coupling) so it is unit-testable in isolation.
 */

/** Replace the common absolute-path shapes with a `<path>` placeholder. */
export function scrubPaths(message) {
  return String(message)
    .replace(/[A-Za-z]:\\[^\s"'<>|]*/g, '<path>')             // Windows drive paths
    .replace(/\\\\[^\s"'<>|]+/g, '<path>')                    // UNC paths
    .replace(/\/(?:Users|home|root)\/[^\s"'<>|]*/g, '<path>'); // Unix home paths
}

/**
 * Wrap a backend IPC error into a sanitized shape. Preserves `{ category, code }`
 * and scrubs paths out of `message`; non-object errors are scrubbed directly.
 */
export function sanitizeLspError(e) {
  if (e && typeof e === 'object') {
    return typeof e.message === 'string' ? { ...e, message: scrubPaths(e.message) } : e;
  }
  if (typeof e === 'string') return scrubPaths(e);
  return e;
}
