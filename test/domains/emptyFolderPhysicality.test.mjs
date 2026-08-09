import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileGroupsWithFolders } from '../../src/app/reconcileGroupsWithFolders.js';
import { createGroupDomain } from '../../src/app/groupDomain.js';

// ---------------------------------------------------------------------------
// brief-group-physicality W1 (owner-ruled 2026-08-01):
// D1 — a group lives exactly as long as its folder does, however it got
//      empty; emptiness never culls.
// D2 — every folder on disk has a canvas presence, empty folders included.
// Trigger: live incident — dragging an empty folder to canvas was a silent
// no-op, and the reconciler both ignored empty folders and DELETED any group
// whose folder had no pieces.
// ---------------------------------------------------------------------------

const norm = (p) => (typeof p === 'string' ? p.replace(/\\/g, '/').replace(/^\/+/, '') : '');
const base = (p) => {
  const n = norm(p);
  const i = n.lastIndexOf('/');
  return i >= 0 ? n.substring(i + 1) : n;
};

function reconcile({ pieces = [], groups = [], folders = null }) {
  return reconcileGroupsWithFolders({ pieces, groups, normalizePath: norm, getBasename: base, folders });
}

// ── Reconciler: D2 parity with the disk list ───────────────────────────────

test('an empty folder on disk gets a group (pieceIds [])', () => {
  const { createGroups } = reconcile({ folders: ['newfolder'] });
  assert.equal(createGroups.length, 1);
  assert.equal(createGroups[0].folderPath, 'newfolder');
  assert.deepEqual(createGroups[0].pieceIds, []);
});

test('an existing empty-folder group is KEPT while its folder exists (D1)', () => {
  const groups = [{ id: 'g1', folderPath: 'newfolder', pieceIds: [], parentId: null }];
  const { createGroups, removeGroups } = reconcile({ groups, folders: ['newfolder'] });
  assert.deepEqual(removeGroups, []);
  assert.deepEqual(createGroups, []);
});

test('a group is removed only when its folder is GONE from disk', () => {
  const groups = [{ id: 'g1', folderPath: 'gone', pieceIds: [], parentId: null }];
  const { removeGroups } = reconcile({ groups, folders: ['still-here'] });
  assert.deepEqual(removeGroups, ['g1']);
});

test('a group whose folder exists but whose pieces all left is kept (D1)', () => {
  const groups = [{ id: 'g1', folderPath: 'src', pieceIds: [], parentId: null }];
  // No pieces anywhere in src — pre-D1 this removed the group.
  const { removeGroups } = reconcile({ groups, folders: ['src'] });
  assert.deepEqual(removeGroups, []);
});

test('nested empty folders get parent hints, parents created in the same pass', () => {
  const { createGroups } = reconcile({ folders: ['main', 'main/heisenburg'] });
  const child = createGroups.find((c) => c.folderPath === 'main/heisenburg');
  assert.ok(child);
  assert.equal(child.parentFolderPath, 'main');
});

test('duplicate same-folder groups heal: first wins, twins removed, children re-point (owner live repro 2026-08-01)', () => {
  // The exact pytest2 workspace.db shape: pre-#241 drops minted twin groups
  // for main and main/heisenburg; the heisenburg twin was parented to the
  // main twin — a complete phantom hierarchy ("main parented to main").
  const groups = [
    { id: 'group-1', name: 'main', folderPath: 'main', pieceIds: [1], parentId: null },
    { id: 'scaffold-folder-A', name: 'main', folderPath: 'main', pieceIds: [1], parentId: null },
    { id: 'group-2', name: 'heisenburg', folderPath: 'main/heisenburg', pieceIds: [2], parentId: 'group-1' },
    { id: 'scaffold-folder-B', name: 'heisenburg', folderPath: 'main/heisenburg', pieceIds: [2], parentId: 'scaffold-folder-A' },
  ];
  const pieces = [
    { id: 1, filename: 'main/main.py' },
    { id: 2, filename: 'main/heisenburg/pymanager.py' },
  ];
  const { createGroups, removeGroups, parentUpdates } = reconcile({
    pieces, groups, folders: ['main', 'main/heisenburg'],
  });
  assert.deepEqual(removeGroups.sort(), ['scaffold-folder-A', 'scaffold-folder-B']);
  assert.deepEqual(createGroups, [], 'survivors cover both folders — nothing recreated');
  // Surviving child keeps deriving its parent from the surviving main.
  assert.ok(!parentUpdates.some((u) => u.groupId === 'group-2' && u.parentFolderPath !== 'main'));
});

test('duplicate healing applies in legacy mode too (no folders list)', () => {
  const groups = [
    { id: 'g1', name: 'src', folderPath: 'src', pieceIds: [1], parentId: null },
    { id: 'g1-twin', name: 'src', folderPath: 'src', pieceIds: [1], parentId: null },
  ];
  const pieces = [{ id: 1, filename: 'src/a.js' }];
  const { removeGroups } = reconcile({ pieces, groups });
  assert.deepEqual(removeGroups, ['g1-twin']);
});

test('legacy callers (no folders list) keep the old piece-derived behavior', () => {
  const groups = [{ id: 'g1', folderPath: 'src', pieceIds: [], parentId: null }];
  const { removeGroups } = reconcile({ groups });
  assert.deepEqual(removeGroups, ['g1'], 'without the disk list, piece-derived removal stands');
});

// ── groupDomain: empty groups are first-class ──────────────────────────────

function makeDomain(initial = []) {
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

test('createFolderGroup accepts an empty folder with seedBounds', () => {
  const { domain, groups } = makeDomain();
  domain.commands.createFolderGroup({
    groupId: 'g1', name: 'newfolder', pieceIds: [], folderPath: 'newfolder',
    isCollapsed: true, seedBounds: { x: 10, y: 20, width: 160, height: 80 },
  });
  const g = groups().find((x) => x.id === 'g1');
  assert.ok(g, 'empty folder group must be created');
  assert.deepEqual(g.seedBounds, { x: 10, y: 20, width: 160, height: 80 });
  assert.equal(g.isCollapsed, true);
});

test('claiming every piece from a folder group no longer culls it (D1)', () => {
  const { domain, groups } = makeDomain([
    { id: 'a', name: 'a', folderPath: 'a', pieceIds: [1, 2], isCollapsed: false },
  ]);
  domain.commands.createFolderGroup({
    groupId: 'b', name: 'b', pieceIds: [1, 2], folderPath: 'b',
  });
  const a = groups().find((x) => x.id === 'a');
  assert.ok(a, 'donor group survives emptying — its folder still exists');
  assert.deepEqual(a.pieceIds, []);
});

test('removePieces leaves an emptied folder group alive (D1)', () => {
  const { domain, groups } = makeDomain([
    { id: 'a', name: 'a', folderPath: 'a', pieceIds: [1], isCollapsed: false },
  ]);
  domain.commands.removePieces([1]);
  assert.ok(groups().find((x) => x.id === 'a'));
});

test('applyFsSyncPlan upserts an empty group with seedBounds', () => {
  const { domain, groups } = makeDomain();
  domain.commands.applyFsSyncPlan({
    upserts: [{
      groupId: 'g1', name: 'newfolder', folderPath: 'newfolder',
      pieceIds: [], parentId: null,
      seedBounds: { x: 5, y: 6, width: 160, height: 80 },
    }],
  }, { withHistory: false });
  const g = groups().find((x) => x.id === 'g1');
  assert.ok(g, 'empty upsert must create the group');
  assert.deepEqual(g.seedBounds, { x: 5, y: 6, width: 160, height: 80 });
});
