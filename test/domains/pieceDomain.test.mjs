import test from 'node:test';
import assert from 'node:assert/strict';

import { createPieceDomain } from '../../src/app/pieceDomain.js';

function createStateSetter(getter, setter) {
  return (updater) => {
    const current = getter();
    const next = typeof updater === 'function' ? updater(current) : updater;
    setter(next);
  };
}

test('PieceDomain createPiece creates a spawning piece and increments next id', () => {
  let pieces = [];
  let nextId = 7;
  const timeoutCalls = [];
  const history = {
    execute(action) {
      action.do();
    }
  };

  const domain = createPieceDomain({
    history,
    setPieces: createStateSetter(() => pieces, (next) => {
      pieces = next;
    }),
    setNextId: createStateSetter(() => nextId, (next) => {
      nextId = next;
    }),
    getSpawnPosition: () => ({ x: 120, y: 240 }),
    getNextId: () => nextId,
    getRandomColor: () => '#abc123',
    setTimeoutFn: (callback, delay) => {
      timeoutCalls.push(delay);
      callback();
    }
  });

  const created = domain.commands.createPiece({ filename: 'src/main.js', label: 'main.js', code: '1', workingCode: '2' });

  assert.equal(created.id, 7);
  assert.equal(created.x, 120);
  assert.equal(created.y, 240);
  assert.equal(created.filename, 'src/main.js');
  assert.equal(created.label, 'main.js');
  assert.equal(created.color, null);
  assert.equal(created.isSpawning, true);
  assert.equal(nextId, 8);
  assert.deepEqual(timeoutCalls, [180]);
  assert.equal(pieces.length, 1);
  assert.equal(pieces[0].id, 7);
  assert.equal(pieces[0].isSpawning, false);
});

test('PieceDomain createPiece with a preassigned (SQLite) id keeps nextId ahead', () => {
  // Reconciliation guard (canvas-internals note 5): when a piece arrives with an
  // authoritative SQLite id, the client nextId counter must advance past it so a
  // later client-assigned id can never collide with an existing AUTOINCREMENT id.
  let pieces = [];
  let nextId = 3;
  const history = { execute(action) { action.do(); } };
  const domain = createPieceDomain({
    history,
    setPieces: createStateSetter(() => pieces, (next) => { pieces = next; }),
    setNextId: createStateSetter(() => nextId, (next) => { nextId = next; }),
    getSpawnPosition: () => ({ x: 0, y: 0 }),
    getNextId: () => nextId,
    setTimeoutFn: (cb) => cb()
  });

  // SQLite handed back id 9 while the client counter was only at 3.
  const created = domain.commands.createPiece({ filename: 'a.js', label: 'a.js', id: 9 });
  assert.equal(created.id, 9, 'uses the preassigned id verbatim');
  assert.equal(nextId, 10, 'nextId jumps past the preassigned id');

  // A preassigned id below the counter must not roll nextId backwards.
  domain.commands.createPiece({ filename: 'b.js', label: 'b.js', id: 4 });
  assert.equal(nextId, 10, 'nextId stays monotonic when preassigned id is lower');
});

test('PieceDomain createPiecesBatch keeps nextId ahead of preassigned ids', () => {
  let pieces = [];
  let nextId = 2;
  const history = { execute(action) { action.do(); } };
  const domain = createPieceDomain({
    history,
    setPieces: createStateSetter(() => pieces, (next) => { pieces = next; }),
    setNextId: createStateSetter(() => nextId, (next) => { nextId = next; }),
    getSpawnPosition: () => ({ x: 0, y: 0 }),
    getNextId: () => nextId
  });

  const created = domain.commands.createPiecesBatch([
    { filename: 'a.js', label: 'a.js', id: 5, x: 0, y: 0 },
    { filename: 'b.js', label: 'b.js', id: 8, x: 0, y: 0 }
  ]);

  assert.deepEqual(created.map((p) => p.id), [5, 8], 'preassigned ids used verbatim');
  assert.equal(nextId, 9, 'nextId advances past the highest preassigned id');
});

