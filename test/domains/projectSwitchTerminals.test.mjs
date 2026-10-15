import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// Switching projects ends every terminal session of the old project (owner
// ruling, 2026-10-14; track T slice T2a), before its workspace database
// closes. A terminal running a program gets an inline pill first; idle
// shells end without asking. Never a modal.
//
// This drives the REAL useProjectLaunch, the REAL TerminalDomain and the REAL
// pill domain. Tauri's `invoke` is stubbed for the database (the ADR-032
// stub); the terminal's Tauri calls are faked and logged in the same list, so
// the order is checked across both.

register('../support/workspace-epoch-stub.mjs', import.meta.url);
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
const { useProjectLaunch } = await import('../../src/app/useProjectLaunch.js');
const { createTerminalDomain } = await import('../../src/terminal/terminalDomain.js');
const { createTerminalEventStream } = await import('../../src/terminal/terminalStorage.js');
const { createPillDomain } = await import('../../src/terminal/pillDomain.js');

let epochCounter = 0;
function resetBackend() {
  globalThis.__EPOCH_CALLS__ = [];
  globalThis.__EPOCH_APPLIED__ = [];
  globalThis.__EPOCH_BACKEND__ = null;
  globalThis.__EPOCH_CHECK__ = () => null;
  globalThis.__EPOCH_OPEN__ = (path) => {
    epochCounter += 1;
    const epoch = `ws-${epochCounter}`;
    globalThis.__EPOCH_BACKEND__ = { epoch, workspace: path };
    return {
      project: { instanceId: `inst-${path}`, name: path },
      pieces: [], groups: [], groupPieces: [], connections: [], editorState: {}, hiddenPaths: [], viewport: null,
      readOnly: false,
      workspaceEpoch: epoch,
    };
  };
}

const logged = (command) => globalThis.__EPOCH_CALLS__.push({ command });
const commands = () => globalThis.__EPOCH_CALLS__.map((call) => call.command);

function terminalBackend() {
  let nextId = 1;
  const backend = {
    busyIds: [],
    adapters: {
      spawn: async (request) => {
        logged('terminal_spawn');
        const channel = { onmessage: null };
        const stream = createTerminalEventStream(channel, { onEvent: request.onEvent });
        return { ok: true, data: { sessionId: `s${nextId++}`, projectId: request.projectId }, stream };
      },
      end: async () => { logged('terminal_session_end'); return { ok: true }; },
      endProject: async () => { logged('terminal_end_project'); return { ok: true }; },
      teardownAll: async () => { logged('terminal_teardown_all'); return { ok: true }; },
      input: async () => ({ ok: true }),
      resize: async () => ({ ok: true }),
      pause: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
      busy: async () => ({ ok: true, data: backend.busyIds }),
      takeReloadReport: async () => ({ ok: true, data: 0 })
    }
  };
  return backend;
}

function mount(backend = terminalBackend()) {
  const terminalDomain = createTerminalDomain({ adapters: backend.adapters, setTimer: () => {} });
  const pillDomain = createPillDomain();
  let api = null;
  let current = null;
  const noop = () => {};

  function App() {
    const [projectInstance, setProjectInstance] = useState(null);
    current = projectInstance;
    api = useProjectLaunch({
      setPieces: noop,
      setNextId: noop,
      setNextGroupId: noop,
      setGroups: noop,
      replaceGroups: noop,
      setHiddenScaffoldPaths: noop,
      setProjectInstance,
      setSelectedGroupId: noop,
      clearSelection: noop,
      projectInstance,
      terminalDomain,
      pillDomain,
      getProjectStorageError: () => null,
      setConnections: noop,
      setNextConnectionIdValue: noop,
      clearHistory: noop,
      showToast: noop,
    });
    return null;
  }

  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(App)));
  return {
    backend,
    terminalDomain,
    pillDomain,
    launch: () => api,
    project: () => current?.name ?? null,
    unmount: () => act(() => root.unmount())
  };
}

async function open(app, rootPath) {
  await act(async () => {
    await app.launch().handleOpenProjectInstance({ rootPath });
  });
}

