import test from 'node:test';
import assert from 'node:assert/strict';

import { createGroupStructureOps } from '../../src/app/groupStructureOps.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function normalizePath(p) {
  return typeof p === 'string' ? p.replace(/\\/g, '/').replace(/^\/+/, '') : '';
}

function getBasename(p) {
  const norm = typeof p === 'string' ? p.replace(/\\/g, '/') : '';
  const idx = norm.lastIndexOf('/');
  return idx >= 0 ? norm.substring(idx + 1) : norm;
}

function makePiece(id, filename) {
  return { id, filename, label: filename ? filename.split('/').pop() : '' };
}

function makeGroup(id, name, folderPath, pieceIds = [], parentId = null) {
  return { id, name, folderPath, pieceIds: [...pieceIds], parentId };
}

function makeDeps({
  pieces = [],
  moveFolderResult = { success: true },
  batchFailFrom = [], // list of `from` paths whose moveFile should fail
} = {}) {
  const calls = {
    moveFolder: [],
    batch: [],
    addPill: [],
    setParentGroup: [],
    mergeIntoGroup: [],
    dbUpdateGroup: [],
    dbDeleteGroup: [],
    dbAddPieceToGroup: [],
  };

  const piecesById = new Map(pieces.map((p) => [p.id, p]));

  const fsManager = {
    moveFolder: async (from, to) => {
      calls.moveFolder.push({ from, to });
      return moveFolderResult;
    },
    batch: async (operations) => {
      calls.batch.push(operations);
      const results = operations.map((op) => {
        if (op.op === 'moveFile' && batchFailFrom.includes(op.from)) {
          return { success: false, error: `Cannot move "${op.from}"`, code: 'fs.move_failed' };
        }
        return { success: true };
      });
      const failureCount = results.filter((r) => !r.success).length;
      return { results, successCount: results.length - failureCount, failureCount };
    },
  };

  const deps = {
    piecesById,
    fsManager,
    groupDomain: {
      commands: {
        setParentGroup: (groupId, parentId) => { calls.setParentGroup.push({ groupId, parentId }); },
        mergeIntoGroup: (fromGroupId, intoGroupId) => { calls.mergeIntoGroup.push({ fromGroupId, intoGroupId }); },
      },
    },
    pillDomain: {
      commands: {
        addPill: (args) => { calls.addPill.push(args); },
      },
    },
    projectInstance: { rootPath: '/proj', instanceId: 'instance-1', name: 'Test Project' },
    normalizePath,
    getBasename,
    dbUpdateGroup: async (id, fields) => { calls.dbUpdateGroup.push({ id, fields }); },
    dbDeleteGroup: async (id) => { calls.dbDeleteGroup.push(id); },
    dbAddPieceToGroup: async (groupId, pieceId) => { calls.dbAddPieceToGroup.push({ groupId, pieceId }); },
  };

  return { deps, calls };
}

// ---------------------------------------------------------------------------
// nestGroup
// ---------------------------------------------------------------------------

test('nestGroup moves the source folder into the target via fsManager and links the parent', async () => {
  const sourceGroup = makeGroup('g-source', 'Source', 'src/source', ['p1']);
  const targetGroup = makeGroup('g-target', 'Target', 'src/target');

  const { deps, calls } = makeDeps();
  const ops = createGroupStructureOps(deps);

  const result = await ops.nestGroup(sourceGroup, targetGroup);

  assert.equal(result.success, true);
  assert.deepEqual(calls.moveFolder, [{ from: 'src/source', to: 'src/target/source' }]);
  assert.deepEqual(calls.setParentGroup, [{ groupId: 'g-source', parentId: 'g-target' }]);
  assert.deepEqual(calls.dbUpdateGroup, [{ id: 'g-source', fields: { parentId: 'g-target' } }]);
  assert.equal(calls.addPill.length, 0, 'no pill on success');
});

test('nestGroup fires a failure pill and skips parent linking when the folder move fails', async () => {
  const sourceGroup = makeGroup('g-source', 'Source', 'src/source');
  const targetGroup = makeGroup('g-target', 'Target', 'src/target');

  const { deps, calls } = makeDeps({
    moveFolderResult: { success: false, error: 'locked', code: 'fs.move_failed' },
  });
  const ops = createGroupStructureOps(deps);

  const result = await ops.nestGroup(sourceGroup, targetGroup);

  assert.equal(result.success, false);
  assert.equal(calls.addPill.length, 1);
  assert.equal(calls.addPill[0].severity, 'error');
  assert.match(calls.addPill[0].message, /Failed to move "source" into "target"/);
  assert.equal(calls.setParentGroup.length, 0);
  assert.equal(calls.dbUpdateGroup.length, 0);
});

