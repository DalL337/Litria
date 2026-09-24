import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// ADR-028 §6 / brief S5: a component-level test of the wizard's lifecycle —
// create (Blank) → held → Open Workspace fails → "Open workspace again" →
// succeeds. Drives the real component in happy-dom with an injected runtime
// (no Tauri); the JSX loader hook is registered for this file only.

register('../support/jsx-hooks.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of [
  'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment',
  'HTMLInputElement', 'HTMLButtonElement', 'HTMLSelectElement', 'SVGElement', 'Event', 'CustomEvent', 'KeyboardEvent',
  'MouseEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  'localStorage', 'DOMParser', 'HTMLIFrameElement', 'ResizeObserver',
]) {
  if (dom[key] === undefined) continue;
  // Node exposes some of these (navigator, localStorage) as getter-only
  // globals; a configurable own property shadows them for this process.
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { createElement } = await import('react');
const { default: NewProjectWizard } = await import('../../src/components/NewProjectWizard.jsx');

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

test('held → open fails → open again → opens, with navigation frozen throughout (F17, F18, F20)', async () => {
  const onDoneCalls = [];
  let rejectFirstOpen = true;
  const onDone = async (payload) => {
    onDoneCalls.push(payload);
    if (rejectFirstOpen) {
      rejectFirstOpen = false;
      throw new Error('database bootstrap failed');
    }
  };
  const invokeImpl = async (cmd, args) => {
    assert.equal(cmd, 'create_blank_project');
    assert.equal(args.projectName, 'demo');
    return { projectPath: `${args.projectLocation}\\demo`, createdFiles: ['README.md', '.gitignore', '.editorconfig'] };
  };

  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(NewProjectWizard, {
      onDone,
      onCancel: () => {},
      defaultFolder: 'C:\\projects',
      initialEnergyLevel: 'live',
      initialTheme: 'glass',
      platform: 'windows',
      tracePause: 'always',
      runtime: makeRuntime({ invokeImpl }),
    }));
  });

  // Identity: name + (seeded) folder.
  await act(async () => { setInputValue(container.querySelector('#npw-name'), 'demo'); });
  await act(async () => { button(container, 'Next').click(); });
  // Stack: Blank.
  await act(async () => { button(container, 'Blank').click(); });
  await act(async () => { button(container, 'Next').click(); });
  // Workspace → Create.
  await act(async () => { button(container, 'Next').click(); });
  const create = button(container, 'Create Project');
  assert.ok(create && !create.disabled, 'Create is enabled on a complete Blank plan');
  await act(async () => { create.click(); });
  await flush();

  // Held: the trace stays, "Open Workspace" is offered, navigation is frozen.
  const open = button(container, 'Open Workspace');
  assert.ok(open, 'held completion offers Open Workspace');
  const stepButtons = Array.from(container.querySelectorAll('.npw-step'));
  assert.ok(stepButtons.every((b) => b.disabled), 'stepper frozen while held (F18)');
  assert.ok(button(container, 'Back').disabled, 'Back frozen while held');
  const cancel = container.querySelector('.npw-btn-cancel');
  assert.ok(cancel.textContent.includes('Close without opening'), 'a created project is closed, not discarded');
  assert.ok(!button(container, 'Created') || button(container, 'Created').disabled, 'no second Create');

  // Open fails: the payload is kept and the only offer is to open again.
  await act(async () => { open.click(); });
  await flush();
  assert.equal(onDoneCalls.length, 1);
  assert.ok(container.querySelector('.npw-error')?.textContent.includes('database bootstrap failed'));
  const again = button(container, 'Open workspace again');
  assert.ok(again, 'failed open offers to open again (F17)');
  assert.equal(button(container, 'Create as Blank instead'), null, 'no re-scaffold into the existing folder');
  assert.ok(Array.from(container.querySelectorAll('.npw-step')).every((b) => b.disabled), 'still frozen after a failed open');

  // Open again succeeds with the same payload.
  await act(async () => { again.click(); });
  await flush();
  assert.equal(onDoneCalls.length, 2);
  assert.deepEqual(onDoneCalls[1], onDoneCalls[0], 'the retained payload is reused verbatim');
  assert.equal(onDoneCalls[0].name, 'demo');
  assert.deepEqual(onDoneCalls[0].blankFiles, ['README.md', '.gitignore', '.editorconfig']);

  await act(async () => { root.unmount(); });
});

