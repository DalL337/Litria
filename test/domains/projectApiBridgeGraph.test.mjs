// `workspace.graph` owner answer (P4c, contract brief §7.4): the JavaScript
// half of the frontier-scoped graph read. The Rust `litria_graph_query` tool
// drives the walk one level at a time and calls this once per level.

import test from 'node:test';
import assert from 'node:assert/strict';

import { answerGraph, graphSnapshot } from '../../src/app/projectApiBridge.js';

// A snapshot built by hand: three files a→b (a imports b), b→c (b imports c).
// SyntaxDomain stores sourceFilePath = exporter, targetFilePath = importer, so
// an edge where b imports c is { sourceFilePath: 'c', targetFilePath: 'b' }.
function sampleSnapshot(overrides = {}) {
  return graphSnapshot({
    // Pieces carry no `groupId` field; membership lives on the group's
    // `pieceIds`, the way production stores it (P4c live pass 2).
    piecesById: new Map([
      [1, { id: 1, filename: 'src/a.ts' }],
      [2, { id: 2, filename: 'src/b.ts' }]
    ]),
    groups: [{ id: 10, folderPath: 'src', pieceIds: [1, 2] }],
    edgeProvenance: [
      {
        edgeId: 'c→b',
        sourceFilePath: 'src/c.ts',
        targetFilePath: 'src/b.ts',
        status: 'resolved',
        connectionIds: ['conn-1'],
        symbols: [{ name: 'parse', kind: 'function' }]
      },
      {
        edgeId: 'b→a',
        sourceFilePath: 'src/b.ts',
        targetFilePath: 'src/a.ts',
        status: 'resolved',
        connectionIds: ['conn-2'],
        symbols: [{ name: 'run', kind: 'function' }]
      }
    ],
    pendingEdges: [],
    parsedRevision: (path) => (path === 'src/a.ts' ? { source: 'editor', revision: 'b1-aa' } : { source: 'disk', revision: 'd1-bb' }),
    discoverable: () => true,
    discoveryInFlight: false,
    ...overrides
  });
}

test('imports from a file returns what it imports, not what imports it', () => {
  const snapshot = sampleSnapshot();
  // a.ts imports b.ts (edge b→a: exporter b, importer a).
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.kind, 'result');
  const { edges, nodes } = reply.result;
  assert.equal(edges.length, 1);
  assert.deepEqual(
    { importer: edges[0].importer, exporter: edges[0].exporter },
    { importer: 'src/a.ts', exporter: 'src/b.ts' }
  );
  assert.equal(nodes.find((n) => n.path === 'src/a.ts').onCanvas, true);
});

test('importedBy returns what imports a file', () => {
  const snapshot = sampleSnapshot();
  // b.ts is imported by a.ts (edge b→a: exporter b).
  const reply = answerGraph({ paths: ['src/b.ts'], direction: 'importedBy', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.edges.length, 1);
  assert.equal(reply.result.edges[0].importer, 'src/a.ts');
  assert.equal(reply.result.edges[0].exporter, 'src/b.ts');
});

test('both directions return incident edges on either side', () => {
  const snapshot = sampleSnapshot();
  // b.ts imports c.ts and is imported by a.ts.
  const reply = answerGraph({ paths: ['src/b.ts'], direction: 'both', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.edges.length, 2);
});

test('node facts carry the folder, on-canvas flag, parsed revision and discoverability', () => {
  const snapshot = sampleSnapshot();
  const reply = answerGraph({ paths: ['src/a.ts', 'src/c.ts'], direction: 'both', maxEdgesPerNode: 50 }, snapshot);
  const a = reply.result.nodes.find((n) => n.path === 'src/a.ts');
  assert.equal(a.folder, 'src');
  assert.equal(a.onCanvas, true);
  assert.deepEqual(a.parsed, { source: 'editor', revision: 'b1-aa' });
  assert.equal(a.discoverable, true);
  const c = reply.result.nodes.find((n) => n.path === 'src/c.ts');
  assert.equal(c.onCanvas, false, 'c.ts has no piece');
  assert.deepEqual(c.parsed, { source: 'disk', revision: 'd1-bb' });
});

test('a legacy group without a folderPath is named by an opaque group id', () => {
  const snapshot = graphSnapshot({
    piecesById: new Map([[1, { id: 1, filename: 'src/a.ts' }]]),
    groups: [{ id: 99, pieceIds: [1] }],
    edgeProvenance: [],
    pendingEdges: [],
    parsedRevision: () => null,
    discoverable: () => true,
    discoveryInFlight: false
  });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'both', maxEdgesPerNode: 50 }, snapshot);
  const node = reply.result.nodes[0];
  assert.equal(node.folder, undefined);
  assert.equal(node.groupId, '99');
});

test('a file with no recorded revision reports no parsed revision (reads unknown)', () => {
  const snapshot = sampleSnapshot({ parsedRevision: () => null });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'both', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.nodes[0].parsed, null);
});

