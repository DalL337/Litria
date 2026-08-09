import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGroupBounds, buildGroupBoundsWithDescendants, buildRenderableWires, resolveNodeEdgeColor, buildPersistedConnectionSides, isScaffoldPathHidden, findInnermostGroupAt } from '../../src/app/selectors/workspaceSelectors.js';

const PW = 100;
const PH = 100;
const byId = (pieces) => new Map(pieces.map((p) => [p.id, p]));

test('buildGroupBounds returns the full piece footprint when expanded', () => {
  const pieces = [
    { id: 1, x: 0, y: 0, scale: 1 },
    { id: 2, x: 200, y: 100, scale: 1 },
  ];
  const b = buildGroupBounds({ pieceIds: [1, 2], isCollapsed: false }, byId(pieces), PW, PH);
  assert.equal(b.minX, 0);
  assert.equal(b.minY, 0);
  assert.equal(b.maxX, 300, 'rightmost piece x + width');
  assert.equal(b.maxY, 200, 'lowest piece y + height');
});

test('buildGroupBounds collapses to a single stub at the top-left when collapsed', () => {
  // Same pieces, but collapsed — the hit region must match the visible stub
  // (one squircle), not the expanded footprint (canvas-internals note 1).
  const pieces = [
    { id: 1, x: 0, y: 0, scale: 1 },
    { id: 2, x: 200, y: 100, scale: 1 },
  ];
  const b = buildGroupBounds({ pieceIds: [1, 2], isCollapsed: true }, byId(pieces), PW, PH);
  assert.equal(b.minX, 0, 'stub anchored at expanded top-left');
  assert.equal(b.minY, 0);
  assert.equal(b.maxX, 100, 'stub is one piece wide (minX + pieceWidth)');
  assert.equal(b.maxY, 80, 'stub is SQUIRCLE_H (80) tall, not the expanded height');
  assert.equal(b.centerX, 50);
  assert.equal(b.centerY, 40);
});

test('buildGroupBounds preserves the top-left anchor when collapsed (offset group)', () => {
  const pieces = [
    { id: 1, x: 500, y: 300, scale: 1 },
    { id: 2, x: 800, y: 700, scale: 1 },
  ];
  const b = buildGroupBounds({ pieceIds: [1, 2], isCollapsed: true }, byId(pieces), PW, PH);
  assert.equal(b.minX, 500);
  assert.equal(b.minY, 300);
  assert.equal(b.maxX, 600);
  assert.equal(b.maxY, 380);
});

test('buildGroupBounds returns null for an empty group', () => {
  assert.equal(buildGroupBounds({ pieceIds: [], isCollapsed: true }, new Map(), PW, PH), null);
  assert.equal(buildGroupBounds({ pieceIds: [], isCollapsed: false }, new Map(), PW, PH), null);
});

// ===========================================================================
// resolveNodeEdgeColor — the left-edge color cascade (ADR-014 amendment)
// ===========================================================================

test('resolveNodeEdgeColor: ad-hoc piece.color wins over inherited and default', () => {
  const groupColors = new Map([[1, '#group']]);
  const color = resolveNodeEdgeColor({ id: 1, color: '#adhoc' }, groupColors, '#default');
  assert.equal(color, '#adhoc');
});

test('resolveNodeEdgeColor: inherits parent/group color when no ad-hoc override', () => {
  const groupColors = new Map([[1, '#group']]);
  const color = resolveNodeEdgeColor({ id: 1, color: null }, groupColors, '#default');
  assert.equal(color, '#group');
});

test('resolveNodeEdgeColor: falls back to ungrouped default when no override and no group', () => {
  const color = resolveNodeEdgeColor({ id: 9, color: null }, new Map(), '#default');
  assert.equal(color, '#default');
});

test('resolveNodeEdgeColor: returns null when nothing applies', () => {
  assert.equal(resolveNodeEdgeColor({ id: 9, color: null }, new Map(), null), null);
  assert.equal(resolveNodeEdgeColor({ id: 9 }, new Map()), null);
});