test('PieceDomain createPiecesBatch honors explicit per-item positions', () => {
  let pieces = [];
  let nextId = 10;
  const history = { execute(action) { action.do(); } };

  let spawnCallCount = 0;
  const domain = createPieceDomain({
    history,
    setPieces: createStateSetter(() => pieces, (next) => { pieces = next; }),
    setNextId: createStateSetter(() => nextId, (next) => { nextId = next; }),
    getSpawnPosition: () => { spawnCallCount += 1; return { x: 999, y: 999 }; },
    getNextId: () => nextId
  });

  const created = domain.commands.createPiecesBatch([
    { filename: 'a.js', label: 'a.js', x: 0, y: 0 },
    { filename: 'b.js', label: 'b.js', x: 200, y: 0 },
    { filename: 'c.js', label: 'c.js', x: 400, y: 100 }
  ]);

  assert.equal(created.length, 3);
  assert.deepEqual(created.map((p) => ({ x: p.x, y: p.y })), [
    { x: 0, y: 0 },
    { x: 200, y: 0 },
    { x: 400, y: 100 }
  ]);
  assert.equal(spawnCallCount, 0, 'getSpawnPosition must not be called when explicit positions provided');
});

test('PieceDomain createPiecesBatch falls back to getSpawnPosition when positions omitted', () => {
  let pieces = [];
  let nextId = 10;
  const history = { execute(action) { action.do(); } };

  let spawnCallCount = 0;
  const domain = createPieceDomain({
    history,
    setPieces: createStateSetter(() => pieces, (next) => { pieces = next; }),
    setNextId: createStateSetter(() => nextId, (next) => { nextId = next; }),
    getSpawnPosition: () => { spawnCallCount += 1; return { x: 50, y: 60 }; },
    getNextId: () => nextId
  });

  const created = domain.commands.createPiecesBatch([
    { filename: 'a.js', label: 'a.js' },
    { filename: 'b.js', label: 'b.js' }
  ]);

  assert.equal(created.length, 2);
  assert.equal(spawnCallCount, 2);
  assert.deepEqual(created.map((p) => ({ x: p.x, y: p.y })), [
    { x: 50, y: 60 },
    { x: 50, y: 60 }
  ]);
});

test('PieceDomain deletePieces runs grouped deletion and returns deleted ids', () => {
  let pieces = [
    { id: 1, label: 'one' },
    { id: 2, label: 'two' },
    { id: 3, label: 'three' }
  ];
  let beginCalls = 0;
  let endCalls = 0;
  const history = {
    beginGroup(label) {
      assert.equal(label, 'Delete pieces');
      beginCalls += 1;
    },
    endGroup() {
      endCalls += 1;
    },
    execute(action) {
      action.do();
    }
  };

  const domain = createPieceDomain({
    history,
    setPieces: createStateSetter(() => pieces, (next) => {
      pieces = next;
    }),
    setNextId: () => {},
    getSpawnPosition: () => ({ x: 0, y: 0 }),
    getNextId: () => 1,
    getRandomColor: () => '#000'
  });

  const deleted = domain.commands.deletePieces({
    ids: [2, 3],
    piecesById: new Map(pieces.map((piece) => [piece.id, piece])),
    pieces
  });

  assert.deepEqual(deleted, [2, 3]);
  assert.equal(beginCalls, 1);
  assert.equal(endCalls, 1);
  assert.deepEqual(pieces.map((piece) => piece.id), [1]);
});

test('PieceDomain selectors return expected values', () => {
  const pieces = [{ id: 1 }, { id: 2 }];
  const piecesById = new Map(pieces.map((piece) => [piece.id, piece]));

  const domain = createPieceDomain({
    history: { execute() {} },
    setPieces: () => {},
    setNextId: () => {},
    getSpawnPosition: () => ({ x: 0, y: 0 }),
    getNextId: () => 1,
    getRandomColor: () => '#000'
  });

  assert.equal(domain.selectors.getPieceById(piecesById, 1)?.id, 1);
  assert.equal(domain.selectors.getPieceById(piecesById, 999), null);
  assert.deepEqual(domain.selectors.listPieces(pieces), pieces);
  assert.notEqual(domain.selectors.listPieces(pieces), pieces);
});

