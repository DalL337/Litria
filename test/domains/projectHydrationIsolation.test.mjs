import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// Project API build plan P2, PR #89 review (2026-09-30): the editor session
// must be restored from the load's OWN pieces, and the bridge's readiness
// signal must never certify a session restored from anything else.
//
// The defect, reproduced by a peer reviewer with this harness's approach and
// confirmed on `main` without the bridge: edit a file in project A, Discard
// (which resets the session but leaves the discarded text on the canvas
// piece), then open project B, which has no pieces but whose saved editor
// state still lists a tab id. B's loader has nothing to await, so it marked
// the load complete inside the same effect pass, and the restore ran with the
// previous render's pieces — A's — restoring A's discarded edit into B's
// fresh session as a closed, dirty tab. One render later the readiness signal
// accepted that restore, and the owner bridge served A's text as B's file.
// A second variant needs no empty project: a cancelled loader from the
// previous load set the shared "loaded" flag, and any re-render then restored
// B's tabs from pieces whose contents had not loaded yet.
//
// This drives the REAL useProjectPersistence, the REAL editor session
// provider and reducer, and the REAL bridge factory. Only disk reads and the
// bridge transport are simulated; the fixtures are read-only, so nothing
// reaches the database layer.

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

const { act, createElement, useMemo, useState } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorSessionProvider, useEditorSession } = await import('../../src/editor/EditorSessionContext.jsx');
const { useProjectPersistence } = await import('../../src/project/useProjectPersistence.js');
const { getSessionDocumentsByPath } = await import('../../src/editor/editorSessionDomain.js');
const { BRIDGE_OPS, createProjectApiBridge, deriveReadyEpoch } = await import('../../src/app/projectApiBridge.js');

const noop = () => {};

function project(name, pieces, openTabIds) {
  return {
    instanceId: name,
    rootPath: name,
    manifestPath: `${name}/.litria/workspace.db`,
    readOnly: true,
    _dbState: {
      workspaceEpoch: `epoch-${name}`,
      pieces: pieces.map((piece) => ({ x: 0, y: 0, ...piece })),
      groups: [], groupPieces: [], connections: [], hiddenPaths: [],
      editorState: {
        open_tab_piece_ids: JSON.stringify(openTabIds),
        active_tab_piece_id: String(openTabIds[0] ?? '')
      }
    }
  };
}

/** Mounts the editor provider and an App-shaped harness around the real hook. */
async function mount(readFile) {
  let latest = null;
  // Stable across renders, like the shell's domain: the hydration effect depends on it.
  const projectDomain = { commands: { readFile } };
  function Harness() {
    const [projectInstance, setProject] = useState(null);
    const [pieces, setPieces] = useState([]);
    const piecesById = useMemo(() => new Map(pieces.map((piece) => [piece.id, piece])), [pieces]);
    const session = useEditorSession();
    const signals = useProjectPersistence({
      projectInstance, pieces, setPieces, piecesById,
      setGroups: noop, setNextGroupId: noop, setNextId: noop, setHiddenScaffoldPaths: noop,
      rebuildAllAdjacencies: null,
      openTabIds: session.openTabIds, activeTabId: session.activeTabId,
      tabPaneAssignments: session.tabPaneAssignments, paneSplitRatio: session.paneSplitRatio,
      setPaneSplitRatio: session.setPaneSplitRatio, openFromSnapshot: session.openFromSnapshot,
      closeTab: session.closeTab, configurePersistence: session.configurePersistence,
      setProjectInstanceId: session.setProjectInstanceId,
      projectDomain,
      viewportScale: 1, viewportOffsetX: 0, viewportOffsetY: 0,
      setViewportScale: noop, setViewportOffsetX: noop, setViewportOffsetY: noop,
      setConnections: noop, setNextConnectionIdValue: noop, writeProjectFile: noop
    });
    latest = { projectInstance, setProject, pieces, setPieces, session, ...signals };
    return null;
  }
  const root = createRoot(dom.document.createElement('div'));
  await act(async () => root.render(createElement(EditorSessionProvider, null, createElement(Harness))));
  return {
    get: () => latest,
    open: (instance) => act(async () => latest.setProject(instance)),
    unmount: () => act(async () => root.unmount())
  };
}

/** The epoch the bridge may answer for now, or null. */
function readyEpoch(harness) {
  const { projectInstance, sessionReadyFor } = harness.get();
  return deriveReadyEpoch(projectInstance, sessionReadyFor);
}

/**
 * One effective `editor.documents` request through the real bridge, bound
 * the way the hook binds it. Null when the bridge is not ready to answer.
 */
