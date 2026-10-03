import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { createSyntaxAdapter } from '../../src/lsp/syntaxAdapter.js';

// ---------------------------------------------------------------------------
// The syntax index follows DISK, not open tabs (implementation policy Rule 7
// "State Follows Disk"). Closing an editor tab for a file still on disk must
// not drop it from the index or mark its outgoing edges broken: discovery has
// not changed anything, the file is right there on disk. Only a file that
// cannot be read is unregistered.
// ---------------------------------------------------------------------------

function setupAdapter(diskFiles, { readProjectFile } = {}) {
  const domain = createSyntaxDomain();
  const disk = new Map(Object.entries(diskFiles));
  const writes = [];
  const adapter = createSyntaxAdapter({
    syntaxDomain: domain,
    projectRoot: '/proj',
    readProjectFile: readProjectFile ?? (async (_root, rel) => disk.get(rel) ?? null),
    writeProjectFile: async (_root, rel, text) => {
      writes.push(rel);
      disk.set(rel, text);
      return true;
    },
  });
  for (const [rel, text] of disk) {
    domain.commands.registerFile(`/proj/${rel}`, text);
  }
  return { domain, adapter, disk, writes };
}

/** Minimal Monaco model stand-in: only getValue is read by the close path. */
function fakeModel(text) {
  return { getValue: () => text };
}

// Build a resolved edge utils.js (exporter) → app.js (importer).
async function withResolvedEdge(setup) {
  const { domain, adapter } = setup;
  const connectResult = await adapter.handleConnect({
    connectionId: 'conn-1',
    sourceFilePath: '/proj/src/utils.js',
    targetFilePath: '/proj/src/app.js',
  });
  assert.equal(connectResult.success, true);
  const helperId = domain.selectors
    .getDefinitionsForFile('/proj/src/utils.js')
    .find((d) => d.name === 'helper').symbolId;
  await adapter.handleResolveMultipleSymbols({
    edgeId: connectResult.edgeId,
    symbolIds: [helperId],
  });
  return connectResult.edgeId;
}

test('closing the tab of a file still on disk keeps it indexed and its edge not broken', async () => {
  const setup = setupAdapter({
    'src/utils.js': 'export function helper() {}\n',
    'src/app.js': "import { helper } from './utils';\nhelper();\n",
  });
  const { domain, adapter } = setup;
  const edgeId = await withResolvedEdge(setup);

  // Exporter tab is open, then the user closes it. The file is still on disk.
  adapter.onFileOpened('/proj/src/utils.js', 'export function helper() {}\n');
  await adapter.onFileClosed('/proj/src/utils.js');

  // The index still holds the file's definitions...
  assert.ok(
    domain.selectors.getDefinitionsForFile('/proj/src/utils.js').some((d) => d.name === 'helper'),
    'definitions survive the close (reproduction: today they are dropped)'
  );
  // ...and its outgoing edge is not marked broken.
  assert.notEqual(
    domain.selectors.getSyntaxEdge(edgeId).status,
    'broken',
    'the edge is not broken by the close (reproduction: today it is)'
  );
});

test('a close discards unsaved edits — the index holds disk text, not the buffer', async () => {
  const setup = setupAdapter({
    'src/utils.js': 'export function helper() {}\n',
  });
  const { domain, adapter } = setup;

  // Open with a dirty buffer that adds an unsaved export the disk lacks.
  const dirty = 'export function helper() {}\nexport function unsaved() {}\n';
  adapter.onFileOpened('/proj/src/utils.js', dirty, fakeModel(dirty));
  domain.commands.notifyFileChanged('/proj/src/utils.js', dirty);
  assert.ok(
    domain.selectors.getDefinitionsForFile('/proj/src/utils.js').some((d) => d.name === 'unsaved'),
    'the dirty buffer symbol is indexed while open'
  );

  await adapter.onFileClosed('/proj/src/utils.js');

  const names = domain.selectors.getDefinitionsForFile('/proj/src/utils.js').map((d) => d.name);
  assert.ok(names.includes('helper'), 'disk symbol survives');
  assert.ok(!names.includes('unsaved'), 'discarded unsaved edit does not survive in the index');
});

