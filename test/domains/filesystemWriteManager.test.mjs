import test from 'node:test';
import assert from 'node:assert/strict';

import { createFilesystemWriteManager, collectEmptiedFolderGroups } from '../../src/app/filesystemWriteManager.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockPiece(id, filename) {
  return { id, filename, label: filename.split('/').pop() };
}

function createMockGroup(id, name, folderPath, pieceIds = [], parentId = null) {
  return { id, name, folderPath, pieceIds: [...pieceIds], parentId };
}

function createMockDeps(overrides = {}) {
  const calls = {
    moveProjectPath: [],
    writeProjectFile: [],
    removeEmptyDirectory: [],
    createProjectDirectory: [],
    deleteProjectPath: [],
    updatePieceFilenames: [],
    deletePieces: [],
    updateTabFilename: [],
    closeTab: [],
    removePiecesFromGroups: [],
    removeConnectionsForPieces: [],
    unregisterFile: [],
    notifyFileChanged: [],
    bumpScaffoldRefresh: [],
    addPieceToGroup: [],
    removePieceFromGroup: [],
    deleteGroup: [],
    createFolderGroup: [],
    setFolderPath: [],
    applyFsSyncPlan: [],
    allocateGroupId: [],
    readProjectFile: [],
  };

  let pieces = overrides.pieces ?? [];
  let groups = overrides.groups ?? [];

  const piecesById = new Map();
  const piecesByFilename = new Map();
  for (const p of pieces) {
    piecesById.set(p.id, p);
    piecesByFilename.set(p.filename, p);
  }

  const groupByPieceId = new Map();
  for (const g of groups) {
    for (const pid of g.pieceIds) {
      groupByPieceId.set(pid, g.id);
    }
  }

  const groupDomain = {
    commands: {
      addPieceToGroup(groupId, pieceId) { calls.addPieceToGroup.push({ groupId, pieceId }); },
      removePieceFromGroup(groupId, pieceId) { calls.removePieceFromGroup.push({ groupId, pieceId }); },
      deleteGroup(groupId) { calls.deleteGroup.push(groupId); },
      createFolderGroup(args) { calls.createFolderGroup.push(args); },
      // Deliberately does NOT mutate the groups array: the real wiring's
      // getGroups() is stale within a tick (groupsRef syncs in an effect),
      // so the pipeline must be correct WITHOUT re-reads observing writes.
      setFolderPath(groupId, folderPath) { calls.setFolderPath.push({ groupId, folderPath }); },
      applyFsSyncPlan(plan) { calls.applyFsSyncPlan.push(plan); },
      allocateGroupId() {
        const idx = calls.allocateGroupId.length + 1;
        calls.allocateGroupId.push(idx);
        return { groupId: `auto-${idx}`, groupIndex: idx };
      },
    }
  };

  const deps = {
    moveProjectPath: async (rootPath, from, to) => {
      calls.moveProjectPath.push({ rootPath, from, to });
      return overrides.moveProjectPathResult ?? true;
    },
    writeProjectFile: async (rootPath, path, contents) => {
      calls.writeProjectFile.push({ rootPath, path, contents });
      return overrides.writeProjectFileResult ?? true;
    },
    removeEmptyDirectory: async (rootPath, path) => {
      calls.removeEmptyDirectory.push({ rootPath, path });
      return overrides.removeEmptyDirectoryResult ?? true;
    },
    createProjectDirectory: async (rootPath, path) => {
      calls.createProjectDirectory.push({ rootPath, path });
      return overrides.createProjectDirectoryResult ?? true;
    },
    deleteProjectPath: async (rootPath, path) => {
      calls.deleteProjectPath.push({ rootPath, path });
      return overrides.deleteProjectPathResult ?? true;
    },

    getRootPath: () => ('rootPath' in overrides ? overrides.rootPath : '/test/project'),
    readProjectFile: async (rootPath, path) => {
      calls.readProjectFile.push({ rootPath, path });
      return overrides.readProjectFileResult ?? null;
    },
    getPiecesById: () => piecesById,
    getPiecesByFilename: () => piecesByFilename,
    getPieces: () => pieces,
    getGroups: () => groups,
    getGroupByPieceId: () => groupByPieceId,
    getGroupDomain: () => groupDomain,

    updatePieceFilenames: (updates) => { calls.updatePieceFilenames.push(updates); },
    deletePieces: (args) => { calls.deletePieces.push(args); },
    updateTabFilename: (pieceId, path) => { calls.updateTabFilename.push({ pieceId, path }); },
    closeTab: (tabId) => { calls.closeTab.push(tabId); },
    removePiecesFromGroups: (ids) => { calls.removePiecesFromGroups.push(ids); },
    removeConnectionsForPieces: (ids) => { calls.removeConnectionsForPieces.push(ids); },
    unregisterFile: (path) => { calls.unregisterFile.push(path); },
    notifyFileChanged: (path, text) => { calls.notifyFileChanged.push({ path, text }); },
    bumpScaffoldRefresh: () => { calls.bumpScaffoldRefresh.push(true); },
    normalizePath: (p) => (typeof p === 'string' ? p.replace(/\\/g, '/').replace(/^\//, '') : ''),
    getBasename: (p) => {
      const norm = typeof p === 'string' ? p.replace(/\\/g, '/') : '';
      const idx = norm.lastIndexOf('/');
      return idx >= 0 ? norm.substring(idx + 1) : norm;
    },
  };

  return { deps, calls, groupDomain };
}

// ===========================================================================
// Move pipeline tests
// ===========================================================================

test('moveFile — moves file and runs full sync pipeline', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveFile('src/foo.py', 'lib/foo.py');

  assert.equal(result.success, true);
  assert.equal(calls.moveProjectPath.length, 1);
  assert.deepEqual(calls.moveProjectPath[0], { rootPath: '/test/project', from: 'src/foo.py', to: 'lib/foo.py' });
  assert.equal(calls.updatePieceFilenames.length, 1);
  assert.deepEqual(calls.updatePieceFilenames[0], [{ pieceId: 1, path: 'lib/foo.py' }]);
  assert.equal(calls.updateTabFilename.length, 1);
  assert.deepEqual(calls.updateTabFilename[0], { pieceId: 1, path: 'lib/foo.py' });
  assert.equal(calls.unregisterFile.length, 1);
  assert.equal(calls.unregisterFile[0], 'src/foo.py');
  // Note: SQLite persistence (dbUpdatePiece) fires internally via dbStorage import
  // and cannot be observed by this mock-deps style test. Rust-side unit tests
  // cover the SQLite layer; see src-tauri/src/db/commands.rs tests.
  assert.equal(calls.bumpScaffoldRefresh.length, 1);
});

test('moveFile — returns failure when filesystem move fails', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const { deps, calls } = createMockDeps({ pieces, moveProjectPathResult: false });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveFile('src/foo.py', 'lib/foo.py');

  assert.equal(result.success, false);
  assert.equal(calls.updatePieceFilenames.length, 0, 'no state changes on fs failure');
  assert.equal(calls.updateTabFilename.length, 0);
  assert.equal(calls.bumpScaffoldRefresh.length, 0);
});

