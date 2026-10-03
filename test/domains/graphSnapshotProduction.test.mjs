// P4c first-review fixes (tasks 9, 10, 15, 17): the production graph snapshot,
// driven by the REAL SyntaxDomain with an absolute project root, so the defects
// the first review found against a hand-built snapshot cannot recur.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSyntaxDomain } from '../../src/app/syntaxDomain.js';
import { graphSnapshot, answerGraph } from '../../src/app/projectApiBridge.js';
import { isDiscoverableFilename } from '../../src/app/useDiscoveryLifecycle.js';

const ROOT = 'C:/Users/alice/project';
const abs = (rel) => `${ROOT}/${rel}`;

// First review 1 (task 9): SyntaxDomain keys files by ABSOLUTE path; pieces and
// requests use project-relative paths. The snapshot must convert, so a query
// for `src/a.ts` meets the edges and parsed revisions.
test('absolute SyntaxDomain keys meet the project-relative paths pieces use', () => {
  const syntax = createSyntaxDomain();
  // a.ts imports b.ts (exporter = b, importer = a).
  syntax.commands.registerFile(abs('src/a.ts'), "import { run } from './b';\n", { source: 'disk', revision: 'd1-a' });
  syntax.commands.registerFile(abs('src/b.ts'), 'export const run = 1;\n', { source: 'disk', revision: 'd1-b' });
  syntax.commands.connectDiscovered({
    connectionId: 'conn-1',
    sourceFilePath: abs('src/b.ts'),
    targetFilePath: abs('src/a.ts'),
    moduleSpecifier: './b',
  });

  const snapshot = graphSnapshot({
    // Production shape: the piece carries no `groupId`; the group lists its
    // members in `pieceIds` (P4c live pass 2).
    piecesById: new Map([[1, { id: 1, filename: 'src/a.ts' }]]),
    groups: [{ id: 10, folderPath: 'src', pieceIds: [1] }],
    edgeProvenance: syntax.selectors.getAllEdgeProvenance(),
    pendingEdges: [],
    parsedRevision: (path) => syntax.selectors.getParsedRevision(path),
    discoverable: isDiscoverableFilename,
    discoveryInFlight: false,
    connections: [],
    projectRoot: ROOT,
  });

  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.edges.length, 1, 'the edge is found via the relative path');
  assert.deepEqual(
    { importer: reply.result.edges[0].importer, exporter: reply.result.edges[0].exporter },
    { importer: 'src/a.ts', exporter: 'src/b.ts' }
  );
  const a = reply.result.nodes.find((n) => n.path === 'src/a.ts');
  assert.deepEqual(a.parsed, { source: 'disk', revision: 'd1-a' }, 'parsed revision meets the relative path');
  assert.equal(a.onCanvas, true);
  assert.equal(a.folder, 'src');
});

// First review 2 (task 10): a manual wire (a connection with no backing syntax
// edge) appears as a `manual` edge through the production snapshot.
test('a canvas wire with no syntax edge is a manual edge', () => {
  const syntax = createSyntaxDomain();
  const snapshot = graphSnapshot({
    piecesById: new Map([
      [1, { id: 1, filename: 'src/a.ts' }],
      [2, { id: 2, filename: 'src/d.ts' }],
    ]),
    groups: [],
    edgeProvenance: syntax.selectors.getAllEdgeProvenance(),
    pendingEdges: [],
    // sourceId = exporter piece (d), targetId = importer piece (a).
    connections: [{ id: 'wire-1', sourceId: 2, targetId: 1 }],
    parsedRevision: (path) => syntax.selectors.getParsedRevision(path),
    discoverable: isDiscoverableFilename,
    discoveryInFlight: false,
    projectRoot: ROOT,
  });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.edges.length, 1);
  assert.equal(reply.result.edges[0].provenance, 'manual');
  assert.equal(reply.result.edges[0].exporter, 'src/d.ts');
});

