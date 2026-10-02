import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// P4 (Codex residual, owner ruling 2026-10-01): a discovery run that is
// already reading files when the user switches projects was never cancelled
// (only a pending refresh timer was). It finished against the CURRENT shared
// domains with the OLD project's file and piece lookups — and piece ids
// repeat across projects (per-project autoincrement). So it could draw the
// old project's wires between the new project's same-id pieces, prune the
// new project's wires, register the old project's files, and replace the
// new project's off-canvas badges.
//
// Drives the REAL useDiscoveryLifecycle with the real SyntaxDomain; only
// Tauri's `invoke` is stubbed. Project A's file reads are held until after
// the switch to B.

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
  '/a': {
    'src/utils.ts': 'export function helper() {}\n',
    'src/app.ts': "import { helper } from './utils';\nhelper();\n",
  },
  '/b': {
    'lib/one.ts': 'export const one = 1;\n',
    'lib/two.ts': 'export const two = 2;\n',
  },
};

function backend() {
  const held = [];
  let holdA = true;
  globalThis.__INVOKE__ = async (command, payload) => {
    const files = PROJECTS[payload.rootPath];
    if (command === 'list_project_tree') {
      return Object.keys(files).map((path) => ({ path, entryType: 'file', depth: path.split('/').length - 1 }));
    }
    if (command === 'read_project_file') {
      const text = files[payload.relativePath] ?? null;
      if (payload.rootPath === '/a' && holdA) {
        return new Promise((resolve) => held.push(() => resolve(text)));
      }
      return text;
    }
    throw new Error(`unexpected ${command}`);
  };
  return {
    releaseA: async () => {
      holdA = false;
      while (held.length) held.shift()();
      await flush();
    },
  };
}

/** The shared connection domain, holding whichever project is current. */
function connectionDomain() {
  const created = [];
  const removed = [];
  let next = 1;
  let current = [];
  return {
    created,
    removed,
    setCurrent: (list) => { current = list; },
    commands: {
      createConnectionFromDrag: (c) => {
        const conn = { id: `conn_${next++}`, ...c };
        created.push(conn);
        return conn;
      },
      removeConnectionById: (id) => { removed.push(id); },
    },
    selectors: { getAllConnections: () => current },
  };
}

const pieces = (root, files) => new Map(Object.keys(files).map((path, i) => [i + 1, {
  id: i + 1, filename: path, label: path.split('/').pop(), x: i * 300, y: 0,
}]));

test('a discovery run still reading when the project switches changes nothing in the new project', async () => {
  const io = backend();
  const syntaxDomain = createSyntaxDomain();
  const conns = connectionDomain();
  const pendingCalls = [];
  const adapter = { getModelRegistry: () => new Map(), handleDisconnect: async () => {} };

  function Harness(props) {
    useDiscoveryLifecycle({
      ...props,
      syntaxDomain,
      syntaxAdapter: adapter,
      connectionDomain: conns,
      onPendingEdges: (edges) => pendingCalls.push({ root: props.projectRoot, edges }),
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (props) => act(async () => root.render(createElement(Harness, props)));

  // Project A loads: the token arms discovery, then the hydrated pieces run it.
  const tokenA = {};
  const piecesA = pieces('/a', PROJECTS['/a']);
  await render({ projectRoot: '/a', loadToken: tokenA, piecesById: new Map() });
  await render({ projectRoot: '/a', loadToken: tokenA, piecesById: piecesA });
  await flush(); // A's run is now waiting on its file reads

  // Switch to B before A's reads come back. B has its own wire between ITS
  // pieces 1 and 2 — the same ids A's pieces have.
  const tokenB = {};
  const piecesB = pieces('/b', PROJECTS['/b']);
  const bWire = { id: 'conn_b', sourceId: 1, targetId: 2, type: 'reference' };
  conns.setCurrent([bWire]);
  await render({ projectRoot: '/b', loadToken: tokenB, piecesById: new Map() });
  await render({ projectRoot: '/b', loadToken: tokenB, piecesById: piecesB });
  await flush();
  const createdBeforeRelease = conns.created.length;
  const pendingBeforeRelease = pendingCalls.length;

  // A's reads finally return.
  await io.releaseA();

  assert.equal(conns.created.length, createdBeforeRelease, 'no wire drawn from project A\'s imports');
  assert.deepEqual(conns.removed, [], 'no wire of project B pruned by A\'s run');
  assert.equal(pendingCalls.length, pendingBeforeRelease, 'B\'s off-canvas badges are not replaced by A\'s');
  assert.deepEqual(syntaxDomain.selectors.getRegisteredFilesUnder('/a'), [], 'no file of project A registered');
  // ...while the current project's own run did its work.
  assert.deepEqual(syntaxDomain.selectors.getRegisteredFilesUnder('/b'), ['/b/lib/one.ts', '/b/lib/two.ts']);
  await act(async () => root.unmount());
});
