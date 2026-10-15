import test from 'node:test';
import assert from 'node:assert/strict';

import { createTerminalDomain } from '../../src/terminal/terminalDomain.js';
import { createTerminalEventStream } from '../../src/terminal/terminalStorage.js';

// TerminalDomain owns terminal sessions (track T slice T2a): several per
// project, alive until the person ends them or their project closes. Only the
// Tauri calls are faked; every stream here is the REAL event stream, so the
// domain's view of a session (ended, first output) comes through the same
// producer the app uses (test-authoring policy Rule 1).

function fakeChannel() {
  return {
    onmessage: null,
    emit(event) { this.onmessage?.(event); }
  };
}

const output = (chunk) => ({ event: 'Output', data: { chunk } });
const exited = (exitCode) => ({ event: 'Exited', data: { exitCode } });

/** A backend whose spawns resolve when the test says so. */
function fakeBackend() {
  const calls = [];
  const spawns = [];
  let nextId = 1;
  const backend = {
    calls,
    spawns,
    busyIds: [],
    adapters: {
      spawn: (request) => {
        calls.push(['spawn', request.projectId, request.projectRoot, request.cols, request.rows]);
        const channel = fakeChannel();
        const stream = createTerminalEventStream(channel, { onEvent: request.onEvent });
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        const sessionId = `s${nextId++}`;
        spawns.push({
          channel,
          stream,
          sessionId,
          resolve: () => resolve({ ok: true, data: { sessionId, projectId: request.projectId }, stream }),
          fail: (error) => resolve({ ok: false, error })
        });
        return promise;
      },
      end: async (projectId, sessionId) => { calls.push(['end', projectId, sessionId]); return { ok: true }; },
      endProject: async (projectId) => { calls.push(['endProject', projectId]); return { ok: true }; },
      teardownAll: async () => { calls.push(['teardownAll']); return { ok: true }; },
      input: async (projectId, sessionId, input) => { calls.push(['input', projectId, sessionId, input]); return { ok: true }; },
      resize: async (projectId, sessionId, cols, rows) => { calls.push(['resize', projectId, sessionId, cols, rows]); return { ok: true }; },
      pause: async (projectId, sessionId) => { calls.push(['pause', projectId, sessionId]); return { ok: true }; },
      resume: async (projectId, sessionId) => { calls.push(['resume', projectId, sessionId]); return { ok: true }; },
      busy: async () => ({ ok: true, data: backend.busyIds }),
      takeReloadReport: async () => ({ ok: true, data: 2 })
    }
  };
  return backend;
}

function domainWith(backend, options = {}) {
  const domain = createTerminalDomain({ adapters: backend.adapters, ...options });
  domain.commands.setCurrentProject({ id: 'p1', root: '/projects/p1' });
  return domain;
}

/** Starts a session and resolves its spawn. */
async function started(domain, backend, options) {
  const pending = domain.commands.startSession(options);
  backend.spawns[backend.spawns.length - 1].resolve();
  return pending;
}

const tabsOf = (domain, projectId = 'p1') => domain.selectors.getProject(projectId).tabs;

test('a start is refused while no project is current', async () => {
  const backend = fakeBackend();
  const domain = createTerminalDomain({ adapters: backend.adapters });
  const result = await domain.commands.startSession();
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'terminal.no_project');
  assert.deepEqual(backend.calls, []);
});

test('a project holds several sessions; the newest is the one in view', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const a = await started(domain, backend);
  const b = await started(domain, backend);
  assert.equal(a.ok && b.ok, true);
  const view = domain.selectors.getProject('p1');
  assert.deepEqual(view.tabs.map((t) => [t.label, t.status, t.sessionId]), [
    ['Terminal 1', 'running', 's1'],
    ['Terminal 2', 'running', 's2']
  ]);
  assert.equal(view.viewedKey, b.key);
});

