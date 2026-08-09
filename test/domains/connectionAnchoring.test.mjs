import test from 'node:test';
import assert from 'node:assert/strict';

import { chooseFacingSides } from '../../src/app/connectionAnchoring.js';
import {
  createConnectionsForEdges,
  decideDiscoveryStep,
  toJsTsAbsPaths,
} from '../../src/app/useDiscoveryLifecycle.js';

// ---------------------------------------------------------------------------
// chooseFacingSides — geometry → facing edges
// ---------------------------------------------------------------------------

test('chooseFacingSides: target to the right → right/left', () => {
  assert.deepEqual(
    chooseFacingSides({ x: 0, y: 0 }, { x: 500, y: 0 }),
    { sourceSide: 'right', targetSide: 'left' },
  );
});

test('chooseFacingSides: target to the left → left/right', () => {
  assert.deepEqual(
    chooseFacingSides({ x: 500, y: 0 }, { x: 0, y: 0 }),
    { sourceSide: 'left', targetSide: 'right' },
  );
});

test('chooseFacingSides: target below → bottom/top', () => {
  assert.deepEqual(
    chooseFacingSides({ x: 0, y: 0 }, { x: 0, y: 500 }),
    { sourceSide: 'bottom', targetSide: 'top' },
  );
});

test('chooseFacingSides: target above → top/bottom', () => {
  assert.deepEqual(
    chooseFacingSides({ x: 0, y: 500 }, { x: 0, y: 0 }),
    { sourceSide: 'top', targetSide: 'bottom' },
  );
});

test('chooseFacingSides: dominant horizontal wins on a shallow diagonal', () => {
  assert.deepEqual(
    chooseFacingSides({ x: 0, y: 0 }, { x: 500, y: 100 }),
    { sourceSide: 'right', targetSide: 'left' },
  );
});

test('chooseFacingSides: dominant vertical wins on a steep diagonal', () => {
  assert.deepEqual(
    chooseFacingSides({ x: 0, y: 0 }, { x: 100, y: 500 }),
    { sourceSide: 'bottom', targetSide: 'top' },
  );
});

test('chooseFacingSides: perfect diagonal ties to the vertical axis', () => {
  assert.deepEqual(
    chooseFacingSides({ x: 0, y: 0 }, { x: 300, y: 300 }),
    { sourceSide: 'bottom', targetSide: 'top' },
  );
});

test('chooseFacingSides: same position resolves deterministically (top/bottom)', () => {
  assert.deepEqual(
    chooseFacingSides({ x: 200, y: 200 }, { x: 200, y: 200 }),
    { sourceSide: 'top', targetSide: 'bottom' },
  );
});

test('chooseFacingSides: only x/y are read (width/height irrelevant)', () => {
  // Extra fields must not change the result.
  const a = chooseFacingSides({ x: 0, y: 0 }, { x: 500, y: 10 });
  const b = chooseFacingSides({ x: 0, y: 0, w: 999 }, { x: 500, y: 10, h: 1 });
  assert.deepEqual(a, b);
});

// ---------------------------------------------------------------------------
// createConnectionsForEdges — anchoring + one-identity linkage
// ---------------------------------------------------------------------------

/** Build a connectionDomain mock that mints sequential ids and logs inputs. */
function makeConnectionDomain({ createReturns } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    commands: {
      createConnectionFromDrag(input) {
        calls.push(input);
        if (createReturns && Object.prototype.hasOwnProperty.call(createReturns, n)) {
          const forced = createReturns[n];
          n += 1;
          return forced;
        }
        n += 1;
        return { id: `conn_${n}`, ...input };
      },
    },
  };
}

function makeSyntaxAdapter() {
  const connectCalls = [];
  const resolveCalls = [];
  return {
    connectCalls,
    resolveCalls,
    async handleConnect(args) {
      connectCalls.push(args);
      return { success: true, edgeId: `edge_for_${args.connectionId}` };
    },
    async handleResolveMultipleSymbols(args) {
      resolveCalls.push(args);
      return { success: true };
    },
  };
}

const SYNTAX_DOMAIN_NO_DEFS = {
  selectors: { getDefinitionsForFile: () => [] },
};

