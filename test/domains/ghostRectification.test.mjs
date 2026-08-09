import test from 'node:test';
import assert from 'node:assert/strict';
import { planGhostRectification } from '../../src/app/useGroupPhysicalityMigration.js';
import { createGroupDomain } from '../../src/app/groupDomain.js';

// ---------------------------------------------------------------------------
// DP2 (brief-group-physicality, owner-ruled 2026-08-01): ghost groups
// (folderPath: null) rectify silently on open — folder minted, files moved,
// informational pill. These tests pin the pure planner + the promote
// command's new empty-group path.
// ---------------------------------------------------------------------------

const norm = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/').replace(/^\/+/, '') : '');
const base = (p) => {
  const n = norm(p);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.substring(i + 1) : n;
};
const dir = (p) => {
  const n = norm(p);
  const i = n.lastIndexOf('/');
  return i > 0 ? n.substring(0, i) : '';
};

function plan({ groups = [], pieces = [] }) {
  const piecesById = new Map(pieces.map((p) => [p.id, p]));
  return planGhostRectification({
    groups, pieces, piecesById, normalizePath: norm, getBasename: base, getDirname: dir,
  });
}

test('a member-holding ghost plans a folder named after it, with file moves', () => {
  const pieces = [
    { id: 1, filename: 'a.js', code: 'A' },
    { id: 2, filename: 'lib/b.js', code: 'B' },
  ];
  const groups = [{ id: 'm1', name: 'ideas', folderPath: null, pieceIds: [1, 2] }];
  const { promotions, skipped } = plan({ groups, pieces });
  assert.deepEqual(skipped, []);
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].folderPath, 'ideas');
  assert.deepEqual(promotions[0].moves.map((m) => m.to), ['ideas/a.js', 'ideas/b.js']);
});

test('an EMPTY ghost plans a folder with zero moves', () => {
  const groups = [{ id: 'm1', name: 'someday', folderPath: null, pieceIds: [] }];
  const { promotions } = plan({ groups });
  assert.equal(promotions.length, 1);
  assert.equal(promotions[0].folderPath, 'someday');
  assert.deepEqual(promotions[0].moves, []);
});

test('folder names uniquify against existing folders AND earlier plan entries', () => {
  const pieces = [{ id: 9, filename: 'utils/x.js', code: '' }];
  const groups = [
    { id: 'real', name: 'utils', folderPath: 'utils', pieceIds: [9] },
    { id: 'm1', name: 'utils', folderPath: null, pieceIds: [] },
    { id: 'm2', name: 'utils', folderPath: null, pieceIds: [] },
  ];
  const { promotions } = plan({ groups, pieces });
  const minted = promotions.map((p) => p.folderPath);
  assert.equal(new Set(minted).size, 2, 'two distinct folders');
  assert.ok(!minted.includes('utils'), 'never merges into the existing utils/');
});

test('duplicate member basenames skip the ghost (would clobber flat in one folder)', () => {
  const pieces = [
    { id: 1, filename: 'a/index.js', code: '' },
    { id: 2, filename: 'b/index.js', code: '' },
  ];
  const groups = [{ id: 'm1', name: 'clash', folderPath: null, pieceIds: [1, 2] }];
  const { promotions, skipped } = plan({ groups, pieces });
  assert.deepEqual(promotions, []);
  assert.equal(skipped[0].reason, 'duplicate member filenames');
});

test('folder-backed groups are never planned', () => {
  const groups = [{ id: 'g', name: 'src', folderPath: 'src', pieceIds: [] }];
  assert.deepEqual(plan({ groups }).promotions, []);
});

// ── promoteToFolderGroup: the empty-group path (W4 lifts the ≥1-member gate) ──

function makeDomain(initial) {
  let groups = initial;
  const domain = createGroupDomain({
    setGroups: (next) => { groups = typeof next === 'function' ? next(groups) : next; },
    getGroups: () => groups,
    history: null,
    getNextGroupId: () => 1,
    setNextGroupId: () => {},
  });
  return { domain, groups: () => groups };
}

test('promoteToFolderGroup promotes an EMPTY group and keeps its seedBounds', () => {
  const seed = { x: 1, y: 2, width: 160, height: 80 };
  const { domain, groups } = makeDomain([
    { id: 'm1', name: 'someday', folderPath: null, pieceIds: [], seedBounds: seed },
  ]);
  domain.commands.promoteToFolderGroup({ groupId: 'm1', folderPath: 'someday' });
  const g = groups()[0];
  assert.equal(g.folderPath, 'someday');
  assert.deepEqual(g.seedBounds, seed, 'seed stays — the only geometry until members arrive');
});

test('promoteToFolderGroup with members still claims them and drops the seed', () => {
  const { domain, groups } = makeDomain([
    { id: 'm1', name: 'ideas', folderPath: null, pieceIds: [1], seedBounds: { x: 0, y: 0, width: 10, height: 10 } },
    { id: 'other', name: 'other', folderPath: 'other', pieceIds: [1] },
  ]);
  domain.commands.promoteToFolderGroup({ groupId: 'm1', folderPath: 'ideas' });
  const promoted = groups().find((g) => g.id === 'm1');
  assert.equal(promoted.folderPath, 'ideas');
  assert.equal(promoted.seedBounds, null);
  assert.deepEqual(groups().find((g) => g.id === 'other').pieceIds, [], 'members claimed exclusively');
});