test('resolveNodeEdgeColor: tolerates null piece / missing map', () => {
  assert.equal(resolveNodeEdgeColor(null, null, '#default'), '#default');
  assert.equal(resolveNodeEdgeColor(null, null, null), null);
});

test('buildPersistedConnectionSides keys by pair, skips side-less and id-less rows, last row wins', () => {
  const map = buildPersistedConnectionSides([
    { fromPieceId: 1, toPieceId: 2, sourceSide: 'left', targetSide: null },
    { fromPieceId: 1, toPieceId: 2, sourceSide: 'right', targetSide: 'top' },
    { fromPieceId: 3, toPieceId: 4, sourceSide: null, targetSide: null },
    { fromPieceId: null, toPieceId: 5, sourceSide: 'left', targetSide: 'left' },
  ]);
  assert.equal(map.size, 1);
  assert.deepEqual(map.get('1-2'), { sourceSide: 'right', targetSide: 'top' });
});

test('buildPersistedConnectionSides tolerates missing input', () => {
  assert.equal(buildPersistedConnectionSides(undefined).size, 0);
  assert.equal(buildPersistedConnectionSides(null).size, 0);
});

test('isScaffoldPathHidden matches exact paths and folder descendants only', () => {
  const normalize = (p) => (p ? String(p).replaceAll('\\', '/') : '');
  const hidden = ['src/legacy', 'notes.md'];
  assert.equal(isScaffoldPathHidden('src/legacy', hidden, normalize), true);
  assert.equal(isScaffoldPathHidden('src\\legacy\\old.js', hidden, normalize), true);
  assert.equal(isScaffoldPathHidden('notes.md', hidden, normalize), true);
  assert.equal(isScaffoldPathHidden('src/legacy-utils/a.js', hidden, normalize), false);
  assert.equal(isScaffoldPathHidden('src/app.js', hidden, normalize), false);
  assert.equal(isScaffoldPathHidden('', hidden, normalize), false);
});

// ---------------------------------------------------------------------------
// buildRenderableWires — endpoint resolver (brief-cross-group-wires D1)
// ---------------------------------------------------------------------------

const WIRE_PW = 180;
const WIRE_PH = 110;

function wireHarness({ pieces, groups, connections, hiddenPaths = [] }) {
  const piecesById = new Map(pieces.map((p) => [p.id, p]));
  const groupByPieceId = new Map();
  for (const g of groups) for (const id of g.pieceIds ?? []) groupByPieceId.set(id, g.id);
  const hiddenPieceIds = new Set();
  for (const g of groups) if (g.isCollapsed) for (const id of g.pieceIds ?? []) hiddenPieceIds.add(id);
  return buildRenderableWires({
    connections,
    piecesById,
    groups,
    groupByPieceId,
    hiddenPieceIds,
    getGroupBounds: (group) => buildGroupBounds(group, piecesById, WIRE_PW, WIRE_PH),
    isPathHidden: (path) => hiddenPaths.includes(path),
    pieceWidth: WIRE_PW,
    pieceHeight: WIRE_PH,
  });
}

test('renderable wires: both endpoints visible keep piece anchors and the connection sides', () => {
  const wires = wireHarness({
    pieces: [
      { id: 1, x: 0, y: 0, filename: 'a.js', status: 'valid' },
      { id: 2, x: 500, y: 0, filename: 'b.js' },
    ],
    groups: [],
    connections: [{ id: 'c1', sourceId: 1, targetId: 2, sourceSide: 'bottom', targetSide: 'top' }],
  });
  assert.equal(wires.length, 1);
  assert.equal(wires[0].sourceAnchor.kind, 'piece');
  assert.equal(wires[0].sourceAnchor.status, 'valid');
  assert.equal(wires[0].sourceSide, 'bottom', 'user-chosen sides preserved');
  assert.equal(wires[0].targetSide, 'top');
});