test('a file missing from disk is unregistered on close', async () => {
  // Registered in the domain but absent from the disk map.
  const setup = setupAdapter({});
  const { domain, adapter } = setup;
  domain.commands.registerFile('/proj/src/ghost.js', 'export function gone() {}\n');
  assert.ok(domain.selectors.getDefinitionsForFile('/proj/src/ghost.js').length > 0);

  await adapter.onFileClosed('/proj/src/ghost.js');

  assert.equal(
    domain.selectors.getDefinitionsForFile('/proj/src/ghost.js').length,
    0,
    'a file gone from disk is unregistered (today\'s behavior)'
  );
});

test('a reopen during the disk read wins: stale disk text does not overwrite the model', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // The disk holds the OLD text; the read is held open on the gate.
  const disk = new Map([['src/utils.js', 'export function old() {}\n']]);
  const setup = setupAdapter(
    { 'src/utils.js': 'export function old() {}\n' },
    {
      readProjectFile: async (_root, rel) => {
        await gate;
        return disk.get(rel) ?? null;
      },
    },
  );
  const { domain, adapter } = setup;

  // Close starts the (gated) disk read.
  const closing = adapter.onFileClosed('/proj/src/utils.js');

  // Before the read resolves, the user reopens the file with NEW text.
  const fresh = 'export function fresh() {}\n';
  adapter.onFileOpened('/proj/src/utils.js', fresh, fakeModel(fresh));
  domain.commands.notifyFileChanged('/proj/src/utils.js', fresh);

  // Now let the stale disk read complete.
  release();
  await closing;

  const names = domain.selectors.getDefinitionsForFile('/proj/src/utils.js').map((d) => d.name);
  assert.ok(names.includes('fresh'), 'the reopened model text wins');
  assert.ok(!names.includes('old'), 'the stale disk text did not overwrite the reopened model');
});

// ---------------------------------------------------------------------------
// A close's disk read finishes later, and anything that changed the file's
// index entry meanwhile wins over it (first review, 2026-10-03: F1 project
// switch, F2 repeated close, F3 rename/delete; plus writes and same-root
// reloads). Every read below is held on its own gate and released in the
// order the race needs.
// ---------------------------------------------------------------------------

const UTILS = '/proj/src/utils.js';
const OLD = 'export function old() {}\n';
const FRESH = 'export function fresh() {}\n';

/** Disk reads that wait until the test releases them, one gate per read, in call order. */
function gatedReads() {
  const gates = [];
  return {
    readProjectFile: () => new Promise((resolve) => gates.push(resolve)),
    release: (index, text) => gates[index](text),
    get count() { return gates.length; },
  };
}

function setupRace() {
  const reads = gatedReads();
  const setup = setupAdapter({ 'src/utils.js': OLD }, { readProjectFile: reads.readProjectFile });
  return { ...setup, reads };
}

const names = (domain, path = UTILS) => domain.selectors.getDefinitionsForFile(path).map((d) => d.name);

test('a project reset during the disk read leaves the old path unindexed (F1)', async () => {
  const { domain, adapter, reads } = setupRace();
  const closing = adapter.onFileClosed(UTILS);
  domain.commands.reset();
  reads.release(0, OLD);
  await closing;
  assert.deepEqual(domain.selectors.getRegisteredFilesUnder('/proj'), []);
});

test('a close after the index was reset adds nothing (F1, reset first)', async () => {
  const { domain, adapter, reads } = setupRace();
  domain.commands.reset();
  const closing = adapter.onFileClosed(UTILS);
  if (reads.count) reads.release(0, OLD);
  await closing;
  assert.deepEqual(domain.selectors.getRegisteredFilesUnder('/proj'), []);
});

test('an older close loses to a newer close of the same file, stale text or stale failure (F2)', async () => {
  for (const stale of [OLD, null]) {
    const { domain, adapter, reads } = setupRace();
    const first = adapter.onFileClosed(UTILS);
    adapter.onFileOpened(UTILS, FRESH, fakeModel(FRESH));
    const second = adapter.onFileClosed(UTILS);
    reads.release(1, FRESH);
    await second;
    reads.release(0, stale);
    await first;
    assert.deepEqual(names(domain), ['fresh'], `stale read returning ${stale === null ? 'null' : 'old text'}`);
  }
});

test('a reopen without a model during the read wins (F2, optional-model form)', async () => {
  const { domain, adapter, reads } = setupRace();
  const closing = adapter.onFileClosed(UTILS);
  adapter.onFileOpened(UTILS, FRESH);
  reads.release(0, OLD);
  await closing;
  assert.deepEqual(names(domain), ['fresh']);
});

