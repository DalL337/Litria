import test from 'node:test';
import assert from 'node:assert/strict';

import { buildOffCanvasImportsByPieceId } from '../../src/app/useOffCanvasImports.js';
import { createConnectionsForEdges, buildPathToPiece } from '../../src/app/useDiscoveryLifecycle.js';

// ---------------------------------------------------------------------------
// Off-canvas import badge derivation (brief-cross-group-wires S3)
// ---------------------------------------------------------------------------

const edge = (source, target) => ({
  sourceFilePath: source,
  targetFilePath: target,
  moduleSpecifier: 'x',
  importLine: 0,
  symbols: [],
});

test('badge derivation groups pending edges under their on-canvas importer', () => {
  const pathToPiece = new Map([
    ['/proj/main.py', { id: 1 }],
    ['/proj/other.py', { id: 2 }],
  ]);
  const map = buildOffCanvasImportsByPieceId(
    [edge('/proj/oAuth.py', '/proj/main.py'), edge('/proj/util.py', '/proj/main.py'), edge('/proj/oAuth.py', '/proj/other.py')],
    pathToPiece
  );
  assert.equal(map.get(1).length, 2);
  assert.equal(map.get(2).length, 1);
});

test('badge derivation evaporates when the imported file gains a piece (derived rule)', () => {
  const pathToPiece = new Map([
    ['/proj/main.py', { id: 1 }],
    ['/proj/oAuth.py', { id: 5 }], // placed by any means
  ]);
  const map = buildOffCanvasImportsByPieceId([edge('/proj/oAuth.py', '/proj/main.py')], pathToPiece);
  assert.equal(map.size, 0);
});

test('badge derivation ignores edges whose importer is itself off-canvas', () => {
  const map = buildOffCanvasImportsByPieceId([edge('/proj/oAuth.py', '/proj/gone.py')], new Map());
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// createConnectionsForEdges retains unmatched edges as pending
// ---------------------------------------------------------------------------

function stubDomains() {
  const created = [];
  return {
    created,
    connectionDomain: {
      commands: {
        createConnectionFromDrag: (args) => {
          created.push(args);
          return { id: `conn_${created.length}` };
        },
      },
    },
    syntaxDomain: {
      selectors: { getDefinitionsForFile: () => [] },
    },
    syntaxAdapter: {
      handleConnect: async () => ({ success: true, edgeId: 'e1' }),
      handleResolveMultipleSymbols: async () => ({ success: true }),
    },
  };
}

test('createConnectionsForEdges wires matched edges and returns unmatched as pending', async () => {
  const { connectionDomain, syntaxDomain, syntaxAdapter, created } = stubDomains();
  const pathToPiece = new Map([
    ['/proj/a.py', { id: 1, x: 0, y: 0 }],
    ['/proj/b.py', { id: 2, x: 400, y: 0 }],
  ]);
  const wired = edge('/proj/a.py', '/proj/b.py');
  const offCanvas = edge('/proj/missing.py', '/proj/b.py');

  const { pendingEdges } = await createConnectionsForEdges({
    edges: [wired, offCanvas],
    pathToPiece,
    syntaxDomain,
    syntaxAdapter,
    connectionDomain,
  });

  assert.equal(created.length, 1, 'only the fully-on-canvas edge wires');
  assert.deepEqual(pendingEdges, [offCanvas]);
});

test('computeStaleDiscoveredConnections prunes only import-backed wires whose import vanished', async () => {
  const { computeStaleDiscoveredConnections } = await import('../../src/app/useDiscoveryLifecycle.js');
  const connections = [
    { id: 'kept-discovered', sourceId: 1, targetId: 2 },
    { id: 'stale-import-backed', sourceId: 1, targetId: 3 },
    { id: 'kept-manual-pending', sourceId: 2, targetId: 3 },
    { id: 'kept-unscanned', sourceId: 1, targetId: 9 },
    { id: 'kept-no-edge', sourceId: 3, targetId: 1 },
  ];
  const edges = {
    'kept-discovered': { symbols: [{ symbolName: 'a' }] },
    'stale-import-backed': { symbols: [{ symbolName: 'b' }] },
    'kept-manual-pending': { symbols: [] },
    'kept-unscanned': { symbols: [{ symbolName: 'c' }] },
    'kept-no-edge': null,
  };
  const stale = computeStaleDiscoveredConnections({
    connections,
    discoveredPairKeys: new Set(['1-2']),
    scannedPieceIds: new Set([1, 2, 3]),
    getEdgeForConnectionId: (id) => edges[id],
  });
  assert.deepEqual(stale, ['stale-import-backed']);
});

test('resolveSymbolsMetadata sets edge symbols without producing any file edits', async () => {
  const { createSyntaxDomain } = await import('../../src/app/syntaxDomain.js');
  const domain = createSyntaxDomain();
  domain.commands.registerFile('/proj/utils.js', 'export function helper() {}\n');
  domain.commands.registerFile('/proj/app.js', "import { helper } from './utils';\n");
  const { edgeId } = domain.commands.connect({
    connectionId: 'conn-m1', sourceFilePath: '/proj/utils.js', targetFilePath: '/proj/app.js',
  });
  const helperId = domain.selectors.getDefinitionsForFile('/proj/utils.js')
    .find((d) => d.name === 'helper').symbolId;

  const result = domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperId] });

  assert.equal(result.edge.symbols.length, 1);
  assert.equal(result.edge.symbols[0].symbolName, 'helper');
  assert.equal(result.edge.status, 'resolved');
  // Metadata-only by contract: the command has no text inputs and returns no
  // edits — re-resolving is also a stable no-op.
  const again = domain.commands.resolveSymbolsMetadata({ edgeId, symbolIds: [helperId] });
  assert.equal(again.edge.symbols.length, 1);
});

test('shouldRefreshOnDirtyShrink fires only after the initial run when a save lands', async () => {
  const { shouldRefreshOnDirtyShrink } = await import('../../src/app/useDiscoveryLifecycle.js');
  const s = (...ids) => new Set(ids);
  // A save: dirty set shrank after the initial discovery ran.
  assert.equal(shouldRefreshOnDirtyShrink({ initialRunDone: true, prevDirty: s(1, 2), nextDirty: s(1) }), true);
  // A file became dirty (typing) — no refresh.
  assert.equal(shouldRefreshOnDirtyShrink({ initialRunDone: true, prevDirty: s(1), nextDirty: s(1, 2) }), false);
  // Same size — no refresh.
  assert.equal(shouldRefreshOnDirtyShrink({ initialRunDone: true, prevDirty: s(1), nextDirty: s(2) }), false);
  // Before the initial per-load run — never.
  assert.equal(shouldRefreshOnDirtyShrink({ initialRunDone: false, prevDirty: s(1, 2), nextDirty: s(1) }), false);
  // Missing sets — never.
  assert.equal(shouldRefreshOnDirtyShrink({ initialRunDone: true, prevDirty: null, nextDirty: s(1) }), false);
});

test('buildPathToPiece maps relative piece filenames to absolute paths', () => {
  const piecesById = new Map([
    [1, { id: 1, filename: 'main/main.py' }],
    [2, { id: 2, filename: 'oAuth.py' }],
  ]);
  const map = buildPathToPiece(piecesById, '/proj');
  assert.equal(map.get('/proj/main/main.py').id, 1);
  assert.equal(map.get('/proj/oAuth.py').id, 2);
});