test('input, resize, pause and resume reach the right session', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const a = await started(domain, backend);
  const b = await started(domain, backend);
  await domain.commands.sendInput(a.key, 'ls\r');
  await domain.commands.resize(b.key, 120, 40);
  await domain.commands.pauseOutput(a.key);
  await domain.commands.resumeOutput(b.key);
  assert.deepEqual(backend.calls.filter(([op]) => op !== 'spawn'), [
    ['input', 'p1', 's1', 'ls\r'],
    ['resize', 'p1', 's2', 120, 40],
    ['pause', 'p1', 's1'],
    ['resume', 'p1', 's2']
  ]);
});

test('the next session starts at the last size a view measured', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const a = await started(domain, backend);
  await domain.commands.resize(a.key, 132, 33);
  await started(domain, backend);
  assert.deepEqual(backend.calls.filter(([op]) => op === 'spawn').map((c) => c.slice(3)), [[80, 24], [132, 33]]);
});

test('a session that exits is marked ended with no view attached', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  await started(domain, backend);
  backend.spawns[0].channel.emit(output('bye\r\n'));
  backend.spawns[0].channel.emit(exited(3));
  const [tab] = tabsOf(domain);
  assert.equal(tab.status, 'ended');
  assert.equal(tab.exitCode, 3);
  // Input to an ended session goes nowhere.
  assert.equal(await domain.commands.sendInput(tab.key, 'x'), false);
});

test('an exit that arrives before the start resolves still ends the tab', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const pending = domain.commands.startSession();
  backend.spawns[0].channel.emit(exited(1));
  backend.spawns[0].resolve();
  await pending;
  assert.equal(tabsOf(domain)[0].status, 'ended');
});

test('ending a session drops its tab and ends it by session id', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const a = await started(domain, backend);
  const b = await started(domain, backend);
  await domain.commands.endSession(b.key);
  assert.deepEqual(tabsOf(domain).map((t) => t.key), [a.key]);
  assert.equal(domain.selectors.getProject('p1').viewedKey, a.key);
  assert.deepEqual(backend.calls.at(-1), ['end', 'p1', 's2']);
});

test('ending a session that is still starting ends it once the start resolves', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const pending = domain.commands.startSession();
  const [tab] = tabsOf(domain);
  assert.equal(tab.status, 'starting');
  await domain.commands.endSession(tab.key);
  assert.equal(tabsOf(domain).length, 0);
  backend.spawns[0].resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(backend.calls.at(-1), ['end', 'p1', 's1']);
});

test('only an ended tab can be removed, and removing ends nothing', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const a = await started(domain, backend);
  assert.equal(domain.commands.removeSession(a.key), false);
  backend.spawns[0].channel.emit(exited(0));
  assert.equal(domain.commands.removeSession(a.key), true);
  assert.equal(tabsOf(domain).length, 0);
  assert.equal(backend.calls.some(([op]) => op === 'end'), false);
});

test('ensureSession makes one shell for an empty project, however often it is called', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  // StrictMode-style double call, then a third while the first is in flight.
  const first = domain.commands.ensureSession();
  const second = domain.commands.ensureSession();
  const third = domain.commands.ensureSession();
  assert.equal(backend.spawns.length, 1);
  backend.spawns[0].resolve();
  await Promise.all([first, second, third]);
  assert.equal(tabsOf(domain).length, 1);
  // A project that already has a tab gets nothing more.
  assert.equal(await domain.commands.ensureSession(), null);
  assert.equal(backend.spawns.length, 1);
});

