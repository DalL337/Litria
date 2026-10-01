import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { createSyntaxAdapter } from '../../src/lsp/syntaxAdapter.js';

// ---------------------------------------------------------------------------
// An edit only ever puts a language's syntax into a file of that language
// (P4 gate item 4, .research/2026-10-01-syntax-write-gates.md). The write
// gates used to read the TARGET file alone, so a wire between a .py and a .ts
// file wrote JS into Python, or Python naming a .ts module; and the JS resolve
// path had no target check at all, so a Markdown target got a JS import.
// ---------------------------------------------------------------------------

const ROOT = '/proj';

function setup(diskFiles) {
  const domain = createSyntaxDomain();
  const disk = new Map(Object.entries(diskFiles));
  const writes = [];
  const adapter = createSyntaxAdapter({
    syntaxDomain: domain,
    projectRoot: ROOT,
    readProjectFile: async (_root, rel) => disk.get(rel) ?? null,
    writeProjectFile: async (_root, rel, text) => {
      writes.push(rel);
      disk.set(rel, text);
      return true;
    },
  });
  for (const [rel, text] of disk) {
    domain.commands.registerFile(`${ROOT}/${rel}`, text);
  }
  return { domain, adapter, disk, writes };
}

/** Draw a wire source → target by hand, as the canvas does. */
async function draw(ctx, source, target) {
  return ctx.adapter.handleConnect({
    connectionId: 'c1',
    sourceFilePath: `${ROOT}/${source}`,
    targetFilePath: `${ROOT}/${target}`,
  });
}

function symbolId(ctx, file, name) {
  return ctx.domain.selectors
    .getDefinitionsForFile(`${ROOT}/${file}`)
    .find((d) => d.name === name).symbolId;
}

test('drawing a wire from a .py file to a .ts file writes no JS import of the .py', async () => {
  const ctx = setup({
    'src/utils.py': 'def helper():\n    pass\n',
    'src/app.ts': 'console.log(1);\n',
  });

  const res = await draw(ctx, 'src/utils.py', 'src/app.ts');

  assert.equal(res.success, true, 'the wire still exists');
  assert.deepEqual(ctx.writes, []);
  assert.equal(ctx.disk.get('src/app.ts'), 'console.log(1);\n');
});

test('picking a Python symbol for a .ts file writes neither file', async () => {
  const ctx = setup({
    'src/utils.py': 'def helper():\n    pass\n',
    'src/app.ts': 'console.log(1);\n',
  });
  const res = await draw(ctx, 'src/utils.py', 'src/app.ts');
  ctx.writes.length = 0;

  await ctx.adapter.handleResolveMultipleSymbols({
    edgeId: res.edgeId,
    symbolIds: [symbolId(ctx, 'src/utils.py', 'helper')],
  });

  assert.deepEqual(ctx.writes, [], 'no JS export block in the .py, no import in the .ts');
  assert.equal(ctx.disk.get('src/utils.py'), 'def helper():\n    pass\n');
  assert.deepEqual(
    ctx.domain.selectors.getSyntaxEdge(res.edgeId).symbols,
    [],
    'the edge claims no import the code does not have',
  );
});

test('picking a TS symbol for a .py file writes no `from utils.ts import`', async () => {
  const ctx = setup({
    'src/utils.ts': 'export function helper() {}\n',
    'src/main.py': 'print(1)\n',
  });
  const res = await draw(ctx, 'src/utils.ts', 'src/main.py');

  await ctx.adapter.handleResolveMultipleSymbols({
    edgeId: res.edgeId,
    symbolIds: [symbolId(ctx, 'src/utils.ts', 'helper')],
  });

  assert.deepEqual(ctx.writes, []);
  assert.equal(ctx.disk.get('src/main.py'), 'print(1)\n');
});

test('picking a TS symbol for a Markdown file writes no import into the Markdown', async () => {
  const ctx = setup({
    'src/utils.ts': 'export function helper() {}\n',
    'README.md': '# Notes\n',
  });
  const res = await draw(ctx, 'src/utils.ts', 'README.md');

  await ctx.adapter.handleResolveMultipleSymbols({
    edgeId: res.edgeId,
    symbolIds: [symbolId(ctx, 'src/utils.ts', 'helper')],
  });

  assert.deepEqual(ctx.writes, []);
  assert.equal(ctx.disk.get('README.md'), '# Notes\n');
});

test('removing a symbol from a .py → .ts edge never edits the .py as JavaScript', () => {
  const domain = createSyntaxDomain();
  // A managed export block an earlier mixed-language write could have left.
  const py = 'def helper():\n    pass\n\nexport { helper };\n';
  domain.commands.registerFile(`${ROOT}/src/utils.py`, py);
  domain.commands.registerFile(`${ROOT}/src/app.ts`, 'console.log(1);\n');
  const { edgeId } = domain.commands.connect({
    connectionId: 'c1',
    sourceFilePath: `${ROOT}/src/utils.py`,
    targetFilePath: `${ROOT}/src/app.ts`,
  });
  const helperId = domain.selectors
    .getDefinitionsForFile(`${ROOT}/src/utils.py`)
    .find((d) => d.name === 'helper').symbolId;
  domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperId] });

  const res = domain.commands.computeRemoveEdits({
    edgeId,
    symbolName: 'helper',
    targetText: "import { helper } from './utils.py';\n",
    sourceText: py,
  });

  assert.deepEqual(res.edits, []);
});

