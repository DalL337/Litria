import test from 'node:test';
import assert from 'node:assert/strict';

import { reconcileGroupsWithFolders } from '../../src/app/reconcileGroupsWithFolders.js';

const norm = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/').replace(/^\/+/, '') : '');
const basename = (p) => {
  const n = norm(p);
  const idx = n.lastIndexOf('/');
  return idx >= 0 ? n.substring(idx + 1) : n;
};

function piece(id, filename) {
  return { id, filename };
}

function group(id, name, folderPath, pieceIds = []) {
  return { id, name, folderPath, pieceIds: [...pieceIds] };
}

// ===========================================================================
// createGroups tests
// ===========================================================================

test('creates group for folder with pieces but no group', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'src/a.py'), piece(2, 'src/b.py')],
    groups: [],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.createGroups.length, 1);
  assert.equal(result.createGroups[0].folderPath, 'src');
  assert.equal(result.createGroups[0].name, 'src');
  assert.deepEqual(result.createGroups[0].pieceIds.sort(), [1, 2]);
});

test('does NOT create group when folder already has a group', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'src/a.py'), piece(2, 'src/b.py')],
    groups: [group('g1', 'src', 'src', [1, 2])],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.createGroups.length, 0);
});

test('skips pieces at project root (no parent folder)', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'main.py'), piece(2, 'readme.md')],
    groups: [],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.createGroups.length, 0);
});

test('creates groups for multiple folders', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [
      piece(1, 'src/a.py'),
      piece(2, 'src/b.py'),
      piece(3, 'lib/c.py'),
    ],
    groups: [],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.createGroups.length, 2);
  const folders = result.createGroups.map((g) => g.folderPath).sort();
  assert.deepEqual(folders, ['lib', 'src']);
});

test('creates group even for single piece in folder', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'utils/helper.py')],
    groups: [],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.createGroups.length, 1);
  assert.equal(result.createGroups[0].folderPath, 'utils');
  assert.deepEqual(result.createGroups[0].pieceIds, [1]);
});

// ===========================================================================
// removeGroups tests
// ===========================================================================

test('removes group whose folder has no pieces', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [],
    groups: [group('g1', 'old', 'old', [])],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.removeGroups.length, 1);
  assert.equal(result.removeGroups[0], 'g1');
});

test('does NOT remove group whose folder still has pieces', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'src/a.py')],
    groups: [group('g1', 'src', 'src', [1])],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.removeGroups.length, 0);
});

test('handles mixed: one folder needs group, another is orphaned', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'newdir/a.py')],
    groups: [group('g-old', 'old', 'old', [])],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.createGroups.length, 1);
  assert.equal(result.createGroups[0].folderPath, 'newdir');
  assert.equal(result.removeGroups.length, 1);
  assert.equal(result.removeGroups[0], 'g-old');
});

// ===========================================================================
// Edge cases
// ===========================================================================

test('returns empty arrays for null/undefined inputs', () => {
  const result = reconcileGroupsWithFolders({
    pieces: null,
    groups: null,
    normalizePath: norm,
    getBasename: basename,
  });

  assert.deepEqual(result, { createGroups: [], removeGroups: [], parentUpdates: [] });
});

test('handles nested folder paths', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'src/utils/helper.py')],
    groups: [],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.createGroups.length, 1);
  assert.equal(result.createGroups[0].folderPath, 'src/utils');
  assert.equal(result.createGroups[0].name, 'utils');
});

test('groups without folderPath are not affected', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'src/a.py')],
    groups: [group('g-no-folder', 'Manual Group', null, [1])],
    normalizePath: norm,
    getBasename: basename,
  });

  // Should create a group for 'src' since the existing group has no folderPath
  assert.equal(result.createGroups.length, 1);
  assert.equal(result.createGroups[0].folderPath, 'src');
  // Should NOT remove the group without folderPath
  assert.equal(result.removeGroups.length, 0);
});

// ===========================================================================
// Parent derivation (2026-07-26 — parentId derived from folder containment)
// ===========================================================================

function groupWithParent(id, name, folderPath, pieceIds = [], parentId = null) {
  return { id, name, folderPath, pieceIds: [...pieceIds], parentId };
}