test('moveFile — no state changes when no pieces match', async () => {
  const { deps, calls } = createMockDeps({ pieces: [] });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveFile('untracked.txt', 'other.txt');

  assert.equal(result.success, true);
  assert.equal(calls.updatePieceFilenames.length, 0);
  assert.equal(calls.bumpScaffoldRefresh.length, 1, 'scaffold still refreshes');
});

test('moveFolder — updates all pieces under folder', async () => {
  const pieces = [
    createMockPiece(1, 'src/a.py'),
    createMockPiece(2, 'src/b.py'),
    createMockPiece(3, 'lib/c.py'),
  ];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveFolder('src', 'dest');

  assert.equal(result.success, true);
  assert.equal(calls.updatePieceFilenames.length, 1);
  const updates = calls.updatePieceFilenames[0];
  assert.equal(updates.length, 2, 'only pieces under src/ affected');
  assert.deepEqual(updates[0], { pieceId: 1, path: 'dest/a.py' });
  assert.deepEqual(updates[1], { pieceId: 2, path: 'dest/b.py' });
});

test('moveFile — membership plan removes from old group and adds to the destination group', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const groups = [
    createMockGroup('g1', 'src', 'src', [1]),
    createMockGroup('g2', 'lib', 'lib', []),
  ];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveFile('src/foo.py', 'lib/foo.py');

  assert.equal(calls.applyFsSyncPlan.length, 1, 'one atomic sync plan');
  assert.deepEqual(calls.applyFsSyncPlan[0], {
    folderPathUpdates: [],
    removals: [{ groupId: 'g1', pieceId: 1 }],
    additions: [{ groupId: 'g2', pieceId: 1 }],
    upserts: [],
  });
  assert.equal(calls.allocateGroupId.length, 0, 'no group creation needed');
});