test('off-canvas pending edges appear with onCanvas false', () => {
  const snapshot = sampleSnapshot({
    edgeProvenance: [],
    pendingEdges: [{ sourceFilePath: 'src/lib.ts', targetFilePath: 'src/a.ts', symbols: [{ name: 'x', kind: 'const' }] }]
  });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.edges.length, 1);
  assert.equal(reply.result.edges[0].onCanvas, false);
  assert.equal(reply.result.edges[0].exporter, 'src/lib.ts');
});

test('a manual wire (no syntax edge) is carried as provenance manual when present', () => {
  // A manual wire is modelled as an edge with provenance 'manual'; graphSnapshot
  // only derives sourceDerived/pending edges, so prove answerGraph passes
  // through a manual edge placed directly in the snapshot.
  const snapshot = {
    nodes: new Map([['src/a.ts', { path: 'src/a.ts', onCanvas: true, folder: 'src', groupId: null, parsed: null, discoverable: true }]]),
    edges: [{ importer: 'src/a.ts', exporter: 'src/d.ts', symbols: [], provenance: 'manual', status: null, onCanvas: true }],
    discoveryInFlight: false
  };
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.edges[0].provenance, 'manual');
  assert.equal(reply.result.edges[0].status, undefined, 'a manual edge carries no sourceDerived status');
});

test('the discovery-in-flight signal rides along', () => {
  const snapshot = sampleSnapshot({ discoveryInFlight: true });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'both', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.discoveryInFlight, true);
});

test('the awaiting-canvas-pieces signal rides along, distinct from in-flight (P4c live pass 1)', () => {
  const snapshot = sampleSnapshot({ discoveryInFlight: false, awaitingCanvasPieces: true });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'both', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.awaitingCanvasPieces, true);
  assert.equal(reply.result.discoveryInFlight, false);
});

test('sourceDerived edges carry the aggregate status, including orphaned', () => {
  const snapshot = sampleSnapshot({
    edgeProvenance: [{
      edgeId: 'x→a', sourceFilePath: 'src/x.ts', targetFilePath: 'src/a.ts',
      status: 'orphaned', connectionIds: ['c'], symbols: []
    }]
  });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.edges[0].status, 'orphaned');
});

test('the per-node edge ceiling counts the rest as omitted', () => {
  const edgeProvenance = Array.from({ length: 5 }, (_, i) => ({
    edgeId: `e${i}`, sourceFilePath: `src/e${i}.ts`, targetFilePath: 'src/a.ts',
    status: 'resolved', connectionIds: ['c'], symbols: []
  }));
  const snapshot = sampleSnapshot({ edgeProvenance });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 2 }, snapshot);
  assert.equal(reply.result.edges.length, 2);
  assert.ok(reply.result.omitted >= 3);
});

test('symbols per edge are capped at 50', () => {
  const symbols = Array.from({ length: 80 }, (_, i) => ({ name: `s${i}`, kind: 'function' }));
  const snapshot = sampleSnapshot({
    edgeProvenance: [{ edgeId: 'x', sourceFilePath: 'src/x.ts', targetFilePath: 'src/a.ts', status: 'resolved', connectionIds: ['c'], symbols }]
  });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.edges[0].symbols.length, 50);
});

test('a reply over the ceiling bounds with omitted, never refuses', () => {
  const edgeProvenance = Array.from({ length: 400 }, (_, i) => ({
    edgeId: `e${i}`, sourceFilePath: `src/really-quite-a-long-exporter-name-${i}.ts`, targetFilePath: 'src/a.ts',
    status: 'resolved', connectionIds: ['c'], symbols: [{ name: `symbol_number_${i}`, kind: 'function' }]
  }));
  const snapshot = sampleSnapshot({ edgeProvenance });
  const reply = answerGraph({ paths: ['src/a.ts'], direction: 'imports', maxEdgesPerNode: 500 }, snapshot, 2048);
  assert.equal(reply.kind, 'result');
  assert.ok(reply.result.omitted > 0, 'something did not fit and was counted');
  assert.ok(JSON.stringify(reply).length <= 2048 + 200);
});

test('a malformed request is refused cleanly', () => {
  const snapshot = sampleSnapshot();
  assert.equal(answerGraph({ paths: [], direction: 'imports' }, snapshot).code, 'invalidRequest');
  assert.equal(answerGraph({ paths: ['src/a.ts'], direction: 'sideways' }, snapshot).code, 'invalidRequest');
  assert.equal(answerGraph({ direction: 'imports' }, snapshot).code, 'invalidRequest');
  assert.equal(answerGraph({ paths: [1], direction: 'imports' }, snapshot).code, 'invalidRequest');
});

test('a frontier path with no edges is still a node', () => {
  const snapshot = sampleSnapshot();
  const reply = answerGraph({ paths: ['src/lonely.ts'], direction: 'both', maxEdgesPerNode: 50 }, snapshot);
  assert.equal(reply.result.nodes.length, 1);
  assert.equal(reply.result.nodes[0].path, 'src/lonely.ts');
  assert.equal(reply.result.edges.length, 0);
});
