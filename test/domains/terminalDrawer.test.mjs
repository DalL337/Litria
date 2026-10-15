import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// Drawers express the person's focus — "I am here right now" — and never own
// a resource's lifetime (owner ruling, 2026-10-14; track T slice T2a). These
// drive the REAL top drawer shell, the REAL drawer descriptors, the REAL
// terminal drawer, the REAL pill notifications and the REAL TerminalDomain,
// all in StrictMode. Only Tauri's terminal calls are faked, and xterm is
// replaced by a recorder (test/support/terminal-renderer-fake.mjs).

register('../support/jsx-hooks.mjs', import.meta.url);
register('../support/terminal-renderer-fake.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of [
  'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Text', 'Comment',
  'DocumentFragment', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent', 'FocusEvent',
  'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'SVGElement',
]) {
  if (dom[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TopDrawerProvider } = await import('../../src/drawers/TopDrawerContext.jsx');
const { default: TopDrawerShell } = await import('../../src/drawers/TopDrawerShell.jsx');
const { useTopDrawers } = await import('../../src/components/useTopDrawers.jsx');
const { default: PillNotification } = await import('../../src/components/PillNotification.jsx');
const { createTerminalDomain } = await import('../../src/terminal/terminalDomain.js');
const { createTerminalEventStream } = await import('../../src/terminal/terminalStorage.js');
const { createPillDomain } = await import('../../src/terminal/pillDomain.js');

const PROJECT = { instanceId: 'litria-p1', rootPath: '/projects/p1' };
const LIFETIME_CALLS = new Set(['end', 'endProject', 'teardownAll']);

function fakeBackend() {
  const calls = [];
  const channels = [];
  let nextId = 1;
  const backend = {
    calls,
    channels,
    busyIds: [],
    adapters: {
      spawn: async (request) => {
        calls.push(['spawn', request.projectId]);
        const channel = { onmessage: null, emit(event) { this.onmessage?.(event); } };
        const stream = createTerminalEventStream(channel, { onEvent: request.onEvent });
        channels.push(channel);
        const sessionId = `s${nextId++}`;
        return { ok: true, data: { sessionId, projectId: request.projectId }, stream };
      },
      end: async (projectId, sessionId) => { calls.push(['end', projectId, sessionId]); return { ok: true }; },
      endProject: async (projectId) => { calls.push(['endProject', projectId]); return { ok: true }; },
      teardownAll: async () => { calls.push(['teardownAll']); return { ok: true }; },
      input: async (projectId, sessionId, input) => { calls.push(['input', projectId, sessionId, input]); return { ok: true }; },
      resize: async () => ({ ok: true }),
      pause: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
      busy: async () => ({ ok: true, data: backend.busyIds }),
      takeReloadReport: async () => ({ ok: true, data: 0 })
    }
  };
  return backend;
}

function Harness({ terminalDomain, pillDomain }) {
  const drawers = useTopDrawers({ terminalDomain, projectInstance: PROJECT });
  return createElement(
    TopDrawerProvider,
    { drawers },
    createElement(TopDrawerShell, { height: 300 }),
    createElement(PillNotification, { pillDomain, terminalDomain })
  );
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount() {
  globalThis.__TERMINAL_VIEWS__ = [];
  const backend = fakeBackend();
  const terminalDomain = createTerminalDomain({ adapters: backend.adapters, setTimer: () => {} });
  terminalDomain.commands.setCurrentProject({ id: PROJECT.instanceId, root: PROJECT.rootPath });
  const pillDomain = createPillDomain();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(Harness, { terminalDomain, pillDomain })));
  });
  const query = (selector) => host.querySelector(selector);
  const byTitle = (title) => host.querySelector(`button[title="${title}"]`);
  const byLabel = (label) => host.querySelector(`[aria-label="${label}"]`);
  return {
    host,
    backend,
    terminalDomain,
    pillDomain,
    query,
    byTitle,
    byLabel,
    isOpen: () => Boolean(query('.top-drawer-panel.is-open')),
    tabs: () => [...host.querySelectorAll('.terminal-tab')],
    views: () => globalThis.__TERMINAL_VIEWS__.filter((v) => v.mounted),
    lifetimeCalls: () => backend.calls.filter(([op]) => LIFETIME_CALLS.has(op)),
    spawns: () => backend.calls.filter(([op]) => op === 'spawn').length,
    unmount: () => act(async () => root.unmount())
  };
}

async function click(el) {
  assert.ok(el, 'element to click exists');
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
  await settle();
}

async function key(el, keyName) {
  await act(async () => {
    el.dispatchEvent(new window.KeyboardEvent('keydown', { key: keyName, bubbles: true }));
  });
  await settle();
}

test('opening the terminal from its rail starts one shell, once', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  assert.equal(ui.isOpen(), true);
  assert.equal(ui.spawns(), 1, 'one shell, even under StrictMode');
  assert.equal(ui.tabs().length, 1);
  // Closing and reopening a project that has a tab starts nothing more.
  await click(ui.byLabel('Close panel'));
  await click(ui.byTitle('Terminal'));
  assert.equal(ui.spawns(), 1);
  await ui.unmount();
});