test('PieceDomain updatePieceFilenames updates matching piece paths', () => {
  let pieces = [
    { id: 1, filename: 'a.js' },
    { id: 2, filename: 'b.js' }
  ];

  const domain = createPieceDomain({
    history: { execute() {} },
    setPieces: createStateSetter(() => pieces, (next) => {
      pieces = next;
    }),
    setNextId: () => {},
    getSpawnPosition: () => ({ x: 0, y: 0 }),
    getNextId: () => 1,
    getRandomColor: () => '#000'
  });

  domain.commands.updatePieceFilenames([{ pieceId: 2, path: 'group-1/b.js' }]);

  assert.deepEqual(pieces, [
    { id: 1, filename: 'a.js' },
    { id: 2, filename: 'group-1/b.js' }
  ]);
});

test('PieceDomain setPieceLabel sets, trims, and clears the display label', () => {
  let pieces = [
    { id: 1, filename: 'a.js', label: 'a.js' },
    { id: 2, filename: 'b.js', label: 'b.js' }
  ];

  const domain = createPieceDomain({
    history: { execute() {} },
    setPieces: createStateSetter(() => pieces, (next) => {
      pieces = next;
    }),
    setNextId: () => {},
    getSpawnPosition: () => ({ x: 0, y: 0 }),
    getNextId: () => 1
  });

  // Set + trim
  domain.commands.setPieceLabel({ id: 1, label: '  Main Entry  ' });
  assert.equal(pieces[0].label, 'Main Entry');
  assert.equal(pieces[1].label, 'b.js', 'other pieces untouched');

  // Clear (empty/whitespace → null, so getPieceDisplayName falls back to filename)
  domain.commands.setPieceLabel({ id: 1, label: '   ' });
  assert.equal(pieces[0].label, null);

  // No id → no-op
  domain.commands.setPieceLabel({ id: null, label: 'x' });
  assert.equal(pieces[0].label, null);
});

test('PieceDomain normalizeInvalidCoordinates repairs non-finite values', () => {
  let pieces = [
    { id: 1, x: 10, y: 20 },
    { id: 2, x: Number.NaN, y: 8 },
    { id: 3, x: 5, y: Number.POSITIVE_INFINITY }
  ];

  const domain = createPieceDomain({
    history: { execute() {} },
    setPieces: createStateSetter(() => pieces, (next) => {
      pieces = next;
    }),
    setNextId: () => {},
    getSpawnPosition: () => ({ x: 0, y: 0 }),
    getNextId: () => 1,
    getRandomColor: () => '#000'
  });

  domain.commands.normalizeInvalidCoordinates({ fallbackX: 60, fallbackY: 90 });

  assert.deepEqual(pieces, [
    { id: 1, x: 10, y: 20 },
    { id: 2, x: 60, y: 8 },
    { id: 3, x: 5, y: 90 }
  ]);
});

test('PieceDomain preview and replace commands update piece positions', () => {
  let pieces = [
    { id: 1, x: 10, y: 20 },
    { id: 2, x: 30, y: 40 }
  ];

  const domain = createPieceDomain({
    history: { execute() {} },
    setPieces: createStateSetter(() => pieces, (next) => {
      pieces = next;
    }),
    setNextId: () => {},
    getSpawnPosition: () => ({ x: 0, y: 0 }),
    getNextId: () => 1,
    getRandomColor: () => '#000'
  });

  domain.commands.previewMovePiece({ id: 1, x: 99, y: 77 });
  assert.deepEqual(pieces, [
    { id: 1, x: 99, y: 77 },
    { id: 2, x: 30, y: 40 }
  ]);

  domain.commands.previewMoveSelectedPieces({
    isSelected: (id) => id === 2,
    deltaX: 5,
    deltaY: -10
  });
  assert.deepEqual(pieces, [
    { id: 1, x: 99, y: 77 },
    { id: 2, x: 35, y: 30 }
  ]);

  const snapshot = new Map([
    [1, { id: 1, x: 10, y: 10 }]
  ]);
  domain.commands.previewMoveSnapshotPieces({ pieceSnapshot: snapshot, dx: 2, dy: 3 });
  assert.deepEqual(pieces, [
    { id: 1, x: 12, y: 13 },
    { id: 2, x: 35, y: 30 }
  ]);

  domain.commands.replacePieces([
    { id: 1, x: 1, y: 1 },
    { id: 2, x: 2, y: 2 }
  ]);
  assert.deepEqual(pieces, [
    { id: 1, x: 1, y: 1 },
    { id: 2, x: 2, y: 2 }
  ]);
});