test('parent derivation: disk-nested group with null parentId gets a parentUpdate (the pytest2 heisenburg case)', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(4, 'main/main.py'), piece(11, 'main/heisenburg/pymanager.py')],
    groups: [
      groupWithParent('g1', 'main', 'main', [4]),
      groupWithParent('g2', 'heisenburg', 'main/heisenburg', [11], null),
    ],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.deepEqual(result.parentUpdates, [{ groupId: 'g2', parentFolderPath: 'main' }]);
});

test('parent derivation: correct existing link produces no update', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'a/x.py'), piece(2, 'a/b/y.py')],
    groups: [
      groupWithParent('ga', 'a', 'a', [1]),
      groupWithParent('gb', 'b', 'a/b', [2], 'ga'),
    ],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.parentUpdates.length, 0);
});

test('parent derivation: nearest ancestor skips a groupless intermediate folder', () => {
  // a/b has no pieces → no group; a/b/c's parent should resolve to a.
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'a/x.py'), piece(2, 'a/b/c/z.py')],
    groups: [
      groupWithParent('ga', 'a', 'a', [1]),
      groupWithParent('gc', 'c', 'a/b/c', [2], null),
    ],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.deepEqual(result.parentUpdates, [{ groupId: 'gc', parentFolderPath: 'a' }]);
});

test('parent derivation: stale link to a non-ancestor clears to null at top level', () => {
  // g2's folder moved to root (un-nest) but its parentId still points at g1.
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'main/x.py'), piece(2, 'standalone/y.py')],
    groups: [
      groupWithParent('g1', 'main', 'main', [1]),
      groupWithParent('g2', 'standalone', 'standalone', [2], 'g1'),
    ],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.deepEqual(result.parentUpdates, [{ groupId: 'g2', parentFolderPath: null }]);
});

test('parent derivation: created groups carry a parentFolderPath hint', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'main/x.py'), piece(2, 'main/newsub/y.py')],
    groups: [groupWithParent('g1', 'main', 'main', [1])],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.createGroups.length, 1);
  assert.equal(result.createGroups[0].folderPath, 'main/newsub');
  assert.equal(result.createGroups[0].parentFolderPath, 'main');
});

test('parent derivation: a parent being created in the same pass is a valid hint target', () => {
  // Both a and a/b are new — b's hint must point at a even though a has no id yet.
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'a/x.py'), piece(2, 'a/b/y.py')],
    groups: [],
    normalizePath: norm,
    getBasename: basename,
  });

  const byFolder = Object.fromEntries(result.createGroups.map((e) => [e.folderPath, e.parentFolderPath]));
  assert.deepEqual(byFolder, { a: null, 'a/b': 'a' });
});

test('parent derivation: link pointing at a group being removed this pass is rederived', () => {
  // g-dead's folder is empty → removed; g2 pointed at it and must relink to g1.
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'main/x.py'), piece(2, 'main/sub/y.py')],
    groups: [
      groupWithParent('g1', 'main', 'main', [1]),
      groupWithParent('g-dead', 'dead', 'dead', []),
      groupWithParent('g2', 'sub', 'main/sub', [2], 'g-dead'),
    ],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.deepEqual(result.removeGroups, ['g-dead']);
  assert.deepEqual(result.parentUpdates, [{ groupId: 'g2', parentFolderPath: 'main' }]);
});

test('parent derivation: manual-parent link survives when no folder ancestor exists', () => {
  // g2 is top-level on disk but manually parented under a box group. The
  // manual parent has no folderPath, so the folder-level comparison is
  // null === null → no update; the manual link is preserved.
  const result = reconcileGroupsWithFolders({
    pieces: [piece(2, 'standalone/y.py')],
    groups: [
      { id: 'm1', name: 'box', folderPath: null, pieceIds: [], parentId: null },
      groupWithParent('g2', 'standalone', 'standalone', [2], 'm1'),
    ],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.parentUpdates.length, 0);
});

test('parent derivation: manual groups themselves never get parentUpdates', () => {
  const result = reconcileGroupsWithFolders({
    pieces: [piece(1, 'main/x.py')],
    groups: [
      groupWithParent('g1', 'main', 'main', [1]),
      { id: 'm1', name: 'box', folderPath: null, pieceIds: [9], parentId: null },
    ],
    normalizePath: norm,
    getBasename: basename,
  });

  assert.equal(result.parentUpdates.length, 0);
});