test('changing the runtime after reaching Create clamps the stepper and disables Create (F19)', async () => {
  const container = dom.document.createElement('div');
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(NewProjectWizard, {
      onDone: async () => {}, onCancel: () => {}, defaultFolder: 'C:\\projects', platform: 'windows',
      runtime: makeRuntime({ invokeImpl: async () => ({}) }),
    }));
  });
  await act(async () => { setInputValue(container.querySelector('#npw-name'), 'demo'); });
  await act(async () => { button(container, 'Next').click(); });
  await act(async () => { button(container, 'Blank').click(); });
  await act(async () => { button(container, 'Next').click(); });
  await act(async () => { button(container, 'Next').click(); });
  assert.ok(button(container, 'Create Project') && !button(container, 'Create Project').disabled);
  // Back to Stack via the stepper and pick a runtime that needs a framework.
  await act(async () => { Array.from(container.querySelectorAll('.npw-step'))[1].click(); });
  await act(async () => { button(container, 'Web Only').click(); });
  // Jumping to Create now lands on Stack (the first invalid page), not Create.
  await act(async () => { Array.from(container.querySelectorAll('.npw-step'))[3].click(); });
  assert.ok(container.querySelector('[aria-label="Runtime wrapper"]'), 'clamped to the Stack step');
  assert.equal(button(container, 'Create Project'), null, 'Create is not reachable with an incomplete stack');
  await act(async () => { root.unmount(); });
});

test('Cancel during a run reaches the runner and the run ends failed with the report (F30, R7)', async () => {
  // A fake runner: scaffold_project stays pending until cancel_scaffold
  // arrives with the same runId, then rejects the way the real runner does
  // (tree torn down, preservation report in the message). The rejection is
  // held until the test releases it: a timer here could fire inside the
  // cancel click's act() on a slow runner and end the run before the
  // "Stopping" state was observed (flaked on CI 2026-09-17/20/24).
  const calls = [];
  let rejectRun = null;
  let finishStopping = null;
  const invokeImpl = (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === 'scaffold_project') {
      assert.equal(typeof args.config.runId, 'string');
      assert.ok(args.config.runId.length > 8, 'a fresh run id');
      assert.ok(args.config.plan.limits, 'limits ride in the plan');
      return new Promise((_, reject) => { rejectRun = reject; });
    }
    if (cmd === 'cancel_scaffold') {
      const run = calls.find(([c]) => c === 'scaffold_project');
      assert.equal(args.runId, run[1].config.runId, 'cancel names the live run');
      finishStopping = () => rejectRun(new Error('`npm` cancelled — its process tree torn down. Partial project retained — C:\\projects\\demo kept: package.json is subprocess output that was never recorded; nothing was deleted.'));
      return Promise.resolve(true);
    }
    return Promise.resolve({});
  };
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
  await act(async () => { button(container, 'Web Only').click(); });
  await act(async () => { button(container, 'React').click(); });
  await act(async () => { button(container, 'TypeScript').click(); });
  await act(async () => { button(container, 'Next').click(); });
  await act(async () => { button(container, 'Next').click(); });
  const create = button(container, 'Create Project');
  assert.ok(create && !create.disabled, 'web/react/ts on npm is verified on windows');
  await act(async () => { create.click(); });
  await flush();

  // Running: Cancel is live, navigation is frozen.
  const cancel = container.querySelector('.npw-btn-cancel');
  assert.ok(!cancel.disabled, 'Cancel is enabled while running (F30)');
  assert.ok(cancel.textContent.startsWith('Cancel'));
  assert.ok(Array.from(container.querySelectorAll('.npw-step')).every((b) => b.disabled), 'stepper frozen while running');
  await act(async () => { cancel.click(); });
  assert.ok(container.querySelector('.npw-btn-cancel').textContent.startsWith('Stopping'), 'debounced while the runner stops');
  assert.ok(calls.some(([c]) => c === 'cancel_scaffold'), 'the runner was asked to stop');
  assert.equal(typeof finishStopping, 'function', 'cancel reached the runner before the run ended');
  await act(async () => { finishStopping(); });
  await flush();

  const error = container.querySelector('.npw-error')?.textContent ?? '';
  assert.match(error, /cancelled/);
  assert.match(error, /Partial project retained/);
  assert.ok(button(container, 'Create Project') && !button(container, 'Create Project').disabled, 'nothing was created: Create is offered again');
  assert.ok(!container.querySelector('.npw-btn-cancel').disabled && container.querySelector('.npw-btn-cancel').textContent.startsWith('Cancel'), 'Cancel is back to closing the wizard');
  await act(async () => { root.unmount(); });
});
