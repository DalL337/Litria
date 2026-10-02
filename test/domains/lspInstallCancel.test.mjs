import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// `lsp_cancel_install` existed in Rust (ADR-005 build plan: an AtomicBool
// checked in the download loop) but nothing could call it, and the backend
// reported a cancel as an ordinary download failure. The RFC and PRD designed
// a progress readout and a Cancel button for every install. Owner,
// 2026-10-01: wire it up.
//
// This drives the REAL useManagedServerOffers hook, pill domain and progress
// hook. Only Tauri's `invoke` and `listen` are stubbed.

register('../support/tauri-invoke-stub.mjs', import.meta.url);
register('../support/jsx-hooks.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Event', 'MouseEvent', 'SVGElement', 'getComputedStyle']) {
  if (dom[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { createPillDomain } = await import('../../src/terminal/pillDomain.js');
const { useManagedServerOffers } = await import('../../src/app/useManagedServerOffers.js');
const { useInstallProgress } = await import('../../src/app/useInstallProgress.js');
const { lspCancelInstall } = await import('../../src/lsp/lspClient.js');
const {
  INSTALL_CANCELLED_CODE,
  formatInstallProgress,
  isInstallCancelled,
} = await import('../../src/lsp/installProgress.js');

const PAYLOAD = {
  platformKey: 'windows-x64',
  installed: {},
  registry: {
    version: 1,
    servers: {
      rust: {
        name: 'Rust',
        extensions: ['.rs'],
        server: 'rust-analyzer',
        version: '2026-07-06',
        command: 'rust-analyzer',
        args: [],
        artifacts: {
          'windows-x64': {
            url: 'https://github.com/rust-lang/rust-analyzer/releases/download/2026-07-06/x.zip',
            sha256: 'ab'.repeat(32),
          },
        },
      },
    },
  },
};

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

/**
 * A backend whose install stays pending until the test settles it, and whose
 * cancel rejects the pending install the way Rust does (lsp.install.cancelled).
 */
function installBackend() {
  const calls = [];
  let settle = null;
  globalThis.__LISTENERS__ = new Map();
  globalThis.__INVOKE__ = async (command, payload) => {
    calls.push({ command, payload });
    if (command === 'lsp_get_registry') return PAYLOAD;
    if (command === 'lsp_install_server') {
      return new Promise((resolve, reject) => { settle = { resolve, reject }; });
    }
    if (command === 'lsp_cancel_install') {
      settle?.reject({
        category: 'Conflict',
        code: 'lsp.install.cancelled',
        message: `The ${payload.serverId} install was cancelled. Nothing was installed.`,
      });
      return true;
    }
    throw new Error(`unexpected command ${command}`);
  };
  return { calls, settle: () => settle };
}

async function mountOffers(pillDomain) {
  function Harness() {
    useManagedServerOffers({
      projectInstance: { instanceId: 'p1', rootPath: '/home/alice/demo' },
      activeFilenames: ['main.rs'],
      pillDomain,
    });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Harness)));
  await flush();
  return root;
}

const pills = (domain) => domain.selectors.getPills();

async function startInstall() {
  const backend = installBackend();
  const pillDomain = createPillDomain();
  const root = await mountOffers(pillDomain);
  const [offer] = pills(pillDomain);
  assert.ok(offer?.action, 'opening main.rs raises the install offer');
  pillDomain.commands.dismissPill(offer.id);
  await act(async () => { offer.action(); });
  await flush();
  const [progress] = pills(pillDomain);
  return { backend, pillDomain, root, progress };
}

// --- pure helpers -----------------------------------------------------------

test('install progress reads as a percentage of the size when the size is known', () => {
  assert.equal(formatInstallProgress({ receivedBytes: 15_728_640, totalBytes: 47_185_920 }), '33% (15.0 of 45.0 MB)');
  assert.equal(formatInstallProgress({ receivedBytes: 15_728_640, totalBytes: null }), '15.0 MB');
  assert.equal(formatInstallProgress(null), null);
});

test('a cancelled install is told apart from a failed one by its code', () => {
  assert.equal(INSTALL_CANCELLED_CODE, 'lsp.install.cancelled');
  assert.equal(isInstallCancelled({ code: 'lsp.install.cancelled', message: 'x' }), true);
  assert.equal(isInstallCancelled({ code: 'lsp.install.download_failed', message: 'install cancelled' }), false);
  assert.equal(isInstallCancelled(new Error('nope')), false);
});

test('lspCancelInstall names the server, not the language', async () => {
  const { calls } = installBackend();
  await lspCancelInstall('rust-analyzer');
  assert.deepEqual(calls, [{ command: 'lsp_cancel_install', payload: { serverId: 'rust-analyzer' } }]);
});

// --- the consent pill --------------------------------------------------------

test('the progress pill offers Cancel, and Cancel stops that server\'s install', async () => {
  const { backend, pillDomain, root, progress } = await startInstall();
  assert.equal(progress.secondary?.label, 'Cancel', 'the progress pill carries a Cancel button');

  await act(async () => { progress.secondary.run(); });
  await flush();

  const cancels = backend.calls.filter((c) => c.command === 'lsp_cancel_install');
  assert.deepEqual(cancels.map((c) => c.payload), [{ serverId: 'rust-analyzer' }]);
  const after = pills(pillDomain);
  assert.equal(after.length, 1, 'the progress pill is replaced by one outcome pill');
  assert.equal(after[0].severity, 'info', 'a cancel is not reported as an error');
  assert.match(after[0].message, /cancelled/i);
  assert.match(after[0].message, /nothing was installed/i);
  await act(async () => root.unmount());
});

test('the progress pill shows the download as it arrives', async () => {
  const { pillDomain, root, progress, backend } = await startInstall();
  await act(async () => {
    globalThis.__EMIT__('lsp:download-progress', { serverId: 'clangd', receivedBytes: 1, totalBytes: 2 });
    globalThis.__EMIT__('lsp:download-progress', { serverId: 'rust-analyzer', receivedBytes: 15_728_640, totalBytes: 47_185_920 });
  });
  const shown = pills(pillDomain).find((p) => p.id === progress.id);
  assert.match(shown.message, /33% \(15\.0 of 45\.0 MB\)/, 'its own server\'s progress, not another\'s');
  backend.settle().resolve({ server: 'rust-analyzer', version: '2026-07-06' });
  await flush();
  await act(async () => root.unmount());
});

test('a failed install is still reported as a failure', async () => {
  const { pillDomain, root, backend } = await startInstall();
  await act(async () => {
    backend.settle().reject({ category: 'Internal', code: 'lsp.install.download_failed', message: 'download failed (timeout)' });
  });
  await flush();
  const [outcome] = pills(pillDomain);
  assert.equal(outcome.severity, 'error');
  assert.match(outcome.message, /install failed: download failed \(timeout\)/);
  await act(async () => root.unmount());
});

// --- the Preferences progress hook ------------------------------------------

test('useInstallProgress follows one server\'s download and nothing else', async () => {
  installBackend();
  let seen = null;
  function Probe({ serverId }) {
    seen = useInstallProgress(serverId);
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe, { serverId: 'rust-analyzer' })));
  await flush();
  assert.equal(seen, null, 'nothing before the first event');

  await act(async () => {
    globalThis.__EMIT__('lsp:download-progress', { serverId: 'clangd', receivedBytes: 5, totalBytes: 10 });
  });
  assert.equal(seen, null, 'another server\'s progress is ignored');

  await act(async () => {
    globalThis.__EMIT__('lsp:download-progress', { serverId: 'rust-analyzer', receivedBytes: 5, totalBytes: 10 });
  });
  assert.deepEqual(seen, { serverId: 'rust-analyzer', receivedBytes: 5, totalBytes: 10 });

  await act(async () => root.render(createElement(Probe, { serverId: null })));
  assert.equal(seen, null, 'no server, no progress');
  await act(async () => root.unmount());
  assert.equal(globalThis.__LISTENERS__.get('lsp:download-progress')?.size ?? 0, 0, 'the listener is removed');
});

