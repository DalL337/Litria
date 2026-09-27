import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// Launch reconciliation regression tests (owner report 2026-09-27: "Layout
// change not saved: Failed to create group: UNIQUE constraint failed:
// groups.id (+4 more)" on opening an existing project).
//
// Drives the REAL useProjectPersistence (hydration), useGroupFolderReconciliation
// and GroupDomain, wired the way App.jsx wires them: the id counter is React
// state read through a ref that catches up on render, and groupsRef syncs in an
// effect. Only Tauri's `invoke` is stubbed (the ADR-032 stub, which records
// every db_* command and the workspace it reached).

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

const { act, createElement, useEffect, useMemo, useRef, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useProjectPersistence } = await import('../../src/project/useProjectPersistence.js');
const { useGroupFolderReconciliation } = await import('../../src/app/useGroupFolderReconciliation.js');
const { createGroupDomain } = await import('../../src/app/groupDomain.js');
const { dbOpenProject, dbCloseProject } = await import('../../src/project/dbStorage.js');
const { normalizePath, getBasename } = await import('../../src/utils/path.js');

const silence = console.warn;

// testblank as the owner's workspace.db held it: three groups, and five
// folders on disk that never got one.
const TESTBLANK = {
  root: 'C:/tmp/testblank',
  pieces: [
    { id: 1, filePath: 'src/App.css', x: 0, y: 0 },
    { id: 2, filePath: 'src/App.tsx', x: 200, y: 0 },
    { id: 3, filePath: 'src/main.tsx', x: 400, y: 0 },
  ],
  groups: [
    { id: 'group-1', name: 'src', folderPath: 'src' },
    { id: 'group-2', name: '.vscode', folderPath: '.vscode' },
    { id: 'group-3', name: 'public', folderPath: 'public' },
  ],
  folders: ['src', '.vscode', 'public', 'src/assets', 'src-tauri', 'src-tauri/capabilities', 'src-tauri/icons', 'src-tauri/src'],
};

// A project whose groups' folders do not exist in testblank.
const OTHER = {
  root: 'C:/tmp/other',
  pieces: [{ id: 1, filePath: 'lib/a.js', x: 0, y: 0 }, { id: 2, filePath: 'lib/util/b.js', x: 200, y: 0 }],
  groups: [
    { id: 'group-1', name: 'lib', folderPath: 'lib' },
    { id: 'group-2', name: 'util', folderPath: 'lib/util', parentId: 'group-1' },
  ],
  folders: ['lib', 'lib/util'],
};

const PROJECTS = new Map([[TESTBLANK.root, TESTBLANK], [OTHER.root, OTHER]]);

let epochCounter = 0;
function resetBackend() {
  globalThis.__EPOCH_CALLS__ = [];
  globalThis.__EPOCH_APPLIED__ = [];
  globalThis.__EPOCH_BACKEND__ = null;
  globalThis.__EPOCH_OPEN__ = (path) => {
    epochCounter += 1;
    const epoch = `ws-${epochCounter}`;
    globalThis.__EPOCH_BACKEND__ = { epoch, workspace: path };
    const project = PROJECTS.get(path);
    return {
      project: { instanceId: `inst-${epochCounter}`, name: path },
      pieces: project.pieces.map((p) => ({ ...p })),
      groups: project.groups.map((g) => ({ ...g })),
      groupPieces: [], connections: [], editorState: {}, hiddenPaths: [], viewport: null,
      readOnly: false,
      workspaceEpoch: epoch,
    };
  };
}

const noop = () => {};

