// Position outbox — the buffer between React piece state and the batched
// position write (db_batch_move_pieces).
//
// Why it exists (owner repro 2026-08-02, .research/2026-08-02-position-
// persistence-regression.md): the old effect updated its last-seen positions
// eagerly and kept detected moves ONLY inside a pending setTimeout. React
// cleanup cancels that timer whenever `pieces` changes again — and post-drop
// churn is now routine (seam maintenance at drag-end, nudge-at-birth, editor
// workingCode commits) — so moves detected once were never re-detectable and
// the write was silently lost. Wired pieces reverted to creation positions on
// reopen while unwired pieces persisted.
//
// The outbox rule: detection writes into a pending map that SURVIVES timer
// cancellation. New churn delays the flush; only a successful drain empties
// the box. Entries are keyed per piece and hold the latest absolute x/y —
// destinations, not journeys — so re-moves overwrite in place.

/** Quiet window before a flush fires. */
export const POSITION_FLUSH_DEBOUNCE_MS = 300;

/**
 * Ceiling on how long a detected move may ride unflushed under continuous
 * churn (each churn resets the debounce; without a cap, sustained sub-300ms
 * state traffic — e.g. typing — could postpone the write indefinitely,
 * leaving a hard crash to eat it).
 */
export const POSITION_FLUSH_MAX_WAIT_MS = 2000;

/**
 * Diff current pieces against the last-seen position map.
 * Returns the detected moves and the next last-seen map. Pure — touches
 * neither input.
 */
export function diffPositions(lastPositions, pieces) {
  const moves = [];
  const next = new Map();
  for (const piece of pieces) {
    next.set(piece.id, { x: piece.x, y: piece.y });
    const prev = lastPositions.get(piece.id);
    if (!prev || prev.x !== piece.x || prev.y !== piece.y) {
      moves.push({ id: piece.id, x: piece.x, y: piece.y });
    }
  }
  return { moves, next };
}

/**
 * Merge detected moves into the pending outbox (mutates `pending`).
 * Per-key overwrite: a piece re-moved before the flush replaces its own
 * entry and never disturbs the others.
 */
export function mergeIntoPending(pending, moves) {
  for (const move of moves) {
    pending.set(move.id, { x: move.x, y: move.y });
  }
  return pending;
}

/**
 * Empty the outbox, returning its contents as a db_batch_move_pieces
 * payload. Draining BEFORE the async write means moves detected while a
 * write is in flight land in a fresh box instead of being cleared with it.
 */
export function drainPending(pending) {
  const moves = [];
  for (const [id, pos] of pending) {
    moves.push({ id, x: pos.x, y: pos.y });
  }
  pending.clear();
  return moves;
}

/**
 * Delay until the flush timer should fire: the debounce, shortened so the
 * oldest pending entry never waits past POSITION_FLUSH_MAX_WAIT_MS total.
 */
export function computeFlushDelay(firstPendingAt, now) {
  if (firstPendingAt == null) return POSITION_FLUSH_DEBOUNCE_MS;
  const remaining = POSITION_FLUSH_MAX_WAIT_MS - (now - firstPendingAt);
  return Math.max(0, Math.min(POSITION_FLUSH_DEBOUNCE_MS, remaining));
}
