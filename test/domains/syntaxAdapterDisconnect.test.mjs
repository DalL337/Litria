import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { createSyntaxAdapter } from '../../src/lsp/syntaxAdapter.js';

// ---------------------------------------------------------------------------
// Edge deletion is STATE-ONLY for every language (owner decision 2026-07-17,
// brief-python-wires S3): deleting a wire never edits code. The import stays;
// discovery re-derives the wire on the next open; removing the relationship
// permanently means removing the import in the editor.
// ---------------------------------------------------------------------------

function setupAdapter(diskFiles) {
  const domain = createSyntaxDomain();
  const disk = new Map(Object.entries(diskFiles));
  const writes = [];
  const adapter = createSyntaxAdapter({
    syntaxDomain: domain,
    projectRoot: '/proj',
    readProjectFile: async (_root, rel) => disk.get(rel) ?? null,
    writeProjectFile: async (_root, rel, text) => {
      writes.push(rel);
      disk.set(rel, text);
    },
  });
  for (const [rel, text] of disk) {
    domain.commands.registerFile(`/proj/${rel}`, text);
  }
  return { domain, adapter, disk, writes };
}

test('JS edge deletion writes nothing and leaves the generated import in place', async () => {
  const { domain, adapter, disk, writes } = setupAdapter({
    'src/utils.js': 'export function helper() {}\n',
    'src/app.js': 'helper();\n',
  });

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
  assert.ok(disk.get('src/app.js').includes('helper'), 'resolve wrote the import');

  const writesBeforeDisconnect = writes.length;
  const result = await adapter.handleDisconnect({ connectionId: 'conn-1' });

  assert.equal(result.success, true);
  assert.equal(result.patchApplied, false);
  assert.equal(writes.length, writesBeforeDisconnect, 'disconnect performed zero writes');
  assert.ok(
    disk.get('src/app.js').includes("import { helper } from './utils'"),
    'the import line survives edge deletion'
  );
  assert.equal(domain.selectors.getSyntaxConnection('conn-1'), null, 'connection gone from state');
  assert.equal(
    domain.selectors.getSyntaxEdgeForPair('/proj/src/utils.js', '/proj/src/app.js'),
    null,
    'edge gone from state'
  );
});

test('python edge deletion is equally state-only', async () => {
  const { domain, adapter, disk, writes } = setupAdapter({
    'oAuth.py': 'def shout(): ...\n',
    'main/main.py': 'from oAuth import shout\n',
  });

  const connectResult = await adapter.handleConnect({
    connectionId: 'conn-py',
    sourceFilePath: '/proj/oAuth.py',
    targetFilePath: '/proj/main/main.py',
  });
  assert.equal(connectResult.success, true);

  const writesBefore = writes.length;
  const result = await adapter.handleDisconnect({ connectionId: 'conn-py' });

  assert.equal(result.success, true);
  assert.equal(writes.length, writesBefore);
  assert.equal(disk.get('main/main.py'), 'from oAuth import shout\n', 'python file byte-identical');
  assert.equal(domain.selectors.getSyntaxConnection('conn-py'), null);
});