test('moveFolder — folderPath fixups ride the sync plan and pieces stay in their group (no stale re-read needed)', async () => {
  const pieces = [
    createMockPiece(1, 'Caboodle/main.py'),
    createMockPiece(2, 'Caboodle/example1.py'),
  ];
  const groups = [
    createMockGroup('g1', 'Caboodle', 'Caboodle', [1, 2]),
  ];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveFolder('Caboodle', 'Alaska/Caboodle');

  assert.equal(result.success, true);
  assert.equal(calls.applyFsSyncPlan.length, 1);
  assert.deepEqual(calls.applyFsSyncPlan[0], {
    folderPathUpdates: [{ groupId: 'g1', folderPath: 'Alaska/Caboodle' }],
    removals: [],
    additions: [],
    upserts: [],
  });

  assert.equal(calls.updatePieceFilenames.length, 1);
  assert.deepEqual(calls.updatePieceFilenames[0], [
    { pieceId: 1, path: 'Alaska/Caboodle/main.py' },
    { pieceId: 2, path: 'Alaska/Caboodle/example1.py' },
  ]);
});

test('moveFolder — nested group folderPaths all land in one sync plan', async () => {
  const pieces = [
    createMockPiece(1, 'parent/child/a.py'),
  ];
  const groups = [
    createMockGroup('g1', 'parent', 'parent', []),
    createMockGroup('g2', 'child', 'parent/child', [1]),
  ];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveFolder('parent', 'dest/parent');

  assert.equal(calls.applyFsSyncPlan.length, 1);
  assert.deepEqual(calls.applyFsSyncPlan[0].folderPathUpdates, [
    { groupId: 'g1', folderPath: 'dest/parent' },
    { groupId: 'g2', folderPath: 'dest/parent/child' },
  ]);
  assert.deepEqual(calls.applyFsSyncPlan[0].removals, [], 'overrides keep members in their groups');
});

// ---------------------------------------------------------------------------
// §3.3 reconciliation — moves into group-less folders create the group
// ---------------------------------------------------------------------------

test('moveFile — into a folder no group owns creates the group in the sync plan (PRD §3.3)', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const groups = [createMockGroup('g1', 'src', 'src', [1])];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveFile('src/foo.py', 'newdir/foo.py');

  assert.equal(calls.allocateGroupId.length, 1, 'one group id allocated');
  assert.equal(calls.applyFsSyncPlan.length, 1);
  assert.deepEqual(calls.applyFsSyncPlan[0], {
    folderPathUpdates: [],
    removals: [{ groupId: 'g1', pieceId: 1 }],
    additions: [],
    upserts: [{ groupId: 'auto-1', name: 'newdir', folderPath: 'newdir', pieceIds: [1], parentId: null }],
  });
});

test('moveFile — a group created in a nested folder links to the group owning its parent folder', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const groups = [createMockGroup('g1', 'src', 'src', [1])];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveFile('src/foo.py', 'src/newsub/foo.py');

  assert.deepEqual(calls.applyFsSyncPlan[0].upserts, [
    { groupId: 'auto-1', name: 'newsub', folderPath: 'src/newsub', pieceIds: [1], parentId: 'g1' },
  ], 'created group is parent-linked by folder containment');
});

test('moveFile — rename within the same group folder produces no sync plan', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const groups = [createMockGroup('g1', 'src', 'src', [1])];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveFile('src/foo.py', 'src/bar.py');

  assert.equal(calls.applyFsSyncPlan.length, 0, 'no membership change, no creation');
  assert.equal(calls.allocateGroupId.length, 0);
});

test('moveFile — move to project root never creates a group', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const groups = [createMockGroup('g1', 'src', 'src', [1])];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveFile('src/foo.py', 'foo.py');

  assert.equal(calls.allocateGroupId.length, 0);
  assert.deepEqual(calls.applyFsSyncPlan[0].removals, [{ groupId: 'g1', pieceId: 1 }]);
  assert.deepEqual(calls.applyFsSyncPlan[0].upserts, []);
});

