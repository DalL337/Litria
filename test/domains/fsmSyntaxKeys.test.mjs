import test from 'node:test';
import assert from 'node:assert/strict';

import { createFilesystemWriteManager } from '../../src/app/filesystemWriteManager.js';
import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { createSyntaxAdapter } from '../../src/lsp/syntaxAdapter.js';
import { normalizePath, getBasename } from '../../src/utils/path.js';

// ---------------------------------------------------------------------------
// The filesystem write manager tells SyntaxDomain about deletes, moves and
// writes (P4 gate item 5, .research/2026-10-01-fsm-unregister-paths.md).
// SyntaxDomain keys every file by its absolute, forward-slash path — the key
// discovery and the editor register under — but the manager passed the
// piece's project-RELATIVE path. So an unregister matched nothing (a deleted
// file stayed indexed as `ok`, and wires from it never went broken), and a
// notify registered a second, relative-keyed copy of the file.
//
// These run the real manager against the real domain.
// ---------------------------------------------------------------------------

const UTILS_TS = 'export function helper() {}\n';
const APP_TS = "import { helper } from './utils';\nhelper();\n";

/**
 * A manager over an in-memory disk, wired to a real SyntaxDomain the way
 * useFilesystemWriteManager wires it. `root` is the project root exactly as
 * the app holds it (a Windows root keeps its backslashes).
 */
function setup({ root = '/proj', files = {}, pieces = [] } = {}) {
  const domain = createSyntaxDomain();
  const disk = new Map(Object.entries(files));
  const piecesById = new Map(pieces.map((p) => [p.id, p]));
  const piecesByFilename = new Map(pieces.map((p) => [p.filename, p]));
  const manager = createFilesystemWriteManager({
    moveProjectPath: async (_root, from, to) => {
      if (!disk.has(from)) return false;
      disk.set(to, disk.get(from));
      disk.delete(from);
      return true;
    },
    writeProjectFile: async (_root, path, contents) => {
      disk.set(path, contents);
      return true;
    },
    // A file, or a folder: every entry under it (the real command deletes recursively).
    deleteProjectPath: async (_root, path) => {
      let removed = disk.delete(path);
      for (const key of [...disk.keys()]) {
        if (key.startsWith(`${path}/`)) removed = disk.delete(key) || removed;
      }
      return removed;
    },
    removeEmptyDirectory: async () => true,
    createProjectDirectory: async () => true,
    readProjectFile: async (_root, path) => disk.get(path) ?? null,
    getRootPath: () => root,
    getPiecesById: () => piecesById,
    getPiecesByFilename: () => piecesByFilename,
    getPieces: () => [...piecesById.values()],
    getGroups: () => [],
    getGroupByPieceId: () => new Map(),
    getGroupDomain: () => null,
    updatePieceFilenames: () => {},
    deletePieces: () => {},
    updateTabFilename: () => {},
    closeTab: () => {},
    removePiecesFromGroups: () => {},
    removeConnectionsForPieces: () => {},
    unregisterFile: domain.commands.unregisterFile,
    notifyFileChanged: domain.commands.notifyFileChanged,
    registerFileIfAbsent: domain.commands.registerFileIfAbsent,
    forgetFile: domain.commands.forgetFile,
    getSyntaxFilesUnder: domain.selectors.getRegisteredFilesUnder,
    bumpScaffoldRefresh: () => {},
    normalizePath,
    getBasename,
  });
  return { domain, manager, disk };
}

/** The key discovery and the editor use: root + '/' + relative, forward slashes. */
function keyOf(root, rel) {
  return `${root.replace(/\\/g, '/').replace(/\/$/, '')}/${rel}`;
}

/** Register both files and a resolved utils → app edge, as discovery does. */
function indexProject(domain, root) {
  domain.commands.registerFile(keyOf(root, 'src/utils.ts'), UTILS_TS);
  domain.commands.registerFile(keyOf(root, 'src/app.ts'), APP_TS);
  const { edgeId } = domain.commands.connectDiscovered({
    connectionId: 'conn_1',
    sourceFilePath: keyOf(root, 'src/utils.ts'),
    targetFilePath: keyOf(root, 'src/app.ts'),
    moduleSpecifier: './utils',
    importLine: 0,
  });
  const helperId = domain.selectors
    .getDefinitionsForFile(keyOf(root, 'src/utils.ts'))
    .find((d) => d.name === 'helper').symbolId;
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperId] });
  return edgeId;
}

