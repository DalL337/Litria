import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// ADR-032 D1 regression test.
//
// The defect: `with_workspace_db` had no workspace identity, so every `db_*`
// command resolved to whatever connection was open at the moment it arrived.
// On a project switch the outgoing project's position flush is issued from a
// React effect cleanup, which runs during the commit that installs the NEW
// project — i.e. AFTER `dbOpenProject`. Project A's piece moves therefore
// executed against project B, on row ids that overlap because piece ids are
// per-workspace autoincrement.
//
// The probe that established this (journalled in `.research/`) swept the delay
// between the last piece move and `dbCloseProject`: at 0/100/150/250/290ms the
// flush reached B; from 310ms the 300ms debounce had already flushed safely
// into A. So the window is bounded, but it is ordinary — open a folder, drag a
// piece, switch immediately.
//
// This drives the REAL `useProjectPersistence` and the REAL `dbStorage`
// chokepoint; only Tauri's `invoke` is stubbed, standing in for Rust.

register('../support/workspace-epoch-stub.mjs', import.meta.url);

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
const { useProjectPersistence } = await import('../../src/project/useProjectPersistence.js');
const { dbOpenProject, dbCloseProject } = await import('../../src/project/dbStorage.js');

let epochCounter = 0;

function resetBackend() {
  globalThis.__EPOCH_CALLS__ = [];
  globalThis.__EPOCH_APPLIED__ = [];
  globalThis.__EPOCH_BACKEND__ = null;
  globalThis.__EPOCH_OPEN__ = (path) => {
    epochCounter += 1;
    const epoch = `ws-${epochCounter}`;
    globalThis.__EPOCH_BACKEND__ = { epoch, workspace: path };
    return {
      project: { instanceId: `inst-${epochCounter}`, name: path },
      pieces: [], groups: [], groupPieces: [], connections: [],
      editorState: {}, hiddenPaths: [], viewport: null,
      readOnly: false,
      workspaceEpoch: epoch,
    };
  };
}

const noop = () => {};

function instance(id, root) {
  return { instanceId: id, rootPath: root, manifestPath: `${root}/.litria/workspace.db`, readOnly: false };
}

function mountHarness() {
  let external = null;

  function Harness() {
    const [inst, setInst] = useState(() => instance('A-1', 'C:/tmp/projA'));
    const [pieces, setPieces] = useState([{ id: 1, x: 10, y: 10, filename: 'a.js' }]);
    external = { setInst, setPieces };

    useProjectPersistence({
      projectInstance: inst,
      pieces,
      setPieces,
      piecesById: new Map(pieces.map((p) => [p.id, p])),
      setGroups: noop, setNextGroupId: noop, setNextId: noop, setHiddenScaffoldPaths: noop,
      rebuildAllAdjacencies: noop,
      openTabIds: [], activeTabId: null, tabPaneAssignments: '{}',
      paneSplitRatio: 0.5, setPaneSplitRatio: noop,
      openFromSnapshot: noop, closeTab: noop, configurePersistence: noop,
      setProjectInstanceId: noop,
      projectDomain: { commands: {} },
      viewportScale: 1, viewportOffsetX: 0, viewportOffsetY: 0,
      setViewportScale: noop, setViewportOffsetX: noop, setViewportOffsetY: noop,
      setConnections: noop, setNextConnectionIdValue: noop,
      writeProjectFile: async () => true,
    });
    return null;
  }

  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  return { root, Harness, ref: () => external };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/** The project-switch sequence from `handleOpenProjectInstance`. */
async function switchProject(external, delayMs) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, delayMs));
    await dbCloseProject();
    await dbOpenProject('C:/tmp/projB');
    external().setInst(instance('B-1', 'C:/tmp/projB'));
  });
  await settle();
}

test("a project switch never writes the outgoing project's moves into the incoming one", async () => {
  resetBackend();
  const { root, Harness, ref } = mountHarness();

  await act(async () => { root.render(createElement(Harness)); });
  await settle();
  await act(async () => { await dbOpenProject('C:/tmp/projA'); });

  // Drag a piece in A, then switch inside the 300ms debounce window.
  await act(async () => { ref().setPieces([{ id: 1, x: 999, y: 999, filename: 'a.js' }]); });
  await switchProject(ref, 0);

  const movesIntoB = globalThis.__EPOCH_APPLIED__.filter(
    (applied) => applied.command === 'db_batch_move_pieces' && applied.workspace === 'C:/tmp/projB',
  );
  assert.deepEqual(
    movesIntoB,
    [],
    "D1: the outgoing project's piece moves were applied to the incoming workspace",
  );

  await act(async () => { root.unmount(); });
});

test('the late flush is refused as db.workspace_changed, not as a malformed request', async () => {
  resetBackend();
  const { root, Harness, ref } = mountHarness();

  await act(async () => { root.render(createElement(Harness)); });
  await settle();
  await act(async () => { await dbOpenProject('C:/tmp/projA'); });
  const staleEpoch = globalThis.__EPOCH_BACKEND__.epoch;

  await act(async () => { ref().setPieces([{ id: 1, x: 999, y: 999, filename: 'a.js' }]); });
  await switchProject(ref, 0);

  const lateFlush = [...globalThis.__EPOCH_CALLS__]
    .reverse()
    .find((call) => call.command === 'db_batch_move_pieces');

  assert.ok(lateFlush, 'the cleanup flush must still be attempted — the fence is what stops it');
  assert.equal(
    lateFlush.stamped,
    staleEpoch,
    "the flush must carry the workspace it was issued for, not the one that happens to be open",
  );
  assert.notEqual(
    lateFlush.openEpoch,
    lateFlush.stamped,
    'the flush must arrive after the incoming workspace replaced the outgoing one',
  );

  await act(async () => { root.unmount(); });
});

test('every workspace-scoped write carries the epoch of the workspace it targets', async () => {
  resetBackend();
  const { root, Harness, ref } = mountHarness();

  await act(async () => { root.render(createElement(Harness)); });
  await settle();
  await act(async () => { await dbOpenProject('C:/tmp/projA'); });
  const epochA = globalThis.__EPOCH_BACKEND__.epoch;

  await act(async () => { ref().setPieces([{ id: 1, x: 42, y: 42, filename: 'a.js' }]); });
  await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
  await settle();

  const appliedToA = globalThis.__EPOCH_APPLIED__.filter(
    (applied) => applied.workspace === 'C:/tmp/projA',
  );
  assert.ok(
    appliedToA.length > 0,
    'the fence must not block ordinary writes to the workspace that is actually open',
  );
  for (const call of globalThis.__EPOCH_CALLS__) {
    if (call.command === 'db_open_project' || call.command === 'db_close_project') continue;
    assert.equal(call.stamped, epochA, `${call.command} must be stamped with the open workspace`);
  }

  await act(async () => { root.unmount(); });
});