test('moveFile — two same-tick moves into one new folder share a single created group (pending map)', async () => {
  // getGroups() never reflects the first move's creation — exactly the real
  // wiring's staleness. The pending map must dedupe the second creation
  // into an upsert against the same id.
  const pieces = [createMockPiece(1, 'src/a.py'), createMockPiece(2, 'src/b.py')];
  const groups = [createMockGroup('g1', 'src', 'src', [1, 2])];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveFile('src/a.py', 'newdir/a.py');
  await mgr.moveFile('src/b.py', 'newdir/b.py');

  assert.equal(calls.allocateGroupId.length, 1, 'second move reuses the pending group id');
  assert.equal(calls.applyFsSyncPlan.length, 2);
  assert.deepEqual(calls.applyFsSyncPlan[0].upserts, [
    { groupId: 'auto-1', name: 'newdir', folderPath: 'newdir', pieceIds: [1], parentId: null },
  ]);
  assert.deepEqual(calls.applyFsSyncPlan[1].upserts, [
    { groupId: 'auto-1', name: 'newdir', folderPath: 'newdir', pieceIds: [2], parentId: null },
  ], 'upsert against the SAME id — unions if state caught up, creates once if not');
});

test('deleteFolder — clears pending auto-created-group bookkeeping under the deleted folder', async () => {
  const pieces = [createMockPiece(1, 'src/a.py')];
  const groups = [createMockGroup('g1', 'src', 'src', [1])];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveFile('src/a.py', 'newdir/a.py');
  await mgr.deleteFolder('newdir');
  // Re-seed a piece so a later move into a recreated folder is observable.
  // (piecesByFilename in the harness is fixed, so reuse the src piece map by
  // moving the same logical path again after "recreating" the folder.)
  await mgr.moveFile('src/a.py', 'newdir/a.py');

  assert.equal(calls.allocateGroupId.length, 2, 'recreated folder gets a FRESH group id, not the stale pending one');
});

// ---------------------------------------------------------------------------
// moveOrWriteFile — move-or-materialize
// ---------------------------------------------------------------------------

test('moveOrWriteFile — successful move runs the normal pipeline', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveOrWriteFile('src/foo.py', 'lib/foo.py', 'fallback');

  assert.equal(result.success, true);
  assert.equal(result.materialized, false);
  assert.equal(calls.moveProjectPath.length, 1);
  assert.equal(calls.writeProjectFile.length, 0, 'no write on successful move');
  assert.deepEqual(calls.updatePieceFilenames[0], [{ pieceId: 1, path: 'lib/foo.py' }]);
});

test('moveOrWriteFile — failed move materializes the file and syncs the piece', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const groups = [createMockGroup('g2', 'lib', 'lib', [])];
  const { deps, calls } = createMockDeps({ pieces, groups, moveProjectPathResult: false });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveOrWriteFile('src/foo.py', 'lib/foo.py', 'print(1)');

  assert.equal(result.success, true);
  assert.equal(result.materialized, true);
  assert.equal(calls.writeProjectFile.length, 1);
  assert.deepEqual(calls.writeProjectFile[0], { rootPath: '/test/project', path: 'lib/foo.py', contents: 'print(1)' });
  assert.deepEqual(calls.updatePieceFilenames[0], [{ pieceId: 1, path: 'lib/foo.py' }]);
  assert.deepEqual(calls.updateTabFilename[0], { pieceId: 1, path: 'lib/foo.py' });
  assert.equal(calls.unregisterFile[0], 'src/foo.py');
  assert.deepEqual(calls.notifyFileChanged[0], { path: 'lib/foo.py', text: 'print(1)' });
  assert.deepEqual(calls.applyFsSyncPlan[0].additions, [{ groupId: 'g2', pieceId: 1 }]);
  assert.equal(calls.bumpScaffoldRefresh.length, 1);
});

test('moveOrWriteFile — prefers readable disk content over the fallback', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const { deps, calls } = createMockDeps({
    pieces,
    moveProjectPathResult: false,
    readProjectFileResult: 'disk contents',
  });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveOrWriteFile('src/foo.py', 'lib/foo.py', 'fallback');

  assert.equal(calls.writeProjectFile[0].contents, 'disk contents');
});

