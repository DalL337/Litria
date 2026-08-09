// Remembers the folder the user last pointed the project pickers at, so the
// Create-project and Open-existing dialogs reopen where they expect (their dev
// projects folder) instead of falling back to the OS "last location" heuristic
// — which is why the pickers were drifting inside a previous project.
//
// Stored in localStorage (like recent projects and collapsed-dir state) so it's
// available on the Launch screen before any project/DB is open. One shared key:
// pointing at the folder in either flow primes both.

const STORAGE_KEY = 'litria.lastProjectDir';

/** The remembered project folder, or undefined if none/unavailable. */
export function getLastProjectDir() {
  try {
    return localStorage.getItem(STORAGE_KEY) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remember the folder a project lives in.
 * @param {string} pickedPath - the path returned by the folder picker.
 * @param {{ isContainer?: boolean }} [opts] - when true the picked path IS the
 *   container (Create flow); otherwise it's a project folder and we store its
 *   parent (Open-existing flow) so the next open lands on the project list.
 */
export function rememberProjectDir(pickedPath, { isContainer = false } = {}) {
  if (typeof pickedPath !== 'string' || !pickedPath) return;
  const dir = isContainer ? pickedPath : parentDir(pickedPath);
  if (!dir) return;
  try {
    localStorage.setItem(STORAGE_KEY, dir);
  } catch {
    // ignore — remembering the dir is a convenience, never block the picker
  }
}

/** Parent directory, handling both Windows (\) and POSIX (/) separators. */
function parentDir(p) {
  const normalized = p.replace(/[\\/]+$/, '');
  const parent = normalized.replace(/[\\/][^\\/]*$/, '');
  // Guard against collapsing a bare drive/root to nothing.
  return parent || normalized;
}
