import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// The Logs drawer (Actions ▸ Logs) had no way to reach the files it lists.
// `build_log_dir` was written "for the viewer's 'reveal' affordance" but was
// never called, and the webview cannot open a path itself: opener IPC is
// deliberately not granted (capabilityScope.test.mjs). Owner, 2026-10-01:
// wire it up. The folder opens through Rust commands whose target is fixed in
// Rust (`build_log_open_dir`, and the existing `crash_open_logs_dir`), and
// `build_log_dir` supplies the path the drawer shows.
//
// This drives the REAL drawer and the REAL useBuildLogs hook. Only Tauri's
// `invoke` is stubbed.

register('../support/tauri-invoke-stub.mjs', import.meta.url);
register('../support/jsx-hooks.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of [
  'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment',
  'DocumentFragment', 'Event', 'CustomEvent', 'MouseEvent', 'MutationObserver',
  'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'SVGElement',
]) {
  if (dom[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { createBuildLogDomain } = await import('../../src/app/buildLogDomain.js');
const { useBuildLogs } = await import('../../src/app/useBuildLogs.js');
const { default: DrawerContentLogs } = await import('../../src/drawers/DrawerContentLogs.jsx');

const BUILDS_DIR = '/home/alice/.litria/logs/builds';

/** A backend with no stored runs; `opens` decides what the open commands report. */
function installBackend({ buildOpens = true } = {}) {
  const calls = [];
  globalThis.__INVOKE__ = async (command, payload) => {
    calls.push({ command, payload });
    switch (command) {
      case 'build_log_list':
      case 'crash_log_list':
        return [];
      case 'build_log_dir':
        return BUILDS_DIR;
      case 'build_log_open_dir':
        return buildOpens;
      case 'crash_open_logs_dir':
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };
  return calls;
}

function Harness({ domain, initialTab }) {
  const actions = useBuildLogs(domain);
  return createElement(DrawerContentLogs, { buildLogDomain: domain, buildLogActions: actions, initialTab });
}

async function mount(initialTab = 'build') {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(createElement(Harness, { domain: createBuildLogDomain(), initialTab }));
  });
  // Let the mount-time refresh and folder lookup settle.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return {
    host,
    button: (label) => [...host.querySelectorAll('button')].find((b) => b.textContent.trim() === label),
    unmount: () => act(async () => root.unmount()),
  };
}

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

test('Open folder on the Build tab opens the builds folder through Rust', async () => {
  const calls = installBackend();
  const view = await mount('build');
  const open = view.button('Open folder');
  assert.ok(open, 'the drawer has an Open folder button');
  await click(open);
  const opened = calls.filter((c) => c.command.endsWith('_open_dir') || c.command === 'crash_open_logs_dir');
  assert.deepEqual(opened, [{ command: 'build_log_open_dir', payload: {} }], 'no path crosses from the webview');
  await view.unmount();
});

test('Open folder on the Crash tab opens the crash records folder', async () => {
  const calls = installBackend();
  const view = await mount('crash');
  await click(view.button('Open folder'));
  const opened = calls.filter((c) => c.command.endsWith('_open_dir') || c.command === 'crash_open_logs_dir');
  assert.deepEqual(opened.map((c) => c.command), ['crash_open_logs_dir']);
  await view.unmount();
});

test('the Build tab says where its runs are saved (build_log_dir)', async () => {
  const calls = installBackend();
  const view = await mount('build');
  assert.ok(calls.some((c) => c.command === 'build_log_dir'), 'the drawer asks Rust for the folder');
  assert.match(view.host.textContent, /\/home\/alice\/\.litria\/logs\/builds/, 'the empty state names the folder');
  assert.equal(view.button('Open folder').getAttribute('title'), `Open ${BUILDS_DIR}`);
  await view.unmount();
});

test('a folder that cannot be opened says so', async () => {
  installBackend({ buildOpens: false });
  const view = await mount('build');
  await click(view.button('Open folder'));
  assert.match(view.host.textContent, /Couldn.t open the folder/);
  await view.unmount();
});
