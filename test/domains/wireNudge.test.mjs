import test from 'node:test';
import assert from 'node:assert/strict';

import { computeBirthNudge, WIRE_NUDGE_SEAM } from '../../src/utils/wireNudge.js';
import { createUndoManager } from '../../src/history/undoManager.js';
import { movePiecesAction } from '../../src/history/actions.js';
import { executeInteractionHistoryAction } from '../../src/app/interactionHelpers.js';
import useAdjacency from '../../src/behaviors/useAdjacency.js';
import React from 'react';

const PIECE_W = 180;
const PIECE_H = 110;

const p = (id, x, y) => ({ id, x, y });

const nudge = (overrides = {}) => computeBirthNudge({
  sourceId: 'A',
  sourceSide: 'bottom',
  targetId: 'C',
  targetSide: 'top',
  pieces: [p('A', 0, 0), p('C', 600, 500)],
  pieceWidth: PIECE_W,
  pieceHeight: PIECE_H,
  ...overrides,
});

// ---------------------------------------------------------------------------
// computeBirthNudge — the minimal approach seam
// ---------------------------------------------------------------------------

test('an unobstructed birth needs no nudge', () => {
  assert.equal(nudge(), null);
});

test('a flush blocker on the anchored face parts by the seam width', () => {
  const moves = nudge({
    pieces: [p('A', 0, 0), p('B', 0, PIECE_H), p('C', 600, 500)],
  });
  assert.deepEqual(moves, [{ id: 'B', dx: 0, dy: WIRE_NUDGE_SEAM }]);
});

test('a flush chain parts as a rigid unit — internal flushness preserved', () => {
  const moves = nudge({
    pieces: [
      p('A', 0, 0),
      p('B', 0, PIECE_H),           // flush under A
      p('B2', 0, PIECE_H * 2),      // flush under B
      p('C', 600, 500),
    ],
  });
  assert.deepEqual(moves, [
    { id: 'B', dx: 0, dy: WIRE_NUDGE_SEAM },
    { id: 'B2', dx: 0, dy: WIRE_NUDGE_SEAM },
  ]);
});

test('a laterally offset flush neighbor outside the corridor is left alone', () => {
  // B sits flush below A but shifted right past the terminal corridor —
  // the launch path at the face midpoint is clear.
  const moves = nudge({
    pieces: [p('A', 0, 0), p('B', 120, PIECE_H), p('C', 600, 500)],
  });
  assert.equal(moves, null);
});

test('group members never freeform-nudge (D1d proportionality)', () => {
  const moves = nudge({
    pieces: [p('A', 0, 0), p('B', 0, PIECE_H), p('C', 600, 500)],
    groupByPieceId: new Map([['B', 7]]),
  });
  assert.equal(moves, null);
});

test('a seam that would shove the other endpoint aborts', () => {
  // C itself is the flush blocker under A's anchored face.
  const moves = computeBirthNudge({
    sourceId: 'A',
    sourceSide: 'bottom',
    targetId: 'C',
    targetSide: 'top',
    pieces: [p('A', 0, 0), p('C', 0, PIECE_H)],
    pieceWidth: PIECE_W,
    pieceHeight: PIECE_H,
  });
  // The other endpoint is never a blocker (contact-is-display handles it).
  assert.equal(moves, null);
});

test('both buried endpoints open both seams', () => {
  const moves = computeBirthNudge({
    sourceId: 'A',
    sourceSide: 'bottom',
    targetId: 'C',
    targetSide: 'top',
    pieces: [
      p('A', 0, 0), p('B', 0, PIECE_H),        // buries A.bottom
      p('C', 600, 500), p('D', 600, 500 - PIECE_H), // buries C.top
    ],
    pieceWidth: PIECE_W,
    pieceHeight: PIECE_H,
  });
  assert.deepEqual(moves, [
    { id: 'B', dx: 0, dy: WIRE_NUDGE_SEAM },
    { id: 'D', dx: 0, dy: -WIRE_NUDGE_SEAM },
  ]);
});

// ---------------------------------------------------------------------------
// undoManager — reentrant groups (single undo for nudge + connection)
// ---------------------------------------------------------------------------

test('nested groups compose into ONE undo step', () => {
  const history = createUndoManager();
  const log = [];
  const act = (name) => ({
    do: () => log.push(`do:${name}`),
    undo: () => log.push(`undo:${name}`),
  });

  history.beginGroup('Create connection');
  executeInteractionHistoryAction(history, { label: 'Nudge pieces', action: act('nudge') });
  executeInteractionHistoryAction(history, { label: 'Create connection', action: act('create') });
  history.endGroup();

  assert.deepEqual(log, ['do:nudge', 'do:create']);
  assert.equal(history.canUndo(), true);
  history.undo();
  // ONE undo reverts both, reverse order.
  assert.deepEqual(log, ['do:nudge', 'do:create', 'undo:create', 'undo:nudge']);
  assert.equal(history.canUndo(), false);
});