test('every way of hiding the drawer leaves the session running and its screen mounted', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  const [view] = ui.views();
  assert.ok(view, 'the session has a screen');
  // StrictMode runs each effect's cleanup once on purpose; count from here.
  const unmountsAtStart = view.unmounts;
  const reopen = () => click(ui.byTitle('Terminal'));

  await click(ui.byLabel('Close panel'));
  assert.equal(ui.isOpen(), false);
  await reopen();
  await click(ui.query('.top-drawer-scrim'));
  assert.equal(ui.isOpen(), false);
  await reopen();
  await key(document, 'Escape');
  assert.equal(ui.isOpen(), false);
  await reopen();
  await click(ui.byTitle('Logs'));
  await click(ui.byTitle('Terminal'));

  assert.deepEqual(ui.lifetimeCalls(), [], 'nothing ended');
  assert.equal(ui.spawns(), 1, 'nothing restarted');
  assert.equal(view.mounted, true);
  assert.equal(view.unmounts, unmountsAtStart, 'the same screen the whole time');
  assert.ok(view.visible.includes(false) && view.visible.at(-1) === true);
  await ui.unmount();
});

test('a second session gets its own screen; only the one in view is shown', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('New terminal'));
  assert.equal(ui.spawns(), 2);
  const [first, second] = ui.views();
  const unmountsAtStart = first.unmounts + second.unmounts;
  assert.equal(first.props.isVisible, false);
  assert.equal(second.props.isVisible, true);
  await click(ui.tabs()[0]);
  assert.equal(first.props.isVisible, true);
  assert.equal(second.props.isVisible, false);
  assert.equal(first.unmounts + second.unmounts, unmountsAtStart, 'switching tabs unmounts nothing');
  assert.equal(first.mounted && second.mounted, true);
  await ui.unmount();
});

test('ending the last session shows the empty state and starts nothing', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('End Terminal 1'));
  assert.deepEqual(ui.lifetimeCalls(), [['end', PROJECT.instanceId, 's1']]);
  assert.equal(ui.tabs().length, 0);
  assert.match(ui.host.textContent, /No terminal is open in this project/);
  await settle();
  assert.equal(ui.spawns(), 1, 'no respawn');
  await ui.unmount();
});

test('a session running a program asks before it ends', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  ui.backend.busyIds = ['s1'];
  await click(ui.byLabel('End Terminal 1'));
  assert.match(ui.host.textContent, /End it\?/);
  assert.deepEqual(ui.lifetimeCalls(), []);
  const button = (label) => [...ui.host.querySelectorAll('.terminal-tab-confirm button')].find((b) => b.textContent === label);
  await click(button('Keep'));
  assert.deepEqual(ui.lifetimeCalls(), []);
  await click(ui.byLabel('End Terminal 1'));
  await click(button('End'));
  assert.deepEqual(ui.lifetimeCalls(), [['end', PROJECT.instanceId, 's1']]);
  await ui.unmount();
});

test('Escape in the rename box cancels the rename and leaves the drawer open', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  const label = ui.query('.terminal-tab-label');
  await act(async () => {
    label.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
  });
  const input = ui.query('.terminal-tab-rename');
  assert.ok(input, 'rename box shown');
  await key(input, 'Escape');
  assert.equal(ui.isOpen(), true);
  assert.equal(ui.query('.terminal-tab-rename'), null);
  assert.equal(ui.query('.terminal-tab-label').textContent, 'Terminal 1');
  await ui.unmount();
});

test('a command pill opens a shell tab of its own and types its command after the prompt', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('Close panel'));
  await act(async () => {
    ui.pillDomain.commands.addPill({ projectId: PROJECT.instanceId, message: 'Install packages?', command: 'npm install' });
  });
  await click(ui.query('.pill-notification-body'));
  assert.equal(ui.isOpen(), true);
  assert.equal(ui.spawns(), 2, 'a new session, not the existing tab');
  assert.deepEqual(ui.tabs().map((t) => t.querySelector('.terminal-tab-label').textContent), ['Terminal 1', 'npm install']);
  assert.equal(ui.backend.calls.some(([op]) => op === 'input'), false, 'nothing typed before the prompt');
  await act(async () => {
    ui.backend.channels[1].emit({ event: 'Output', data: { chunk: 'PS C:\\p1> ' } });
  });
  assert.deepEqual(ui.backend.calls.filter(([op]) => op === 'input'), [['input', PROJECT.instanceId, 's2', 'npm install\r']]);
  await ui.unmount();
});

test('a command pill from another project runs nothing here', async () => {
  const ui = await mount();
  await act(async () => {
    ui.pillDomain.commands.addPill({ projectId: 'litria-other', message: 'Install?', command: 'npm install' });
  });
  await click(ui.query('.pill-notification-body'));
  assert.equal(ui.spawns(), 0);
  await ui.unmount();
});