const PIECES = [
  { id: 1, filename: 'src/utils.ts', label: 'utils.ts' },
  { id: 2, filename: 'src/app.ts', label: 'app.ts' },
];

test('deleting a file removes it from the syntax index and breaks wires from it', async () => {
  const ctx = setup({ files: { 'src/utils.ts': UTILS_TS, 'src/app.ts': APP_TS }, pieces: PIECES });
  const edgeId = indexProject(ctx.domain, '/proj');
  assert.equal(ctx.domain.selectors.getSyntaxEdge(edgeId).status, 'resolved');

  const result = await ctx.manager.deleteFile('src/utils.ts');

  assert.equal(result.success, true);
  assert.equal(ctx.domain.selectors.getFileStatus('/proj/src/utils.ts'), undefined, 'no longer indexed');
  assert.deepEqual(ctx.domain.selectors.getDefinitionsForFile('/proj/src/utils.ts'), []);
  assert.equal(ctx.domain.selectors.getSyntaxEdge(edgeId).status, 'broken');
});

test('moving a file re-indexes it at the new path and nothing at the old one', async () => {
  const ctx = setup({ files: { 'src/utils.ts': UTILS_TS, 'src/app.ts': APP_TS }, pieces: PIECES });
  const edgeId = indexProject(ctx.domain, '/proj');

  const result = await ctx.manager.moveFile('src/utils.ts', 'lib/utils.ts');

  assert.equal(result.success, true);
  assert.equal(ctx.domain.selectors.getFileStatus('/proj/src/utils.ts'), undefined);
  assert.equal(ctx.domain.selectors.getFileStatus('/proj/lib/utils.ts'), 'ok');
  assert.equal(ctx.domain.selectors.getFileStatus('lib/utils.ts'), undefined, 'no relative-keyed copy');
  // The importer still says './utils', which no longer resolves: broken until
  // the editor's rename rewrites it or discovery re-derives the wire.
  assert.equal(ctx.domain.selectors.getSyntaxEdge(edgeId).status, 'broken');
});

test('a Windows root reaches the same key the editor and discovery use', async () => {
  const root = 'C:\\Users\\alice\\proj';
  const ctx = setup({ root, files: { 'src/utils.ts': UTILS_TS, 'src/app.ts': APP_TS }, pieces: PIECES });
  indexProject(ctx.domain, root);

  await ctx.manager.deleteFile('src/utils.ts');

  assert.equal(ctx.domain.selectors.getFileStatus('C:/Users/alice/proj/src/utils.ts'), undefined);
});

test('writing a file updates its indexed entry and adds no relative-keyed copy', async () => {
  const ctx = setup({ files: { 'src/utils.ts': UTILS_TS, 'src/app.ts': APP_TS }, pieces: PIECES });
  indexProject(ctx.domain, '/proj');

  await ctx.manager.writeFile('src/utils.ts', 'export function helper() {}\nexport function added() {}\n');

  assert.equal(ctx.domain.selectors.getFileStatus('src/utils.ts'), undefined, 'no relative-keyed copy');
  const names = ctx.domain.selectors.getDefinitionsForFile('/proj/src/utils.ts').map((d) => d.name);
  assert.deepEqual(names.sort(), ['added', 'helper'], 'the real entry carries the new text');
});

test('materializing a never-written piece indexes it under the absolute key', async () => {
  const pieces = [{ id: 3, filename: 'draft.ts', label: 'draft.ts' }];
  const ctx = setup({ files: {}, pieces });

  const result = await ctx.manager.moveOrWriteFile('draft.ts', 'src/draft.ts', 'export const x = 1;\n');

  assert.equal(result.materialized, true);
  assert.equal(ctx.domain.selectors.getFileStatus('src/draft.ts'), undefined, 'no relative-keyed copy');
  assert.equal(ctx.domain.selectors.getFileStatus('/proj/src/draft.ts'), 'ok');
});