test('createConnectionsForEdges: anchors from geometry and links by the minted id', async () => {
  const pathToPiece = new Map([
    ['/p/a.ts', { id: 1, x: 0, y: 0 }],
    ['/p/b.ts', { id: 2, x: 500, y: 0 }],
  ]);
  const connectionDomain = makeConnectionDomain();
  const syntaxAdapter = makeSyntaxAdapter();

  await createConnectionsForEdges({
    edges: [{ sourceFilePath: '/p/a.ts', targetFilePath: '/p/b.ts', symbols: [] }],
    pathToPiece,
    syntaxDomain: SYNTAX_DOMAIN_NO_DEFS,
    syntaxAdapter,
    connectionDomain,
  });

  // Anchored from geometry (b is to the right of a).
  assert.deepEqual(connectionDomain.calls[0], {
    sourceId: 1, sourceSide: 'right', targetId: 2, targetSide: 'left',
  });
  // The syntax edge is keyed to the SAME id the visual connection got —
  // not a separate `discovery-N`.
  assert.equal(syntaxAdapter.connectCalls.length, 1);
  assert.equal(syntaxAdapter.connectCalls[0].connectionId, 'conn_1');
});

test('createConnectionsForEdges: persisted sides override geometry', async () => {
  const pathToPiece = new Map([
    ['/p/a.ts', { id: 1, x: 0, y: 0 }],
    ['/p/b.ts', { id: 2, x: 500, y: 0 }], // geometry would give right/left
  ]);
  const connectionDomain = makeConnectionDomain();
  const syntaxAdapter = makeSyntaxAdapter();
  // User had drawn this pair bottom→top; that choice must win over geometry.
  const persistedSides = new Map([['1-2', { sourceSide: 'bottom', targetSide: 'top' }]]);

  await createConnectionsForEdges({
    edges: [{ sourceFilePath: '/p/a.ts', targetFilePath: '/p/b.ts', symbols: [] }],
    pathToPiece,
    syntaxDomain: SYNTAX_DOMAIN_NO_DEFS,
    syntaxAdapter,
    connectionDomain,
    persistedSides,
  });

  assert.deepEqual(connectionDomain.calls[0], {
    sourceId: 1, sourceSide: 'bottom', targetId: 2, targetSide: 'top',
  });
});

test('createConnectionsForEdges: missing side in override falls back to geometry per side', async () => {
  const pathToPiece = new Map([
    ['/p/a.ts', { id: 1, x: 0, y: 0 }],
    ['/p/b.ts', { id: 2, x: 500, y: 0 }], // geometry: source right, target left
  ]);
  const connectionDomain = makeConnectionDomain();
  const syntaxAdapter = makeSyntaxAdapter();
  // Only the source side persisted; target side must fall back to geometry (left).
  const persistedSides = new Map([['1-2', { sourceSide: 'top', targetSide: null }]]);

  await createConnectionsForEdges({
    edges: [{ sourceFilePath: '/p/a.ts', targetFilePath: '/p/b.ts', symbols: [] }],
    pathToPiece,
    syntaxDomain: SYNTAX_DOMAIN_NO_DEFS,
    syntaxAdapter,
    connectionDomain,
    persistedSides,
  });

  assert.deepEqual(connectionDomain.calls[0], {
    sourceId: 1, sourceSide: 'top', targetId: 2, targetSide: 'left',
  });
});

test('createConnectionsForEdges: override for a different pair is ignored (geometry used)', async () => {
  const pathToPiece = new Map([
    ['/p/a.ts', { id: 1, x: 0, y: 0 }],
    ['/p/b.ts', { id: 2, x: 500, y: 0 }],
  ]);
  const connectionDomain = makeConnectionDomain();
  const syntaxAdapter = makeSyntaxAdapter();
  const persistedSides = new Map([['9-9', { sourceSide: 'top', targetSide: 'bottom' }]]);

  await createConnectionsForEdges({
    edges: [{ sourceFilePath: '/p/a.ts', targetFilePath: '/p/b.ts', symbols: [] }],
    pathToPiece,
    syntaxDomain: SYNTAX_DOMAIN_NO_DEFS,
    syntaxAdapter,
    connectionDomain,
    persistedSides,
  });

  assert.equal(connectionDomain.calls[0].sourceSide, 'right'); // geometry, not override
});