test('renderable wires: collapsed-group endpoint re-anchors to the pill stub with geometry sides', () => {
  const wires = wireHarness({
    pieces: [
      { id: 1, x: 0, y: 0, filename: 'main.py' },
      { id: 2, x: 600, y: 0, filename: 'src/tool.py' },
    ],
    groups: [{ id: 'g1', pieceIds: [2], isCollapsed: true }],
    connections: [{ id: 'c1', sourceId: 1, targetId: 2, sourceSide: 'top', targetSide: 'bottom' }],
  });
  assert.equal(wires.length, 1);
  assert.equal(wires[0].targetAnchor.kind, 'pill');
  assert.equal(wires[0].targetAnchor.groupId, 'g1');
  assert.equal(wires[0].targetAnchor.x, 600, 'pill stub sits at the group top-left');
  assert.equal(wires[0].targetAnchor.height, 80, 'stub height, not piece height');
  // Geometry overrides the user's piece-chosen sides for a pill endpoint.
  assert.equal(wires[0].sourceSide, 'right');
  assert.equal(wires[0].targetSide, 'left');
});

test('renderable wires: both endpoints in the SAME collapsed group are internal — not rendered', () => {
  const wires = wireHarness({
    pieces: [
      { id: 1, x: 0, y: 0, filename: 'a.py' },
      { id: 2, x: 300, y: 0, filename: 'b.py' },
    ],
    groups: [{ id: 'g1', pieceIds: [1, 2], isCollapsed: true }],
    connections: [{ id: 'c1', sourceId: 1, targetId: 2, sourceSide: 'right', targetSide: 'left' }],
  });
  assert.deepEqual(wires, []);
});

test('renderable wires: two different collapsed groups produce a pill-to-pill wire', () => {
  const wires = wireHarness({
    pieces: [
      { id: 1, x: 0, y: 0, filename: 'a.py' },
      { id: 2, x: 800, y: 0, filename: 'b.py' },
    ],
    groups: [
      { id: 'g1', pieceIds: [1], isCollapsed: true },
      { id: 'g2', pieceIds: [2], isCollapsed: true },
    ],
    connections: [{ id: 'c1', sourceId: 1, targetId: 2 }],
  });
  assert.equal(wires.length, 1);
  assert.equal(wires[0].sourceAnchor.kind, 'pill');
  assert.equal(wires[0].targetAnchor.kind, 'pill');
  assert.notEqual(wires[0].sourceAnchor.groupId, wires[0].targetAnchor.groupId);
});

test('renderable wires: nested collapse anchors at the OUTERMOST collapsed ancestor', () => {
  const wires = wireHarness({
    pieces: [
      { id: 1, x: 0, y: 0, filename: 'main.py' },
      { id: 2, x: 600, y: 200, filename: 'pkg/sub/x.py' },
      // Anchor piece for the parent group's bounds origin.
      { id: 3, x: 500, y: 100, filename: 'pkg/y.py' },
    ],
    groups: [
      { id: 'parent', pieceIds: [3, 2], isCollapsed: true },
      { id: 'child', pieceIds: [2], isCollapsed: true, parentId: 'parent' },
    ],
    connections: [{ id: 'c1', sourceId: 1, targetId: 2 }],
  });
  assert.equal(wires.length, 1);
  assert.equal(wires[0].targetAnchor.groupId, 'parent');
});

test('renderable wires: scaffold-hidden endpoints drop the wire entirely', () => {
  const wires = wireHarness({
    pieces: [
      { id: 1, x: 0, y: 0, filename: 'a.js' },
      { id: 2, x: 500, y: 0, filename: 'legacy/b.js' },
    ],
    groups: [],
    connections: [{ id: 'c1', sourceId: 1, targetId: 2 }],
    hiddenPaths: ['legacy/b.js'],
  });
  assert.deepEqual(wires, []);
});

test('renderable wires: missing endpoint pieces are skipped defensively', () => {
  const wires = wireHarness({
    pieces: [{ id: 1, x: 0, y: 0, filename: 'a.js' }],
    groups: [],
    connections: [{ id: 'c1', sourceId: 1, targetId: 99 }],
  });
  assert.deepEqual(wires, []);
});

