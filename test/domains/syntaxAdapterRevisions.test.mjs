import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { createSyntaxAdapter } from '../../src/lsp/syntaxAdapter.js';
import { bufferRevision } from '../../src/app/projectApiBridge.js';

// P4c (2026-10-03): every path that registers text in SyntaxDomain supplies
// its revision. Editor text carries the JS buffer revision (the same function
// the owner bridge reports for a session document); disk text carries the disk
// revision Rust mints, obtained through the revision-returning read.

function setup(diskFiles = {}) {
  const domain = createSyntaxDomain();
  const disk = new Map(Object.entries(diskFiles));
  const revisions = new Map(); // rel -> disk revision, bumped on each write
  let counter = 0;
  const diskRevisionFor = (rel) => {
    if (!revisions.has(rel)) revisions.set(rel, `d1-${counter++}`);
    return revisions.get(rel);
  };
  const adapter = createSyntaxAdapter({
    syntaxDomain: domain,
    projectRoot: '/proj',
    readProjectFile: async (_root, rel) => (disk.has(rel) ? disk.get(rel) : null),
    readProjectFileWithRevision: async (_root, rel) =>
      disk.has(rel) ? { text: disk.get(rel), revision: diskRevisionFor(rel) } : null,
    writeProjectFile: async (_root, rel, text) => {
      disk.set(rel, text);
      revisions.set(rel, `d1-${counter++}`); // a write changes the bytes → new revision
      return true;
    },
  });
  return { domain, adapter, disk, diskRevisionFor };
}

test('onFileOpened registers editor text with the buffer revision the bridge reports', () => {
  const { domain, adapter } = setup();
  const text = 'export const a = 1;\n';
  adapter.onFileOpened('/proj/src/a.js', text, { getValue: () => text });
  assert.deepEqual(domain.selectors.getParsedRevision('/proj/src/a.js'), {
    source: 'editor',
    revision: bufferRevision(text),
  });
});

test('onFileChanged updates the editor buffer revision', () => {
  const { domain, adapter } = setup();
  adapter.onFileOpened('/proj/src/a.js', 'v1\n', { getValue: () => 'v1\n' });
  adapter.onFileChanged('/proj/src/a.js', 'v2\n');
  assert.deepEqual(domain.selectors.getParsedRevision('/proj/src/a.js'), {
    source: 'editor',
    revision: bufferRevision('v2\n'),
  });
});

test('closing a tab re-indexes from disk with the disk revision', async () => {
  const { domain, adapter, diskRevisionFor } = setup({ 'src/a.js': 'export const a = 1;\n' });
  // Open it (editor revision), then close it (disk re-index).
  adapter.onFileOpened('/proj/src/a.js', 'export const a = 1;\n', { getValue: () => 'export const a = 1;\n' });
  await adapter.onFileClosed('/proj/src/a.js');
  const parsed = domain.selectors.getParsedRevision('/proj/src/a.js');
  assert.equal(parsed.source, 'disk');
  assert.equal(parsed.revision, diskRevisionFor('src/a.js'));
});

test('a closed-file write records the disk revision Rust reports for the bytes written', async () => {
  const { domain, adapter } = setup({ 'src/a.js': 'old\n' });
  const before = domain.selectors.getParsedRevision('/proj/src/a.js'); // null (registered without one)
  assert.equal(before, null);
  const ok = await adapter.writeResultText('/proj/src/a.js', 'new\n');
  assert.equal(ok, true);
  const parsed = domain.selectors.getParsedRevision('/proj/src/a.js');
  assert.equal(parsed.source, 'disk');
  assert.match(parsed.revision, /^d1-/);
});

test('an editor-backed write records the editor revision of the new text', async () => {
  const { domain, adapter } = setup();
  let modelText = 'v1\n';
  const model = {
    getValue: () => modelText,
    getLineCount: () => modelText.split('\n').length,
    getLineMaxColumn: () => 1,
    pushEditOperations: (_a, [edit]) => { modelText = edit.text; },
  };
  adapter.onFileOpened('/proj/src/a.js', 'v1\n', model);
  await adapter.writeResultText('/proj/src/a.js', 'v2\n');
  assert.deepEqual(domain.selectors.getParsedRevision('/proj/src/a.js'), {
    source: 'editor',
    revision: bufferRevision('v2\n'),
  });
});