test('nestGroup rejects folder-less groups without touching the filesystem', async () => {
  const manualGroup = makeGroup('g-manual', 'Manual', null);
  const targetGroup = makeGroup('g-target', 'Target', 'src/target');

  const { deps, calls } = makeDeps();
  const ops = createGroupStructureOps(deps);

  const result = await ops.nestGroup(manualGroup, targetGroup);

  assert.equal(result.success, false);
  assert.equal(result.code, 'group.not_folder_backed');
  assert.equal(calls.moveFolder.length, 0);
  assert.equal(calls.setParentGroup.length, 0);
});

// ---------------------------------------------------------------------------
// unnestGroup
// ---------------------------------------------------------------------------

test('unnestGroup moves a nested group folder to the project root and clears the parent link', async () => {
  const childGroup = makeGroup('g-child', 'Child', 'src/parent/child', ['p1'], 'g-parent');

  const { deps, calls } = makeDeps();
  const ops = createGroupStructureOps(deps);

  const result = await ops.unnestGroup(childGroup);

  assert.equal(result.success, true);
  assert.deepEqual(calls.moveFolder, [{ from: 'src/parent/child', to: 'child' }]);
  assert.deepEqual(calls.setParentGroup, [{ groupId: 'g-child', parentId: null }]);
  assert.deepEqual(calls.dbUpdateGroup, [{ id: 'g-child', fields: { parentId: null } }]);
  assert.equal(calls.addPill.length, 0);
});

test('unnestGroup no-ops when the group has no parent', async () => {
  const rootGroup = makeGroup('g-root', 'Root', 'src/root');

  const { deps, calls } = makeDeps();
  const ops = createGroupStructureOps(deps);

  const result = await ops.unnestGroup(rootGroup);

  assert.equal(result.success, false);
  assert.equal(result.code, 'group.not_nested');
  assert.equal(calls.moveFolder.length, 0);
  assert.equal(calls.setParentGroup.length, 0);
});

test('unnestGroup fires a failure pill and keeps the parent link when the folder move fails', async () => {
  const childGroup = makeGroup('g-child', 'Child', 'src/parent/child', [], 'g-parent');

  const { deps, calls } = makeDeps({
    moveFolderResult: { success: false, error: 'locked', code: 'fs.move_failed' },
  });
  const ops = createGroupStructureOps(deps);

  const result = await ops.unnestGroup(childGroup);

  assert.equal(result.success, false);
  assert.equal(calls.addPill.length, 1);
  assert.match(calls.addPill[0].message, /Failed to move "child" out of its parent folder/);
  assert.equal(calls.setParentGroup.length, 0);
  assert.equal(calls.dbUpdateGroup.length, 0);
});

test('unnestGroup unlinks a folder-less (manual) child state-only', async () => {
  const manualChild = makeGroup('g-manual', 'Manual', null, [], 'g-parent');

  const { deps, calls } = makeDeps();
  const ops = createGroupStructureOps(deps);

  const result = await ops.unnestGroup(manualChild);

  assert.equal(result.success, true);
  assert.equal(calls.moveFolder.length, 0, 'no filesystem work for a manual group');
  assert.deepEqual(calls.setParentGroup, [{ groupId: 'g-manual', parentId: null }]);
  assert.deepEqual(calls.dbUpdateGroup, [{ id: 'g-manual', fields: { parentId: null } }]);
});

test('unnestGroup skips the folder move when the folder is already at the project root', async () => {
  // State inconsistency guard: parentId set but folder already top-level.
  const oddGroup = makeGroup('g-odd', 'Odd', 'odd', [], 'g-parent');

  const { deps, calls } = makeDeps();
  const ops = createGroupStructureOps(deps);

  const result = await ops.unnestGroup(oddGroup);

  assert.equal(result.success, true);
  assert.equal(calls.moveFolder.length, 0, 'folder already at root — nothing to move');
  assert.deepEqual(calls.setParentGroup, [{ groupId: 'g-odd', parentId: null }]);
});

// ---------------------------------------------------------------------------
// mergeGroups
// ---------------------------------------------------------------------------