// ---------------------------------------------------------------------------
// Aggregation (brief-cross-group-wires D2)
// ---------------------------------------------------------------------------

test('aggregation: multiple wires into one pill merge to a single wire with a count', () => {
  const wires = wireHarness({
    pieces: [
      { id: 1, x: 0, y: 0, filename: 'a.js' },
      { id: 2, x: 600, y: 0, filename: 'grp/x.js' },
      { id: 3, x: 700, y: 100, filename: 'grp/y.js' },
    ],
    groups: [{ id: 'g1', pieceIds: [2, 3], isCollapsed: true }],
    connections: [
      { id: 'c1', sourceId: 1, targetId: 2 },
      { id: 'c2', sourceId: 1, targetId: 3 },
    ],
  });
  assert.equal(wires.length, 1);
  assert.equal(wires[0].count, 2);
  assert.equal(wires[0].countEnd, 'target');
  assert.deepEqual(wires[0].connections.map((c) => c.id), ['c1', 'c2']);
  assert.equal(wires[0].targetAnchor.kind, 'pill');
});

test('aggregation: opposite directions stay separate wires (chevron keeps meaning)', () => {
  const wires = wireHarness({
    pieces: [
      { id: 1, x: 0, y: 0, filename: 'a.js' },
      { id: 2, x: 600, y: 0, filename: 'grp/x.js' },
    ],
    groups: [{ id: 'g1', pieceIds: [2], isCollapsed: true }],
    connections: [
      { id: 'c1', sourceId: 1, targetId: 2 },
      { id: 'c2', sourceId: 2, targetId: 1 },
    ],
  });
  assert.equal(wires.length, 2);
  assert.ok(wires.every((w) => w.count === 1));
});

test('aggregation: piece-to-piece wires never merge and keep count 1', () => {
  const wires = wireHarness({
    pieces: [
      { id: 1, x: 0, y: 0, filename: 'a.js' },
      { id: 2, x: 600, y: 0, filename: 'b.js' },
      { id: 3, x: 300, y: 400, filename: 'c.js' },
    ],
    groups: [],
    connections: [
      { id: 'c1', sourceId: 1, targetId: 2 },
      { id: 'c2', sourceId: 3, targetId: 2 },
    ],
  });
  assert.equal(wires.length, 2);
  assert.ok(wires.every((w) => w.count === 1));
});

test('aggregation: pill-to-pill bundles collapse to one counted wire', () => {
  const wires = wireHarness({
    pieces: [
      { id: 1, x: 0, y: 0, filename: 'ga/a.py' },
      { id: 2, x: 20, y: 100, filename: 'ga/b.py' },
      { id: 3, x: 800, y: 0, filename: 'gb/x.py' },
    ],
    groups: [
      { id: 'ga', pieceIds: [1, 2], isCollapsed: true },
      { id: 'gb', pieceIds: [3], isCollapsed: true },
    ],
    connections: [
      { id: 'c1', sourceId: 1, targetId: 3 },
      { id: 'c2', sourceId: 2, targetId: 3 },
    ],
  });
  assert.equal(wires.length, 1);
  assert.equal(wires[0].count, 2);
  assert.equal(wires[0].sourceAnchor.kind, 'pill');
  assert.equal(wires[0].targetAnchor.kind, 'pill');
});

// ---------------------------------------------------------------------------
// findInnermostGroupAt — nested/overlapping hit testing (2026-07-26)
// ---------------------------------------------------------------------------