test('moveOrWriteFile — skipGroupSync suppresses the sync plan on both branches', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const groups = [createMockGroup('g1', 'src', 'src', [1])];
  const { deps, calls } = createMockDeps({ pieces, groups, moveProjectPathResult: false });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveOrWriteFile('src/foo.py', 'newdir/foo.py', 'x', { skipGroupSync: true });

  assert.equal(calls.applyFsSyncPlan.length, 0, 'caller owns group semantics');
  assert.equal(calls.allocateGroupId.length, 0);
});

test('moveOrWriteFile — write failure returns error without state changes', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const { deps, calls } = createMockDeps({
    pieces,
    moveProjectPathResult: false,
    writeProjectFileResult: false,
  });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveOrWriteFile('src/foo.py', 'lib/foo.py', 'x');

  assert.equal(result.success, false);
  assert.equal(result.code, 'fs.write_failed');
  assert.equal(calls.updatePieceFilenames.length, 0);
});

test('moveFile — returns failure when no root path', async () => {
  const { deps } = createMockDeps({ rootPath: null });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveFile('a.py', 'b.py');

  assert.equal(result.success, false);
  assert.equal(result.code, 'fs.no_root');
});

// ===========================================================================
// Delete pipeline tests
// ===========================================================================

test('deleteFile — runs full delete pipeline', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.deleteFile('src/foo.py');

  assert.equal(result.success, true);
  assert.equal(calls.deleteProjectPath.length, 1);
  assert.deepEqual(calls.deleteProjectPath[0], { rootPath: '/test/project', path: 'src/foo.py' });
  assert.equal(calls.closeTab.length, 1, 'closes open tab');
  assert.equal(calls.closeTab[0], 1);
  assert.equal(calls.removeConnectionsForPieces.length, 1, 'removes connections');
  assert.deepEqual(calls.removeConnectionsForPieces[0], [1]);
  assert.equal(calls.unregisterFile.length, 1, 'unregisters from syntax domain');
  assert.equal(calls.unregisterFile[0], 'src/foo.py');
  assert.equal(calls.deletePieces.length, 1, 'removes piece from state');
  assert.deepEqual(calls.deletePieces[0].ids, [1]);
  assert.equal(calls.removePiecesFromGroups.length, 1, 'removes from groups');
  assert.deepEqual(calls.removePiecesFromGroups[0], [1]);
  // SQLite persistence (dbDeletePiece) fires via direct dbStorage import.
  assert.equal(calls.bumpScaffoldRefresh.length, 1);
});

test('deleteFile — returns failure when filesystem delete fails', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const { deps, calls } = createMockDeps({ pieces, deleteProjectPathResult: false });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.deleteFile('src/foo.py');

  assert.equal(result.success, false);
  assert.equal(calls.closeTab.length, 0, 'no state changes on fs failure');
  assert.equal(calls.deletePieces.length, 0);
  assert.equal(calls.removePiecesFromGroups.length, 0);
});

test('deleteFile — no piece state changes for non-piece file', async () => {
  const { deps, calls } = createMockDeps({ pieces: [] });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.deleteFile('readme.txt');

  assert.equal(result.success, true);
  assert.equal(calls.deletePieces.length, 0);
  assert.equal(calls.bumpScaffoldRefresh.length, 1);
});

test('deleteFolder — removes all pieces under folder', async () => {
  const pieces = [
    createMockPiece(1, 'src/a.py'),
    createMockPiece(2, 'src/b.py'),
    createMockPiece(3, 'lib/c.py'),
  ];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.deleteFolder('src');

  assert.equal(result.success, true);
  assert.equal(calls.closeTab.length, 2, 'closes tabs for 2 pieces');
  assert.deepEqual(calls.removeConnectionsForPieces[0], [1, 2]);
  assert.deepEqual(calls.deletePieces[0].ids, [1, 2]);
  assert.deepEqual(calls.removePiecesFromGroups[0], [1, 2]);
});

test('deleteFolder — removes matching group when folder is a group', async () => {
  const pieces = [createMockPiece(1, 'src/a.py')];
  const groups = [createMockGroup('g1', 'src', 'src', [1])];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.deleteFolder('src');

  assert.equal(calls.deleteGroup.length, 1);
  assert.equal(calls.deleteGroup[0], 'g1');
});

