import test from 'node:test';
import assert from 'node:assert/strict';

import { layoutEmptyGroupSeeds, seedColumnSpacing, GROUP_TAB_HEIGHT } from '../../src/app/emptyGroupSeeds.js';
import { GROUP_OUTLINE_PAD, GROUP_NEST_PAD, applyGroupSeedPreview } from '../../src/app/selectors/workspaceSelectors.js';
import { DEFAULT_GRID_DEFINITION, deriveGridSteps } from '../../src/utils/gridGeometry.js';
import { rectsOverlap } from '../../src/utils/spatialGeometry2d.js';

const steps = deriveGridSteps(DEFAULT_GRID_DEFINITION);
const W = 180;
const H = 80;

// A drawn box: the seed padded, its name tab above.
const drawn = (seed) => {
  const pad = GROUP_OUTLINE_PAD + GROUP_NEST_PAD;
  return { x: seed.x - pad, y: seed.y - pad - GROUP_TAB_HEIGHT, width: seed.width + 2 * pad, height: seed.height + 2 * pad + GROUP_TAB_HEIGHT };
};

const create = (groupId, folderPath, parentFolderPath = null, pieceIds = []) => ({ groupId, folderPath, parentFolderPath, pieceIds });

// testone as the wizard left it: src holds every node; six folders are empty.
const TESTONE = [
  create('group-2', '.vscode'),
  create('group-3', 'public'),
  create('group-4', 'src-tauri'),
  create('group-5', 'src-tauri/capabilities', 'src-tauri'),
  create('group-6', 'src-tauri/icons', 'src-tauri'),
  create('group-7', 'src-tauri/src', 'src-tauri'),
];
// The src group's box (six nodes in two rows), drawn with its tab.
const SRC_BOX = { x: 1000 - 12, y: 200 - 12 - 20, width: 580 + 24, height: 236 + 24 + 20 };

test('the empty folders a project opens with never share a spot or overlap', () => {
  // Owner smoke test 2026-09-27: capabilities, icons and src-tauri/src all
  // seeded at (772, 552); .vscode, public and src-tauri 24 units apart.
  const seeds = layoutEmptyGroupSeeds({
    creations: TESTONE, anchorBoundsFor: () => null, origin: { x: 1100, y: 500 },
    obstacles: [SRC_BOX], steps, seedWidth: W, seedHeight: H,
  });
  assert.equal(seeds.size, 6);
  const boxes = [...seeds.entries()];
  for (const [id, seed] of boxes) {
    assert.ok(!rectsOverlap(drawn(seed), SRC_BOX), `${id} overlaps the src group`);
  }
  // Siblings and separate subtrees never overlap; a parent's own seed row
  // sits above its children.
  const [, capabilities] = boxes.find(([id]) => id === 'group-5');
  const [, icons] = boxes.find(([id]) => id === 'group-6');
  const [, tauriSrc] = boxes.find(([id]) => id === 'group-7');
  for (const [a, b] of [[capabilities, icons], [icons, tauriSrc], [capabilities, tauriSrc]]) {
    assert.ok(!rectsOverlap(drawn(a), drawn(b)), 'sibling subfolders overlap');
  }
  for (const root of ['group-2', 'group-3']) {
    for (const [id, seed] of boxes) {
      if (id === root) continue;
      assert.ok(!rectsOverlap(drawn(seeds.get(root)), drawn(seed)), `${root} overlaps ${id}`);
    }
  }
});

test('subfolders sit indented under their parent, one row apart, in folder order', () => {
  const seeds = layoutEmptyGroupSeeds({
    creations: TESTONE, anchorBoundsFor: () => null, origin: { x: 0, y: 0 }, steps, seedWidth: W, seedHeight: H,
  });
  const { pitch, indent } = seedColumnSpacing({ steps, seedHeight: H });
  const parent = seeds.get('group-4');
  assert.deepEqual(
    ['group-5', 'group-6', 'group-7'].map((id) => seeds.get(id)),
    [1, 2, 3].map((row) => ({ x: parent.x + indent, y: parent.y + row * pitch, width: W, height: H })),
  );
  assert.equal(pitch % steps.minorY, 0, 'rows stay on the minor lattice');
  assert.equal(indent % steps.minorX, 0);
});