test('findInnermostGroupAt: child wins over containing parent (smallest area)', () => {
  const parent = { id: 'parent', pieceIds: [1, 2] };
  const child = { id: 'child', pieceIds: [3] };
  const boundsById = {
    parent: { minX: 0, minY: 0, maxX: 1000, maxY: 800 },
    child: { minX: 400, minY: 300, maxX: 600, maxY: 450 },
  };
  const getBounds = (g) => boundsById[g.id];

  const insideChild = findInnermostGroupAt([parent, child], 500, 400, getBounds);
  assert.equal(insideChild.id, 'child', 'point inside both → innermost child wins despite parent-first array order');

  const insideParentOnly = findInnermostGroupAt([parent, child], 100, 100, getBounds);
  assert.equal(insideParentOnly.id, 'parent');

  const outside = findInnermostGroupAt([parent, child], 2000, 2000, getBounds);
  assert.equal(outside, null);
});

test('findInnermostGroupAt: overlapping siblings resolve to the tighter box', () => {
  const big = { id: 'big' };
  const small = { id: 'small' };
  const boundsById = {
    big: { minX: 0, minY: 0, maxX: 500, maxY: 500 },
    small: { minX: 400, minY: 400, maxX: 550, maxY: 550 },
  };
  const hit = findInnermostGroupAt([big, small], 450, 450, (g) => boundsById[g.id]);
  assert.equal(hit.id, 'small');
});

test('findInnermostGroupAt: exclusions and null bounds are skipped', () => {
  const a = { id: 'a' };
  const b = { id: 'b' };
  const boundsById = { a: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, b: null };
  const hit = findInnermostGroupAt([a, b], 50, 50, (g) => boundsById[g.id], (g) => g.id === 'a');
  assert.equal(hit, null, 'excluded a, boundless b → nothing');
});

// ---------------------------------------------------------------------------
// buildGroupBoundsWithDescendants — §10.2 containment slice (2026-07-26)
// ---------------------------------------------------------------------------

test('descendant bounds: parent box unions a nested child sitting outside its member bounds', () => {
  // Parent members cluster right; the child's piece sits LEFT of them —
  // member-only bounds would exclude the child box entirely.
  const piecesById = new Map([
    [1, { id: 1, x: 600, y: 500 }],
    [2, { id: 2, x: 800, y: 500 }],
    [11, { id: 11, x: 400, y: 600 }],
  ]);
  const parent = { id: 'main', pieceIds: [1, 2], isCollapsed: false, parentId: null };
  const child = { id: 'heis', pieceIds: [11], isCollapsed: false, parentId: 'main' };
  const groups = [parent, child];

  const childBounds = buildGroupBoundsWithDescendants(child, groups, piecesById, 180, 110);
  const parentBounds = buildGroupBoundsWithDescendants(parent, groups, piecesById, 180, 110);

  assert.ok(parentBounds.minX <= childBounds.minX - 14, 'parent contains child with clearance on the left');
  assert.ok(parentBounds.maxY >= childBounds.maxY + 14, 'parent contains child with clearance below');
  assert.equal(parentBounds.maxX, 800 + 180, 'right edge still member-driven');
  assert.equal(parentBounds.centerX, (parentBounds.minX + parentBounds.maxX) / 2, 'center recomputed');
});

test('descendant bounds: recursion covers grandchildren; collapsed groups stay stubs', () => {
  const piecesById = new Map([
    [1, { id: 1, x: 0, y: 0 }],
    [2, { id: 2, x: 1000, y: 0 }],
    [3, { id: 3, x: 2000, y: 0 }],
  ]);
  const a = { id: 'a', pieceIds: [1], isCollapsed: false, parentId: null };
  const b = { id: 'b', pieceIds: [2], isCollapsed: false, parentId: 'a' };
  const c = { id: 'c', pieceIds: [3], isCollapsed: false, parentId: 'b' };
  const groups = [a, b, c];

  const aBounds = buildGroupBoundsWithDescendants(a, groups, piecesById, 180, 110);
  assert.ok(aBounds.maxX >= 2000 + 180 + 14, 'grandchild reached through the chain');

  const collapsedA = { ...a, isCollapsed: true };
  const stub = buildGroupBoundsWithDescendants(collapsedA, [collapsedA, b, c], piecesById, 180, 110);
  assert.equal(stub.maxX, 0 + 180, 'collapsed parent returns its stub — no union');
});