test('after a move, the editor\'s rename rewrites the importer and the wire resolves', async () => {
  // The order the app runs: the manager moves the file first, then the open
  // tab's model is re-acquired under its new name and the adapter renames.
  // Unregistering marks the wire broken but keeps the edge, so the rename
  // still finds it and rewrites the import; the manager has already indexed
  // the new path, so the rewritten import resolves straight away.
  const ctx = setup({ files: { 'src/utils.ts': UTILS_TS, 'src/app.ts': APP_TS }, pieces: PIECES });
  const adapter = createSyntaxAdapter({
    syntaxDomain: ctx.domain,
    projectRoot: '/proj',
    readProjectFile: async (_root, rel) => ctx.disk.get(rel) ?? null,
    writeProjectFile: async (_root, rel, text) => {
      ctx.disk.set(rel, text);
      return true;
    },
  });
  indexProject(ctx.domain, '/proj');

  await ctx.manager.moveFile('src/utils.ts', 'src/core.ts');
  await adapter.onFileRenamed('/proj/src/utils.ts', '/proj/src/core.ts');

  assert.match(ctx.disk.get('src/app.ts'), /from '\.\/core';/);
  const edge = ctx.domain.selectors.getSyntaxEdgeForPair('/proj/src/core.ts', '/proj/src/app.ts');
  assert.equal(edge?.status, 'resolved');
});

// ---------------------------------------------------------------------------
// Codex review F5 (2026-10-01): moving a file that is OPEN with unsaved edits.
// The manager re-indexes the new path from disk; the editor's rename moved
// the model but never re-registered its text, so the unsaved definitions
// vanished from the index — whichever of the two landed first.
// ---------------------------------------------------------------------------

function deferredDisk(ctx) {
  const pending = [];
  const original = ctx.disk;
  return {
    pending,
    read: async (_root, path) => new Promise((resolve) => pending.push(() => resolve(original.get(path) ?? null))),
  };
}

for (const order of ['rename-then-read', 'read-then-rename']) {
  test(`moving an open file with unsaved edits keeps the buffer indexed (${order})`, async () => {
    const saved = 'export const saved = 1;\n';
    const unsaved = 'export const saved = 1;\nexport const unsaved = 2;\n';
    const domain = createSyntaxDomain();
    const disk = new Map(Object.entries({ 'src/utils.ts': saved }));
    const pieces = [{ id: 1, filename: 'src/utils.ts', label: 'utils.ts' }];
    const ctx = { disk };
    const slow = deferredDisk(ctx);
    const manager = createFilesystemWriteManager({
      moveProjectPath: async (_root, from, to) => { disk.set(to, disk.get(from)); disk.delete(from); return true; },
      writeProjectFile: async (_root, path, contents) => { disk.set(path, contents); return true; },
      deleteProjectPath: async () => true,
      removeEmptyDirectory: async () => true,
      createProjectDirectory: async () => true,
      readProjectFile: slow.read,
      getRootPath: () => '/proj',
      getPiecesById: () => new Map(pieces.map((p) => [p.id, p])),
      getPiecesByFilename: () => new Map(pieces.map((p) => [p.filename, p])),
      getPieces: () => pieces,
      getGroups: () => [],
      getGroupByPieceId: () => new Map(),
      getGroupDomain: () => null,
      updatePieceFilenames: () => {},
      deletePieces: () => {},
      updateTabFilename: () => {},
      closeTab: () => {},
      removePiecesFromGroups: () => {},
      removeConnectionsForPieces: () => {},
      unregisterFile: domain.commands.unregisterFile,
      notifyFileChanged: domain.commands.notifyFileChanged,
      registerFileIfAbsent: domain.commands.registerFileIfAbsent,
      bumpScaffoldRefresh: () => {},
      normalizePath,
      getBasename,
    });
    const adapter = createSyntaxAdapter({
      syntaxDomain: domain,
      projectRoot: '/proj',
      readProjectFile: async (_root, rel) => disk.get(rel) ?? null,
      writeProjectFile: async (_root, rel, text) => { disk.set(rel, text); return true; },
    });
    const model = { getValue: () => unsaved, getLineCount: () => 3, getLineMaxColumn: () => 1, pushEditOperations: () => {} };
    adapter.onFileOpened('/proj/src/utils.ts', unsaved, model);

    const moving = manager.moveFile('src/utils.ts', 'src/core.ts');
    // Let the manager reach its disk read of the new path.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (order === 'rename-then-read') {
      await adapter.onFileRenamed('/proj/src/utils.ts', '/proj/src/core.ts');
      while (slow.pending.length) slow.pending.shift()();
      await moving;
    } else {
      while (slow.pending.length) slow.pending.shift()();
      await moving;
      await adapter.onFileRenamed('/proj/src/utils.ts', '/proj/src/core.ts');
    }

    const names = domain.selectors.getDefinitionsForFile('/proj/src/core.ts').map((d) => d.name).sort();
    assert.deepEqual(names, ['saved', 'unsaved']);
  });
}

