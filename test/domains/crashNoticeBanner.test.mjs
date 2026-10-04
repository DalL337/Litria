import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// The launcher's crash banner after a Rust panic that aborted the process. The
// panic reached a frame that cannot unwind, so the hook wrote two records half
// a second apart: the real panic, then core::panicking's follow-up "panic in a
// function that cannot unwind". The banner led with the follow-up, which says
// only that the process aborted (1.1.0 pre-release crash test, 2026-10-03).
//
// Renders the REAL CrashNoticeBanner. Only Tauri's `invoke` is stubbed.

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
const { default: CrashNoticeBanner } = await import('../../src/crash/CrashNoticeBanner.jsx');

const CRASHES = '/home/alice/.litria/logs/crashes';
const record = (ts, pid, layer, message) => ({
  fileName: `crash-${ts}-${pid}-${layer}.json`,
  path: `${CRASHES}/crash-${ts}-${pid}-${layer}.json`,
  layer,
  timestamp: new Date(ts).toISOString(),
  message,
  litriaVersion: '1.1.0',
  os: 'Windows',
});

// Startup-scan order: newest first.
const NOTICES = [
  record(1791082155473, 22876, 'rust', 'panic in a function that cannot unwind'),
  record(1791082154956, 22876, 'rust', 'crash_test_panic: intentional dev-only panic to exercise the crash hook'),
  record(1791052609582, 16816, 'unclean-shutdown', 'Litria did not shut down cleanly (last phase: webview-ready).'),
];

test('after a Rust abort, the banner leads with the panic and Report files that panic', async () => {
  const calls = [];
  globalThis.__INVOKE__ = async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'crash_home_dir') return '/home/alice';
    if (command === 'crash_open_report_url') return null;
    throw new Error(`unexpected command ${command}`);
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(CrashNoticeBanner, { notices: NOTICES })); });

  const text = host.querySelector('.crash-banner-text').textContent.replace(/\s+/g, ' ');
  assert.match(text, /Litria backend crashed last time\./);
  assert.match(text, /crash_test_panic: intentional dev-only panic/);
  assert.doesNotMatch(text, /cannot unwind/);
  assert.match(text, /\(\+2 more\)/, 'every record still counts');

  const report = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Report');
  await act(async () => { report.click(); await new Promise((r) => setTimeout(r, 0)); });
  const opened = calls.find((c) => c.command === 'crash_open_report_url');
  assert.ok(opened, 'Report opened an issue URL');
  const body = decodeURIComponent(opened.payload.url);
  assert.match(body, /crash_test_panic: intentional dev-only panic/);
  assert.doesNotMatch(body, /cannot unwind/);

  await act(async () => { root.unmount(); });
  host.remove();
});