test('a top-level empty folder lands on a free major intersection', () => {
  const node = { x: 1100, y: 500, width: 180, height: 110 };
  const seeds = layoutEmptyGroupSeeds({
    creations: [create('group-9', 'docs')], anchorBoundsFor: () => null,
    origin: { x: 1100, y: 500 }, obstacles: [node], steps, seedWidth: W, seedHeight: H,
  });
  const seed = seeds.get('group-9');
  assert.equal(seed.x % steps.majorX, 0);
  assert.equal(seed.y % steps.majorY, 0);
  assert.ok(!rectsOverlap(drawn(seed), node));
});

test('empty subfolders of a folder with a box stack below it instead of on one spot', () => {
  const parentBounds = { minX: 1000, minY: 200, maxX: 1580, maxY: 436 };
  const seeds = layoutEmptyGroupSeeds({
    creations: [create('group-8', 'src/hooks', 'src'), create('group-9', 'src/lib', 'src')],
    anchorBoundsFor: (folder) => (folder === 'src' ? parentBounds : null),
    origin: { x: 0, y: 0 }, steps, seedWidth: W, seedHeight: H,
  });
  const hooks = seeds.get('group-8');
  const lib = seeds.get('group-9');
  assert.ok(hooks.y > parentBounds.maxY && lib.y > hooks.y, 'both below the parent, in folder order');
  assert.equal(hooks.x, lib.x);
  assert.ok(!rectsOverlap(drawn(hooks), drawn(lib)));
});

test('an empty folder under a new folder with members stacks below that folder', () => {
  const seeds = layoutEmptyGroupSeeds({
    creations: [create('group-3', 'lib', null, [7, 8]), create('group-4', 'lib/empty', 'lib')],
    anchorBoundsFor: (folder) => (folder === 'lib' ? { minX: 0, minY: 0, maxX: 380, maxY: 110 } : null),
    origin: { x: 900, y: 900 }, steps, seedWidth: W, seedHeight: H,
  });
  assert.equal(seeds.has('group-3'), false, 'a folder with members derives its box from them');
  assert.ok(seeds.get('group-4').y > 110);
});

test('without a grid the layout still separates every box', () => {
  const seeds = layoutEmptyGroupSeeds({
    creations: TESTONE, anchorBoundsFor: () => null, origin: { x: 13, y: 7 }, seedWidth: W, seedHeight: H,
  });
  const all = [...seeds.values()];
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[i].x !== all[j].x || all[i].y !== all[j].y) continue;
      assert.fail('two seeds share a spot');
    }
  }
});

test('a group drag previews its subtree seeds offset, and nothing else', () => {
  const groups = [
    { id: 'a', seedBounds: { x: 0, y: 0, width: W, height: H } },
    { id: 'b', seedBounds: { x: 40, y: 160, width: W, height: H } },
    { id: 'c', seedBounds: { x: 500, y: 0, width: W, height: H } },
    { id: 'd', pieceIds: [1] },
  ];
  assert.equal(applyGroupSeedPreview(groups, null), groups);
  assert.equal(applyGroupSeedPreview(groups, { ids: ['a'], dx: 0, dy: 0 }), groups);
  const drawnGroups = applyGroupSeedPreview(groups, { ids: ['a', 'b', 'd'], dx: 30, dy: -10 });
  assert.deepEqual(drawnGroups.map((g) => g.seedBounds && [g.seedBounds.x, g.seedBounds.y]), [[30, -10], [70, 150], [500, 0], undefined]);
  assert.equal(groups[0].seedBounds.x, 0, 'the input is untouched');
});
