/**
 * Files changed outside Litria (track T slice T3a): the neutral channel
 * between the save path and the notice that offers a choice.
 *
 * - A save that finds a newer version on disk writes nothing and reports it
 *   here; the disk-change hook owns what the person sees.
 * - Saves in flight are recorded, so the check of open files never mistakes
 *   Litria's own write for another program's.
 *
 * Listeners are isolated, as for persistence failures: reporting a conflict
 * can never create a second failure.
 */
const listeners = new Set();
const saving = new Map();

/**
 * @param {{ pieceId: unknown, filename: string, disk: string | null }} conflict
 *   `disk` is the revision on disk, or null when nothing has the name.
 */
export function reportDiskConflict(conflict) {
  for (const listener of listeners) {
    try {
      listener(conflict);
    } catch {
      // A notice is informational and must not affect the save.
    }
  }
}

export function onDiskConflict(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Mark a save of `key` (a piece id) in flight; returns the release. */
export function beginSave(key) {
  saving.set(key, (saving.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (saving.get(key) ?? 1) - 1;
    if (left <= 0) saving.delete(key);
    else saving.set(key, left);
  };
}

export function isSaving(key) {
  return saving.has(key);
}

// The text each piece's last save wrote. The piece state that records it
// lands a render later, so for a moment the check of open files can see the
// new file before the piece's new baseline: this keeps it from reading
// Litria's own save as another program's change.
const lastSaved = new Map();

export function noteSavedText(key, text) {
  lastSaved.set(key, text);
}

export function wasSavedText(key, text) {
  return lastSaved.has(key) && lastSaved.get(key) === text;
}

/** A project closed: nothing of it applies to the next one. */
export function forgetSavedTexts() {
  lastSaved.clear();
}
