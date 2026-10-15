import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// One session's screen (track T slice T2a). It is mounted for the session's
// whole life and only hidden, so what it does on mount, hide and unmount
// decides whether a hidden session can be typed into or left paused. This
// drives the REAL TerminalRenderer, in StrictMode, with the REAL event stream;
// xterm is replaced by a recorder (test/support/xterm-fake.mjs).

register('../support/jsx-hooks.mjs', import.meta.url);
register('../support/xterm-fake.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of [
  'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Comment',
  'DocumentFragment', 'Event', 'CustomEvent', 'MutationObserver', 'getComputedStyle',
  'requestAnimationFrame', 'cancelAnimationFrame',
]) {
  if (dom[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
// happy-dom has no layout: give every box a size, as a shown drawer would.
for (const prop of ['clientWidth', 'clientHeight']) {
  Object.defineProperty(dom.HTMLElement.prototype, prop, { configurable: true, get: () => 400 });
}

const { act, createElement, StrictMode } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: TerminalRenderer } = await import('../../src/components/TerminalRenderer.jsx');
const { createTerminalEventStream } = await import('../../src/terminal/terminalStorage.js');

const BIG = 'x'.repeat(1200 * 1024); // past the 1 MiB pause mark

function session({ replayLimit } = {}) {
  const channel = { onmessage: null, emit(event) { this.onmessage?.(event); } };
  const stream = createTerminalEventStream(channel, { limit: replayLimit });
  return { channel, stream, output: (chunk) => channel.emit({ event: 'Output', data: { chunk } }) };
}

function mount(stream, props = {}) {
  globalThis.__XTERMS__ = [];
  const calls = { input: [], resize: [], pause: 0, resume: 0 };
  const callbacks = {
    onInput: (data) => calls.input.push(data),
    onResize: (cols, rows) => calls.resize.push([cols, rows]),
    onPause: () => { calls.pause += 1; },
    onResume: () => { calls.resume += 1; },
  };
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const render = (next = {}) => act(() => {
    root.render(createElement(StrictMode, null,
      createElement(TerminalRenderer, { stream, isVisible: true, ...callbacks, ...props, ...next })));
  });
  render();
  const live = () => globalThis.__XTERMS__.filter((t) => !t.disposed);
  return { calls, render, live, all: () => globalThis.__XTERMS__, unmount: () => act(() => root.unmount()) };
}

test('a mounted screen reports its size once and sends what is typed', () => {
  const { stream } = session();
  const view = mount(stream);
  const [terminal] = view.live();
  assert.equal(view.live().length, 1, 'one live screen after StrictMode\'s double mount');
  // StrictMode mounts twice; each mount reports once.
  assert.deepEqual(view.calls.resize.at(-1), [80, 24]);
  assert.equal(view.calls.resize.length, view.all().length);
  for (const listener of terminal.listeners.data) listener('ls\r');
  assert.deepEqual(view.calls.input, ['ls\r']);
  view.unmount();
});

test('hiding the screen gives up the keyboard', () => {
  const { stream } = session();
  const view = mount(stream);
  const [terminal] = view.live();
  view.render({ isVisible: false });
  assert.equal(terminal.blurs, 1, 'a hidden session cannot be typed into');
  view.unmount();
});

test('a flood pauses the session; parsing catches up and resumes it', () => {
  const { stream, output } = session();
  const view = mount(stream);
  const [terminal] = view.live();
  act(() => output(BIG));
  assert.equal(view.calls.pause, 1);
  assert.equal(view.calls.resume, 0);
  terminal.drain();
  assert.equal(view.calls.resume, 1);
  view.unmount();
});

test('a screen that leaves while it holds the session paused lifts the pause', () => {
  const { stream, output } = session();
  const view = mount(stream);
  act(() => output(BIG));
  assert.equal(view.calls.pause, 1);
  view.unmount();
  assert.equal(view.calls.resume, 1, 'never parked for good');
});

test('writes still queued in a disposed screen never count against the next one', () => {
  // StrictMode mounts, disposes and remounts at once, and the stream replays
  // the backlog into both screens. xterm still runs the first screen's write
  // callbacks after it is disposed.
  const { stream, output } = session({ replayLimit: 4 * 1024 * 1024 });
  output(BIG);
  const view = mount(stream);
  const [first, second] = view.all();
  assert.equal(first.disposed, true);
  assert.equal(second.disposed, false);
  const resumesBefore = view.calls.resume;
  first.drain();
  assert.equal(view.calls.resume, resumesBefore, 'the old screen\'s writes do not resume the new one');
  second.drain();
  assert.equal(view.calls.resume, resumesBefore + 1, 'the new screen resumes once it caught up');
  view.unmount();
});
