import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// Project API build plan P3 (2026-09-30): opening another project must not
// carry the previous project's canvas selection into it.
//
// Selection holds piece ids and the selected group holds a group id. Piece
// ids are per-project autoincrement numbers and group ids repeat across
// projects too, so a selection that survives a switch lands on the NEXT
// project's pieces and groups with the same ids — a selection the user never
// made there. The canvas would show it, and the Project API's
// `workspace.selection` (litria_project_context) would report it as the new
// project's selection.
//
// This drives the REAL useProjectLaunch open handler and the REAL useSelection
// behavior. Only Tauri's `invoke` is stubbed (the ADR-032 stub), so
// dbStorage's open runs for real.

register('../support/workspace-epoch-stub.mjs', import.meta.url);
// The launch hook imports some modules without extensions, as Vite allows.
register('../support/jsx-hooks.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of [
  'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment',
  'DocumentFragment', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage', 'ResizeObserver',
]) {
  if (dom[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: useSelection } = await import('../../src/behaviors/useSelection.js');
const { useProjectLaunch } = await import('../../src/app/useProjectLaunch.js');

let epochCounter = 0;
function resetBackend() {
  globalThis.__EPOCH_CALLS__ = [];
  globalThis.__EPOCH_APPLIED__ = [];
  globalThis.__EPOCH_BACKEND__ = null;
  globalThis.__EPOCH_OPEN__ = (path) => {
    epochCounter += 1;
    const epoch = `ws-${epochCounter}`;
    globalThis.__EPOCH_BACKEND__ = { epoch, workspace: path };
    // Both projects use the same small ids, as real workspaces do.
    return {
      project: { instanceId: `inst-${path}`, name: path },
      pieces: [1, 2, 3].map((id) => ({ id, filePath: `${path}-${id}.ts`, x: 0, y: 0 })),
      groups: [{ id: 'group-1', name: 'g', folderPath: 'g' }],
      groupPieces: [], connections: [], editorState: {}, hiddenPaths: [], viewport: null,
      readOnly: false,
      workspaceEpoch: epoch,
    };
  };
}

const noop = () => {};

function mount() {
  const renders = [];
  let api = null;

  function App() {
    const selection = useSelection();
    const [selectedGroupId, setSelectedGroupId] = useState(null);
    const [projectInstance, setProjectInstance] = useState(null);
    const launch = useProjectLaunch({
      setPieces: noop,
      setNextId: noop,
      setNextGroupId: noop,
      setGroups: noop,
      replaceGroups: noop,
      setHiddenScaffoldPaths: noop,
      setProjectInstance,
      setSelectedGroupId,
      clearSelection: selection.clear,
      projectInstance,
      getProjectStorageError: () => null,
      setConnections: noop,
      setNextConnectionIdValue: noop,
      clearHistory: noop,
    });
    renders.push({
      project: projectInstance?.name ?? null,
      selected: [...selection.selectedIds],
      group: selectedGroupId,
    });
    api = { selection, setSelectedGroupId, launch };
    return null;
  }

  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(App)));
  return { api: () => api, renders, unmount: () => act(() => root.unmount()) };
}

test('opening another project clears the canvas selection and the selected group', async () => {
  resetBackend();
  const app = mount();
  await act(async () => { await app.api().launch.handleOpenProjectInstance({ rootPath: 'A' }); });
  act(() => {
    app.api().selection.selectMultiple([1, 3]);
    app.api().setSelectedGroupId('group-1');
  });
  assert.deepEqual(app.renders.at(-1), { project: 'A', selected: [1, 3], group: 'group-1' });

  await act(async () => { await app.api().launch.handleOpenProjectInstance({ rootPath: 'B' }); });

  assert.deepEqual(app.renders.at(-1), { project: 'B', selected: [], group: null });
  const leaked = app.renders.filter((render) => render.project === 'B' && (render.selected.length || render.group));
  assert.deepEqual(leaked, [], 'no render ever showed project B with project A\'s selection');
  app.unmount();
});

test('reopening the same project starts with an empty selection too', async () => {
  resetBackend();
  const app = mount();
  await act(async () => { await app.api().launch.handleOpenProjectInstance({ rootPath: 'A' }); });
  act(() => { app.api().selection.select(2); });
  await act(async () => { await app.api().launch.handleOpenProjectInstance({ rootPath: 'A' }); });
  assert.deepEqual(app.renders.at(-1).selected, []);
  app.unmount();
});
