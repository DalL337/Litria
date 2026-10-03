import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// P4 (Codex residual, owner ruling 2026-10-01): SyntaxDomain is created once
// for the app's lifetime and was never reset, while every project load
// restarts canvas connection ids at conn_1 (useProjectLaunch). So the next
// project's conn_1 — a different wire, maybe a manual one — was linked to
// the previous project's edge: its status colour came from that edge, and
// the graph query would have reported its provenance from another project's
// files. The previous project's files stayed registered too.
//
// Drives the REAL useSyntaxDomainLifecycle hook.

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
const { useSyntaxDomainLifecycle } = await import('../../src/app/useSyntaxDomainLifecycle.js');

test('a new project load starts with an empty syntax index and no wire statuses', async () => {
  let seen = null;
  function Harness(props) {
    seen = useSyntaxDomainLifecycle({ ...props, readProjectFile: async () => null, writeProjectFile: async () => true });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (props) => act(async () => root.render(createElement(Harness, props)));

  const loadA = {};
  await render({ projectRoot: '/a', loadToken: loadA });
  const domain = seen.syntaxDomain;
  await act(async () => {
    domain.commands.registerFile('/a/src/utils.ts', 'export function helper() {}\n');
    domain.commands.registerFile('/a/src/app.ts', "import { helper } from './utils';\nhelper();\n");
    domain.commands.connectDiscovered({
      connectionId: 'conn_1',
      sourceFilePath: '/a/src/utils.ts',
      targetFilePath: '/a/src/app.ts',
      moduleSpecifier: './utils',
      importLine: 0,
    });
  });
  assert.ok(domain.selectors.getEdgeIdForConnection('conn_1'), 'project A\'s conn_1 is linked');
  assert.ok(seen.syntaxConnStatuses.has('conn_1'), 'and has a status');

  // Open project B: a new load, whose wire ids start at conn_1 again.
  await render({ projectRoot: '/b', loadToken: {} });

  assert.equal(seen.syntaxDomain.selectors.getEdgeIdForConnection('conn_1'), null, 'B\'s conn_1 is not A\'s edge');
  assert.deepEqual(seen.syntaxDomain.selectors.getAllSyntaxEdges(), []);
  assert.deepEqual(seen.syntaxDomain.selectors.getRegisteredFilesUnder('/a'), [], 'A\'s files are not indexed');
  assert.equal(seen.syntaxConnStatuses.has('conn_1'), false, 'no wire status carried over');
  await act(async () => root.unmount());
});

test('reopening the same project is a new load too', async () => {
  let seen = null;
  function Harness(props) {
    seen = useSyntaxDomainLifecycle({ ...props, readProjectFile: async () => null, writeProjectFile: async () => true });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (props) => act(async () => root.render(createElement(Harness, props)));
  await render({ projectRoot: '/a', loadToken: {} });
  await act(async () => { seen.syntaxDomain.commands.registerFile('/a/x.ts', 'export const x = 1;\n'); });
  await render({ projectRoot: '/a', loadToken: {} });
  assert.equal(seen.syntaxDomain.selectors.getFileStatus('/a/x.ts'), undefined);
  await act(async () => root.unmount());
});

test('a tab closed just before a project switch does not re-index the old project into the new one', async () => {
  // A close re-indexes the file from disk once its read returns (tab-close
  // build plan). Switching projects closes tabs as the index resets, so the
  // read lands after the reset (first review F1, 2026-10-03).
  let seen = null;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const readProjectFile = async () => { await gate; return 'export function old() {}\n'; };
  const writeProjectFile = async () => true;
  function Harness(props) {
    seen = useSyntaxDomainLifecycle({ ...props, readProjectFile, writeProjectFile });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const render = (props) => act(async () => root.render(createElement(Harness, props)));
  await render({ projectRoot: '/a', loadToken: {} });
  let closing;
  await act(async () => {
    seen.syntaxAdapter.onFileOpened('/a/src/utils.js', 'export function old() {}\n');
    closing = seen.syntaxAdapter.onFileClosed('/a/src/utils.js');
  });
  await render({ projectRoot: '/b', loadToken: {} });
  release();
  await act(async () => { await closing; });
  assert.deepEqual(seen.syntaxDomain.selectors.getRegisteredFilesUnder('/a'), [], 'A\'s file stays out of B\'s index');
  await act(async () => root.unmount());
});

test('a late close read from a replaced adapter loses after A → B → A reopens the file with identical text', async () => {
  // Second review (2026-10-03): the adapter is recreated when the project
  // root changes, so a fence kept inside one adapter cannot see a reopen
  // through its replacement. The reopened text is identical on purpose.
  const path = '/a/src/utils.js';
  const current = 'export function current() {}\n';
  for (const late of ['export function stale() {}\n', null]) {
    let seen = null;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let reads = 0;
    const readProjectFile = async () => (++reads === 1 ? gate : current);
    const writeProjectFile = async () => true;
    function Harness(props) {
      seen = useSyntaxDomainLifecycle({ ...props, readProjectFile, writeProjectFile });
      return null;
    }
    const root = createRoot(document.createElement('div'));
    const render = (props) => act(async () => root.render(createElement(Harness, props)));
    await render({ projectRoot: '/a', loadToken: {} });
    let closing;
    await act(async () => {
      seen.syntaxAdapter.onFileOpened(path, current);
      closing = seen.syntaxAdapter.onFileClosed(path);
    });
    await render({ projectRoot: '/b', loadToken: {} });
    await render({ projectRoot: '/a', loadToken: {} });
    await act(async () => { seen.syntaxAdapter.onFileOpened(path, current, { getValue: () => current }); });
    release(late);
    await act(async () => { await closing; });
    const names = seen.syntaxDomain.selectors.getDefinitionsForFile(path).map((d) => d.name);
    assert.deepEqual(names, ['current'], `late read ${late === null ? 'failed' : 'returned stale text'}`);
    await act(async () => root.unmount());
  }
});

test('re-rendering the same load keeps the index', async () => {
  let seen = null;
  function Harness(props) {
    seen = useSyntaxDomainLifecycle({ ...props, readProjectFile: async () => null, writeProjectFile: async () => true });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  const load = {};
  await act(async () => root.render(createElement(Harness, { projectRoot: '/a', loadToken: load })));
  await act(async () => { seen.syntaxDomain.commands.registerFile('/a/x.ts', 'export const x = 1;\n'); });
  await act(async () => root.render(createElement(Harness, { projectRoot: '/a', loadToken: load })));
  assert.equal(seen.syntaxDomain.selectors.getFileStatus('/a/x.ts'), 'ok');
  await act(async () => root.unmount());
});
