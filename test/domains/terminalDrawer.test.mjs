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
    agents: { claude: true, codex: false },
    adapters: {
      spawnAgent: async (request) => {
        calls.push(['spawnAgent', request.projectId, request.agent]);
        const channel = { onmessage: null, emit(event) { this.onmessage?.(event); } };
        const stream = createTerminalEventStream(channel, { onEvent: request.onEvent });
        channels.push(channel);
        const sessionId = `s${nextId++}`;
        return { ok: true, data: { sessionId, projectId: request.projectId }, stream };
      },
      detectAgents: async () => { calls.push(['detectAgents']); return { ok: true, data: { ...backend.agents } }; },
      installGuide: async (agent) => { calls.push(['installGuide', agent]); return { ok: true }; },
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

function Harness({ terminalDomain, pillDomain, projectInstance }) {
  const drawers = useTopDrawers({ terminalDomain, projectInstance });
  return createElement(
    TopDrawerProvider,
    { drawers },
    createElement(TopDrawerShell, { height: 300 }),
    createElement(PillNotification, { pillDomain, terminalDomain })
  );
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

async function mount({ project = PROJECT } = {}) {
  globalThis.__TERMINAL_VIEWS__ = [];
  const backend = fakeBackend();
  const terminalDomain = createTerminalDomain({ adapters: backend.adapters, setTimer: () => {} });
  terminalDomain.commands.setCurrentProject({ id: project.instanceId, root: project.rootPath });
  const pillDomain = createPillDomain();
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(StrictMode, null, createElement(Harness, { terminalDomain, pillDomain, projectInstance: project })));
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
    isInert: () => query('.top-drawer-panel').hasAttribute('inert'),
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
  input.value = 'renamed';
  // Escape, then the blur a browser can fire as the box is removed, before
  // React has re-rendered: neither may commit what was typed.
  await act(async () => {
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  });
  await settle();
  assert.equal(ui.isOpen(), true);
  assert.ok(!ui.query('.terminal-tab-rename'), 'rename box gone');
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

test('closing the drawer from its rail never starts a shell', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('End Terminal 1'));
  assert.equal(ui.tabs().length, 0);
  // The rail button closes the open drawer: no tab, but no new shell either.
  await click(ui.byTitle('Terminal'));
  assert.equal(ui.isOpen(), false);
  assert.equal(ui.spawns(), 1, 'a close is not an open');
  // Opening it again is the person asking for a terminal.
  await click(ui.byTitle('Terminal'));
  assert.equal(ui.spawns(), 2);
  await ui.unmount();
});

test('a closed drawer is out of reach of the keyboard', async () => {
  const ui = await mount();
  assert.equal(ui.isInert(), true, 'closed: inert');
  await click(ui.byTitle('Terminal'));
  assert.equal(ui.isInert(), false, 'open: reachable');
  await click(ui.byLabel('Close panel'));
  assert.equal(ui.isInert(), true, 'hidden again: inert, while its session runs on');
  assert.deepEqual(ui.lifetimeCalls(), []);
  await ui.unmount();
});

test('a session that exits while End is being confirmed drops the question', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  ui.backend.busyIds = ['s1'];
  await click(ui.byLabel('End Terminal 1'));
  assert.match(ui.host.textContent, /End it?/);
  await act(async () => {
    ui.backend.channels[0].emit({ event: 'Exited', data: { exitCode: 0 } });
  });
  assert.doesNotMatch(ui.host.textContent, /End it?/);
  assert.ok(ui.byLabel('Remove Terminal 1'), 'the ended tab can be removed');
  assert.deepEqual(ui.lifetimeCalls(), []);
  await ui.unmount();
});

test('an untitled file says why it has no terminal, and starts none', async () => {
  const ui = await mount({ project: { instanceId: 'litria-untitled', rootPath: '' } });
  await click(ui.byTitle('Terminal'));
  assert.match(ui.host.textContent, /Save this file to a folder to use the terminal/);
  assert.ok(!ui.byLabel('New terminal'), 'no New terminal');
  assert.equal(ui.spawns(), 0);
  await ui.unmount();
});

test('a project that is closing offers no new terminal', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  assert.ok(ui.byLabel('New terminal'));
  await act(async () => {
    ui.terminalDomain.commands.clearCurrentProject();
  });
  assert.ok(!ui.byLabel('New terminal'), 'no New terminal');
  assert.equal(ui.tabs().length, 1, 'its tab still shows until the project ends it');
  await ui.unmount();
});

// "Needs you" (track T slice T2a-2): the drawer reports which tab is on
// screen; a session out of sight that needs the person badges the rail.

const emitTo = (ui, index, chunk) => act(async () => {
  ui.backend.channels[index].emit({ event: 'Output', data: { chunk } });
});
const terminalRail = (ui) => ui.query('.top-drawer-tab');
// A boolean, never the element: a failed assertion on a happy-dom element
// hangs while node:assert formats it.
const hasBadge = (ui) => Boolean(ui.query('.top-drawer-tab .top-drawer-tab-badge'));

test('a hidden session that rings badges the rail; opening from the rail shows it', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('New terminal'));
  await click(ui.tabs()[1]);
  await click(ui.byLabel('Close panel'));
  assert.equal(hasBadge(ui), false);

  await emitTo(ui, 0, 'done\x07');
  assert.equal(hasBadge(ui), true, 'the rail shows that something needs the person');
  assert.equal(terminalRail(ui).getAttribute('title'), 'Terminal: a session needs you');
  assert.match(ui.tabs()[0].className, /needs-you/);

  await click(terminalRail(ui));
  assert.equal(ui.isOpen(), true);
  assert.equal(ui.tabs()[0].getAttribute('aria-selected'), 'true', 'taken to the session that rang');
  assert.equal(hasBadge(ui), false, 'seen');
  assert.doesNotMatch(ui.tabs()[0].className, /needs-you/);
  assert.equal(ui.spawns(), 2, 'opening started nothing');
  await ui.unmount();
});

