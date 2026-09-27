// brief-structural-grid §10: "Drop followed immediately by undo, a new drag,
// a project switch, or app close cannot persist an animation intermediate."
// The slide is presentation only (state is committed at the drop); this
// proves every one of those events cancels it, so nothing stale is drawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

register('../support/jsx-hooks.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event']) {
  if (dom[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// Frames never fire on their own here; the tests drive time explicitly.
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};

const React = await import('react');
const { act } = React;
const { createRoot } = await import('react-dom/client');
const { usePlacementTransition } = await import('../../src/behaviors/usePlacementTransition.js');
const { createUndoManager } = await import('../../src/history/undoManager.js');

function mount(initial) {
  const history = createUndoManager();
  let latest = null;
  let setProps = null;
  function Harness() {
    const [props, set] = React.useState(initial);
    setProps = set;
    latest = usePlacementTransition({ ...props, history });
    return null;
  }
  const root = createRoot(dom.document.createElement('div'));
  act(() => root.render(React.createElement(Harness)));
  return {
    history,
    get state() { return latest; },
    update: (patch) => act(() => setProps((prev) => ({ ...prev, ...patch }))),
    run: (fn) => act(fn),
    unmount: () => act(() => root.unmount()),
  };
}

const from = new Map([[1, { x: 650, y: 290 }]]);
const to = new Map([[1, { x: 600, y: 300 }]]);
const base = { durationMs: 150, easing: 'cubic', reduceMotion: false, isDragActive: false, resetKey: 'project-a' };

test('a drop starts a slide', () => {
  const h = mount(base);
  h.run(() => h.state.begin(from, to));
  assert.equal(h.state.isSettling, true);
  h.unmount();
});

test('undo (any history change) cancels the slide', () => {
  const h = mount(base);
  h.run(() => h.state.begin(from, to));
  h.run(() => h.history.execute({ label: 'x', do() {}, undo() {} }));
  assert.equal(h.state.isSettling, false);
  h.unmount();
});

test('a new drag cancels the slide', () => {
  const h = mount(base);
  h.run(() => h.state.begin(from, to));
  h.update({ isDragActive: true });
  assert.equal(h.state.isSettling, false);
  h.unmount();
});

test('a project switch cancels the slide', () => {
  const h = mount(base);
  h.run(() => h.state.begin(from, to));
  h.update({ resetKey: 'project-b' });
  assert.equal(h.state.isSettling, false);
  h.unmount();
});

test('reduced motion never starts one', () => {
  const h = mount({ ...base, reduceMotion: true });
  h.run(() => h.state.begin(from, to));
  assert.equal(h.state.isSettling, false);
  h.unmount();
});