test('single-level grouping behaves exactly as before', () => {
  const history = createUndoManager();
  const log = [];
  executeInteractionHistoryAction(history, {
    label: 'Solo',
    action: { do: () => log.push('do'), undo: () => log.push('undo') },
  });
  history.undo();
  assert.deepEqual(log, ['do', 'undo']);
});

// ---------------------------------------------------------------------------
// The owner's question: does adjacency codewise overwrite the nudge?
// Proof: stored adjacentTo FOLLOWS the nudge in both do() and undo().
// ---------------------------------------------------------------------------

const withHookShim = (fn) => {
  const container = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
    ?? React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
  const dispatcher = { useCallback: (cb) => cb };
  if ('H' in container) {
    const prev = container.H;
    container.H = dispatcher;
    try { return fn(); } finally { container.H = prev; }
  }
  const slot = container.ReactCurrentDispatcher;
  const prev = slot.current;
  slot.current = dispatcher;
  try { return fn(); } finally { slot.current = prev; }
};

test('the nudge clears adjacentTo, and undo restores it — adjacency follows, never overwrites', () => {
  const adjacency = withHookShim(() => useAdjacency());
  const history = createUndoManager();

  // A with B snapped flush below (stored adjacency both ways), plus target C.
  let pieces = adjacency.rebuildAllAdjacencies([
    p('A', 0, 0), p('B', 0, PIECE_H), p('C', 600, 500),
  ]);
  assert.equal(pieces.find((x) => x.id === 'A').adjacentTo.bottom, 'B');
  assert.equal(pieces.find((x) => x.id === 'B').adjacentTo.top, 'A');

  // Birth of a wire from A.bottom → C.top: B must part.
  const moves = computeBirthNudge({
    sourceId: 'A', sourceSide: 'bottom', targetId: 'C', targetSide: 'top',
    pieces, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  assert.ok(moves);

  const deltaById = new Map(moves.map((m) => [m.id, m]));
  const movedIds = moves.map((m) => m.id);
  const afterPieces = pieces.map((x) => {
    const d = deltaById.get(x.id);
    return d ? { ...x, x: x.x + d.dx, y: x.y + d.dy } : x;
  });
  const action = movePiecesAction({
    beforePieces: pieces,
    afterPieces,
    setPieces: (updater) => { pieces = updater(pieces); },
    ids: movedIds,
    label: 'Nudge pieces',
    finalizePieces: (updated) => adjacency.updateAdjacenciesForPieces(updated, movedIds),
  });
  executeInteractionHistoryAction(history, { label: 'Nudge pieces', action });

  // After the nudge: seam open, stored adjacency CLEARED both ways.
  assert.equal(pieces.find((x) => x.id === 'B').y, PIECE_H + WIRE_NUDGE_SEAM);
  assert.equal(pieces.find((x) => x.id === 'A').adjacentTo.bottom, null);
  assert.equal(pieces.find((x) => x.id === 'B').adjacentTo.top, null);

  // Undo: positions AND stored adjacency restored — one coherent step.
  history.undo();
  assert.equal(pieces.find((x) => x.id === 'B').y, PIECE_H);
  assert.equal(pieces.find((x) => x.id === 'B').adjacentTo.top, 'A');
});

// ---------------------------------------------------------------------------
// Transit seams + umbrella (ADR-025 §4 as amended 2026-07-31: seams are
// maintained at every arrangement settle — wires never under-pass)
// ---------------------------------------------------------------------------

const { computeTransitSeams, computeWireSeams } = await import('../../src/utils/wireNudge.js');

test("the owner's scenario: a flush pair on the wire's path parts laterally", () => {
  // testdev4 above; flush pair testdev|testdev1 below it; wire from
  // testdev4.bottom to testdev3 far below — the intent line crosses the
  // pair's shared vertical seam. They part 10px each way (20px corridor).
  const pieces = [
    p('testdev4', 402, 45),
    p('testdev', 320, 200),          // right edge x=500
    p('testdev1', 500, 200),         // flush: left edge x=500
    p('testdev3', 410, 500),
  ];
  const moves = computeTransitSeams({
    wires: [{ sourceId: 'testdev4', sourceSide: 'bottom', targetId: 'testdev3', targetSide: 'top' }],
    pieces, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  assert.deepEqual(moves, [
    { id: 'testdev', dx: -WIRE_NUDGE_SEAM / 2, dy: 0 },
    { id: 'testdev1', dx: WIRE_NUDGE_SEAM / 2, dy: 0 },
  ]);
});

test('a near-flush pair (small gap) parts only by the remainder', () => {
  const pieces = [
    p('S', 402, 45),
    p('L', 316, 200), p('R', 500, 200),   // 4px gap at x=496..500
    p('T', 410, 500),
  ];
  const moves = computeTransitSeams({
    wires: [{ sourceId: 'S', sourceSide: 'bottom', targetId: 'T', targetSide: 'top' }],
    pieces, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  assert.deepEqual(moves, [
    { id: 'L', dx: -(WIRE_NUDGE_SEAM - 4) / 2, dy: 0 },
    { id: 'R', dx: (WIRE_NUDGE_SEAM - 4) / 2, dy: 0 },
  ]);
});

test('a pair NOT on the wire path stays put', () => {
  const pieces = [
    p('S', 402, 45),
    p('L', 900, 200), p('R', 1080, 200), // flush pair far to the right
    p('T', 410, 500),
  ];
  const moves = computeTransitSeams({
    wires: [{ sourceId: 'S', sourceSide: 'bottom', targetId: 'T', targetSide: 'top' }],
    pieces, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  assert.equal(moves, null);
});

test('grouped pairs never part (D1d) — the seam aborts cleanly', () => {
  const pieces = [
    p('S', 402, 45),
    p('L', 320, 200), p('R', 500, 200),
    p('T', 410, 500),
  ];
  const moves = computeTransitSeams({
    wires: [{ sourceId: 'S', sourceSide: 'bottom', targetId: 'T', targetSide: 'top' }],
    pieces, groupByPieceId: new Map([['L', 3]]),
    pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  assert.equal(moves, null);
});

test('horizontal seams part vertically for a left-to-right wire', () => {
  const pieces = [
    p('S', 0, 250),
    p('Top', 400, 145), p('Bot', 400, 255),  // flush horizontally-shared seam at y=255
    p('T', 900, 250),
  ];
  const moves = computeTransitSeams({
    wires: [{ sourceId: 'S', sourceSide: 'right', targetId: 'T', targetSide: 'left' }],
    pieces, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  assert.deepEqual(moves, [
    { id: 'Bot', dx: 0, dy: WIRE_NUDGE_SEAM / 2 },
    { id: 'Top', dx: 0, dy: -WIRE_NUDGE_SEAM / 2 },
  ]);
});

test('the umbrella composes face burial and transit seams', () => {
  // Overlapping blocker on the anchored face AND a flush pair mid-path.
  const pieces = [
    p('S', 402, 45),
    p('FaceBlock', 402, 150),               // flush under S's bottom face
    p('L', 320, 340), p('R', 500, 340),     // flush pair further down
    p('T', 410, 640),
  ];
  const moves = computeWireSeams({
    wires: [{ sourceId: 'S', sourceSide: 'bottom', targetId: 'T', targetSide: 'top' }],
    pieces, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  assert.ok(moves);
  const byId = Object.fromEntries(moves.map((m) => [m.id, m]));
  assert.ok(byId.FaceBlock.dy > 0, 'face blocker pushed down');
  assert.ok(byId.L.dx < 0 && byId.R.dx > 0, 'pair parted laterally');
});

test('N wires through one seam open N lanes — the readability rule', async () => {
  const { WIRE_CORRIDOR_SPACING } = await import('../../src/utils/wireSpacing.js');
  // Owner's fan-out: testdev4 feeds testdev3 (below-left) AND testdev6
  // (below-right); both intent lines cross the flush pair's seam.
  const pieces = [
    p('testdev4', 402, 45),
    p('testdev', 320, 200), p('testdev1', 500, 200),
    p('testdev3', 410, 500), p('testdev6', 660, 500),
  ];
  const wires = [
    { sourceId: 'testdev4', sourceSide: 'bottom', targetId: 'testdev3', targetSide: 'top' },
    { sourceId: 'testdev4', sourceSide: 'bottom', targetId: 'testdev6', targetSide: 'top' },
  ];
  const moves = computeTransitSeams({
    wires, pieces, pieceWidth: PIECE_W, pieceHeight: PIECE_H,
  });
  const required = WIRE_NUDGE_SEAM + WIRE_CORRIDOR_SPACING; // two lanes
  assert.deepEqual(moves, [
    { id: 'testdev', dx: -required / 2, dy: 0 },
    { id: 'testdev1', dx: required / 2, dy: 0 },
  ]);
});
