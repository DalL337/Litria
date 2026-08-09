import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyDragEndSnap,
  executeInteractionHistoryAction,
  getLassoSelectedIds
} from '../../src/app/interactionHelpers.js';

test('getLassoSelectedIds returns only finite ids', () => {
  const ids = getLassoSelectedIds([
    { id: 1 },
    { id: 'x' },
    { id: 2 },
    null,
    {}
  ]);
  assert.deepEqual(ids, [1, 2]);
});

test('applyDragEndSnap applies single-piece snap', () => {
  const pieces = [{ id: 1, x: 10, y: 20 }, { id: 2, x: 30, y: 40 }];
  const nextPieces = applyDragEndSnap({
    pieces,
    dragIds: [1],
    draggedPieceId: 1,
    dragX: 0,
    dragY: 0,
    checkSnap: () => ({ x: 99, y: 77 })
  });

  assert.deepEqual(nextPieces, [{ id: 1, x: 99, y: 77 }, { id: 2, x: 30, y: 40 }]);
});

test('applyDragEndSnap applies group snap delta', () => {
  const pieces = [{ id: 1, x: 10, y: 20 }, { id: 2, x: 30, y: 40 }, { id: 3, x: 0, y: 0 }];
  const nextPieces = applyDragEndSnap({
    pieces,
    dragIds: [1, 2],
    draggedPieceId: 1,
    dragX: 0,
    dragY: 0,
    getGroupSnapDelta: () => ({ dx: 5, dy: -3 })
  });

  assert.deepEqual(nextPieces, [
    { id: 1, x: 15, y: 17 },
    { id: 2, x: 35, y: 37 },
    { id: 3, x: 0, y: 0 }
  ]);
});

test('executeInteractionHistoryAction enforces begin/execute/end boundary', () => {
  const calls = [];
  const history = {
    beginGroup(label) {
      calls.push(['begin', label]);
    },
    execute(action, options) {
      calls.push(['execute', action.label, options ?? null]);
    },
    endGroup() {
      calls.push(['end']);
    }
  };

  executeInteractionHistoryAction(history, {
    label: 'Move pieces',
    action: { label: 'Move pieces' },
    skipDo: true
  });

  assert.deepEqual(calls, [
    ['begin', 'Move pieces'],
    ['execute', 'Move pieces', { skipDo: true }],
    ['end']
  ]);
});

