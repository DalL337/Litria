import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffPositions,
  mergeIntoPending,
  drainPending,
  computeFlushDelay,
  POSITION_FLUSH_DEBOUNCE_MS,
  POSITION_FLUSH_MAX_WAIT_MS
} from '../../src/project/positionOutbox.js';

// ---------------------------------------------------------------------------
// Position outbox (owner repro 2026-08-02): the old persistence effect kept
// detected moves only inside a cancellable setTimeout while advancing its
// last-seen map eagerly — any pieces churn within the debounce window (seam
// maintenance at drag-end, nudge-at-birth, editor commits) cancelled the
// write and made the moves permanently undetectable. Wired pieces reverted
// to creation positions on reopen. These tests pin the outbox invariants the
// fix rests on: detection lands in a pending map that survives cancellation,
// re-moves overwrite per-key, and only a drain empties the box.
// ---------------------------------------------------------------------------

const piece = (id, x, y) => ({ id, x, y });

test('diff detects position changes against the last-seen map', () => {
  const last = new Map([[1, { x: 12, y: 25 }], [2, { x: 700, y: 300 }]]);
  const { moves } = diffPositions(last, [piece(1, 45, 82), piece(2, 700, 300)]);
  assert.deepEqual(moves, [{ id: 1, x: 45, y: 82 }]);
});

test('diff treats unknown pieces as moves and returns a complete next map', () => {
  const last = new Map([[1, { x: 12, y: 25 }]]);
  const { moves, next } = diffPositions(last, [piece(1, 12, 25), piece(9, 5, 5)]);
  assert.deepEqual(moves, [{ id: 9, x: 5, y: 5 }]);
  assert.deepEqual([...next.keys()], [1, 9]);
});

test('diff is pure — inputs untouched', () => {
  const last = new Map([[1, { x: 12, y: 25 }]]);
  const pieces = [piece(1, 45, 82)];
  diffPositions(last, pieces);
  assert.deepEqual(last.get(1), { x: 12, y: 25 });
  assert.deepEqual(pieces, [piece(1, 45, 82)]);
});

test('identity churn with unchanged positions produces zero moves', () => {
  // The doorbell rings for workingCode commits / adjacency rebuilds too —
  // fresh piece objects, same x/y. Those runs must not enqueue anything.
  const last = new Map([[1, { x: 45, y: 82 }]]);
  const { moves } = diffPositions(last, [{ ...piece(1, 45, 82), workingCode: 'edited' }]);
  assert.deepEqual(moves, []);
});

test('merge is per-key: a re-move overwrites its own entry, others ride untouched', () => {
  const pending = new Map();
  mergeIntoPending(pending, [{ id: 1, x: 45, y: 82 }, { id: 2, x: 700, y: 300 }]);
  mergeIntoPending(pending, [{ id: 1, x: 200, y: 140 }]);
  assert.deepEqual(pending.get(1), { x: 200, y: 140 });
  assert.deepEqual(pending.get(2), { x: 700, y: 300 });
  assert.equal(pending.size, 2);
});

test('drain returns the batch payload and empties the box', () => {
  const pending = new Map([[1, { x: 200, y: 140 }], [2, { x: 700, y: 300 }]]);
  const moves = drainPending(pending);
  assert.deepEqual(moves, [
    { id: 1, x: 200, y: 140 },
    { id: 2, x: 700, y: 300 }
  ]);
  assert.equal(pending.size, 0, 'only a drain empties the outbox');
});

test('drain of an empty box is a no-op payload', () => {
  assert.deepEqual(drainPending(new Map()), []);
});

// ── The regression scenario, end to end at the pure layer ──────────────────
test('churn between detection and flush cannot lose the move', () => {
  // Run A: drag-end commits main.py's move — detected, enqueued.
  let last = new Map([[1, { x: 12, y: 25 }], [2, { x: 700, y: 300 }]]);
  const pending = new Map();
  const runA = diffPositions(last, [piece(1, 45, 82), piece(2, 700, 300)]);
  last = runA.next;
  mergeIntoPending(pending, runA.moves);

  // Run B (inside the window): seam maintenance parts a neighbor. The old
  // shape cancelled A's timer here with A's moves unrecoverable.
  const runB = diffPositions(last, [piece(1, 45, 82), piece(2, 716, 300)]);
  last = runB.next;
  mergeIntoPending(pending, runB.moves);

  // Run C: pure identity churn — enqueues nothing, disturbs nothing.
  const runC = diffPositions(last, [piece(1, 45, 82), piece(2, 716, 300)]);
  mergeIntoPending(pending, runC.moves);

  assert.deepEqual(drainPending(pending), [
    { id: 1, x: 45, y: 82 },
    { id: 2, x: 716, y: 300 }
  ], 'both the drag and the seam adjustment survive to the flush');
});

// ── Max-wait cap ───────────────────────────────────────────────────────────
test('flush delay is the debounce while young, shrinking to zero at max-wait', () => {
  const t0 = 100_000;
  assert.equal(computeFlushDelay(null, t0), POSITION_FLUSH_DEBOUNCE_MS);
  assert.equal(computeFlushDelay(t0, t0), POSITION_FLUSH_DEBOUNCE_MS);
  const nearCap = t0 + POSITION_FLUSH_MAX_WAIT_MS - 100;
  assert.equal(computeFlushDelay(t0, nearCap), 100, 'remaining budget beats the debounce');
  const pastCap = t0 + POSITION_FLUSH_MAX_WAIT_MS + 500;
  assert.equal(computeFlushDelay(t0, pastCap), 0, 'never negative, fires immediately');
});
