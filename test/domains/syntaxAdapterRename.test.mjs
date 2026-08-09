import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { createSyntaxAdapter } from '../../src/lsp/syntaxAdapter.js';

// ---------------------------------------------------------------------------
// Rename patch plans carry the edge.importLine recorded when the import was
// written. That line number goes stale as soon as the user edits lines above
// the import; a blind lines[line] replace then overwrites arbitrary code —
// the JS twin of the 2026-07-17 python line-0 corruption (PR #153). The
// adapter must locate the import by its pre-rename spec at apply time and
// fail closed when it is gone.
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

async function connectAndResolve(domain, adapter) {
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
}

test('rename rewrites the import where it actually lives, not at the stale stored line', async () => {
  const { domain, adapter, disk } = setupAdapter({
    'src/utils.js': 'export function helper() {}\n',
    'src/app.js': 'helper();\n',
  });
  await connectAndResolve(domain, adapter);
  assert.ok(disk.get('src/app.js').startsWith('import { helper }'), 'import written at line 0');

  // User edits the buffer: two lines land ABOVE the import. The stored
  // edge.importLine (0) is now stale — the import really lives on line 2.
  const edited = `// app entry\n// (c) alice\n${disk.get('src/app.js')}`;
  disk.set('src/app.js', edited);
  adapter.onFileChanged('/proj/src/app.js', edited);

  await adapter.onFileRenamed('/proj/src/utils.js', '/proj/src/util-belt.js');

  const lines = disk.get('src/app.js').split('\n');
  assert.equal(lines[0], '// app entry', 'user line 0 untouched');
  assert.equal(lines[1], '// (c) alice', 'user line 1 untouched');
  assert.ok(lines[2].includes("from './util-belt'"), 'import rewritten in place');
  assert.ok(!disk.get('src/app.js').includes("'./utils'"), 'no stale duplicate import left behind');
});

test('rename fails closed when the user already deleted the import', async () => {
  const { domain, adapter, disk } = setupAdapter({
    'src/utils.js': 'export function helper() {}\n',
    'src/app.js': 'helper();\n',
  });
  await connectAndResolve(domain, adapter);

  // User deletes the generated import entirely — nothing left to rewrite.
  const edited = 'helper();\n';
  disk.set('src/app.js', edited);
  adapter.onFileChanged('/proj/src/app.js', edited);

  await adapter.onFileRenamed('/proj/src/utils.js', '/proj/src/util-belt.js');

  assert.equal(disk.get('src/app.js'), edited, 'no write when the import is gone');
});

test('computeImportLineForSpec locates extension-tolerant matches and misses cleanly', () => {
  const domain = createSyntaxDomain();
  const text = "// header\nimport { a } from './other';\nimport { helper } from './utils.js';\n";
  assert.equal(domain.commands.computeImportLineForSpec({ text, spec: './utils' }), 2);
  assert.equal(domain.commands.computeImportLineForSpec({ text, spec: './missing' }), null);
  assert.equal(domain.commands.computeImportLineForSpec({ text: null, spec: './utils' }), null);
  assert.equal(domain.commands.computeImportLineForSpec({ text, spec: '' }), null);
});
