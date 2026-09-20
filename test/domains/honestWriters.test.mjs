import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { createSyntaxAdapter } from '../../src/lsp/syntaxAdapter.js';
import { createFilesystemWriteManager } from '../../src/app/filesystemWriteManager.js';
import { onPersistenceWriteFailure } from '../../src/project/persistenceFailures.js';

// ADR-032 D3/D4, decision 5 — a writer's return value is a claim about the
// write, and notification is not a substitute for one.
//
// `writeProjectFile` resolves `false` on failure rather than throwing
// (src/project/storage.js), so a discarded result is indistinguishable from a
// successful write. Two writers discarded it:
//
//   D3 `syntaxAdapter.writeResultText` — the CLOSED-file branch awaited the
//      write, ignored the boolean, told the syntax domain the file had changed
//      and returned true. This is the canvas-wire import-stub path, which by
//      design writes to closed files: on failure the wire appeared, the domain
//      believed the import existed, and the file on disk never received it.
//      File writes do not flow through the ADR-026 failure observer, so there
//      was no notice either — and canvas writes to closed files have no undo.
//
//   D4 the delete-undo `extraActions` — restore and re-delete called
//      `.then(() => bumpScaffoldRefresh())` with no result check, so undo of a
//      delete could fail to restore the file while the piece returned to the
//      canvas and the scaffold refreshed.

function setupSyntax({ writeSucceeds }) {
  const domain = createSyntaxDomain();
  const notified = [];
  const realNotify = domain.commands.notifyFileChanged;
  domain.commands.notifyFileChanged = (path, text) => {
    notified.push(path);
    return realNotify(path, text);
  };
  const disk = new Map([
    ['src/app.js', 'export const app = 1;\n'],
    ['src/utils.js', 'export const helper = 2;\n'],
  ]);
  const attempted = [];
  const adapter = createSyntaxAdapter({
    syntaxDomain: domain,
    projectRoot: '/proj',
    readProjectFile: async (_root, rel) => disk.get(rel) ?? null,
    writeProjectFile: async (_root, rel, text) => {
      attempted.push(rel);
      if (!writeSucceeds) return false; // what storage.js returns on failure
      disk.set(rel, text);
      return true;
    },
  });
  for (const [rel, text] of disk) {
    domain.commands.registerFile(`/proj/${rel}`, text);
  }
  return { domain, adapter, disk, attempted, notified };
}

test('D3: a failed closed-file write is reported as a failure', async () => {
  const { adapter, attempted } = setupSyntax({ writeSucceeds: false });

  const applied = await adapter.writeResultText('/proj/src/app.js', 'REPLACEMENT\n');

  assert.equal(attempted.length, 1, 'the write must actually be attempted');
  assert.equal(
    applied,
    false,
    'D3: a failed write reported success — the caller cannot tell it did not happen',
  );
});

test('D3: a failed closed-file write does not tell the syntax domain the file changed', async () => {
  const { adapter, notified } = setupSyntax({ writeSucceeds: false });

  await adapter.writeResultText('/proj/src/app.js', 'REPLACEMENT\n');

  assert.deepEqual(
    notified,
    [],
    'D3: the syntax domain was told a change happened that never reached disk',
  );
});

test('D3: a successful closed-file write does notify the syntax domain', async () => {
  const { adapter, notified } = setupSyntax({ writeSucceeds: true });

  await adapter.writeResultText('/proj/src/app.js', 'REPLACEMENT\n');

  assert.deepEqual(notified, ['/proj/src/app.js'], 'the notification path must survive');
});

test('D3: a wire whose import stub cannot be written does not report the patch applied', async () => {
  const { adapter } = setupSyntax({ writeSucceeds: false });

  const result = await adapter.handleConnect({
    connectionId: 'conn-1',
    sourceFilePath: '/proj/src/utils.js',
    targetFilePath: '/proj/src/app.js',
  });

  assert.equal(
    result.patchApplied,
    false,
    'D3: the wire claimed its import stub was written when the write failed',
  );
});