test('descendant bounds: parentId cycles do not recurse forever', () => {
  const piecesById = new Map([[1, { id: 1, x: 0, y: 0 }], [2, { id: 2, x: 500, y: 0 }]]);
  const a = { id: 'a', pieceIds: [1], isCollapsed: false, parentId: 'b' };
  const b = { id: 'b', pieceIds: [2], isCollapsed: false, parentId: 'a' };

  const bounds = buildGroupBoundsWithDescendants(a, [a, b], piecesById, 180, 110);
  assert.ok(bounds, 'returns bounds instead of stack-overflowing');
});

// ---------------------------------------------------------------------------
// Subtractive-drag exclusions — source box stops chasing the departing
// piece/child (B3 follow-up polish; un-nest per ADR-013 addendum)
// ---------------------------------------------------------------------------

test('exclusions: departing piece stops counting toward its group bounds', () => {
  const piecesById = new Map([
    [1, { id: 1, x: 0, y: 0 }],
    [2, { id: 2, x: 200, y: 0 }],
    [3, { id: 3, x: 2000, y: 2000 }], // dragged far away mid-flight
  ]);
  const group = { id: 'g', pieceIds: [1, 2, 3], isCollapsed: false, parentId: null };

  const chasing = buildGroupBounds(group, piecesById, 180, 110);
  assert.ok(chasing.maxX >= 2000, 'without exclusion the box chases the piece');

  const excluded = buildGroupBounds(group, piecesById, 180, 110, new Set([3]));
  assert.equal(excluded.maxX, 200 + 180, 'excluded piece no longer stretches the box');
});

test('exclusions: all pieces excluded returns null — honest dissolve preview', () => {
  const piecesById = new Map([[1, { id: 1, x: 0, y: 0 }]]);
  const group = { id: 'g', pieceIds: [1], isCollapsed: false, parentId: null };

  const bounds = buildGroupBounds(group, piecesById, 180, 110, new Set([1]));
  assert.equal(bounds, null, 'single-piece source vanishes while its only piece departs');
});

test('exclusions: excluded child group skipped from ancestor union but measures itself', () => {
  const piecesById = new Map([
    [1, { id: 1, x: 0, y: 0 }],
    [11, { id: 11, x: 3000, y: 0 }],
  ]);
  const parent = { id: 'parent', pieceIds: [1], isCollapsed: false, parentId: null };
  const child = { id: 'child', pieceIds: [11], isCollapsed: false, parentId: 'parent' };
  const groups = [parent, child];
  const exclusions = { groupIds: new Set(['child']) };

  const parentBounds = buildGroupBoundsWithDescendants(parent, groups, piecesById, 180, 110, undefined, exclusions);
  assert.equal(parentBounds.maxX, 0 + 180, 'parent no longer unions the departing child');

  const childBounds = buildGroupBoundsWithDescendants(child, groups, piecesById, 180, 110, undefined, exclusions);
  assert.ok(childBounds, 'the excluded group still measures its own box (it is the one being dragged)');
  assert.equal(childBounds.minX, 3000);
});

test('exclusions: piece exclusion applies through descendant groups', () => {
  const piecesById = new Map([
    [1, { id: 1, x: 0, y: 0 }],
    [11, { id: 11, x: 400, y: 0 }],
    [12, { id: 12, x: 5000, y: 0 }], // child member being extracted
  ]);
  const parent = { id: 'parent', pieceIds: [1], isCollapsed: false, parentId: null };
  const child = { id: 'child', pieceIds: [11, 12], isCollapsed: false, parentId: 'parent' };
  const groups = [parent, child];
  const exclusions = { pieceIds: new Set([12]) };

  const parentBounds = buildGroupBoundsWithDescendants(parent, groups, piecesById, 180, 110, undefined, exclusions);
  assert.equal(parentBounds.maxX, 400 + 180 + 14, 'ancestor union reflects the child WITHOUT the departing piece');
});
