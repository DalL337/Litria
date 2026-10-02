import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// P4 gate item 2 (2026-10-01, seen live during P3): opening a project tore the
// current one down BEFORE the new open could fail. Terminals, language
// servers, diagnostics, undo history and the workspace database were all gone,
// yet the window kept showing the old project, with a closed workspace behind
// it, after an open of a bad path (a deleted recent, a typo). Owner ruling: a
// path that cannot be a project is refused BEFORE teardown, and an open that
// fails AFTER teardown lands on the launcher.
//
// This drives the REAL useProjectLaunch. Only Tauri's `invoke` is stubbed
// (the ADR-032 stub), so dbStorage runs for real.

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
const { useProjectLaunch } = await import('../../src/app/useProjectLaunch.js');

/** What Rust's CommandError serializes to; `invoke` rejects with it. */
function notADirectory(path) {
  return { category: 'NotFound', code: 'db.open.not_dir', message: `Project path is not a directory: ${path}` };
}

let epochCounter = 0;
/**
 * `missing` is not a directory: the preflight and the open both refuse it.
 * `corrupt` is a directory, so the preflight passes, but the open fails (a
 * workspace database that will not open).
 */
function resetBackend() {
  globalThis.__EPOCH_CALLS__ = [];
  globalThis.__EPOCH_APPLIED__ = [];
  globalThis.__EPOCH_BACKEND__ = null;
  globalThis.__EPOCH_CHECK__ = (path) => {
    if (path === 'missing') throw notADirectory(path);
    return null;
  };
  globalThis.__EPOCH_OPEN__ = (path) => {
    if (path === 'missing') throw notADirectory(path);
    if (path === 'corrupt') throw { category: 'Io', code: 'db.open_failed', message: 'file is not a database' };
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

function commands() {
  return globalThis.__EPOCH_CALLS__.map((call) => call.command);
}

function mount() {
  const renders = [];
  const toasts = [];
  let api = null;
  const noop = () => {};

  function App() {
    const [projectInstance, setProjectInstance] = useState(null);
    const launch = useProjectLaunch({
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
      getProjectStorageError: () => null,
      setConnections: noop,
      setNextConnectionIdValue: noop,
      clearHistory: noop,
      showToast: (message, opts) => toasts.push({ message, severity: opts?.severity }),
    });
    renders.push(projectInstance?.name ?? null);
    api = launch;
    return null;
  }

  const root = createRoot(document.createElement('div'));
  act(() => root.render(createElement(App)));
  return { launch: () => api, renders, toasts, unmount: () => act(() => root.unmount()) };
}

async function open(app, rootPath) {
  let error = null;
  await act(async () => {
    try {
      await app.launch().handleOpenProjectInstance({ rootPath });
    } catch (e) {
      error = e;
    }
  });
  return error;
}

test('a path that is not a project folder leaves the open project untouched', async () => {
  resetBackend();
  const app = mount();
  assert.equal(await open(app, 'A'), null);
  const before = commands().length;

  const error = await open(app, 'missing');

  assert.match(error?.message ?? '', /not a directory/, 'the caller gets the reason');
  assert.equal(app.renders.at(-1), 'A', 'still showing project A');
  assert.deepEqual(globalThis.__EPOCH_BACKEND__?.workspace, 'A', "A's workspace is still open");
  assert.equal(commands().slice(before).includes('db_close_project'), false, 'nothing was torn down');
  app.unmount();
});

test('the path is checked before the current project is torn down', async () => {
  resetBackend();
  const app = mount();
  await open(app, 'A');
  const before = commands().length;

  assert.equal(await open(app, 'B'), null);

  const switching = commands().slice(before);
  assert.ok(switching.includes('db_check_project_path'), `checked: ${switching.join(', ')}`);
  assert.ok(
    switching.indexOf('db_check_project_path') < switching.indexOf('db_close_project'),
    `check before teardown: ${switching.join(', ')}`,
  );
  assert.equal(app.renders.at(-1), 'B');
  app.unmount();
});

test('an open that fails after teardown lands on the launcher', async () => {
  resetBackend();
  const app = mount();
  await open(app, 'A');

  const error = await open(app, 'corrupt');

  assert.match(error?.message ?? '', /not a database/, 'the caller gets the reason');
  assert.equal(app.renders.at(-1), null, 'the launcher, not a project with a closed workspace');
  assert.equal(globalThis.__EPOCH_BACKEND__, null);
  app.unmount();
});

test('a failed switch from the project switcher reports the error', async () => {
  resetBackend();
  const app = mount();
  await open(app, 'A');

  await act(async () => {
    await app.launch().handleSwitchProject({ rootPath: 'missing' });
  });

  assert.equal(app.toasts.length, 1, 'one error toast');
  assert.equal(app.toasts[0].severity, 'error');
  assert.match(app.toasts[0].message, /not a directory/);
  assert.equal(app.renders.at(-1), 'A');
  app.unmount();
});

// ---------------------------------------------------------------------------
// P4 (Codex residual, owner ruling 2026-10-01): opens had no fence. A second
// open started while the first was still opening ran its own teardown and
// open in between, so the two finished in either order: the window ended on
// whichever open FINISHED last, not the one the user asked for last, and the
// loser was replaced without its teardown (its terminals and language
// servers never stopped). Opens now run one at a time, newest request wins.
// ---------------------------------------------------------------------------

/** B's database takes a while to open: it answers only when released. */
function holdOpen(path) {
  const inner = globalThis.__EPOCH_OPEN__;
  let release = null;
  globalThis.__EPOCH_OPEN__ = (p) => {
    if (p !== path) return inner(p);
    return new Promise((resolve, reject) => {
      release = () => { try { resolve(inner(p)); } catch (e) { reject(e); } };
    });
  };
  return () => release?.();
}

test('a second open waits for the one in flight, and the last one asked for wins', async () => {
  resetBackend();
  const app = mount();
  await open(app, 'A');
  const releaseB = holdOpen('B');
  const before = commands().length;

  let openingB;
  let openingC;
  await act(async () => {
    openingB = app.launch().handleOpenProjectInstance({ rootPath: 'B' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
    openingC = app.launch().handleOpenProjectInstance({ rootPath: 'C' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    releaseB();
    await openingB;
    await openingC;
  });

  assert.equal(app.renders.at(-1), 'C', 'the window ends on the project asked for last');
  assert.equal(globalThis.__EPOCH_BACKEND__?.workspace, 'C', 'and so does the workspace');
  const seq = commands().slice(before).filter((c) => c === 'db_open_project' || c === 'db_close_project');
  assert.deepEqual(seq, ['db_close_project', 'db_open_project', 'db_close_project', 'db_open_project'],
    'A closed, B opened, B closed (its teardown ran), C opened — never interleaved');
  app.unmount();
});

test('of several opens queued behind one in flight, only the newest runs', async () => {
  resetBackend();
  const app = mount();
  await open(app, 'A');
  const releaseB = holdOpen('B');
  const before = commands().length;

  const pending = [];
  await act(async () => {
    pending.push(app.launch().handleOpenProjectInstance({ rootPath: 'B' }).catch((e) => e));
    await new Promise((r) => setTimeout(r, 0));
    pending.push(app.launch().handleOpenProjectInstance({ rootPath: 'C' }).catch((e) => e));
    pending.push(app.launch().handleOpenProjectInstance({ rootPath: 'D' }).catch((e) => e));
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    releaseB();
    await Promise.all(pending);
  });

  assert.equal(app.renders.at(-1), 'D');
  const opened = globalThis.__EPOCH_CALLS__.slice(before)
    .filter((c) => c.command === 'db_open_project').map((c) => c.payload.path);
  assert.deepEqual(opened, ['B', 'D'], 'C was superseded before its turn and never opened');
  app.unmount();
});

test('from the launcher, an open queued behind another tears that one down first', async () => {
  resetBackend();
  const app = mount(); // nothing open: the launcher
  const releaseB = holdOpen('B');

  let openingB;
  let openingC;
  await act(async () => {
    openingB = app.launch().handleOpenProjectInstance({ rootPath: 'B' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
    openingC = app.launch().handleOpenProjectInstance({ rootPath: 'C' }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 0));
  });
  await act(async () => {
    releaseB();
    await openingB;
    await openingC;
  });

  assert.equal(app.renders.at(-1), 'C');
  const seq = commands().filter((c) => c === 'db_open_project' || c === 'db_close_project');
  assert.deepEqual(seq, ['db_open_project', 'db_close_project', 'db_open_project'],
    'B is closed before C opens, though C was asked for while the launcher showed nothing open');
  app.unmount();
});