test('mergeGroups batches piece moves + source-folder delete, merges state, persists rows', async () => {
  const piece1 = makePiece('p1', 'src/source/a.js');
  const piece2 = makePiece('p2', 'src/source/b.js');
  const sourceGroup = makeGroup('g-source', 'Source', 'src/source', ['p1', 'p2']);
  const targetGroup = makeGroup('g-target', 'Target', 'src/target');

  const { deps, calls } = makeDeps({ pieces: [piece1, piece2] });
  const ops = createGroupStructureOps(deps);

  const result = await ops.mergeGroups(sourceGroup, targetGroup);

  assert.equal(result.success, true);
  assert.equal(calls.batch.length, 1, 'one batch call');
  assert.deepEqual(calls.batch[0], [
    { op: 'moveFile', from: 'src/source/a.js', to: 'src/target/a.js' },
    { op: 'moveFile', from: 'src/source/b.js', to: 'src/target/b.js' },
    { op: 'deleteEmptyFolder', path: 'src/source' },
  ]);
  assert.deepEqual(calls.mergeIntoGroup, [{ fromGroupId: 'g-source', intoGroupId: 'g-target' }]);
  assert.deepEqual(calls.dbAddPieceToGroup, [
    { groupId: 'g-target', pieceId: 'p1' },
    { groupId: 'g-target', pieceId: 'p2' },
  ]);
  assert.deepEqual(calls.dbDeleteGroup, ['g-source']);
  assert.equal(calls.addPill.length, 0, 'no pill on clean merge');
});

test('mergeGroups skips the file move for pieces already at the target path but still persists membership', async () => {
  const alreadyThere = makePiece('p1', 'src/target/a.js');
  const sourceGroup = makeGroup('g-source', 'Source', 'src/source', ['p1']);
  const targetGroup = makeGroup('g-target', 'Target', 'src/target');

  const { deps, calls } = makeDeps({ pieces: [alreadyThere] });
  const ops = createGroupStructureOps(deps);

  await ops.mergeGroups(sourceGroup, targetGroup);

  assert.deepEqual(calls.batch[0], [
    { op: 'deleteEmptyFolder', path: 'src/source' },
  ], 'no moveFile op for a same-path piece');
  assert.deepEqual(calls.dbAddPieceToGroup, [{ groupId: 'g-target', pieceId: 'p1' }]);
});

test('mergeGroups reports partial failure with a pill and withholds membership rows for failed moves', async () => {
  const piece1 = makePiece('p1', 'src/source/a.js');
  const piece2 = makePiece('p2', 'src/source/b.js');
  const sourceGroup = makeGroup('g-source', 'Source', 'src/source', ['p1', 'p2']);
  const targetGroup = makeGroup('g-target', 'Target', 'src/target');

  const { deps, calls } = makeDeps({
    pieces: [piece1, piece2],
    batchFailFrom: ['src/source/b.js'],
  });
  const ops = createGroupStructureOps(deps);

  const result = await ops.mergeGroups(sourceGroup, targetGroup);

  assert.equal(result.success, false);
  assert.equal(result.failureCount, 1);
  assert.equal(calls.addPill.length, 1);
  assert.equal(calls.addPill[0].severity, 'error');
  assert.match(calls.addPill[0].message, /Merge into "Target": 1 file operation\(s\) failed/);
  assert.deepEqual(calls.dbAddPieceToGroup, [{ groupId: 'g-target', pieceId: 'p1' }],
    'only the successfully moved piece gets a membership row');
  assert.deepEqual(calls.mergeIntoGroup, [{ fromGroupId: 'g-source', intoGroupId: 'g-target' }],
    'state merge still happens — reconciliation heals stranded pieces on refresh');
  assert.deepEqual(calls.dbDeleteGroup, ['g-source']);
});

test('mergeGroups rejects folder-less groups without touching the filesystem', async () => {
  const sourceGroup = makeGroup('g-source', 'Source', 'src/source');
  const manualTarget = makeGroup('g-manual', 'Manual', null);

  const { deps, calls } = makeDeps();
  const ops = createGroupStructureOps(deps);

  const result = await ops.mergeGroups(sourceGroup, manualTarget);

  assert.equal(result.success, false);
  assert.equal(result.code, 'group.not_folder_backed');
  assert.equal(calls.batch.length, 0);
  assert.equal(calls.mergeIntoGroup.length, 0);
});

test('nestGroup no-ops the folder move when the source is already nested in the target', async () => {
  const childGroup = makeGroup('g-child', 'child', 'main/child', ['p1'], null);
  const targetGroup = makeGroup('g-main', 'main', 'main');

  const { deps, calls } = makeDeps();
  const ops = createGroupStructureOps(deps);

  const result = await ops.nestGroup(childGroup, targetGroup);

  assert.equal(result.success, true);
  assert.equal(calls.moveFolder.length, 0, 'no redundant folder move');
  assert.deepEqual(calls.setParentGroup, [{ groupId: 'g-child', parentId: 'g-main' }],
    'parent link still ensured (idempotent)');
  assert.equal(calls.addPill.length, 0);
});