test('a rename during the read leaves only the new path (F3)', async () => {
  const { domain, adapter, reads } = setupRace();
  const closing = adapter.onFileClosed(UTILS);
  await adapter.onFileRenamed(UTILS, '/proj/src/renamed.js');
  reads.release(0, OLD);
  await closing;
  assert.deepEqual(domain.selectors.getRegisteredFilesUnder('/proj'), ['/proj/src/renamed.js']);
});

test('a delete during the read keeps the path forgotten (F3)', async () => {
  const { domain, adapter, reads } = setupRace();
  const closing = adapter.onFileClosed(UTILS);
  domain.commands.forgetFile(UTILS);
  reads.release(0, OLD);
  await closing;
  assert.deepEqual(domain.selectors.getRegisteredFilesUnder('/proj'), []);
});

test('a write that re-indexes the file during the read wins', async () => {
  const { domain, adapter, reads } = setupRace();
  const closing = adapter.onFileClosed(UTILS);
  domain.commands.notifyFileChanged(UTILS, 'export function written() {}\n');
  reads.release(0, OLD);
  await closing;
  assert.deepEqual(names(domain), ['written']);
});

// Second review (2026-10-03): comparing the indexed text was blind to an entry
// that changed and came back identical. Each change below leaves the index
// holding the text the close saw; the late read must still lose, whether it
// returns stale disk text or fails.
const CURRENT = 'export function current() {}\n';
const STALE = 'export function stale() {}\n';
const IDENTICAL_CHANGES = {
  'a reset and identical re-registration': (domain) => {
    domain.commands.reset();
    domain.commands.registerFile(UTILS, CURRENT);
  },
  'a same-text write': (domain) => domain.commands.notifyFileChanged(UTILS, CURRENT),
  'a delete and identical recreation': (domain) => {
    domain.commands.forgetFile(UTILS);
    domain.commands.registerFile(UTILS, CURRENT);
  },
  'a rename away and back': (domain) => {
    domain.commands.renameFile(UTILS, '/proj/src/moved.js');
    domain.commands.renameFile('/proj/src/moved.js', UTILS);
  },
};

for (const [change, apply] of Object.entries(IDENTICAL_CHANGES)) {
  test(`a late close read loses after ${change}, stale text or failure (second review)`, async () => {
    for (const late of [STALE, null]) {
      const reads = gatedReads();
      const { domain, adapter } = setupAdapter({ 'src/utils.js': CURRENT }, { readProjectFile: reads.readProjectFile });
      const closing = adapter.onFileClosed(UTILS);
      apply(domain);
      reads.release(0, late);
      await closing;
      assert.deepEqual(names(domain), ['current'], `late read ${late === null ? 'failed' : 'returned stale text'}`);
    }
  });
}

// Third review (2026-10-03): two closes of the same path with no reopen
// between them. The newer close's read must win whichever read finishes
// first, also when the newer close comes through a replacement adapter.
test('a newer close wins over an older one whichever read finishes first (third review)', async () => {
  for (const replacement of [false, true]) {
    for (const olderFirst of [true, false]) {
      for (const older of [STALE, null]) {
        const { domain, adapter, reads } = setupRace();
        const other = replacement
          ? createSyntaxAdapter({ syntaxDomain: domain, projectRoot: '/proj', readProjectFile: reads.readProjectFile })
          : adapter;
        const first = adapter.onFileClosed(UTILS);
        const second = other.onFileClosed(UTILS);
        const finish = async (index, text, closing) => { reads.release(index, text); await closing; };
        if (olderFirst) {
          await finish(0, older, first);
          await finish(1, FRESH, second);
        } else {
          await finish(1, FRESH, second);
          await finish(0, older, first);
        }
        assert.deepEqual(names(domain), ['fresh'],
          `${replacement ? 'replacement adapter, ' : ''}${olderFirst ? 'older' : 'newer'} read first, older read ${older === null ? 'failed' : 'stale'}`);
      }
    }
  }
});

test('a same-root reload that re-indexes the file during the read keeps the newer text', async () => {
  const { domain, adapter, reads } = setupRace();
  const closing = adapter.onFileClosed(UTILS);
  domain.commands.reset();
  domain.commands.registerFile(UTILS, 'export function reloaded() {}\n');
  reads.release(0, OLD);
  await closing;
  assert.deepEqual(names(domain), ['reloaded']);
});