function mountApp({ listTree }) {
  let external = null;

  function App() {
    const [inst, setInst] = useState(null);
    const [pieces, setPieces] = useState([]);
    const [groups, setGroups] = useState([]);
    const groupsRef = useRef(groups);
    useEffect(() => { groupsRef.current = groups; }, [groups]);
    const [nextGroupId, setNextGroupId] = useState(1);
    const nextGroupIdRef = useRef(nextGroupId);
    nextGroupIdRef.current = nextGroupId;
    external = { setInst, groups };

    const groupDomain = useMemo(() => createGroupDomain({
      setGroups,
      getGroups: () => groupsRef.current,
      getNextGroupId: () => nextGroupIdRef.current,
      setNextGroupId,
    }), []);
    const projectDomain = useMemo(() => ({ commands: { readFile: async () => '' } }), []);

    const { hydratedLoad } = useProjectPersistence({
      projectInstance: inst,
      pieces,
      setPieces,
      piecesById: new Map(pieces.map((p) => [p.id, p])),
      setGroups, setNextGroupId, setNextId: noop, setHiddenScaffoldPaths: noop,
      rebuildAllAdjacencies: null,
      openTabIds: [], activeTabId: null, tabPaneAssignments: '{}',
      paneSplitRatio: 0.5, setPaneSplitRatio: noop,
      openFromSnapshot: noop, closeTab: noop, configurePersistence: noop,
      setProjectInstanceId: noop,
      projectDomain,
      viewportScale: 1, viewportOffsetX: 0, viewportOffsetY: 0,
      setViewportScale: noop, setViewportOffsetX: noop, setViewportOffsetY: noop,
      setConnections: noop, setNextConnectionIdValue: noop,
      writeProjectFile: async () => true,
    });

    useGroupFolderReconciliation({
      pieces,
      groups,
      groupDomain,
      scaffoldRefreshToken: 0,
      loadToken: hydratedLoad?.token ?? null,
      normalizePath,
      getBasename,
      listTree,
      projectRootPath: hydratedLoad?.rootPath ?? null,
    });
    return null;
  }

  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  return { root, App, ref: () => external };
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function openProject(ref, path) {
  await act(async () => {
    if (globalThis.__EPOCH_BACKEND__) await dbCloseProject();
    const state = await dbOpenProject(path);
    ref().setInst({
      instanceId: state.project.instanceId,
      rootPath: path,
      manifestPath: `${path}/.litria/workspace.db`,
      readOnly: false,
      _dbState: state,
    });
  });
  await settle();
  await settle();
}

const treeOf = (path) => PROJECTS.get(path).folders.map((folder) => ({ path: folder, entryType: 'dir' }));

function groupWrites(workspace) {
  return globalThis.__EPOCH_APPLIED__
    .filter((applied) => applied.workspace === workspace)
    .filter((applied) => applied.command === 'db_create_group' || applied.command === 'db_delete_group');
}

test('opening a project mints one distinct id per missing folder', async () => {
  console.warn = noop;
  resetBackend();
  const { root, App, ref } = mountApp({ listTree: async (path) => treeOf(path) });
  await act(async () => { root.render(createElement(App)); });

  await openProject(ref, TESTBLANK.root);

  const created = groupWrites(TESTBLANK.root).map(({ payload }) => [payload.group.id, payload.group.folderPath]);
  assert.deepEqual(created, [
    ['group-4', 'src/assets'],
    ['group-5', 'src-tauri'],
    ['group-6', 'src-tauri/capabilities'],
    ['group-7', 'src-tauri/icons'],
    ['group-8', 'src-tauri/src'],
  ]);
  assert.equal(new Set(ref().groups.map((g) => g.id)).size, 8, 'eight folders, eight groups in memory');

  await act(async () => { root.unmount(); });
  console.warn = silence;
});

test("a project switch never reconciles the outgoing project's groups against the incoming workspace", async () => {
  console.warn = noop;
  resetBackend();
  const { root, App, ref } = mountApp({ listTree: async (path) => treeOf(path) });
  await act(async () => { root.render(createElement(App)); });

  await openProject(ref, OTHER.root);
  await openProject(ref, TESTBLANK.root);

  const writes = groupWrites(TESTBLANK.root);
  assert.deepEqual(
    writes.filter(({ command }) => command === 'db_delete_group'),
    [],
    "testblank's groups all have folders on disk; a delete there came from the other project's groups",
  );
  assert.deepEqual(
    writes.map(({ payload }) => payload.group?.folderPath),
    ['src/assets', 'src-tauri', 'src-tauri/capabilities', 'src-tauri/icons', 'src-tauri/src'],
  );
  assert.deepEqual(
    ref().groups.map((g) => g.folderPath).sort(),
    [...TESTBLANK.folders].sort(),
  );

  await act(async () => { root.unmount(); });
  console.warn = silence;
});

test('a launch pass cancelled while the tree loads is rerun, not dropped', async () => {
  console.warn = noop;
  resetBackend();
  // Hold every tree read until released: hydration's file-content load
  // re-sets the pieces first, which cancels the pass that is waiting.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let treeReads = 0;
  const listTree = async (path) => { treeReads += 1; await gate; return treeOf(path); };
  const { root, App, ref } = mountApp({ listTree });
  await act(async () => { root.render(createElement(App)); });

  await openProject(ref, TESTBLANK.root);
  assert.ok(treeReads >= 2, 'the cancelled pass was retried on the newer pieces');
  await act(async () => { release(); });
  await settle();

  assert.equal(groupWrites(TESTBLANK.root).length, 5, 'the five missing folders got their groups');
  assert.equal(ref().groups.length, 8);

  await act(async () => { root.unmount(); });
  console.warn = silence;
});
