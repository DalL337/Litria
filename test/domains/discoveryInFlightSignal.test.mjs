import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// P4c first review 9 and 10 (task 16): the discovery-in-flight signal the owner
// bridge reads for `workspace.graph`.
//  9. It must read in-flight while a refresh is ARMED (its debounce timer is
//     set) but has not started reading yet.
// 10. A previous project's run finishing must not clear the CURRENT project's
//     signal while that project's own run is still reading.
//
// Drives the REAL useDiscoveryLifecycle; only Tauri's `invoke` is stubbed.

register('../support/tauri-invoke-stub.mjs', import.meta.url);
register('../support/jsx-hooks.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Event']) {
  if (dom[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useDiscoveryLifecycle } = await import('../../src/app/useDiscoveryLifecycle.js');
const { createSyntaxDomain } = await import('../../src/app/syntaxDomain.js');

const flush = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });

const PROJECTS = {
  '/a': { 'src/app.ts': "import { x } from './dep';\n", 'src/dep.ts': 'export const x = 1;\n' },
  '/b': { 'lib/one.ts': "import { y } from './two';\n", 'lib/two.ts': 'export const y = 2;\n' },
};

function backend() {
  const held = { '/a': [], '/b': [] };
  const holding = { '/a': true, '/b': true };
  globalThis.__INVOKE__ = async (command, payload) => {
    const files = PROJECTS[payload.rootPath];
    if (command === 'list_project_tree') {
      return Object.keys(files).map((path) => ({ path, entryType: 'file', depth: path.split('/').length - 1 }));
    }
    if (command === 'read_project_file' || command === 'read_project_file_with_revision') {
      const text = files[payload.relativePath] ?? null;
      const shape = (v) => (v == null ? null : command === 'read_project_file_with_revision' ? { text: v, revision: `d1-${v.length}` } : v);
      if (holding[payload.rootPath]) {
        return new Promise((resolve) => held[payload.rootPath].push(() => resolve(shape(text))));
      }
      return shape(text);
    }
    throw new Error(`unexpected ${command}`);
  };
  return {
    release: async (root) => {
      holding[root] = false;
      while (held[root].length) held[root].shift()();
      await flush();
    },
  };
}

const conns = () => ({
  commands: { createConnectionFromDrag: (c) => ({ id: `c${Math.random()}`, ...c }), removeConnectionById: () => {} },
  selectors: { getAllConnections: () => [] },
});

const pieces = (files) => new Map(Object.keys(files).map((path, i) => [i + 1, { id: i + 1, filename: path, x: i * 300, y: 0 }]));

test('a previous project run finishing does not clear the current project signal (review 10)', async () => {
  const io = backend();
  const syntaxDomain = createSyntaxDomain();
  const adapter = { getModelRegistry: () => new Map(), handleDisconnect: async () => {} };
  let inFlight = () => false;

  function Harness(props) {
    const api = useDiscoveryLifecycle({ ...props, syntaxDomain, syntaxAdapter: adapter, connectionDomain: conns() });
    inFlight = api.isDiscoveryInFlight;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (props) => act(async () => root.render(createElement(Harness, props)));

  const tokenA = {};
  await render({ projectRoot: '/a', loadToken: tokenA, piecesById: new Map() });
  await render({ projectRoot: '/a', loadToken: tokenA, piecesById: pieces(PROJECTS['/a']) });
  await flush();
  assert.equal(inFlight(), true, 'A is reading');

  // Switch to B before A's reads return; B starts its own run (also held).
  const tokenB = {};
  await render({ projectRoot: '/b', loadToken: tokenB, piecesById: new Map() });
  await render({ projectRoot: '/b', loadToken: tokenB, piecesById: pieces(PROJECTS['/b']) });
  await flush();
  assert.equal(inFlight(), true, 'B is reading');

  // A's run finishes now: it must NOT clear the signal while B still reads.
  await io.release('/a');
  assert.equal(inFlight(), true, "A finishing does not clear B's signal");

  // B finishing clears it.
  await io.release('/b');
  assert.equal(inFlight(), false, 'B finished, nothing in flight');
  await act(async () => root.unmount());
});

test('an empty canvas is awaiting pieces, not in flight (task 18 / live pass 1)', async () => {
  // Discovery is canvas-driven: with no pieces it never reads, so it must not
  // claim to be in flight — it is waiting for pieces, its own distinct signal.
  globalThis.__INVOKE__ = async (command) => {
    throw new Error(`discovery read on an empty canvas: ${command}`);
  };
  const syntaxDomain = createSyntaxDomain();
  const adapter = { getModelRegistry: () => new Map(), handleDisconnect: async () => {} };
  let api = {};
  function Harness(props) {
    api = useDiscoveryLifecycle({ ...props, syntaxDomain, syntaxAdapter: adapter, connectionDomain: conns() });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (props) => act(async () => root.render(createElement(Harness, props)));

  const token = {};
  await render({ projectRoot: '/a', loadToken: token, piecesById: new Map() });
  await flush();
  assert.equal(api.isDiscoveryInFlight(), false, 'nothing is reading on an empty canvas');
  assert.equal(api.isDiscoveryAwaitingCanvasPieces(), true, 'discovery is armed, waiting for pieces');
  await act(async () => root.unmount());
});

test('a refresh that is armed but not started reads in-flight (review 9)', async () => {
  // Immediate reads (nothing held), so the initial run settles before we probe.
  globalThis.__INVOKE__ = async (command, payload) => {
    const files = PROJECTS[payload.rootPath];
    if (command === 'list_project_tree') {
      return Object.keys(files).map((path) => ({ path, entryType: 'file', depth: path.split('/').length - 1 }));
    }
    const text = files[payload.relativePath] ?? null;
    return text == null ? null : command === 'read_project_file_with_revision' ? { text, revision: `d1-${text.length}` } : text;
  };
  const syntaxDomain = createSyntaxDomain();
  const adapter = { getModelRegistry: () => new Map(), handleDisconnect: async () => {} };
  let inFlight = () => false;

  function Harness(props) {
    const api = useDiscoveryLifecycle({ ...props, syntaxDomain, syntaxAdapter: adapter, connectionDomain: conns() });
    inFlight = api.isDiscoveryInFlight;
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (props) => act(async () => root.render(createElement(Harness, props)));

  const token = {};
  const dirtyTwo = new Set([1, 2]);
  await render({ projectRoot: '/a', loadToken: token, piecesById: new Map(), dirtyPieceIds: dirtyTwo });
  await render({ projectRoot: '/a', loadToken: token, piecesById: pieces(PROJECTS['/a']), dirtyPieceIds: dirtyTwo });
  await flush();
  assert.equal(inFlight(), false, 'the initial run has settled');

  // A save lands (the dirty set shrinks): a refresh is scheduled. Its debounce
  // has not fired, but the signal must already read in-flight.
  await render({ projectRoot: '/a', loadToken: token, piecesById: pieces(PROJECTS['/a']), dirtyPieceIds: new Set([1]) });
  assert.equal(inFlight(), true, 'an armed refresh reads in-flight before it starts');
  await act(async () => root.unmount());
});