test('createConnectionsForEdges: skips edges with an endpoint not on canvas', async () => {
  const pathToPiece = new Map([['/p/a.ts', { id: 1, x: 0, y: 0 }]]);
  const connectionDomain = makeConnectionDomain();
  const syntaxAdapter = makeSyntaxAdapter();

  await createConnectionsForEdges({
    edges: [{ sourceFilePath: '/p/a.ts', targetFilePath: '/p/missing.ts', symbols: [] }],
    pathToPiece,
    syntaxDomain: SYNTAX_DOMAIN_NO_DEFS,
    syntaxAdapter,
    connectionDomain,
  });

  assert.equal(connectionDomain.calls.length, 0);
  assert.equal(syntaxAdapter.connectCalls.length, 0);
});

test('createConnectionsForEdges: no dangling syntax edge when createConnection returns null', async () => {
  const pathToPiece = new Map([
    ['/p/a.ts', { id: 1, x: 0, y: 0 }],
    ['/p/b.ts', { id: 2, x: 500, y: 0 }],
  ]);
  // Force the dedup/invalid case (createConnectionFromDrag → null).
  const connectionDomain = makeConnectionDomain({ createReturns: { 0: null } });
  const syntaxAdapter = makeSyntaxAdapter();

  await createConnectionsForEdges({
    edges: [{ sourceFilePath: '/p/a.ts', targetFilePath: '/p/b.ts', symbols: [] }],
    pathToPiece,
    syntaxDomain: SYNTAX_DOMAIN_NO_DEFS,
    syntaxAdapter,
    connectionDomain,
  });

  assert.equal(connectionDomain.calls.length, 1); // attempted
  assert.equal(syntaxAdapter.connectCalls.length, 0); // but no syntax edge created
});

test('createConnectionsForEdges: pre-resolves matched symbols on the linked edge', async () => {
  const pathToPiece = new Map([
    ['/p/a.ts', { id: 1, x: 0, y: 0 }],
    ['/p/b.ts', { id: 2, x: 0, y: 500 }],
  ]);
  const connectionDomain = makeConnectionDomain();
  const syntaxAdapter = makeSyntaxAdapter();
  const metadataResolveCalls = [];
  const syntaxDomain = {
    selectors: {
      getDefinitionsForFile: (file) =>
        file === '/p/a.ts' ? [{ name: 'foo', symbolId: 'sym_foo' }] : [],
    },
    commands: {
      resolveSymbolsMetadata: (args) => {
        metadataResolveCalls.push(args);
        return { edge: {} };
      },
    },
  };

  await createConnectionsForEdges({
    edges: [{
      sourceFilePath: '/p/a.ts',
      targetFilePath: '/p/b.ts',
      symbols: [{ name: 'foo' }, { name: 'unmatched' }],
    }],
    pathToPiece,
    syntaxDomain,
    syntaxAdapter,
    connectionDomain,
  });

  // Vertical anchor (b below a).
  assert.equal(connectionDomain.calls[0].sourceSide, 'bottom');
  // The matched symbol resolves; the unmatched one becomes a BROKEN marker
  // (dead import → red from first load). METADATA ONLY either way — the
  // write-capable adapter resolve must not be called.
  assert.equal(metadataResolveCalls.length, 1);
  assert.deepEqual(metadataResolveCalls[0], {
    edgeId: 'edge_for_conn_1',
    symbolIds: ['sym_foo'],
    brokenNames: ['unmatched'],
  });
  assert.equal(syntaxAdapter.resolveCalls.length, 0);
});

// ---------------------------------------------------------------------------
// decideDiscoveryStep — run-once-per-load orchestration
// ---------------------------------------------------------------------------

/**
 * Drive decideDiscoveryStep the way the effect does: apply the action, mutating
 * a refs object, and record which renders produced a 'run'. Each render passes
 * the current (loadToken, piecesById).
 */
function driveDiscovery(renders) {
  const refs = { ranForToken: null, armedToken: null, armedPieces: null };
  const actions = [];
  for (const { loadToken, piecesById } of renders) {
    const { action } = decideDiscoveryStep({ ...refs, loadToken, piecesById });
    actions.push(action);
    if (action === 'arm') {
      refs.armedToken = loadToken;
      refs.armedPieces = piecesById;
    } else if (action === 'run') {
      refs.ranForToken = loadToken;
    }
  }
  return actions;
}