test('deleteFile — does NOT auto-delete empty group', async () => {
  const pieces = [createMockPiece(1, 'src/a.py')];
  const groups = [createMockGroup('g1', 'src', 'src', [1])];
  const { deps, calls } = createMockDeps({ pieces, groups });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.deleteFile('src/a.py');

  assert.equal(calls.deleteGroup.length, 0, 'group kept even though piece removed');
});

test('deleteEmptyFolder — removes empty folder', async () => {
  const { deps, calls } = createMockDeps({});
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.deleteEmptyFolder('empty_dir');

  assert.equal(result.success, true);
  assert.equal(calls.removeEmptyDirectory.length, 1);
  assert.equal(calls.bumpScaffoldRefresh.length, 1);
});

test('deleteEmptyFolder — fails when directory not empty', async () => {
  const { deps, calls } = createMockDeps({ removeEmptyDirectoryResult: false });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.deleteEmptyFolder('non_empty');

  assert.equal(result.success, false);
  assert.ok(result.error.includes('not be empty'));
});

// ===========================================================================
// Write pipeline tests
// ===========================================================================

test('writeFile — writes file and notifies syntax domain', async () => {
  const { deps, calls } = createMockDeps({});
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.writeFile('src/new.py', 'print("hello")');

  assert.equal(result.success, true);
  assert.equal(calls.writeProjectFile.length, 1);
  assert.equal(calls.notifyFileChanged.length, 1);
  assert.deepEqual(calls.notifyFileChanged[0], { path: 'src/new.py', text: 'print("hello")' });
  assert.equal(calls.bumpScaffoldRefresh.length, 1);
});

test('writeFile — opts skip syntax notify and scaffold refresh', async () => {
  const { deps, calls } = createMockDeps({});
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.writeFile('src/saved.py', 'x = 1', { notify: false, skipScaffold: true });

  assert.equal(result.success, true);
  assert.equal(calls.writeProjectFile.length, 1);
  assert.equal(calls.notifyFileChanged.length, 0, 'content-owning callers notify themselves');
  assert.equal(calls.bumpScaffoldRefresh.length, 0, 'content writes do not change the tree');
});

test('writeFile — failed write returns error without notify or refresh', async () => {
  const { deps, calls } = createMockDeps({ writeProjectFileResult: false });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.writeFile('src/new.py', 'contents');

  assert.equal(result.success, false);
  assert.equal(result.code, 'fs.write_failed');
  assert.equal(calls.notifyFileChanged.length, 0);
  assert.equal(calls.bumpScaffoldRefresh.length, 0);
});

test('createDirectory — creates directory', async () => {
  const { deps, calls } = createMockDeps({});
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.createDirectory('new_dir');

  assert.equal(result.success, true);
  assert.equal(calls.createProjectDirectory.length, 1);
  assert.equal(calls.bumpScaffoldRefresh.length, 1);
});

// ===========================================================================
// Reserved Windows device names (owner ruling 2026-07-28): the verbatim-path
// backend can create con.py etc., so the manager rejects creation targets
// before any filesystem call — regardless of surface-level validation.
// ===========================================================================

test('writeFile — rejects reserved device names before touching disk', async () => {
  const { deps, calls } = createMockDeps({});
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.writeFile('con.py', 'x = 1');

  assert.equal(result.success, false);
  assert.equal(result.code, 'fs.reserved_name');
  assert.equal(calls.writeProjectFile.length, 0);
  assert.equal(calls.notifyFileChanged.length, 0);
  assert.equal(calls.bumpScaffoldRefresh.length, 0);
});

test('moveFile — rejects reserved destination segments before the move', async () => {
  const pieces = [createMockPiece(1, 'src/a.py')];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveFile('src/a.py', 'aux/a.py');

  assert.equal(result.success, false);
  assert.equal(result.code, 'fs.reserved_name');
  assert.equal(calls.moveProjectPath.length, 0);
  assert.equal(calls.updatePieceFilenames.length, 0);
});

test('createDirectory — rejects reserved directory names', async () => {
  const { deps, calls } = createMockDeps({});
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.createDirectory('lpt1');

  assert.equal(result.success, false);
  assert.equal(result.code, 'fs.reserved_name');
  assert.equal(calls.createProjectDirectory.length, 0);
});

