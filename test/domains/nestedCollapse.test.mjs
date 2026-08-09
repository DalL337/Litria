import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildHiddenPieceIds,
  buildGroupPills,
  buildGroupBoundsWithDescendants,
  collectSubtreePieceIds,
  hasCollapsedAncestor,
  COLLAPSED_STUB_HEIGHT,
} from '../../src/app/selectors/workspaceSelectors.js';
import { buildWireObstacles } from '../../src/app/selectors/wireRoutes.js';

// ---------------------------------------------------------------------------
// D3 (brief-nested-group-containment, owner-ruled 2026-07-28): a collapsed
// parent hides its WHOLE subtree — descendant pieces, boxes, and pills fold
// into the parent's pill; children's own collapse state is never mutated.
// Owner live repro 2026-08-01: child groups escaped the parent pill.
// ---------------------------------------------------------------------------

const PIECE_W = 160;
const PIECE_H = 120;

// parent(p1) > child(c: p2,p3) > grandchild(g: p4); unrelated(u: p9)
function makeGroups({ parentCollapsed = false, childCollapsed = false } = {}) {
  return [
    { id: 'parent', name: 'parent', parentId: null, isCollapsed: parentCollapsed, pieceIds: [1] },
    { id: 'child', name: 'child', parentId: 'parent', isCollapsed: childCollapsed, pieceIds: [2, 3] },
    { id: 'grand', name: 'grand', parentId: 'child', isCollapsed: false, pieceIds: [4] },
    { id: 'unrelated', name: 'unrelated', parentId: null, isCollapsed: false, pieceIds: [9] },
  ];
}

function makePiecesById() {
  return new Map([
    [1, { id: 1, x: 0, y: 0, scale: 1 }],
    [2, { id: 2, x: 400, y: 100, scale: 1 }],
    [3, { id: 3, x: 600, y: 100, scale: 1 }],
    [4, { id: 4, x: 500, y: 300, scale: 1 }],
    [9, { id: 9, x: 2000, y: 2000, scale: 1 }],
  ]);
}

test('collapsed parent hides the whole subtree, expanded children included', () => {
  const hidden = buildHiddenPieceIds(makeGroups({ parentCollapsed: true }));
  assert.deepEqual([...hidden].sort(), [1, 2, 3, 4]);
});

test('collapsed parent + collapsed child: same subtree, no double-count issues', () => {
  const hidden = buildHiddenPieceIds(makeGroups({ parentCollapsed: true, childCollapsed: true }));
  assert.deepEqual([...hidden].sort(), [1, 2, 3, 4]);
});

test('collapsing only the child hides the child subtree, not the parent pieces', () => {
  const hidden = buildHiddenPieceIds(makeGroups({ childCollapsed: true }));
  assert.deepEqual([...hidden].sort(), [2, 3, 4]);
});

test('parentId cycles terminate instead of hanging', () => {
  const cyclic = [
    { id: 'a', parentId: 'b', isCollapsed: true, pieceIds: [1] },
    { id: 'b', parentId: 'a', isCollapsed: false, pieceIds: [2] },
  ];
  const hidden = buildHiddenPieceIds(cyclic);
  assert.deepEqual([...hidden].sort(), [1, 2]);
});

test('hasCollapsedAncestor: strict ancestry, transitive, never self', () => {
  const groups = makeGroups({ parentCollapsed: true });
  const byId = new Map(groups.map((g) => [g.id, g]));
  assert.equal(hasCollapsedAncestor(byId.get('child'), byId), true);
  assert.equal(hasCollapsedAncestor(byId.get('grand'), byId), true, 'transitive through expanded child');
  assert.equal(hasCollapsedAncestor(byId.get('parent'), byId), false, 'a group is not its own ancestor');
  assert.equal(hasCollapsedAncestor(byId.get('unrelated'), byId), false);
});

test('collectSubtreePieceIds walks own + descendants', () => {
  const groups = makeGroups();
  const childrenByParent = new Map([
    ['parent', [groups[1]]],
    ['child', [groups[2]]],
  ]);
  assert.deepEqual([...collectSubtreePieceIds(groups[0], childrenByParent)].sort(), [1, 2, 3, 4]);
  assert.deepEqual([...collectSubtreePieceIds(groups[1], childrenByParent)].sort(), [2, 3, 4]);
});