async function readThroughBridge(harness, path) {
  const epoch = harness.get().projectInstance._dbState.workspaceEpoch;
  const replies = [];
  const bridge = createProjectApiBridge({
    ports: { sessionDocuments: () => getSessionDocumentsByPath(harness.get().session) },
    getWorkspaceEpoch: () => epoch,
    transport: {
      attach: async () => 'g1',
      detach: async () => true,
      reply: async (_requestId, _generation, text) => { replies.push(text); }
    }
  });
  await bridge.setReadyEpoch(readyEpoch(harness));
  bridge.handleRequest({
    requestId: 'r1', generation: 'g1', epoch, op: BRIDGE_OPS.documents,
    request: { documents: [{ path, maxBytes: 4096 }], maxTextBytes: 4096 }
  });
  await bridge.dispose();
  return replies[0] ?? null;
}

function sessionTexts(harness) {
  return Object.values(harness.get().session.tabsById).flatMap((tab) => [tab.code, tab.workingCode]);
}

test('a discarded edit in A never reaches B through a stale saved tab id', async () => {
  const harness = await mount(async (root, file) => `${root}: ${file} on disk\n`);
  const A = project('project-A', [{ id: 1, filePath: 'main.ts' }], [1]);
  await harness.open(A);
  assert.equal(harness.get().sessionReadyFor, A._dbState, 'A hydrated');
  assert.equal(harness.get().session.tabsById[1].workingCode, 'project-A: main.ts on disk\n');

  // Edit, then Discard — what the unsaved-changes gate does before a switch.
  await act(async () => harness.get().session.updateWorkingCode(1, 'project-A: discarded edit\n'));
  await act(async () => harness.get().session.discardAllTabs());
  assert.equal(harness.get().session.hasDirtyTabs, false);

  // B: no pieces, but its saved editor state still lists tab id 1.
  const B = project('project-B', [], [1]);
  await harness.open(B);

  assert.equal(readyEpoch(harness), 'epoch-project-B', 'B hydrated, so the bridge answers for it');
  assert.deepEqual(harness.get().session.tabsById, {}, 'B restores no tabs: it has no pieces');
  assert.ok(!sessionTexts(harness).some((text) => text.includes('project-A')), 'no A text in B session');
  assert.equal(harness.get().session.hasDirtyTabs, false, 'B has no unsaved changes it never made');

  const reply = await readThroughBridge(harness, 'main.ts');
  assert.ok(reply, 'the bridge answered');
  assert.ok(!reply.includes('project-A'), `the bridge returned A text: ${reply}`);
  assert.equal(JSON.parse(reply).result.documents[0].kind, 'notBuffered');
  await harness.unmount();
});

test('a cancelled loader from the previous load cannot let B restore before its own contents load', async () => {
  // Reads resolve only when the test says so.
  const pending = new Map();
  const readFile = (root, file) => new Promise((resolve) => {
    pending.set(`${root}/${file}`, () => resolve(`${root}: ${file} on disk\n`));
  });
  const release = async (key) => {
    const resolve = pending.get(key);
    assert.ok(resolve, `a read of ${key} is pending`);
    pending.delete(key);
    await act(async () => { resolve(); });
  };
  const harness = await mount(readFile);

  // A starts loading, and the user switches to B before A's read returns.
  await harness.open(project('project-A', [{ id: 1, filePath: 'main.ts' }], [1]));
  const B = project('project-B', [{ id: 1, filePath: 'main.ts' }], [1]);
  await harness.open(B);

  // A's cancelled loader finishes, then anything re-renders B (a canvas
  // change) while B's own read is still pending.
  await release('project-A/main.ts');
  await act(async () => harness.get().setPieces((pieces) => pieces.map((piece) => ({ ...piece, x: piece.x + 1 }))));

  assert.equal(readyEpoch(harness), null, 'B is not ready before its contents load');
  assert.deepEqual(harness.get().session.tabsById, {}, 'no tab is restored from unloaded pieces');
  assert.equal(await readThroughBridge(harness, 'main.ts'), null, 'the bridge does not answer for B yet');

  await release('project-B/main.ts');
  assert.equal(readyEpoch(harness), 'epoch-project-B');
  assert.equal(harness.get().session.tabsById[1]?.workingCode, 'project-B: main.ts on disk\n');
  const reply = await readThroughBridge(harness, 'main.ts');
  assert.ok(!reply.includes('project-A'), `the bridge returned A text: ${reply}`);
  assert.equal(JSON.parse(reply).result.documents[0].text, 'project-B: main.ts on disk\n');
  await harness.unmount();
});
