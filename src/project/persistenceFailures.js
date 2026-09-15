/**
 * Neutral persistence-failure observer (ADR-027 decision 2).
 *
 * Database and file adapters emit through one channel; the notice hook owns
 * presentation. Listeners are isolated so reporting a failed write can never
 * create a second failure.
 */
const listeners = new Set();

export function emitPersistenceWriteFailure({ command, error }) {
  for (const listener of listeners) {
    try {
      listener({ command, error });
    } catch {
      // Failure observers are informational and must not affect persistence.
    }
  }
}

export function onPersistenceWriteFailure(listener) {
  if (typeof listener !== 'function') return () => {};
  listeners.add(listener);
  return () => listeners.delete(listener);
}