test('a command session types its command after the first output', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const timers = [];
  const pending = domain.commands.startSession({ label: 'npm install', initialInput: 'npm install\r' });
  backend.spawns[0].resolve();
  const result = await pending;
  assert.equal(tabsOf(domain)[0].label, 'npm install');
  assert.equal(backend.calls.some(([op]) => op === 'input'), false, 'not before the prompt');
  backend.spawns[0].channel.emit(output('PS C:\\p1> '));
  assert.deepEqual(backend.calls.filter(([op]) => op === 'input'), [['input', 'p1', 's1', 'npm install\r']]);
  backend.spawns[0].channel.emit(output('more'));
  assert.equal(backend.calls.filter(([op]) => op === 'input').length, 1, 'typed once');
  assert.equal(result.ok, true);
  assert.deepEqual(timers, []);
});

test('a command session whose prompt came during the start types at once', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const pending = domain.commands.startSession({ initialInput: 'go version\r' });
  backend.spawns[0].channel.emit(output('$ '));
  backend.spawns[0].resolve();
  await pending;
  assert.deepEqual(backend.calls.filter(([op]) => op === 'input'), [['input', 'p1', 's1', 'go version\r']]);
});

test('a command session with no output types after the fallback delay', async () => {
  const backend = fakeBackend();
  const timers = [];
  const domain = domainWith(backend, { setTimer: (fn, ms) => timers.push([fn, ms]) });
  const pending = domain.commands.startSession({ initialInput: 'pip list\r' });
  backend.spawns[0].resolve();
  await pending;
  assert.equal(timers.length, 1);
  timers[0][0]();
  assert.deepEqual(backend.calls.filter(([op]) => op === 'input'), [['input', 'p1', 's1', 'pip list\r']]);
});

test('teardownAll drops only the tabs that existed when it was called', async () => {
  const backend = fakeBackend();
  let release;
  backend.adapters.teardownAll = () => new Promise((r) => { release = () => r({ ok: true }); });
  const domain = domainWith(backend);
  await started(domain, backend);
  const tearing = domain.commands.teardownAll();
  assert.equal(tabsOf(domain).length, 0);
  // The next project's first session starts before the old teardown replies.
  domain.commands.setCurrentProject({ id: 'p2', root: '/projects/p2' });
  const next = await started(domain, backend);
  release();
  await tearing;
  assert.deepEqual(tabsOf(domain, 'p2').map((t) => t.key), [next.key]);
});

test('endProject drops that project only', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  await started(domain, backend);
  domain.commands.setCurrentProject({ id: 'p2', root: '/projects/p2' });
  await started(domain, backend);
  await domain.commands.endProject('p1');
  assert.equal(tabsOf(domain, 'p1').length, 0);
  assert.equal(tabsOf(domain, 'p2').length, 1);
  assert.deepEqual(backend.calls.at(-1), ['endProject', 'p1']);
});

test('a start that resolves after its project closed ends the new session', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const pending = domain.commands.startSession();
  domain.commands.clearCurrentProject();
  await domain.commands.teardownAll();
  backend.spawns[0].resolve();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.deepEqual(backend.calls.at(-1), ['end', 'p1', 's1']);
  // And nothing new can start while no project is current.
  assert.equal((await domain.commands.startSession()).ok, false);
});

test('a failed start leaves an ended tab that says why', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const pending = domain.commands.startSession();
  backend.spawns[0].fail({ code: 'terminal.session_limit', message: 'A project can have at most 8 terminals.' });
  const result = await pending;
  assert.equal(result.ok, false);
  const [tab] = tabsOf(domain);
  assert.equal(tab.status, 'ended');
  assert.equal(tab.error.code, 'terminal.session_limit');
});

test('busySessions maps the busy session ids to the project tabs', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const a = await started(domain, backend);
  const b = await started(domain, backend);
  backend.busyIds = ['s2'];
  assert.deepEqual(await domain.commands.busySessions('p1'), [{ key: b.key, label: 'Terminal 2' }]);
  assert.equal(await domain.commands.isBusy(a.key), false);
  assert.equal(await domain.commands.isBusy(b.key), true);
});