test('pill count is the subtree count, computed over the unfiltered list', () => {
  const groups = makeGroups({ parentCollapsed: true });
  // Renderable list excludes ancestor-collapsed children — the pill still
  // counts them via allGroups.
  const renderable = groups.filter((g) => g.id === 'parent' || g.id === 'unrelated');
  const bounds = { minX: 0, minY: 0, maxX: 10, maxY: 10, centerX: 5, centerY: 5 };
  const pills = buildGroupPills(renderable, () => bounds, PIECE_W, PIECE_H, null, groups);
  const parentPill = pills.find((p) => p.id === 'parent');
  assert.ok(parentPill);
  assert.equal(parentPill.pieceCount, 4);
});

test('pure-container collapsed parent still gets a stub, anchored at descendant union', () => {
  const groups = [
    { id: 'shell', name: 'shell', parentId: null, isCollapsed: true, pieceIds: [] },
    { id: 'inner', name: 'inner', parentId: 'shell', isCollapsed: false, pieceIds: [2, 3] },
  ];
  const bounds = buildGroupBoundsWithDescendants(groups[0], groups, makePiecesById(), PIECE_W, PIECE_H);
  assert.ok(bounds, 'a folder-of-folders must not lose its pill when its subtree hides');
  assert.equal(bounds.minX, 400);
  assert.equal(bounds.minY, 100);
  assert.equal(bounds.maxX, 400 + PIECE_W);
  assert.equal(bounds.maxY, 100 + COLLAPSED_STUB_HEIGHT);
});

test('pure-container collapsed parent with no measurable descendants stays boundless', () => {
  const groups = [
    { id: 'shell', name: 'shell', parentId: null, isCollapsed: true, pieceIds: [] },
  ];
  assert.equal(buildGroupBoundsWithDescendants(groups[0], groups, makePiecesById(), PIECE_W, PIECE_H), null);
});

test('collapsed group with own pieces keeps its own stub position (unchanged behavior)', () => {
  const groups = makeGroups({ parentCollapsed: true });
  const bounds = buildGroupBoundsWithDescendants(groups[0], groups, makePiecesById(), PIECE_W, PIECE_H);
  assert.equal(bounds.minX, 0);
  assert.equal(bounds.minY, 0);
  assert.equal(bounds.maxY, COLLAPSED_STUB_HEIGHT);
});

test('descendant union reserves tab headroom above a child (owner request 2026-08-01)', () => {
  // Child tab top sits 39 canvas units above childBounds.minY (childPad 20 +
  // tabH 20 − 1); a root parent's tab bottom sits 11 above its own minY.
  // The union's TOP clearance must therefore be ≥ 28 for legibility — 34
  // gives a 6px gap. Sides/bottom keep the owner-tuned 14.
  const groups = [
    { id: 'parent', name: 'parent', parentId: null, isCollapsed: false, pieceIds: [] },
    { id: 'child', name: 'child', parentId: 'parent', isCollapsed: false, pieceIds: [2] },
  ];
  const piecesById = new Map([[2, { id: 2, x: 400, y: 100, scale: 1 }]]);
  const bounds = buildGroupBoundsWithDescendants(groups[0], groups, piecesById, PIECE_W, PIECE_H);
  const childTop = 100;
  assert.equal(childTop - bounds.minY, 34, 'top clearance = tab headroom');
  assert.equal(bounds.minX, 400 - 14, 'side clearance unchanged');
  assert.equal(bounds.maxY, 100 + PIECE_H + 14, 'bottom clearance unchanged');
});

test('ancestor-collapsed groups leave no phantom wire obstacle', () => {
  const groups = makeGroups({ parentCollapsed: true, childCollapsed: true });
  const piecesById = makePiecesById();
  const getGroupBounds = (g) => buildGroupBoundsWithDescendants(g, groups, piecesById, PIECE_W, PIECE_H);
  const obstacles = buildWireObstacles({
    pieces: [...piecesById.values()],
    hiddenPieceIds: buildHiddenPieceIds(groups),
    isPathHidden: () => false,
    groups,
    getGroupBounds,
    pieceWidth: PIECE_W,
    pieceHeight: PIECE_H,
  });
  const groupObstacleIds = obstacles.filter((o) => o.groupId).map((o) => o.groupId);
  assert.ok(groupObstacleIds.includes('parent'), 'the visible parent pill is an obstacle');
  assert.ok(!groupObstacleIds.includes('child'), 'hidden collapsed child leaves no pill obstacle');
  assert.ok(!groupObstacleIds.includes('grand'), 'hidden expanded grandchild leaves no box obstacle');
  // Hidden subtree pieces are not piece obstacles either.
  const pieceObstacleIds = obstacles.filter((o) => o.kind === 'piece').map((o) => o.pieceId);
  assert.deepEqual(pieceObstacleIds, [9]);
});