// First review 2 (task 10): a wire already backed by a sourceDerived edge is NOT
// also reported as manual.
test('a wire backed by a syntax edge is not duplicated as manual', () => {
  const syntax = createSyntaxDomain();
  syntax.commands.registerFile(abs('src/a.ts'), "import './b';\n");
  syntax.commands.registerFile(abs('src/b.ts'), 'export const x = 1;\n');
  syntax.commands.connectDiscovered({
    connectionId: 'wire-1',
    sourceFilePath: abs('src/b.ts'),
    targetFilePath: abs('src/a.ts'),
    moduleSpecifier: './b',
  });
  const snapshot = graphSnapshot({
    piecesById: new Map([
      [1, { id: 1, filename: 'src/a.ts' }],
      [2, { id: 2, filename: 'src/b.ts' }],
    ]),
    groups: [],
    edgeProvenance: syntax.selectors.getAllEdgeProvenance(),
    pendingEdges: [],
    connections: [{ id: 'wire-1', sourceId: 2, targetId: 1 }],
    parsedRevision: (path) => syntax.selectors.getParsedRevision(path),
    discoverable: isDiscoverableFilename,
    discoveryInFlight: false,
    projectRoot: ROOT,
  });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.edges.length, 1, 'only the sourceDerived edge, not a manual duplicate');
  assert.equal(reply.result.edges[0].provenance, 'sourceDerived');
});

// First review 11 (task 17): an off-canvas focus gets the same node facts as an
// on-canvas one, including `discoverable` from the file name.
test('an off-canvas file reports discoverable from its name', () => {
  const syntax = createSyntaxDomain();
  const snapshot = graphSnapshot({
    piecesById: new Map(), // nothing on canvas
    groups: [],
    edgeProvenance: [],
    pendingEdges: [],
    connections: [],
    parsedRevision: (path) => syntax.selectors.getParsedRevision(path),
    discoverable: isDiscoverableFilename,
    discoveryInFlight: false,
    projectRoot: ROOT,
  });
  const reply = answerGraph({ paths: ['src/off.js'], direction: 'both', maxEdgesPerNode: 50 }, snapshot);
  const node = reply.result.nodes[0];
  assert.equal(node.onCanvas, false);
  assert.equal(node.discoverable, true, 'a .js off-canvas file is discoverable by name');
});

// Live pass 2 (task 19): folder facts come from GROUP membership
// (`group.pieceIds`) — production pieces carry no `groupId`. A folder group
// yields the file node's `folder`; a legacy group without a `folderPath`
// yields an opaque `groupId`.
test('folder facts derive from group.pieceIds, not a piece groupId field', () => {
  const syntax = createSyntaxDomain();
  const snapshot = graphSnapshot({
    piecesById: new Map([
      [1, { id: 1, filename: 'src/a.ts' }], // in a folder group
      [2, { id: 2, filename: 'lib/legacy.ts' }], // in a legacy group
      [3, { id: 3, filename: 'loose.ts' }], // in no group
    ]),
    groups: [
      { id: 10, folderPath: 'src', pieceIds: [1] },
      { id: 77, pieceIds: [2] }, // legacy: no folderPath
    ],
    edgeProvenance: [],
    pendingEdges: [],
    connections: [],
    parsedRevision: () => null,
    discoverable: isDiscoverableFilename,
    discoveryInFlight: false,
    projectRoot: ROOT,
  });
  const reply = answerGraph(
    { paths: ['src/a.ts', 'lib/legacy.ts', 'loose.ts'], direction: 'both', maxEdgesPerNode: 50 },
    snapshot,
  );
  const node = (p) => reply.result.nodes.find((n) => n.path === p);
  assert.equal(node('src/a.ts').folder, 'src', 'folder group membership from pieceIds');
  assert.equal(node('src/a.ts').groupId, undefined);
  assert.equal(node('lib/legacy.ts').groupId, '77', 'legacy group named by opaque id');
  assert.equal(node('lib/legacy.ts').folder, undefined);
  assert.equal(node('loose.ts').folder, undefined, 'a piece in no group has no folder');
  assert.equal(node('loose.ts').groupId, undefined);
});

// First review 7 (task 15): the owner cuts symbols at 50 and FLAGS it, so the
// tool is not left to guess.
test('symbol truncation at 50 is flagged in the owner reply', () => {
  const symbols = Array.from({ length: 80 }, (_, i) => ({ name: `s${i}`, kind: 'function' }));
  const snapshot = graphSnapshot({
    piecesById: new Map([[1, { id: 1, filename: 'src/a.ts' }]]),
    groups: [],
    edgeProvenance: [{
      edgeId: 'x', sourceFilePath: abs('src/x.ts'), targetFilePath: abs('src/a.ts'),
      status: 'resolved', connectionIds: ['c'], symbols,
    }],
    pendingEdges: [],
    connections: [],
    parsedRevision: () => null,
    discoverable: isDiscoverableFilename,
    discoveryInFlight: false,
    projectRoot: ROOT,
  });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.edges[0].symbols.length, 50);
  assert.equal(reply.result.edges[0].symbolsTruncated, true, 'the cut is reported');
});