test('decideDiscoveryStep: first open — arm on token, run once pieces hydrate', () => {
  const empty = new Map();
  const p1 = new Map([[1, {}]]);
  const load1 = { id: 'load1' };
  const actions = driveDiscovery([
    { loadToken: load1, piecesById: empty }, // token arrives, pieces empty
    { loadToken: load1, piecesById: p1 },     // pieces hydrated
    { loadToken: load1, piecesById: p1 },     // steady state
  ]);
  assert.deepEqual(actions, ['arm', 'run', 'skip']);
});

test('decideDiscoveryStep: project switch — does NOT run against the previous project pieces', () => {
  const aPieces = new Map([[1, {}]]);
  const bPieces = new Map([[2, {}]]);
  const loadA = { id: 'A' };
  const loadB = { id: 'B' };
  const actions = driveDiscovery([
    { loadToken: loadA, piecesById: new Map() }, // A arrives (empty)
    { loadToken: loadA, piecesById: aPieces },    // A pieces
    // switch: B's token arrives one render before B's pieces; A's pieces linger
    { loadToken: loadB, piecesById: aPieces },    // MUST NOT run here
    { loadToken: loadB, piecesById: bPieces },    // B pieces swapped in
  ]);
  assert.deepEqual(actions, ['arm', 'run', 'arm', 'run']);
});

test('decideDiscoveryStep: reopen same project (fresh load token) re-runs', () => {
  const p = new Map([[1, {}]]);
  const open1 = { id: 'open1' }; // dbOpenProject → fresh object each open
  const open2 = { id: 'open2' };
  const actions = driveDiscovery([
    { loadToken: open1, piecesById: new Map() },
    { loadToken: open1, piecesById: p },
    // closed to launcher then reopened same path → new _dbState object
    { loadToken: open2, piecesById: p },        // arm (token changed)
    { loadToken: open2, piecesById: new Map([[1, {}]]) }, // new pieces ref → run
  ]);
  assert.deepEqual(actions, ['arm', 'run', 'arm', 'run']);
});

test('decideDiscoveryStep: no load token (single-file mode) never arms or runs', () => {
  const actions = driveDiscovery([
    { loadToken: null, piecesById: new Map([[1, {}]]) },
    { loadToken: null, piecesById: new Map([[1, {}]]) },
  ]);
  // arm requires armedToken !== loadToken; null !== null is false → skip.
  assert.deepEqual(actions, ['skip', 'skip']);
});

// ---------------------------------------------------------------------------
// toJsTsAbsPaths — list_project_tree returns entry OBJECTS, not path strings
// ---------------------------------------------------------------------------

test('toJsTsAbsPaths: extracts .path from ProjectTreeEntry objects (regression)', () => {
  // Shape returned by list_project_tree (src-tauri/src/project_types.rs).
  const tree = [
    { path: 'src', entryType: 'directory', depth: 0 },
    { path: 'src/main.tsx', entryType: 'file', depth: 1 },
    { path: 'src/App.tsx', entryType: 'file', depth: 1 },
    { path: 'src/App.css', entryType: 'file', depth: 1 },
    { path: 'README.md', entryType: 'file', depth: 0 },
  ];
  assert.deepEqual(toJsTsAbsPaths(tree, 'C:/Projects1/awesomerite'), [
    'C:/Projects1/awesomerite/src/main.tsx',
    'C:/Projects1/awesomerite/src/App.tsx',
  ]);
});

test('toJsTsAbsPaths: tolerates bare string entries and normalizes backslashes', () => {
  const tree = ['src\\a.ts', { path: 'src\\b.jsx', entryType: 'file', depth: 1 }, 'notes.txt'];
  assert.deepEqual(toJsTsAbsPaths(tree, '/proj'), [
    '/proj/src/a.ts',
    '/proj/src/b.jsx',
  ]);
});

test('toJsTsAbsPaths: non-array or empty tree yields no files', () => {
  assert.deepEqual(toJsTsAbsPaths(null, '/proj'), []);
  assert.deepEqual(toJsTsAbsPaths([], '/proj'), []);
  assert.deepEqual(toJsTsAbsPaths([{ path: 'src', entryType: 'directory' }], '/proj'), []);
});
