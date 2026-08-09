import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createHandlePieceGroupDrop,
  createHandleGroupStructureDrop,
} from '../../src/app/groupDropHandlers.js';

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

function makeRecorders() {
  const calls = {
    addPill: [],
    addPieceToGroup: [],
    removePieceFromGroup: [],
    setParentGroup: [],
    setFolderPath: [],
    mergeIntoGroup: [],
    updatePieceFilenames: [],
    moveFile: [],
    moveProjectPath: [],
    updateTabFilename: [],
    bumpScaffoldRefresh: [],
    setPendingGroupDrop: [],
    setIsResolving: [],
    dbUpdatePiece: [],
    dbUpdateGroup: [],
    dbDeleteGroup: [],
    dbAddPieceToGroup: [],
    removeEmptyDirectory: [],
  };
  return calls;
}

function makePieceDropDeps({ pieces = [], groups = [], rootPath = '/proj', moveFileResult = { success: true } } = {}) {
  const calls = makeRecorders();

  const piecesById = new Map(pieces.map((p) => [p.id, p]));

  const fsManager = {
    moveFile: async (from, to) => {
      calls.moveFile.push({ from, to });
      return moveFileResult;
    },
  };

  const pillDomain = {
    commands: {
      addPill: (args) => { calls.addPill.push(args); },
    },
  };

  const groupDomain = {
    commands: {
      addPieceToGroup: (groupId, pieceId) => { calls.addPieceToGroup.push({ groupId, pieceId }); },
      removePieceFromGroup: (groupId, pieceId) => { calls.removePieceFromGroup.push({ groupId, pieceId }); },
      setParentGroup: (groupId, parentId) => { calls.setParentGroup.push({ groupId, parentId }); },
      setFolderPath: (groupId, folderPath) => { calls.setFolderPath.push({ groupId, folderPath }); },
      mergeIntoGroup: (fromGroupId, intoGroupId) => { calls.mergeIntoGroup.push({ fromGroupId, intoGroupId }); },
    },
  };

  const projectInstance = { rootPath, instanceId: 'instance-1', name: 'Test Project' };

  return {
    deps: {
      piecesById,
      groups,
      projectInstance,
      fsManager,
      pillDomain,
      groupDomain,
      normalizePath,
      getBasename,
    },
    calls,
  };
}

function makeStructureDropDeps({ groups = [], rootPath = '/proj' } = {}) {
  const calls = {
    nestGroup: [],
    unnestGroup: [],
    mergeGroups: [],
  };

  const groupStructureOps = {
    nestGroup: async (sourceGroup, targetGroup) => {
      calls.nestGroup.push({ sourceGroup, targetGroup });
      return { success: true };
    },
    unnestGroup: async (sourceGroup) => {
      calls.unnestGroup.push({ sourceGroup });
      return { success: true };
    },
    mergeGroups: async (sourceGroup, targetGroup) => {
      calls.mergeGroups.push({ sourceGroup, targetGroup });
      return { success: true };
    },
  };

  const projectInstance = { rootPath, instanceId: 'instance-1', name: 'Test Project' };

  return {
    deps: { groups, projectInstance, groupStructureOps },
    calls,
  };
}

// ---------------------------------------------------------------------------
// 1. handlePieceGroupDrop — piece into group with folderPath
// ---------------------------------------------------------------------------

test('characterization: handlePieceGroupDrop moves piece file into a group with folderPath', async () => {
  const piece = makePiece('p1', 'feature.js');
  const group = makeGroup('g-target', 'Target Group', 'src/target');

  const { deps, calls } = makePieceDropDeps({ pieces: [piece], groups: [group] });
  const handler = createHandlePieceGroupDrop(deps);

  await handler({ pieceId: 'p1', fromGroupId: null, toGroupId: 'g-target' });

  assert.equal(calls.moveFile.length, 1, 'fsManager.moveFile called once');
  assert.deepEqual(calls.moveFile[0], { from: 'feature.js', to: 'src/target/feature.js' });
  assert.equal(calls.addPieceToGroup.length, 0, 'membership update is skipped when file move is the side effect (early return)');
  assert.equal(calls.addPill.length, 0, 'no failure pill on success');
});

// ---------------------------------------------------------------------------
// 2. handlePieceGroupDrop — folder-less target REFUSES (W3, group physicality)
// ---------------------------------------------------------------------------

test('handlePieceGroupDrop refuses a drop into a folder-less group with an error pill (W3)', async () => {
  const piece = makePiece('p1', 'feature.js');
  const group = makeGroup('g-virtual', 'Virtual Group', null);

  const { deps, calls } = makePieceDropDeps({ pieces: [piece], groups: [group] });
  const handler = createHandlePieceGroupDrop(deps);

  await handler({ pieceId: 'p1', fromGroupId: 'g-prev', toGroupId: 'g-virtual' });

  assert.equal(calls.moveFile.length, 0, 'no file move — there is no folder to move into');
  assert.equal(calls.addPieceToGroup.length, 0, 'membership-only ghost writes retired');
  assert.equal(calls.removePieceFromGroup.length, 0, 'source membership untouched on refusal');
  assert.equal(calls.addPill.length, 1, 'the refusal explains itself');
});

// ---------------------------------------------------------------------------
// 3. handlePieceGroupDrop — piece out of group (file move back to root)
// ---------------------------------------------------------------------------

