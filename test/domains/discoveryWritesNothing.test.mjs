import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { createSyntaxAdapter } from '../../src/lsp/syntaxAdapter.js';
import { discoverProjectEdges } from '../../src/app/discoveryEngine.js';
import { createConnectionsForEdges } from '../../src/app/useDiscoveryLifecycle.js';

// ---------------------------------------------------------------------------
// Discovery mirrors code into wires and never writes code back (owner rule
// 2026-07-18; P4 gate item 3, .research/2026-10-01-syntax-write-gates.md).
// It used to create each wire through the write-capable connect, which
// inserts a TODO stub unless it finds the import already there, so any
// import it missed got a stub written into a user file on project load: a
// directory import (`'./utils'` is utils/index.ts, but the path-derived spec
// was `./utils/index`), or an import removed in an unsaved buffer.
//
// These run the real chain: discovery engine → createConnectionsForEdges →
// SyntaxDomain, with the real adapter for the user actions that follow.
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

/** Connection domain stand-in: mints ids like the real one. */
function makeConnectionDomain() {
  let n = 0;
  return {
    commands: {
      createConnectionFromDrag(input) {
        n += 1;
        return { id: `conn_${n}`, ...input };
      },
    },
  };
}

/** A Monaco-shaped model holding `text`, counting edits pushed into it. */
function makeModel(text) {
  const model = {
    value: text,
    edits: 0,
    getValue: () => model.value,
    getLineCount: () => model.value.split('\n').length,
    getLineMaxColumn: (line) => model.value.split('\n')[line - 1].length + 1,
    pushEditOperations: (_sel, ops) => {
      model.edits += 1;
      model.value = ops[0].text;
    },
  };
  return model;
}

/** Run discovery's edge pass over everything on disk, every file on canvas. */
async function discover({ domain, disk }) {
  const fileContents = new Map([...disk].map(([rel, text]) => [`${ROOT}/${rel}`, text]));
  const { edges } = discoverProjectEdges({
    projectRoot: ROOT,
    filePaths: [...fileContents.keys()],
    readFile: (p) => fileContents.get(p) ?? null,
  });
  const pathToPiece = new Map(
    [...fileContents.keys()].map((p, i) => [p, { id: i + 1, x: i * 400, y: 0 }]),
  );
  await createConnectionsForEdges({
    edges,
    pathToPiece,
    syntaxDomain: domain,
    connectionDomain: makeConnectionDomain(),
  });
  return edges;
}

function importsFrom(text, spec) {
  return text.split('\n').filter((l) => l.startsWith('import ') && l.includes(`'${spec}`));
}

const DIRECTORY_IMPORT = {
  'src/utils/index.ts': 'export function helper() {}\nexport function other() {}\n',
  'src/app.ts': "import { helper } from './utils';\nhelper();\n",
};

test('discovery writes nothing for a directory import (./utils → utils/index.ts)', async () => {
  const ctx = setup(DIRECTORY_IMPORT);

  const edges = await discover(ctx);

  assert.equal(edges.length, 1, 'discovery found the import');
  assert.deepEqual(ctx.writes, [], 'no file was written');
  assert.equal(ctx.disk.get('src/app.ts'), DIRECTORY_IMPORT['src/app.ts']);
  const edge = ctx.domain.selectors.getSyntaxEdgeForPair(`${ROOT}/src/utils/index.ts`, `${ROOT}/src/app.ts`);
  assert.ok(edge, 'the wire has its syntax edge');
  assert.equal(edge.status, 'resolved');
});

test('discovery writes nothing into an open buffer that no longer has the import', async () => {
  // Disk still imports `helper`; the open, unsaved buffer has just had that
  // import deleted. Discovery reads disk, so it finds the edge; the old
  // connect then read the BUFFER, found no import, and put one back.
  const ctx = setup({
    'src/utils.ts': 'export function helper() {}\n',
    'src/app.ts': "import { helper } from './utils';\nhelper();\n",
  });
  const model = makeModel('helper();\n');
  ctx.adapter.onFileOpened(`${ROOT}/src/app.ts`, model.value, model);

  await discover(ctx);

  assert.equal(model.edits, 0, 'the open buffer was not edited');
  assert.equal(model.value, 'helper();\n');
  assert.deepEqual(ctx.writes, []);
});

test('a symbol picked later on a discovered directory import joins the existing import', async () => {
  const ctx = setup(DIRECTORY_IMPORT);
  await discover(ctx);
  const edge = ctx.domain.selectors.getSyntaxEdgeForPair(`${ROOT}/src/utils/index.ts`, `${ROOT}/src/app.ts`);
  const otherId = ctx.domain.selectors
    .getDefinitionsForFile(`${ROOT}/src/utils/index.ts`)
    .find((d) => d.name === 'other').symbolId;

  await ctx.adapter.handleResolveMultipleSymbols({ edgeId: edge.edgeId, symbolIds: [otherId] });

  const app = ctx.disk.get('src/app.ts');
  const utilsImports = importsFrom(app, './utils');
  assert.equal(utilsImports.length, 1, `one import from ./utils, got:\n${app}`);
  assert.match(utilsImports[0], /\bhelper\b/);
  assert.match(utilsImports[0], /\bother\b/);
  assert.equal(utilsImports[0].includes('./utils/index'), false, 'the spec as written is kept');
});

test('renaming a directory import\'s index file rewrites the real import', async () => {
  const ctx = setup(DIRECTORY_IMPORT);
  await discover(ctx);
  ctx.disk.set('src/utils/core.ts', ctx.disk.get('src/utils/index.ts'));
  ctx.disk.delete('src/utils/index.ts');

  await ctx.adapter.onFileRenamed(`${ROOT}/src/utils/index.ts`, `${ROOT}/src/utils/core.ts`);

  const app = ctx.disk.get('src/app.ts');
  assert.deepEqual(importsFrom(app, './utils'), ["import { helper } from './utils/core';"], app);
});

test('discovery of a Python import writes nothing and keeps no line hint', async () => {
  const ctx = setup({
    'src/utils.py': 'def helper():\n    pass\n',
    'src/main.py': 'from utils import helper\nhelper()\n',
  });

  const edges = await discover(ctx);

  assert.equal(edges.length, 1);
  assert.deepEqual(ctx.writes, []);
  const edge = ctx.domain.selectors.getSyntaxEdgeForPair(`${ROOT}/src/utils.py`, `${ROOT}/src/main.py`);
  assert.equal(edge.status, 'resolved');
  assert.equal(edge.importLine, null, 'python edges carry no JS line hint');
});