/** Opens a project and starts one terminal session in it. */
async function openWithTerminal(app, rootPath) {
  await open(app, rootPath);
  app.terminalDomain.commands.setCurrentProject({ id: `inst-${rootPath}`, root: `/projects/${rootPath}` });
  const started = await app.terminalDomain.commands.startSession();
  assert.equal(started.ok, true);
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

test('a switch ends the old project\'s terminals before its database closes', async () => {
  resetBackend();
  const app = mount();
  await openWithTerminal(app, 'A');
  const before = commands().length;

  await open(app, 'B');

  const switchCommands = commands().slice(before);
  const teardown = switchCommands.indexOf('terminal_teardown_all');
  const close = switchCommands.indexOf('db_close_project');
  assert.ok(teardown >= 0 && close > teardown, `terminals end before the database closes: ${switchCommands.join(', ')}`);
  assert.equal(app.terminalDomain.selectors.getProject('inst-A').tabs.length, 0);
  assert.equal(app.pillDomain.selectors.getPills().length, 0, 'idle shells end without a pill');
  assert.equal(app.project(), 'B');
  app.unmount();
});

test('a busy terminal asks first; dismissing the pill keeps the project open', async () => {
  resetBackend();
  const app = mount();
  await openWithTerminal(app, 'A');
  app.backend.busyIds = ['s1'];
  const before = commands().length;

  let switched;
  await act(async () => {
    switched = app.launch().handleOpenProjectInstance({ rootPath: 'B' });
  });
  await settle();
  const [pill] = app.pillDomain.selectors.getPills();
  assert.equal(pill?.message, 'A terminal is still running a command. Switching ends it.');
  assert.equal(pill.secondary.label, 'Switch');

  await act(async () => {
    app.pillDomain.commands.dismissPill(pill.id);
    await switched;
  });
  assert.equal(app.project(), 'A');
  assert.deepEqual(commands().slice(before).filter((c) => c.startsWith('terminal_') || c === 'db_close_project'), []);
  assert.equal(app.terminalDomain.selectors.getProject('inst-A').tabs.length, 1, 'the session keeps running');
  app.unmount();
});

test('the pill\'s Switch goes ahead and ends the busy terminal', async () => {
  resetBackend();
  const app = mount();
  await openWithTerminal(app, 'A');
  app.backend.busyIds = ['s1'];

  let switched;
  await act(async () => {
    switched = app.launch().handleOpenProjectInstance({ rootPath: 'B' });
  });
  await settle();
  await act(async () => {
    app.pillDomain.selectors.getPills()[0].secondary.run();
    await switched;
  });
  assert.equal(app.project(), 'B');
  assert.ok(commands().includes('terminal_teardown_all'));
  assert.equal(app.pillDomain.selectors.getPills().length, 0);
  app.unmount();
});

test('Exit to Launcher asks the same way when a terminal is busy', async () => {
  resetBackend();
  const app = mount();
  await openWithTerminal(app, 'A');
  app.backend.busyIds = ['s1'];

  let exited;
  await act(async () => {
    exited = app.launch().handleExitToLauncher();
  });
  await settle();
  const [pill] = app.pillDomain.selectors.getPills();
  assert.equal(pill?.message, 'A terminal is still running a command. Closing the project ends it.');
  assert.equal(pill.secondary.label, 'Close project');
  await act(async () => {
    pill.secondary.run();
    await exited;
  });
  assert.equal(app.project(), null);
  assert.ok(commands().includes('terminal_teardown_all'));
  app.unmount();
});

test('nothing can start a terminal in a project while it closes', async () => {
  resetBackend();
  const backend = terminalBackend();
  // Hold the terminal teardown open, and try a late start (a pill, a click)
  // from inside it.
  let lateStart = null;
  let app = null;
  backend.adapters.teardownAll = async () => {
    logged('terminal_teardown_all');
    lateStart = await app.terminalDomain.commands.startSession();
    return { ok: true };
  };
  app = mount(backend);
  await openWithTerminal(app, 'A');
  const spawnsBefore = commands().filter((c) => c === 'terminal_spawn').length;

  await open(app, 'B');

  assert.equal(lateStart?.ok, false);
  assert.equal(lateStart.error.code, 'terminal.no_project');
  assert.equal(commands().filter((c) => c === 'terminal_spawn').length, spawnsBefore);
  app.unmount();
});