test('a bell from the tab on screen asks nothing; the same bell with the drawer closed does', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await emitTo(ui, 0, '\x07');
  assert.doesNotMatch(ui.tabs()[0].className, /needs-you/, 'the person is looking at it');
  await click(ui.byLabel('Close panel'));
  assert.equal(hasBadge(ui), false);
  await emitTo(ui, 0, '\x07');
  assert.equal(hasBadge(ui), true, 'out of sight, it needs them');
  await ui.unmount();
});

test("a blocked program's tab says why, in its dot and its tooltip", async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('New terminal'));
  const msg = Buffer.from('Allow edit to src/app.js?').toString('base64');
  await emitTo(ui, 0, `\x1b]7501;state=blocked:app=claude-code:kind=permission:msg=${msg}\x07`);
  const [first] = ui.tabs();
  assert.match(first.querySelector('.terminal-tab-dot').className, /\bis-running\b.*\bis-needs-you\b/);
  assert.equal(
    first.getAttribute('title'),
    'Terminal 1 — Running\nNeeds you: claude-code asks for permission: Allow edit to src/app.js?'
  );
  assert.match(first.textContent, /Needs you\./, 'screen readers hear it too');
  await emitTo(ui, 0, '\x1b]7501;state=working:app=claude-code\x07');
  assert.match(ui.tabs()[0].querySelector('.terminal-tab-dot').className, /\bis-working\b/);
  assert.equal(ui.tabs()[0].getAttribute('title'), 'Terminal 1 — Running\nclaude-code is working');
  await ui.unmount();
});

test("Litria answers a program's status question through that session only", async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('New terminal'));
  await emitTo(ui, 1, '\x1b]7501;?\x07\x1b[c');
  const answers = ui.backend.calls.filter(([op, , , input]) => op === 'input' && input.startsWith('\x1b]7501;?'));
  assert.deepEqual(answers.map(([, projectId, sessionId]) => [projectId, sessionId]), [[PROJECT.instanceId, 's2']]);
  await ui.unmount();
});

// Starting the person's own agent (track T slice T2b-1): a menu beside +.

const startMenu = (ui) => ui.query('.terminal-start-menu');
const menuItem = (ui, label) => [...ui.host.querySelectorAll('.terminal-start-item')]
  .find((item) => item.querySelector('.terminal-start-label')?.textContent === label);

test('+ still starts a shell in one click; the menu beside it offers the agents', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('New terminal'));
  assert.equal(ui.spawns(), 2, 'two shells, no menu');
  assert.equal(Boolean(startMenu(ui)), false);

  await click(ui.byLabel('Start a terminal or an agent'));
  assert.equal(Boolean(startMenu(ui)), true);
  assert.ok(ui.backend.calls.some(([op]) => op === 'detectAgents'), 'it looks when it opens');
  assert.deepEqual(
    [...ui.host.querySelectorAll('.terminal-start-label')].map((label) => label.textContent),
    ['Shell', 'Claude Agent', 'Codex']
  );
  assert.equal(menuItem(ui, 'Claude Agent').disabled, false);
  assert.match(menuItem(ui, 'Claude Agent').textContent, /runs Claude Code/);
  assert.equal(menuItem(ui, 'Codex').disabled, true, 'not installed');
  assert.match(menuItem(ui, 'Codex').textContent, /Not installed/);
  await ui.unmount();
});

test('choosing an agent starts it as a tab of its own', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('Start a terminal or an agent'));
  await click(menuItem(ui, 'Claude Agent'));
  assert.equal(Boolean(startMenu(ui)), false, 'the menu closed');
  assert.deepEqual(ui.backend.calls.filter(([op]) => op === 'spawnAgent'), [['spawnAgent', PROJECT.instanceId, 'claude']]);
  const labels = ui.tabs().map((tab) => tab.querySelector('.terminal-tab-label').textContent);
  assert.deepEqual(labels, ['Terminal 1', 'Claude Agent 1']);
  assert.equal(ui.tabs()[1].getAttribute('aria-selected'), 'true');
  assert.deepEqual(ui.lifetimeCalls(), []);
  await ui.unmount();
});

test("an agent that is not installed offers its maker's install guide and starts nothing", async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('Start a terminal or an agent'));
  const guide = ui.query('.terminal-start-guide');
  assert.ok(guide, 'an install guide for Codex');
  await click(guide);
  assert.deepEqual(ui.backend.calls.filter(([op]) => op === 'installGuide'), [['installGuide', 'codex']]);
  assert.equal(ui.backend.calls.filter(([op]) => op === 'spawnAgent').length, 0);
  assert.equal(Boolean(startMenu(ui)), false);
  await ui.unmount();
});

test('Escape closes the menu and leaves the drawer open; so does a click elsewhere', async () => {
  const ui = await mount();
  await click(ui.byTitle('Terminal'));
  await click(ui.byLabel('Start a terminal or an agent'));
  await key(startMenu(ui), 'Escape');
  assert.equal(Boolean(startMenu(ui)), false);
  assert.equal(ui.isOpen(), true, 'the drawer stayed open');

  await click(ui.byLabel('Start a terminal or an agent'));
  await act(async () => {
    ui.query('.terminal-stack').dispatchEvent(new window.PointerEvent('pointerdown', { bubbles: true }));
  });
  assert.equal(Boolean(startMenu(ui)), false);
  assert.equal(ui.spawns(), 1, 'closing it started nothing');
  await ui.unmount();
});