test('moveOrWriteFile — reserved destination does not fall through to materialize', async () => {
  const pieces = [createMockPiece(1, 'src/a.py')];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.moveOrWriteFile('src/a.py', 'con.py', 'fallback');

  assert.equal(result.success, false);
  assert.equal(result.code, 'fs.reserved_name');
  assert.equal(result.materialized, false);
  assert.equal(calls.writeProjectFile.length, 0, 'materialize branch not taken');
});

// ===========================================================================
// Batch operation tests
// ===========================================================================

test('batch — executes operations sequentially', async () => {
  const pieces = [
    createMockPiece(1, 'random/a.py'),
    createMockPiece(2, 'random/b.py'),
  ];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.batch([
    { op: 'moveFile', from: 'random/a.py', to: 'src/a.py' },
    { op: 'moveFile', from: 'random/b.py', to: 'src/b.py' },
    { op: 'deleteEmptyFolder', path: 'random' },
  ]);

  assert.equal(result.successCount, 3);
  assert.equal(result.failureCount, 0);
  assert.equal(result.results.length, 3);
  assert.equal(calls.moveProjectPath.length, 2);
  assert.equal(calls.removeEmptyDirectory.length, 1);
  // Manifest and scaffold only called once at end (by batch)
  assert.equal(calls.bumpScaffoldRefresh.length, 1);
});

test('batch — partial failure collects errors', async () => {
  const pieces = [
    createMockPiece(1, 'src/a.py'),
    createMockPiece(2, 'src/b.py'),
  ];
  let callCount = 0;
  const { deps, calls } = createMockDeps({ pieces });
  // Override moveProjectPath to fail on second call
  deps.moveProjectPath = async (rootPath, from, to) => {
    callCount++;
    calls.moveProjectPath.push({ rootPath, from, to });
    return callCount !== 2; // fail on second call
  };
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.batch([
    { op: 'moveFile', from: 'src/a.py', to: 'dest/a.py' },
    { op: 'moveFile', from: 'src/b.py', to: 'dest/b.py' },
  ]);

  assert.equal(result.successCount, 1);
  assert.equal(result.failureCount, 1);
  assert.equal(result.results[0].success, true);
  assert.equal(result.results[1].success, false);
});

test('batch — writeFile op writes with no notify and a single final refresh', async () => {
  const { deps, calls } = createMockDeps({});
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.batch([
    { op: 'writeFile', path: 'src/a.py', contents: 'a' },
    { op: 'writeFile', path: 'src/b.py' },
  ]);

  assert.equal(result.successCount, 2);
  assert.equal(calls.writeProjectFile.length, 2);
  assert.equal(calls.writeProjectFile[1].contents, '', 'missing contents default to empty');
  assert.equal(calls.notifyFileChanged.length, 0);
  assert.equal(calls.bumpScaffoldRefresh.length, 1, 'one refresh at batch end');
});

test('batch — unknown operation reports failure', async () => {
  const { deps } = createMockDeps({});
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.batch([{ op: 'nonexistent', path: 'foo' }]);

  assert.equal(result.failureCount, 1);
  assert.equal(result.results[0].code, 'fs.unknown_op');
});

test('batch — empty array returns zero counts', async () => {
  const { deps } = createMockDeps({});
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.batch([]);

  assert.equal(result.successCount, 0);
  assert.equal(result.failureCount, 0);
  assert.equal(result.results.length, 0);
});

test('batch — mixed move and delete operations', async () => {
  const pieces = [
    createMockPiece(1, 'src/keep.py'),
    createMockPiece(2, 'src/remove.py'),
  ];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.batch([
    { op: 'moveFile', from: 'src/keep.py', to: 'lib/keep.py' },
    { op: 'deleteFile', path: 'src/remove.py' },
  ]);

  assert.equal(result.successCount, 2);
  assert.equal(calls.moveProjectPath.length, 1);
  assert.equal(calls.deleteProjectPath.length, 1);
  assert.equal(calls.updatePieceFilenames.length, 1, 'move pipeline ran');
  assert.equal(calls.deletePieces.length, 1, 'delete pipeline ran');
});

// ===========================================================================
// Pipeline ordering tests
// ===========================================================================