test('D3: a successful closed-file write still reports success', async () => {
  const { adapter, disk } = setupSyntax({ writeSucceeds: true });

  const applied = await adapter.writeResultText('/proj/src/app.js', 'REPLACEMENT\n');

  assert.equal(applied, true, 'the honest writer must not break the success path');
  assert.equal(disk.get('src/app.js'), 'REPLACEMENT\n');
});

// ---------------------------------------------------------------------------
// D4 — delete-undo's filesystem restore
// ---------------------------------------------------------------------------

function setupManager({ restoreSucceeds }) {
  const piece = { id: 1, filename: 'src/doomed.js', label: 'doomed.js' };
  const disk = new Map([['src/doomed.js', 'CONTENT']]);
  let captured = null;

  const manager = createFilesystemWriteManager({
    moveProjectPath: async () => true,
    writeProjectFile: async (_root, rel, text) => {
      if (!restoreSucceeds) return false;
      disk.set(rel, text);
      return true;
    },
    removeEmptyDirectory: async () => true,
    createProjectDirectory: async () => true,
    deleteProjectPath: async (_root, rel) => {
      disk.delete(rel);
      return true;
    },
    readProjectFile: async (_root, rel) => disk.get(rel) ?? null,
    getRootPath: () => 'C:/proj',
    getPiecesById: () => new Map([[piece.id, piece]]),
    getPiecesByFilename: () => new Map([[piece.filename, piece]]),
    getPieces: () => [piece],
    getGroups: () => [],
    getGroupByPieceId: () => new Map(),
    updatePieceFilenames: () => {},
    deletePieces: ({ extraActions }) => { captured = extraActions; },
    updateTabFilename: () => {},
    closeTab: () => {},
    getGroupDomain: () => null,
    removePiecesFromGroups: () => {},
    removeConnectionsForPieces: () => {},
    unregisterFile: () => {},
    notifyFileChanged: () => {},
    bumpScaffoldRefresh: () => {},
    normalizePath: (p) => p.replace(/\\/g, '/'),
    getBasename: (p) => p.split('/').pop(),
  });

  return { manager, disk, undoActions: () => captured };
}

test('D4: a delete-undo whose restore fails is surfaced, not swallowed', async () => {
  const { manager, disk, undoActions } = setupManager({ restoreSucceeds: false });

  const deleted = await manager.deleteFile('src/doomed.js');
  assert.equal(deleted.success, true, 'the delete itself must succeed to set up the undo');
  assert.equal(disk.has('src/doomed.js'), false, 'the file is gone from disk');

  const actions = undoActions();
  assert.ok(actions?.length, 'the delete must journal a restore action for undo');

  // ADR-027 decision 2 gave persistence failures ONE surface. A restore that
  // cannot put the file back belongs on it: the piece returns to the canvas
  // and the scaffold refreshes either way, so without this the user is shown a
  // successful undo over a file that is still missing.
  const seen = [];
  const unsubscribe = onPersistenceWriteFailure((failure) => seen.push(failure));
  try {
    await actions[0].undo();
  } finally {
    unsubscribe();
  }

  assert.equal(disk.has('src/doomed.js'), false, 'precondition: the restore did fail');
  assert.equal(
    seen.length,
    1,
    'D4: the failed restore was swallowed — undo appeared to work over a missing file',
  );
});

test('D4: a successful delete-undo reports no failure', async () => {
  const { manager, undoActions } = setupManager({ restoreSucceeds: true });

  await manager.deleteFile('src/doomed.js');
  const seen = [];
  const unsubscribe = onPersistenceWriteFailure((failure) => seen.push(failure));
  try {
    await undoActions()[0].undo();
  } finally {
    unsubscribe();
  }

  assert.deepEqual(seen, [], 'a successful restore must not raise a failure notice');
});

test('D4: a delete-undo whose restore succeeds puts the file back', async () => {
  const { manager, disk, undoActions } = setupManager({ restoreSucceeds: true });

  await manager.deleteFile('src/doomed.js');
  const actions = undoActions();
  await actions[0].undo();

  assert.equal(disk.get('src/doomed.js'), 'CONTENT', 'the restore path must still work');
});
