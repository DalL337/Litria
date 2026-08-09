// Remembers the Python interpreter the user last chose in the New Project
// wizard (ADR-020 Slice 2), so the environment strip preselects it on the
// next Python project instead of re-deriving the recommendation — the
// remember-folder precedent applied to interpreters. The wizard still
// validates the remembered path against the live probe before using it
// (machines change; a stale path silently falls back to the recommendation).
//
// localStorage, like lastProjectDir: available on the Launch screen before
// any project/DB is open.

const STORAGE_KEY = 'litria.lastPyInterpreter';

/** The remembered interpreter path, or undefined if none/unavailable. */
export function getLastPyInterpreter() {
  try {
    return localStorage.getItem(STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/** Remember the interpreter path chosen at creation. */
export function rememberPyInterpreter(path) {
  if (typeof path !== 'string' || !path) return;
  try {
    localStorage.setItem(STORAGE_KEY, path);
  } catch {
    // ignore — remembering is a convenience, never block creation
  }
}
