import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// Switching projects ends every terminal session of the old project (owner
// ruling, 2026-10-14; track T slice T2a), before its workspace database
// closes. A terminal running a program gets an inline pill first; idle
// shells end without asking. Never a modal.
//
// This drives the REAL useProjectLaunch and useTerminalLifecycle together, as
// the app shell does, with the REAL TerminalDomain and the REAL pill domain.
// Nothing sets the terminal's current project by hand: the tests see what
// the shell's own wiring produces. Tauri's `invoke` is stubbed for the
// database (the ADR-032 stub); the terminal's Tauri calls are faked and
// logged in the same list, so the order is checked across both.

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
const { useTerminalLifecycle } = await import('../../src/terminal/useTerminalLifecycle.js');
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

function mount(backend = terminalBackend(), { guardUnsavedChanges, openFileDialog } = {}) {
  const terminalDomain = createTerminalDomain({ adapters: backend.adapters, setTimer: () => {} });
  const pillDomain = createPillDomain();
  let api = null;
  let current = null;
  const noop = () => {};

  function App() {
    const [projectInstance, setProjectInstance] = useState(null);
    current = projectInstance;
    useTerminalLifecycle({ projectInstance, terminalDomain, showToast: noop });
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
      guardUnsavedChanges,
      openFileDialog,
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
  const started = await app.terminalDomain.commands.startSession();
  assert.equal(started.ok, true);
  assert.equal(app.terminalDomain.selectors.getProject(`inst-${rootPath}`).tabs.length, 1);
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

test('picking another project while the notice waits replaces it', async () => {
  // Opens run one at a time, so a second pick would otherwise queue behind
  // the first notice and do nothing until the person answered it.
  resetBackend();
  const app = mount();
  await openWithTerminal(app, 'A');
  app.backend.busyIds = ['s1'];

  let first;
  let second;
  await act(async () => {
    first = app.launch().handleOpenProjectInstance({ rootPath: 'B' });
  });
  await settle();
  const [firstPill] = app.pillDomain.selectors.getPills();
  assert.ok(firstPill, 'the first pick asks');
  await act(async () => {
    second = app.launch().handleOpenProjectInstance({ rootPath: 'C' });
  });
  await settle();
  await settle();
  const pills = app.pillDomain.selectors.getPills();
  assert.equal(pills.length, 1, 'one notice');
  assert.notEqual(pills[0].id, firstPill.id, 'the notice is the newest pick\'s, at once');
  const opensBefore = commands().filter((c) => c === 'db_open_project').length;
  await act(async () => {
    pills[0].secondary.run();
    await first;
    await second;
  });
  assert.equal(app.project(), 'C');
  assert.equal(commands().filter((c) => c === 'db_open_project').length - opensBefore, 1, 'B was never opened');
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

test('terminals start in whichever project the shell has open', async () => {
  resetBackend();
  const app = mount();
  const startIn = async () => {
    const started = await app.terminalDomain.commands.startSession();
    return started.ok ? started : started.error.code;
  };

  await open(app, 'A');
  assert.equal((await startIn()).ok, true);
  assert.equal(app.terminalDomain.selectors.getProject('inst-A').tabs.length, 1);

  await open(app, 'B');
  assert.equal((await startIn()).ok, true);
  assert.equal(app.terminalDomain.selectors.getProject('inst-B').tabs.length, 1, 'the new tab is B\'s');

  // Reopening the project that is open (File → Open Project… on its own
  // folder) keeps its id and folder; terminals must still start after it.
  await open(app, 'B');
  assert.equal((await startIn()).ok, true, 'a terminal starts in the reopened project');

  await act(async () => {
    await app.launch().handleExitToLauncher();
  });
  assert.equal(await startIn(), 'terminal.no_project', 'none on the launcher');
  app.unmount();
});

function unsavedGuard() {
  const guard = { calls: [], discarded: 0 };
  // Answers Discard: the edits are thrown away, then the transition goes on.
  guard.run = async (reason) => {
    guard.calls.push(reason);
    guard.discarded += 1;
    return true;
  };
  return guard;
}

test('staying in the project after the terminal notice never discards unsaved edits', async () => {
  resetBackend();
  const guard = unsavedGuard();
  const app = mount(terminalBackend(), { guardUnsavedChanges: guard.run });
  await openWithTerminal(app, 'A');
  guard.calls.length = 0;
  guard.discarded = 0;
  app.backend.busyIds = ['s1'];

  for (const start of [
    () => app.launch().handleOpenProjectInstance({ rootPath: 'B' }),
    () => app.launch().handleExitToLauncher()
  ]) {
    let pending;
    await act(async () => {
      pending = start();
    });
    await settle();
    const [pill] = app.pillDomain.selectors.getPills();
    assert.ok(pill, 'the notice is up');
    assert.deepEqual(guard.calls, [], 'no unsaved-changes prompt before the notice is answered');
    await act(async () => {
      app.pillDomain.commands.dismissPill(pill.id);
      await pending;
    });
    assert.equal(guard.discarded, 0, 'the person stayed: nothing was discarded');
    assert.equal(app.project(), 'A');
  }
  app.unmount();
});

test('the unsaved-changes check runs once the terminal notice says go ahead', async () => {
  // The person can keep editing while the notice waits, so the check must
  // come after it, right before the teardown.
  resetBackend();
  const guard = unsavedGuard();
  const app = mount(terminalBackend(), { guardUnsavedChanges: guard.run });
  await openWithTerminal(app, 'A');
  guard.calls.length = 0;
  app.backend.busyIds = ['s1'];

  let switched;
  await act(async () => {
    switched = app.launch().handleOpenProjectInstance({ rootPath: 'B' });
  });
  await settle();
  assert.deepEqual(guard.calls, []);
  await act(async () => {
    app.pillDomain.selectors.getPills()[0].secondary.run();
    await switched;
  });
  assert.deepEqual(guard.calls, ['switch-project']);
  assert.equal(app.project(), 'B');
  app.unmount();
});

test('a single file opened from disk gets terminals in its folder; an untitled one gets none', async () => {
  resetBackend();
  const app = mount(terminalBackend(), {
    openFileDialog: async () => ({ path: '/files/notes.txt', contents: '' })
  });
  await act(async () => {
    await app.launch().handleOpenFileInstance();
  });
  const started = await app.terminalDomain.commands.startSession();
  assert.equal(started.ok, true, 'its shell runs in the file\'s folder');

  await act(async () => {
    app.launch().handleNewFileInstance();
  });
  const refused = await app.terminalDomain.commands.startSession();
  assert.equal(refused.error?.code, 'terminal.no_project', 'an untitled file has no folder');
  app.unmount();
});
