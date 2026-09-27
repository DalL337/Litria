// Controller integration for the structural grid (brief-structural-grid §9
// Slice 3, §10 mandatory scenarios). Drives the REAL interaction controller
// in happy-dom with the real snap, adjacency, piece domain, history and seam
// code; only pointer plumbing (Konva stage, lasso, connection drag) is faked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

register('../support/jsx-hooks.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent']) {
  if (dom[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { useCanvasInteractionController } = await import('../../src/behaviors/useCanvasInteractionController.js');
const { default: useSnap } = await import('../../src/behaviors/useSnap.js');
const { default: useAdjacency } = await import('../../src/behaviors/useAdjacency.js');
const { default: usePiecePlacement } = await import('../../src/behaviors/usePiecePlacement.js');
const { createPieceDomain } = await import('../../src/app/pieceDomain.js');
const { createUndoManager } = await import('../../src/history/undoManager.js');
const { movePiecesAction } = await import('../../src/history/actions.js');
const { buildGroupBoundsWithDescendants } = await import('../../src/app/selectors/workspaceSelectors.js');
const { DEFAULT_GRID_DEFINITION, deriveGridSteps } = await import('../../src/utils/gridGeometry.js');

const W = 180;
const H = 110;
const steps = deriveGridSteps(DEFAULT_GRID_DEFINITION);

function mount({
  pieces: initialPieces,
  groups = [],
  connections = [],
  mode = 'strict',
  guides = true,
  selected = [],
  onGroupSeedTranslate = null,
}) {
  const history = createUndoManager();
  const stageNodes = [];
  const stage = { find: (predicate) => stageNodes.filter(predicate) };
  let latest = null;

  function Harness() {
    const [pieces, setPieces] = React.useState(initialPieces);
    const piecesById = React.useMemo(() => new Map(pieces.map((p) => [p.id, p])), [pieces]);
    const selection = React.useMemo(() => ({
      isSelected: (id) => selected.includes(id),
      selectedIds: selected,
      count: selected.length,
      clear() {},
      selectMultiple() {},
    }), []);
    const pieceDomain = React.useMemo(() => createPieceDomain({
      history,
      setPieces,
      setNextId() {},
      getSpawnPosition: () => ({ x: 0, y: 0 }),
      getNextId: () => 1,
    }), []);
    const snap = useSnap({ pieces, piecesById, selection, snapDistance: 40, pieceWidth: W, pieceHeight: H, connections });
    const adjacency = useAdjacency();
    const placement = usePiecePlacement();
    const groupByPieceId = React.useMemo(
      () => new Map(groups.flatMap((g) => g.pieceIds.map((pid) => [pid, g.id]))),
      [],
    );
    const getGroupBounds = React.useCallback(
      (group) => buildGroupBoundsWithDescendants(group, groups, piecesById, W, H),
      [piecesById],
    );
    const controller = useCanvasInteractionController({
      adjacency,
      adjacencyMode: 'fast',
      checkSnap: snap.checkSnap,
      clamp: (value, lo, hi) => Math.min(hi, Math.max(lo, value)),
      connectionDrag: { isDragging: false },
      connectionDomain: { selectors: { getAllConnections: () => connections } },
      getGroupBounds,
      getGroupSnapDelta: snap.getGroupSnapDelta,
      groupByPieceId,
      groupDrag: { endGroupDrag() {} },
      groups,
      history,
      isFiniteNumber: Number.isFinite,
      lasso: { isSelecting: false },
      minScale: 0.25,
      maxScale: 1.5,
      modifiers: {},
      movePiecesAction,
      pieceHeight: H,
      pieceWidth: W,
      pieces,
      piecesById,
      placement,
      selection,
      pieceDomain,
      setDragDebug() {},
      setScaffoldFocus() {},
      setSelectedGroupId() {},
      stageRef: { current: stage },
      hiddenPieceIds: new Set(),
      onGroupSeedTranslate,
      getGridPlacement: () => ({ mode, steps, guides, guideTolerancePx: 6 }),
      getViewportScale: () => 1,
    });
    latest = { controller, pieces };
    return null;
  }

  const container = dom.document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(React.createElement(Harness)));
  const run = (fn) => act(() => fn(latest.controller));
  return {
    history,
    stageNodes,
    run,
    get pieces() { return latest.pieces; },
    get preview() { return latest.controller.placementPreview; },
    at(id) {
      const piece = latest.pieces.find((p) => p.id === id);
      return { x: piece.x, y: piece.y };
    },
    unmount: () => act(() => root.unmount()),
  };
}

// A drag of one piece: start, one move to (x, y), end at (x, y).
function drag(harness, id, x, y) {
  harness.run((c) => c.handlePieceDragStart(id));
  harness.run((c) => c.handlePieceDragMove(id, x, y));
  harness.run((c) => c.handlePieceDragEnd(id, x, y));
}

const piece = (id, x, y, extra = {}) => ({ id, x, y, scale: 1, adjacentTo: { top: null, right: null, bottom: null, left: null }, references: [], ...extra });

test('Strict: a drop lands on the nearest free major intersection; one undo restores it', () => {
  const h = mount({ pieces: [piece(1, 0, 0), piece(2, 613, 247)] });
  drag(h, 2, 635, 229);
  assert.deepEqual(h.at(2), { x: 600, y: 200 });
  h.run(() => h.history.undo());
  assert.deepEqual(h.at(2), { x: 613, y: 247 });
  h.run(() => h.history.redo());
  assert.deepEqual(h.at(2), { x: 600, y: 200 });
  h.unmount();
});

test('Strict never docks flush, even inside the snap distance', () => {
  const h = mount({ pieces: [piece(1, 0, 0), piece(2, 600, 0)] });
  drag(h, 2, 195, 4); // flush would be x = 180
  assert.deepEqual(h.at(2), { x: 200, y: 0 });
  h.unmount();
});

test('Flex keeps today\'s flush dock', () => {
  const h = mount({ pieces: [piece(1, 0, 0), piece(2, 600, 0)], mode: 'flex' });
  drag(h, 2, 195, 4);
  assert.deepEqual(h.at(2), { x: 180, y: 0 });
  h.unmount();
});

test('Flex: a smart guide grabs the nearest face; guides off lets the lattice round', () => {
  const layout = () => [piece(1, -300, 100), piece(2, 0, 200), piece(3, 613, 247)];
  const on = mount({ pieces: layout(), mode: 'flex' });
  drag(on, 3, 603, 206); // db-like bottom edge at 210 is 4 away
  assert.deepEqual(on.at(3), { x: 600, y: 210 });
  on.unmount();
  const off = mount({ pieces: layout(), mode: 'flex', guides: false });
  drag(off, 3, 603, 203);
  assert.deepEqual(off.at(3), { x: 600, y: 200 });
  off.unmount();
});

test('the preview shows the landing while dragging and clears at the drop', () => {
  const h = mount({ pieces: [piece(1, 0, 0), piece(2, 613, 247)] });
  h.run((c) => c.handlePieceDragStart(2));
  h.run((c) => c.handlePieceDragMove(2, 635, 229));
  assert.equal(h.preview.reason, 'major');
  assert.deepEqual(h.preview.positions.get(2), { x: 600, y: 200 });
  assert.ok(Array.isArray(h.preview.guideLines));
  h.run((c) => c.handlePieceDragEnd(2, 635, 229));
  assert.equal(h.preview, null);
  h.unmount();
});

test('a Strict drop that seals a two-wire seam parts it off-major; undo and redo keep every affected node', () => {
  // L and R sit 20 apart; two vertical wires cross their shared seam, which
  // needs 20 + 16 = 36. The drop of L resolves on the grid, then the seam
  // parts the pair 8 each way — off the major lattice, and it stays there.
  const pieces = [
    piece('L', 50, 40), piece('R', 200, 0),
    piece('T1', 100, -400), piece('B1', 100, 400),
    piece('T2', 100, -600), piece('B2', 100, 600),
  ];
  const connections = [
    { id: 'w1', sourceId: 'T1', sourceSide: 'bottom', targetId: 'B1', targetSide: 'top' },
    { id: 'w2', sourceId: 'T2', sourceSide: 'bottom', targetId: 'B2', targetSide: 'top' },
  ];
  const h = mount({ pieces, connections });
  drag(h, 'L', 20, 10); // Strict → (0, 0), flush-ish 20 from R
  assert.deepEqual(h.at('L'), { x: -8, y: 0 });
  assert.deepEqual(h.at('R'), { x: 208, y: 0 });
  h.run(() => h.history.undo());
  assert.deepEqual(h.at('L'), { x: 50, y: 40 });
  assert.deepEqual(h.at('R'), { x: 200, y: 0 });
  h.run(() => h.history.redo());
  assert.deepEqual(h.at('L'), { x: -8, y: 0 });
  assert.deepEqual(h.at('R'), { x: 208, y: 0 });
  h.unmount();
});

test('a multi-selection moves rigidly: the set corner snaps and offsets hold', () => {
  const h = mount({ pieces: [piece(1, 0, 0), piece(2, 30, 250), piece(9, 900, 900)], selected: [1, 2] });
  h.run((c) => c.handlePieceDragStart(1));
  h.run((c) => c.handlePieceDragMove(1, 412, 318));
  h.run((c) => c.handlePieceDragEnd(1, 412, 318));
  assert.deepEqual(h.at(1), { x: 400, y: 300 });
  assert.deepEqual(h.at(2), { x: 430, y: 550 }, 'offset (30, 250) kept');
  h.unmount();
});

test('no free spot nearby: the drag ends where it began, with no history', () => {
  const pieces = [];
  for (let i = -8; i <= 8; i++) {
    for (let j = -8; j <= 8; j++) pieces.push(piece(`n${i}_${j}`, i * 200, j * 200, { scale: 1.2 }));
  }
  pieces.push(piece('me', 5000, 5000));
  const h = mount({ pieces });
  drag(h, 'me', 10, 10);
  assert.deepEqual(h.at('me'), { x: 5000, y: 5000 });
  assert.equal(h.history.canUndo?.() ?? false, false);
  h.unmount();
});

test('Escape cancels a drag: the start comes back and nothing is recorded', () => {
  const h = mount({ pieces: [piece(1, 0, 0), piece(2, 613, 247)] });
  h.run((c) => c.handlePieceDragStart(2));
  h.run((c) => c.handlePieceDragMove(2, 900, 700));
  // Konva's stopDrag fires dragend; the fake node does the same.
  h.stageNodes.push({ isDragging: () => true, stopDrag: () => h.run((c) => c.handlePieceDragEnd(2, 900, 700)) });
  h.run((c) => { assert.equal(c.cancelActiveDrag(), true); });
  assert.deepEqual(h.at(2), { x: 613, y: 247 });
  assert.equal(h.history.canUndo?.() ?? false, false);
  h.unmount();
});

test('a group drag snaps its members\' corner, keeps offsets, and is one undo', () => {
  const group = { id: 'g', pieceIds: [1, 2], isCollapsed: false, parentId: null };
  const h = mount({ pieces: [piece(1, 0, 0), piece(2, 200, 0), piece(3, 900, 900)], groups: [group] });
  h.run((c) => c.handleGroupPillDragStart('g', { detectNest: false }));
  // The Konva box moved by (137, 58); members preview the same delta.
  h.run((c) => c.handleGroupPillDragMove({ target: { x: () => 137, y: () => 58 }, evt: null }));
  h.run((c) => c.handleGroupPillDragEnd('g'));
  assert.deepEqual(h.at(1), { x: 100, y: 100 });
  assert.deepEqual(h.at(2), { x: 300, y: 100 });
  h.run(() => h.history.undo());
  assert.deepEqual(h.at(1), { x: 0, y: 0 });
  assert.deepEqual(h.at(2), { x: 200, y: 0 });
  h.unmount();
});

test('a memberless group\'s seed lands on the lattice', () => {
  const calls = [];
  const group = { id: 'seed', pieceIds: [], isCollapsed: false, parentId: null, seedBounds: { x: 40, y: 20, width: 160, height: 80 } };
  const h = mount({ pieces: [piece(1, 900, 900)], groups: [group], onGroupSeedTranslate: (...args) => calls.push(args) });
  h.run((c) => c.handleGroupPillDragStart('seed', { detectNest: false }));
  h.run((c) => c.handleGroupPillDragMove({ target: { x: () => 40 + 155, y: () => 20 + 71 }, evt: null }));
  h.run((c) => c.handleGroupPillDragEnd('seed'));
  // Seed corner (40, 20) moved by (155, 71) → (195, 91) → major (200, 100).
  assert.deepEqual(calls, [['seed', 160, 80]]);
  h.unmount();
});

test('scale grows from each node\'s own corner and is one undo', () => {
  const h = mount({ pieces: [piece(1, 100, 200), piece(2, 400, 200)], selected: [1, 2] });
  h.run((c) => c.scaleSelectedPieces(1.25));
  const [a, b] = h.pieces;
  assert.deepEqual({ x: a.x, y: a.y, scale: a.scale }, { x: 100, y: 200, scale: 1.25 });
  assert.deepEqual({ x: b.x, y: b.y, scale: b.scale }, { x: 400, y: 200, scale: 1.25 });
  h.run(() => h.history.undo());
  assert.equal(h.pieces[0].scale, 1);
  assert.equal(h.pieces[1].scale, 1);
  h.unmount();
});

test('scaling that seals a wired face opens a seam in the same undo step', () => {
  // A's right face carries a wire to C; B sits 20 off it. Scaling A to 1.25
  // grows its face to x = 325, burying B's left edge (220): B parts to a seam.
  const pieces = [piece('A', 100, 0), piece('B', 300, 0), piece('C', 900, 0)];
  const connections = [{ id: 'w', sourceId: 'A', sourceSide: 'right', targetId: 'C', targetSide: 'left' }];
  const h = mount({ pieces, connections, selected: ['A'] });
  h.run((c) => c.scaleSelectedPieces(1.25));
  assert.equal(h.pieces.find((p) => p.id === 'A').scale, 1.25);
  assert.deepEqual(h.at('A'), { x: 100, y: 0 }, 'the corner never moves');
  assert.ok(h.at('B').x >= 100 + 225 + 20, `B parted to a seam: ${h.at('B').x}`);
  h.run(() => h.history.undo());
  assert.deepEqual(h.at('B'), { x: 300, y: 0 });
  assert.equal(h.pieces.find((p) => p.id === 'A').scale, 1);
  h.unmount();
});
