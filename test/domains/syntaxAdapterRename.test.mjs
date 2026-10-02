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
      // The real writer resolves true on success / false on failure
      // (src/project/storage.js). Returning nothing modelled a FAILING write,
      // which went unnoticed while `writeResultText` discarded the result
      // (ADR-032 D3).
      return true;
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

test('rewriteImportSpec finds the import extension-tolerantly, rewrites only its path, and misses cleanly', () => {
  const domain = createSyntaxDomain();
  const rewrite = (text, matchSpec, newSpec = './util-belt') => domain.commands.rewriteImportSpec({ text, matchSpec, newSpec });
  const text = "// header\nimport { a } from './other';\nimport { helper } from './utils.js';\n";
  assert.equal(rewrite(text, './utils'), "// header\nimport { a } from './other';\nimport { helper } from './util-belt.js';\n");
  assert.equal(rewrite(text, './missing'), null);
  assert.equal(rewrite(null, './utils'), null);
  assert.equal(rewrite(text, ''), null);
  // A string equal to the path elsewhere in the statement is not touched.
  assert.equal(
    rewrite("import { /* './utils' */ helper } from `./utils`;\n", './utils'),
    "import { /* './utils' */ helper } from `./util-belt`;\n"
  );
});

// ---------------------------------------------------------------------------
// Symbol ids embed the defining file's path (`${filePath}::${name}`). A rename
// re-pointed the edge but kept the old ids, so nothing the moved file defines
// matched them again: its next edit turned the wire broken, and the picker
// offered a symbol already on the edge as new (2026-10-01, found while fixing
// P4 gate item 5).
// ---------------------------------------------------------------------------

test('a renamed file keeps its wires resolved through its next edit', async () => {
  const { domain, adapter } = setupAdapter({
    'src/utils.js': 'export function helper() {}\n',
    'src/app.js': 'helper();\n',
  });
  await connectAndResolve(domain, adapter);

  await adapter.onFileRenamed('/proj/src/utils.js', '/proj/src/util-belt.js');
  adapter.onFileChanged('/proj/src/util-belt.js', 'export function helper() {}\n// edited\n');

  const edge = domain.selectors.getSyntaxEdgeForPair('/proj/src/util-belt.js', '/proj/src/app.js');
  assert.equal(edge.status, 'resolved');
  assert.deepEqual(edge.symbols.map((s) => s.symbolId), ['/proj/src/util-belt.js::helper']);
});

test('after a rename, a symbol already on the edge is not offered again', async () => {
  const { domain, adapter } = setupAdapter({
    'src/utils.js': 'export function helper() {}\nexport function other() {}\n',
    'src/app.js': 'helper();\n',
  });
  await connectAndResolve(domain, adapter);

  await adapter.onFileRenamed('/proj/src/utils.js', '/proj/src/util-belt.js');

  const edge = domain.selectors.getSyntaxEdgeForPair('/proj/src/util-belt.js', '/proj/src/app.js');
  const offered = domain.selectors
    .getAvailableSymbolsForEdge('/proj/src/util-belt.js', edge.edgeId)
    .map((s) => s.name);
  assert.deepEqual(offered, ['other']);
});

// ---------------------------------------------------------------------------
// P4 (owner ruling 2026-10-01): a rename rewrote only the FIRST line of the
// import it found (the statement's start line) with an import rebuilt from
// the edge's symbols. A multi-line import kept its old closing lines (a
// syntax error, written to disk for a closed file), and anything the edge
// does not track — an alias, an extra name, the file's quote and extension
// style, or a discovered edge's whole import list — was replaced. A rename
// changes where the module lives, so only the module path may change.
// ---------------------------------------------------------------------------

async function renameWith(appText, { resolve = true, discovered = false } = {}) {
  const { domain, adapter, disk } = setupAdapter({
    'src/utils.js': 'export function helper() {}\nexport function other() {}\nexport const extra = 1;\n',
    'src/app.js': discovered ? appText : 'helper();\n',
  });
  if (discovered) {
    domain.commands.connectDiscovered({
      connectionId: 'conn-1',
      sourceFilePath: '/proj/src/utils.js',
      targetFilePath: '/proj/src/app.js',
      moduleSpecifier: './utils',
      importLine: 0,
    });
  } else {
    if (resolve) await connectAndResolve(domain, adapter);
    disk.set('src/app.js', appText);
    adapter.onFileChanged('/proj/src/app.js', appText);
  }
  await adapter.onFileRenamed('/proj/src/utils.js', '/proj/src/util-belt.js');
  return disk.get('src/app.js');
}

test('a multi-line import is renamed whole: only its module path changes', async () => {
  const before = "import {\n  helper,\n  other,\n} from './utils';\nhelper(); other();\n";
  const after = await renameWith(before);
  assert.equal(after, "import {\n  helper,\n  other,\n} from './util-belt';\nhelper(); other();\n");
});

test('a rename keeps aliases and names the edge does not track', async () => {
  const after = await renameWith("import { helper as h, extra } from './utils';\nh(extra);\n");
  assert.equal(after, "import { helper as h, extra } from './util-belt';\nh(extra);\n");
});

test('a rename keeps the import\'s quote and extension style', async () => {
  const after = await renameWith('import { helper } from "./utils.js";\nhelper();\n');
  assert.equal(after, 'import { helper } from "./util-belt.js";\nhelper();\n');
});

test('a discovered import keeps its names through a rename (no TODO stub)', async () => {
  const before = "import { helper, other } from './utils';\nhelper(); other();\n";
  const after = await renameWith(before, { discovered: true });
  assert.equal(after, "import { helper, other } from './util-belt';\nhelper(); other();\n");
});