test('renaming changes the label; viewing changes focus only', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  const a = await started(domain, backend);
  await started(domain, backend);
  domain.commands.renameSession(a.key, '  dev server ');
  domain.commands.setViewedSession('p1', a.key);
  const view = domain.selectors.getProject('p1');
  assert.equal(view.tabs[0].label, 'dev server');
  assert.equal(view.viewedKey, a.key);
  assert.equal(backend.calls.filter(([op]) => op !== 'spawn').length, 0);
});

test('the snapshot is stable until something changes', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  let notified = 0;
  domain.subscribe(() => { notified += 1; });
  const before = domain.selectors.getSnapshot();
  assert.equal(domain.selectors.getSnapshot(), before);
  await started(domain, backend);
  assert.notEqual(domain.selectors.getSnapshot(), before);
  const settled = domain.selectors.getSnapshot();
  const notifiedBefore = notified;
  // Output does not change the snapshot or notify (no per-chunk renders).
  backend.spawns[0].channel.emit(output('lots of output'));
  assert.equal(domain.selectors.getSnapshot(), settled);
  assert.equal(notified, notifiedBefore);
});

test('takeReloadReport returns the count Rust kept', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  assert.equal(await domain.commands.takeReloadReport(), 2);
});

// ---------------------------------------------------------------------------
// createTerminalEventStream: the per-session stream.
// ---------------------------------------------------------------------------

test('the stream buffers early events and replays them in order', () => {
  const channel = fakeChannel();
  const stream = createTerminalEventStream(channel);
  channel.emit(output('banner'));
  channel.emit(output('prompt> '));
  const seen = [];
  stream.subscribe((event) => seen.push(event.data.chunk));
  channel.emit(output('live'));
  assert.deepEqual(seen, ['banner', 'prompt> ', 'live']);
});

test('the replay does not drain: a second view gets the same screen', () => {
  // StrictMode mounts, unmounts and remounts a view in development: the
  // second terminal must not come up blank.
  const channel = fakeChannel();
  const stream = createTerminalEventStream(channel);
  channel.emit(output('banner'));
  const first = [];
  const stop = stream.subscribe((event) => first.push(event.data.chunk));
  stop();
  const second = [];
  stream.subscribe((event) => second.push(event.data.chunk));
  assert.deepEqual(first, ['banner']);
  assert.deepEqual(second, ['banner']);
});

test('a stale unsubscribe never detaches a newer view', () => {
  const channel = fakeChannel();
  const stream = createTerminalEventStream(channel);
  const old = [];
  const stopOld = stream.subscribe((event) => old.push(event.data.chunk));
  const fresh = [];
  stream.subscribe((event) => fresh.push(event.data.chunk));
  stopOld();
  channel.emit(output('x'));
  assert.deepEqual(fresh, ['x']);
  assert.deepEqual(old, []);
});

test('the replay keeps whole chunks up to its limit and says when it dropped some', () => {
  const channel = fakeChannel();
  const stream = createTerminalEventStream(channel, { limit: 10 });
  channel.emit(output('aaaaaa'));
  channel.emit(output('bbbbbb'));
  channel.emit(exited(0));
  const seen = [];
  stream.subscribe((event) => seen.push(event));
  assert.equal(seen.length, 3);
  assert.match(seen[0].data.chunk, /earlier output not kept/);
  assert.equal(seen[1].data.chunk, 'bbbbbb');
  assert.equal(seen[2].event, 'Exited', 'Exited replays last');
});

test('the tap sees every event, with or without a view, and cannot break delivery', () => {
  const channel = fakeChannel();
  const tapped = [];
  const stream = createTerminalEventStream(channel, {
    onEvent: (event) => {
      tapped.push(event.event);
      throw new Error('a broken tap');
    }
  });
  channel.emit(output('a'));
  const seen = [];
  stream.subscribe((event) => seen.push(event.event));
  channel.emit(exited(0));
  assert.deepEqual(tapped, ['Output', 'Exited']);
  assert.deepEqual(seen, ['Output', 'Exited']);
});
