import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// `check_scaffold_prerequisites` existed but nothing called it (owner,
// 2026-10-01: wire it up). The wizard offered package managers from recipe
// EVIDENCE only, never from the machine, so a pnpm or Yarn that is missing
// (or Yarn Classic, which the run refuses) surfaced only after Create, after
// the registry age-gate's network call; a Tauri project created without Rust
// was never warned that it cannot run. The check now uses the run's own
// resolver (`resolve_pm`), so the wizard and the run cannot disagree.
//
// Drives the real wizard in happy-dom with an injected runtime (no Tauri),
// like wizardComponent.test.mjs; plus the plan derivation directly.

register('../support/jsx-hooks.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of [
  'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
  'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'SVGElement', 'Event', 'CustomEvent', 'KeyboardEvent',
  'MouseEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'localStorage', 'DOMParser', 'HTMLIFrameElement', 'ResizeObserver',
]) {
  if (dom[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: NewProjectWizard } = await import('../../src/components/NewProjectWizard.jsx');
const { buildScaffoldPlan } = await import('../../src/scaffold/scaffoldPlan.js');

const PNPM_MISSING = 'pnpm is not installed. Run: npm install -g pnpm';
const YARN_CLASSIC = 'yarn 1.22.22 is not supported: Litria\'s yarn recipes need yarn 4+ (this is yarn 1.x). Upgrade — for Yarn: `corepack enable && yarn set version stable` — or pick npm.';
const NO_RUST = 'Litria can create the project without it, but running a Tauri app needs the Rust toolchain (https://rustup.rs).';

const tool = (name, available, extra = {}) => ({ name, available, version: null, source: null, required: true, detail: null, ...extra });

/** What Rust answers for this machine: npm fine, pnpm missing, Yarn Classic; no cargo. */
function machine(args) {
  const tools = [tool('Node.js', true)];
  let ready = true;
  let message = null;
  if (args.manager === 'npm') tools.push(tool('npm', true, { source: 'bundled' }));
  if (args.manager === 'pnpm') { tools.push(tool('pnpm', false, { detail: PNPM_MISSING })); ready = false; message = PNPM_MISSING; }
  if (args.manager === 'yarn') { tools.push(tool('yarn', false, { detail: YARN_CLASSIC })); ready = false; message = YARN_CLASSIC; }
  if (args.wrapper === 'tauri') tools.push(tool('Rust toolchain', false, { required: false, detail: NO_RUST }));
  return { ready, tools, message };
}

function makeRuntime({ invokeImpl }) {
  class Channel { constructor() { this.onmessage = null; } }
  return {
    core: async () => ({ invoke: invokeImpl, Channel }),
    dialog: async () => ({ open: async () => null }),
    lsp: async () => ({ detectPythonInterpreters: async () => ({ interpreters: [], excluded: [], uvAvailable: false }) }),
  };
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(globalThis.HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, value); else input.value = value;
  input.dispatchEvent(new dom.Event('input', { bubbles: true }));
}

function button(container, text) {
  return Array.from(container.querySelectorAll('button')).find((b) => b.textContent.trim().startsWith(text)) ?? null;
}

async function openWizardOn(wrapperLabel, invokeImpl) {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(NewProjectWizard, {
      onDone: async () => {}, onCancel: () => {}, defaultFolder: 'C:\\projects', platform: 'windows',
      runtime: makeRuntime({ invokeImpl }),
    }));
  });
  await act(async () => { setInputValue(container.querySelector('#npw-name'), 'demo'); });
  await act(async () => { button(container, 'Next').click(); });
  await act(async () => { button(container, wrapperLabel).click(); });
  await act(async () => { button(container, 'React').click(); });
  await act(async () => { button(container, 'TypeScript').click(); });
  await flush();
  await flush();
  return { container, root };
}

function managerRadios(container) {
  const group = container.querySelector('[aria-label="Package manager"]');
  return Object.fromEntries(Array.from(group.querySelectorAll('label')).map((label) => [
    label.textContent.trim(),
    { disabled: label.querySelector('input').disabled, title: label.getAttribute('title') },
  ]));
}

test('a package manager this computer cannot run is offered disabled, with the run\'s own reason', async () => {
  const calls = [];
  const { container, root } = await openWizardOn('Web Only', async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'check_scaffold_prerequisites') return machine(args);
    return {};
  });
  const checked = calls.filter(([c]) => c === 'check_scaffold_prerequisites').map(([, a]) => `${a.wrapper}/${a.manager}`).sort();
  assert.deepEqual(checked, ['web/npm', 'web/pnpm', 'web/yarn'], 'each manager is checked for this wrapper');

  const radios = managerRadios(container);
  assert.equal(radios.npm.disabled, false);
  assert.equal(radios.pnpm.disabled, true, 'pnpm has recipe evidence but is not on this computer');
  assert.equal(radios.pnpm.title, PNPM_MISSING);
  assert.equal(radios.yarn.disabled, true);
  assert.equal(radios.yarn.title, YARN_CLASSIC, 'Yarn Classic is refused before Create, in the run\'s words');
  await act(async () => { root.unmount(); });
});

test('when the check itself fails, nothing is blocked (the run still decides)', async () => {
  const { container, root } = await openWizardOn('Web Only', async (cmd) => {
    if (cmd === 'check_scaffold_prerequisites') throw new Error('probe crashed');
    return {};
  });
  const radios = managerRadios(container);
  assert.deepEqual([radios.npm.disabled, radios.pnpm.disabled, radios.yarn.disabled], [false, false, false]);
  await act(async () => { root.unmount(); });
});

test('Tauri without Rust: Create stays available and the review says what running it needs', async () => {
  const { container, root } = await openWizardOn('Tauri', async (cmd, args) => {
    if (cmd === 'check_scaffold_prerequisites') return machine(args);
    return {};
  });
  await act(async () => { button(container, 'Next').click(); });
  await act(async () => { button(container, 'Next').click(); });
  const create = button(container, 'Create Project');
  assert.ok(create && !create.disabled, 'Rust is not needed to create the project');
  const warning = container.querySelector('.npw-review-warning');
  assert.ok(warning, 'the review carries a warning');
  assert.match(warning.textContent, /rustup\.rs/);
  await act(async () => { root.unmount(); });
});

// --- the plan derivation ----------------------------------------------------

const base = {
  name: 'demo', folder: 'C:\\proj', wrapper: 'web', framework: 'react', lang: 'ts',
  backend: 'none', addons: [], manager: 'pnpm', theme: 'glass',
  pyInterpreter: null, pyEnvMode: 'venv', pyEnvEngine: 'auto', pyExistingEnv: '', pyRequiresFloor: null,
};
const probe = { interpreters: [], uvAvailable: false };

test('the plan refuses a manager the machine check says the run would refuse', () => {
  const evidenceOnly = buildScaffoldPlan(base, probe, { platform: 'windows' });
  assert.equal(evidenceOnly.availability.selectable, true, 'web/react/ts on pnpm has evidence');

  const tools = { wrapper: 'web', byManager: { pnpm: machine({ wrapper: 'web', manager: 'pnpm' }) } };
  const plan = buildScaffoldPlan(base, probe, { platform: 'windows', tools });
  assert.equal(plan.availability.selectable, false);
  assert.equal(plan.availability.reason, PNPM_MISSING);

  const stale = { wrapper: 'tauri', byManager: { pnpm: machine({ wrapper: 'tauri', manager: 'pnpm' }) } };
  assert.equal(buildScaffoldPlan(base, probe, { platform: 'windows', tools: stale }).availability.selectable, true,
    'a check made for another wrapper is not applied');
});
