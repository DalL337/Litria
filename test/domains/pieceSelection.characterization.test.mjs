import test from 'node:test';
import assert from 'node:assert/strict';

import { createPieceDomain } from '../../src/app/pieceDomain.js';
import { createSelectionDomain } from '../../src/app/selectionDomain.js';

function createStateSetter(getter, setter) {
  return (updater) => {
    const current = getter();
    const next = typeof updater === 'function' ? updater(current) : updater;
    setter(next);
  };
}

function createSelectionModel() {
  let selectedIds = [];

  const selection = {
    select(id) {
      selectedIds = [id];
    },
    add(id) {
      if (!selectedIds.includes(id)) selectedIds = [...selectedIds, id];
    },
    remove(id) {
      selectedIds = selectedIds.filter((selectedId) => selectedId !== id);
    },
    toggle(id) {
      selectedIds = selectedIds.includes(id)
        ? selectedIds.filter((selectedId) => selectedId !== id)
        : [...selectedIds, id];
    },
    clear() {
      selectedIds = [];
    },
    selectMultiple(ids) {
      selectedIds = [...ids];
    },
    isSelected(id) {
      return selectedIds.includes(id);
    }
  };

  Object.defineProperty(selection, 'selectedIds', {
    get() {
      return selectedIds;
    }
  });
  Object.defineProperty(selection, 'count', {
    get() {
      return selectedIds.length;
    }
  });
  Object.defineProperty(selection, 'hasSelection', {
    get() {
      return selectedIds.length > 0;
    }
  });

  return selection;
}

test('characterization: piece create/select/toggle/delete flow remains stable', () => {
  let pieces = [];
  let nextId = 1;
  const history = {
    execute(action) {
      action.do();
    },
    beginGroup() {},
    endGroup() {}
  };

  const pieceDomain = createPieceDomain({
    history,
    setPieces: createStateSetter(() => pieces, (next) => {
      pieces = next;
    }),
    setNextId: createStateSetter(() => nextId, (next) => {
      nextId = next;
    }),
    getSpawnPosition: () => ({ x: 10, y: 20 }),
    getNextId: () => nextId,
    getRandomColor: () => '#123456',
    setTimeoutFn: (callback) => callback()
  });

  const selection = createSelectionModel();
  const selectionDomain = createSelectionDomain(selection);

  const a = pieceDomain.commands.createPiece({ filename: 'a.js', label: 'a.js' });
  const b = pieceDomain.commands.createPiece({ filename: 'b.js', label: 'b.js' });
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(nextId, 3);
  assert.deepEqual(pieces.map((piece) => piece.id), [1, 2]);

  selectionDomain.commands.select(a.id);
  assert.deepEqual(selectionDomain.selectors.getSelectedIds(), [1]);
  assert.equal(selectionDomain.selectors.getCount(), 1);

  selectionDomain.commands.toggle(b.id);
  assert.deepEqual(selectionDomain.selectors.getSelectedIds(), [1, 2]);
  assert.equal(selectionDomain.selectors.isSelected(2), true);

  selectionDomain.commands.toggle(a.id);
  assert.deepEqual(selectionDomain.selectors.getSelectedIds(), [2]);
  assert.equal(selectionDomain.selectors.getCount(), 1);

  selectionDomain.commands.selectMultiple([a.id, b.id]);
  assert.deepEqual(selectionDomain.selectors.getSelectedIds(), [1, 2]);
  assert.equal(selectionDomain.selectors.hasSelection(), true);

  pieceDomain.commands.deletePieces({
    ids: selectionDomain.selectors.getSelectedIds(),
    piecesById: new Map(pieces.map((piece) => [piece.id, piece])),
    pieces
  });
  assert.deepEqual(pieces, []);

  selectionDomain.commands.clear();
  assert.deepEqual(selectionDomain.selectors.getSelectedIds(), []);
  assert.equal(selectionDomain.selectors.getCount(), 0);
});