test('characterization: handlePieceGroupDrop moves piece file out of a group with folderPath', async () => {
  const piece = makePiece('p1', 'src/source/feature.js');
  const sourceGroup = makeGroup('g-source', 'Source Group', 'src/source', ['p1']);

  const { deps, calls } = makePieceDropDeps({ pieces: [piece], groups: [sourceGroup] });
  const handler = createHandlePieceGroupDrop(deps);

  await handler({ pieceId: 'p1', fromGroupId: 'g-source', toGroupId: null });

  assert.equal(calls.moveFile.length, 1);
  assert.deepEqual(calls.moveFile[0], { from: 'src/source/feature.js', to: 'feature.js' });
  assert.equal(calls.removePieceFromGroup.length, 0, 'membership remove skipped on the file-move branch (early return)');
});

// ---------------------------------------------------------------------------
// 4. handlePieceGroupDrop — failure path (pill fires, no state change)
// ---------------------------------------------------------------------------

test('characterization: handlePieceGroupDrop fires a failure pill and skips membership when fsManager.moveFile fails', async () => {
  const piece = makePiece('p1', 'feature.js');
  const group = makeGroup('g-target', 'Target Group', 'src/target');

  const { deps, calls } = makePieceDropDeps({
    pieces: [piece],
    groups: [group],
    moveFileResult: { success: false },
  });
  const handler = createHandlePieceGroupDrop(deps);

  await handler({ pieceId: 'p1', fromGroupId: null, toGroupId: 'g-target' });

  assert.equal(calls.moveFile.length, 1, 'move was attempted');
  assert.equal(calls.addPill.length, 1, 'one failure pill fired');
  assert.equal(calls.addPill[0].severity, 'error');
  assert.match(calls.addPill[0].message, /Failed to move "feature\.js" into "Target Group"/);
  assert.equal(calls.addPieceToGroup.length, 0, 'no membership change on failure');
  assert.equal(calls.removePieceFromGroup.length, 0, 'no membership change on failure');
});

// ---------------------------------------------------------------------------
// 5. handleGroupStructureDrop — nest intent delegates to groupStructureOps
// ---------------------------------------------------------------------------

test('handleGroupStructureDrop nest intent delegates to groupStructureOps.nestGroup with resolved groups', async () => {
  const sourceGroup = makeGroup('g-source', 'Source', 'src/source', ['p1']);
  const targetGroup = makeGroup('g-target', 'Target', 'src/target');

  const { deps, calls } = makeStructureDropDeps({ groups: [sourceGroup, targetGroup] });
  const handler = createHandleGroupStructureDrop(deps);

  await handler({ groupId: 'g-source', targetGroupId: 'g-target', intent: 'nest' });

  assert.equal(calls.nestGroup.length, 1, 'nestGroup called once');
  assert.equal(calls.nestGroup[0].sourceGroup, sourceGroup);
  assert.equal(calls.nestGroup[0].targetGroup, targetGroup);
  assert.equal(calls.unnestGroup.length, 0);
  assert.equal(calls.mergeGroups.length, 0);
});

// ---------------------------------------------------------------------------
// 6. handleGroupStructureDrop — unnest intent delegates to groupStructureOps
// ---------------------------------------------------------------------------

test('handleGroupStructureDrop unnest intent delegates to groupStructureOps.unnestGroup', async () => {
  const parentGroup = makeGroup('g-parent', 'Parent', 'src/parent');
  const childGroup = makeGroup('g-child', 'Child', 'src/parent/child', ['p1'], 'g-parent');

  const { deps, calls } = makeStructureDropDeps({ groups: [parentGroup, childGroup] });
  const handler = createHandleGroupStructureDrop(deps);

  await handler({ groupId: 'g-child', targetGroupId: null, intent: 'unnest' });

  assert.equal(calls.unnestGroup.length, 1, 'unnestGroup called once');
  assert.equal(calls.unnestGroup[0].sourceGroup, childGroup);
  assert.equal(calls.nestGroup.length, 0);
});

// ---------------------------------------------------------------------------
// 7. handleGroupStructureDrop — guards (self-drop, unknown groups, no root)
// ---------------------------------------------------------------------------

test('handleGroupStructureDrop no-ops on self-drop, unknown groups, and missing root path', async () => {
  const sourceGroup = makeGroup('g-source', 'Source', 'src/source');
  const targetGroup = makeGroup('g-target', 'Target', 'src/target');

  const { deps, calls } = makeStructureDropDeps({ groups: [sourceGroup, targetGroup] });
  const handler = createHandleGroupStructureDrop(deps);

  await handler({ groupId: 'g-source', targetGroupId: 'g-source', intent: 'nest' });
  await handler({ groupId: 'g-missing', targetGroupId: 'g-target', intent: 'nest' });
  await handler({ groupId: 'g-source', targetGroupId: 'g-missing', intent: 'nest' });

  const { deps: rootlessDeps, calls: rootlessCalls } = makeStructureDropDeps({
    groups: [sourceGroup, targetGroup],
    rootPath: null,
  });
  const rootlessHandler = createHandleGroupStructureDrop(rootlessDeps);
  await rootlessHandler({ groupId: 'g-source', targetGroupId: 'g-target', intent: 'nest' });

  assert.equal(calls.nestGroup.length, 0);
  assert.equal(calls.unnestGroup.length, 0);
  assert.equal(rootlessCalls.nestGroup.length, 0);
});