test('same-language wires still write: a TS stub, and a Python import', async () => {
  const ts = setup({
    'src/utils.ts': 'export function helper() {}\n',
    'src/app.ts': 'console.log(1);\n',
  });
  await draw(ts, 'src/utils.ts', 'src/app.ts');
  assert.deepEqual(ts.writes, ['src/app.ts']);
  assert.match(ts.disk.get('src/app.ts'), /from '\.\/utils';/);

  const py = setup({
    'src/utils.py': 'def helper():\n    pass\n',
    'src/main.py': 'print(1)\n',
  });
  const res = await draw(py, 'src/utils.py', 'src/main.py');
  await py.adapter.handleResolveMultipleSymbols({
    edgeId: res.edgeId,
    symbolIds: [symbolId(py, 'src/utils.py', 'helper')],
  });
  assert.match(py.disk.get('src/main.py'), /^from utils import helper$/m);
});

// ---------------------------------------------------------------------------
// Codex review (2026-10-01). F4: JavaScript and TypeScript share the `jsts`
// edit language, but a type-only symbol can only be imported into
// TypeScript — `import { type Config }` is not JavaScript. F6: a refused
// edit must not be reported as a successful no-op ("Already imported").
// ---------------------------------------------------------------------------

const TYPES_TS = 'export const helper = 1;\nexport type Config = { key: string };\n';

for (const target of ['src/app.js', 'src/app.jsx', 'src/app.mjs', 'src/app.cjs']) {
  test(`a TypeScript type is never imported into ${target.split('.').pop()} code`, async () => {
    const ctx = setup({ 'src/types.ts': TYPES_TS, [target]: 'console.log(helper);\n' });
    const res = await draw(ctx, 'src/types.ts', target);
    ctx.writes.length = 0;

    const both = await ctx.adapter.handleResolveMultipleSymbols({
      edgeId: res.edgeId,
      symbolIds: [symbolId(ctx, 'src/types.ts', 'helper'), symbolId(ctx, 'src/types.ts', 'Config')],
    });

    const written = ctx.disk.get(target);
    assert.equal(written.includes('type '), false, `TypeScript syntax in ${target}:\n${written}`);
    assert.match(written, /\bhelper\b/, 'the value symbol is still imported');
    assert.equal(both.success, true);
    const offered = ctx.domain.selectors.getAvailableSymbolsForEdge(`${ROOT}/src/types.ts`, res.edgeId).map((s) => s.name);
    assert.equal(offered.includes('Config'), false, 'the picker does not offer a type to a JS file');
  });
}

test('a TypeScript type is still imported into a TypeScript file', async () => {
  const ctx = setup({ 'src/types.ts': TYPES_TS, 'src/app.ts': 'console.log(1);\n' });
  const res = await draw(ctx, 'src/types.ts', 'src/app.ts');
  await ctx.adapter.handleResolveMultipleSymbols({
    edgeId: res.edgeId,
    symbolIds: [symbolId(ctx, 'src/types.ts', 'helper'), symbolId(ctx, 'src/types.ts', 'Config')],
  });
  assert.match(ctx.disk.get('src/app.ts'), /type Config/);
});

test('a pick refused for its languages is reported as unsupported, not as already imported', async () => {
  const ctx = setup({ 'src/utils.py': 'def helper():\n    pass\n', 'src/app.ts': 'console.log(1);\n' });
  const res = await draw(ctx, 'src/utils.py', 'src/app.ts');
  const outcome = await ctx.adapter.handleResolveMultipleSymbols({
    edgeId: res.edgeId,
    symbolIds: [symbolId(ctx, 'src/utils.py', 'helper')],
  });
  assert.equal(outcome.status, 'unsupported');
  assert.equal(outcome.success, false);
});

test('a pick whose write fails is reported as an error, not as a no-op', async () => {
  const domain = createSyntaxDomain();
  const disk = new Map(Object.entries({ 'src/utils.ts': 'export function helper() {}\n', 'src/app.ts': 'console.log(1);\n' }));
  const adapter = createSyntaxAdapter({
    syntaxDomain: domain,
    projectRoot: ROOT,
    readProjectFile: async (_root, rel) => disk.get(rel) ?? null,
    writeProjectFile: async () => false, // every write fails
  });
  for (const [rel, text] of disk) domain.commands.registerFile(`${ROOT}/${rel}`, text);
  const res = await adapter.handleConnect({ connectionId: 'c1', sourceFilePath: `${ROOT}/src/utils.ts`, targetFilePath: `${ROOT}/src/app.ts` });
  const helperId = domain.selectors.getDefinitionsForFile(`${ROOT}/src/utils.ts`).find((d) => d.name === 'helper').symbolId;
  const outcome = await adapter.handleResolveMultipleSymbols({ edgeId: res.edgeId, symbolIds: [helperId] });
  assert.equal(outcome.status, 'error');
  assert.equal(outcome.success, false);
});