// --- Preferences ▸ Language servers ------------------------------------------
// The panel has no DOM test harness (preferencesPanelShell.test.mjs holds its
// contracts by text); its behaviour is checked in headless Chrome. These pin
// the wiring that a refactor could silently drop.

test('Preferences installs track the SERVER id and offer Cancel for that server', async () => {
  const { readFileSync } = await import('node:fs');
  const jsx = readFileSync(new URL('../../src/components/PreferencesPanel.jsx', import.meta.url), 'utf8');
  const installs = jsx.match(/\{ installServer: row\.server \}/g) ?? [];
  assert.equal(installs.length, 2, 'Install and Update both register the server being installed');
  assert.match(jsx, /useInstallProgress\(installingServer\)/, 'progress follows the server being installed');
  assert.match(jsx, /onClick=\{\(\) => cancelServerInstall\(row\.server\)\}/, 'Cancel names the server, not the language');
  assert.match(jsx, /isInstallCancelled\(actionError\)/, 'a cancel is a notice, not an error');
});

test('a pill with a secondary action renders it as a button that runs without dismissing', async () => {
  const { TopDrawerProvider } = await import('../../src/drawers/TopDrawerContext.jsx');
  const { default: PillNotification } = await import('../../src/components/PillNotification.jsx');
  const pillDomain = createPillDomain();
  let ran = 0;
  pillDomain.commands.addPill({
    projectId: 'p1',
    message: 'Installing rust-analyzer 2026-07-06 — 33% (15.0 of 45.0 MB)',
    secondary: { label: 'Cancel', run: () => { ran += 1; } },
  });
  pillDomain.commands.addPill({ projectId: 'p1', message: 'Build finished' });

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => root.render(
    createElement(TopDrawerProvider, { drawers: [] }, createElement(PillNotification, { pillDomain, terminalDomain: null }))
  ));

  const buttons = [...host.querySelectorAll('.pill-notification-secondary')];
  assert.deepEqual(buttons.map((b) => b.textContent), ['Cancel'], 'only the pill that has one shows it');
  await act(async () => {
    buttons[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(ran, 1);
  assert.equal(pillDomain.selectors.getPills().length, 2, 'the pill stays until its owner replaces it');
  await act(async () => root.unmount());
});