// ---------------------------------------------------------------------------
// P4 (owner ruling 2026-10-01): stale entries the syntax index kept after
// deletes and moves. The graph query reads this index, so a deleted file must
// not stay "indexed and ok", and an edge must not outlive its importer.
// ---------------------------------------------------------------------------

test('deleting a file that is not on the canvas removes it from the index too', async () => {
  const ctx = setup({ files: { 'src/utils.ts': UTILS_TS, 'src/app.ts': APP_TS }, pieces: [] });
  const edgeId = indexProject(ctx.domain, '/proj');

  await ctx.manager.deleteFile('src/utils.ts');

  assert.equal(ctx.domain.selectors.getFileStatus('/proj/src/utils.ts'), undefined, 'no longer indexed');
  assert.equal(ctx.domain.selectors.getSyntaxEdge(edgeId).status, 'broken', 'its importer\'s import is broken');
});

test('deleting a folder forgets every indexed file under it, on the canvas or not', async () => {
  const ctx = setup({
    files: { 'src/utils.ts': UTILS_TS, 'src/app.ts': APP_TS, 'srcx/keep.ts': UTILS_TS },
    pieces: [{ id: 2, filename: 'src/app.ts', label: 'app.ts' }],
  });
  indexProject(ctx.domain, '/proj');
  ctx.domain.commands.registerFile('/proj/srcx/keep.ts', UTILS_TS);

  await ctx.manager.deleteFolder('src');

  assert.equal(ctx.domain.selectors.getFileStatus('/proj/src/utils.ts'), undefined);
  assert.equal(ctx.domain.selectors.getFileStatus('/proj/src/app.ts'), undefined);
  assert.equal(ctx.domain.selectors.getFileStatus('/proj/srcx/keep.ts'), 'ok', 'a sibling with a shared prefix is untouched');
});

test('moving a file that is not on the canvas re-keys it in the index', async () => {
  const ctx = setup({ files: { 'src/utils.ts': UTILS_TS, 'src/app.ts': APP_TS }, pieces: [] });
  indexProject(ctx.domain, '/proj');

  await ctx.manager.moveFile('src/utils.ts', 'lib/utils.ts');

  assert.equal(ctx.domain.selectors.getFileStatus('/proj/src/utils.ts'), undefined, 'nothing at the old path');
  assert.equal(ctx.domain.selectors.getFileStatus('/proj/lib/utils.ts'), 'ok', 'indexed at the new path');
});

test('deleting an importer removes its edges and their wire links', async () => {
  const ctx = setup({ files: { 'src/utils.ts': UTILS_TS, 'src/app.ts': APP_TS }, pieces: PIECES });
  const edgeId = indexProject(ctx.domain, '/proj');
  assert.equal(ctx.domain.selectors.getEdgeIdForConnection('conn_1'), edgeId);

  await ctx.manager.deleteFile('src/app.ts');

  assert.equal(ctx.domain.selectors.getSyntaxEdge(edgeId), null, 'the import is gone with its file');
  assert.equal(ctx.domain.selectors.getEdgeIdForConnection('conn_1'), null, 'no link to a wire that was removed');
  assert.deepEqual(ctx.domain.selectors.getEdgesForFile('/proj/src/utils.ts'), [], 'the exporter keeps no edge to it');
});

test('deleting an exporter on the canvas breaks the edge and drops the removed wire\'s link', async () => {
  const ctx = setup({ files: { 'src/utils.ts': UTILS_TS, 'src/app.ts': APP_TS }, pieces: PIECES });
  const edgeId = indexProject(ctx.domain, '/proj');

  await ctx.manager.deleteFile('src/utils.ts');

  const edge = ctx.domain.selectors.getSyntaxEdge(edgeId);
  assert.equal(edge.status, 'broken', 'the importer still imports it: a real, broken import');
  assert.equal(ctx.domain.selectors.getEdgeIdForConnection('conn_1'), null, 'the wire went with the piece');
  assert.deepEqual(edge.connectionIds, []);
});