test('delete pipeline — filesystem-first: no state changes on fs failure', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const { deps, calls } = createMockDeps({ pieces, deleteProjectPathResult: false });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.deleteFile('src/foo.py');

  assert.equal(calls.closeTab.length, 0);
  assert.equal(calls.removeConnectionsForPieces.length, 0);
  assert.equal(calls.unregisterFile.length, 0);
  assert.equal(calls.deletePieces.length, 0);
  assert.equal(calls.removePiecesFromGroups.length, 0);
  assert.equal(calls.bumpScaffoldRefresh.length, 0);
});

test('move pipeline — filesystem-first: no state changes on fs failure', async () => {
  const pieces = [createMockPiece(1, 'src/foo.py')];
  const { deps, calls } = createMockDeps({ pieces, moveProjectPathResult: false });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.moveFile('src/foo.py', 'lib/foo.py');

  assert.equal(calls.updatePieceFilenames.length, 0);
  assert.equal(calls.updateTabFilename.length, 0);
  assert.equal(calls.unregisterFile.length, 0);
  assert.equal(calls.bumpScaffoldRefresh.length, 0);
});

// ---------------------------------------------------------------------------
// removeFromCanvas — demotion (owner-ratified 2026-07-18, wire-arc E):
// off the canvas, file kept. Mirrors deletePath's canvas cascade with NO
// filesystem operation; the syntax domain keeps the file registered.
// ---------------------------------------------------------------------------

test('removeFromCanvas — removes canvas state but never touches the filesystem', async () => {
  const pieces = [createMockPiece(1, 'oAuth.py'), createMockPiece(2, 'main/main.py')];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  const result = await mgr.removeFromCanvas([1]);

  assert.equal(result.success, true);
  assert.equal(calls.deleteProjectPath.length, 0, 'no filesystem delete');
  assert.equal(calls.writeProjectFile.length, 0, 'no filesystem write');
  assert.deepEqual(calls.closeTab, [1], 'open tab closed');
  assert.deepEqual(calls.removeConnectionsForPieces, [[1]], 'wires cascade');
  assert.equal(calls.deletePieces.length, 1);
  assert.deepEqual(calls.deletePieces[0].ids, [1]);
  assert.deepEqual(calls.removePiecesFromGroups, [[1]]);
  assert.equal(calls.unregisterFile.length, 0, 'file stays registered — it still exists on disk');
  assert.equal(calls.bumpScaffoldRefresh.length, 1, 'refresh re-runs discovery → off-canvas badge appears');
});

test('removeFromCanvas — accepts a single id and unknown ids are a safe no-op', async () => {
  const pieces = [createMockPiece(1, 'a.py')];
  const { deps, calls } = createMockDeps({ pieces });
  const mgr = createFilesystemWriteManager(deps);

  await mgr.removeFromCanvas(1);
  assert.deepEqual(calls.deletePieces[0].ids, [1], 'single id accepted');

  const { deps: deps2, calls: calls2 } = createMockDeps({ pieces: [] });
  const mgr2 = createFilesystemWriteManager(deps2);
  const result = await mgr2.removeFromCanvas([99]);
  assert.equal(result.success, true);
  assert.equal(calls2.deletePieces.length, 0);
  assert.equal(calls2.bumpScaffoldRefresh.length, 0);
});


// ---------------------------------------------------------------------------
// collectEmptiedFolderGroups — ghost-row persistence (2026-07-26)
// ---------------------------------------------------------------------------

test('collectEmptiedFolderGroups flags folder groups whose whole membership is removed', () => {
  const groups = [
    createMockGroup('g1', 'main', 'main', [1, 2]),
    createMockGroup('g2', 'sub', 'main/sub', [3]),
    createMockGroup('m1', 'box', null, [4]),
  ];

  const emptied = collectEmptiedFolderGroups(groups, [
    { groupId: 'g2', pieceId: 3 },
    { groupId: 'g1', pieceId: 1 },
    { groupId: 'm1', pieceId: 4 },
  ]);

  assert.deepEqual(emptied, ['g2'],
    'g1 keeps a member, m1 is manual (survives empty by design) — only g2 empties');
});

test('collectEmptiedFolderGroups returns empty for no removals or already-empty groups', () => {
  const groups = [createMockGroup('g1', 'main', 'main', [])];
  assert.deepEqual(collectEmptiedFolderGroups(groups, []), []);
  assert.deepEqual(collectEmptiedFolderGroups(groups, [{ groupId: 'g1', pieceId: 9 }]), [],
    'a group with no members was never non-empty — nothing to persist');
});
