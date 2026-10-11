import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';
import { Window } from 'happy-dom';

// Compare-and-apply through the REAL editor session (EditorSessionContext;
// Project API build plan W1b): the check and the edit happen in one turn,
// against the latest session text — typing and earlier edits from the same
// turn included — and the engine and the piece mirror take the new text.
// Only the engine is scripted (a registered capability).

register('../support/tauri-invoke-stub.mjs', import.meta.url);
register('../support/jsx-hooks.mjs', import.meta.url);

const dom = new Window({ url: 'http://localhost/' });
for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Text', 'Event', 'MutationObserver']) {
  if (dom[key] === undefined) continue;
  Object.defineProperty(globalThis, key, { value: dom[key], configurable: true, writable: true });
}
globalThis.window = dom;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorSessionProvider, useEditorSession } = await import('../../src/editor/EditorSessionContext.jsx');
const { registerEngineCapabilities } = await import('../../src/editor/engineCapabilities.js');
const { bufferRevision } = await import('../../src/app/projectApiBridge.js');

/** Render the provider; `latest()` is the context value of the last render. */
async function mountSession() {
  let current = null;
  function Probe() {
    current = useEditorSession();
    return null;
  }
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(EditorSessionProvider, null, createElement(Probe))); });
  return {
    latest: () => current,
    unmount: async () => { await act(async () => { root.unmount(); }); host.remove(); },
  };
}

const A = { id: 1, filename: 'src/a.ts', code: 'export const a = 1;\n' };

test('edits in one turn see each other, even through a stale render', async () => {
  const session = await mountSession();
  const engine = [];
  const stopEngine = registerEngineCapabilities({ applyBufferText: (tabId, text) => { engine.push([tabId, text]); return true; } });
  const persisted = [];
  await act(async () => {
    session.latest().configurePersistence({ onWorkingCodeChange: (tab, text) => persisted.push([tab.id, text]) });
    session.latest().openFromSelection([A]);
  });

  const stale = session.latest(); // captured once; never re-read during the turn
  let first;
  let second;
  let replayed;
  await act(async () => {
    first = stale.applyBufferEdit({ path: 'src/a.ts', expectedRevision: bufferRevision(A.code), edits: [{ oldText: 'a = 1', newText: 'a = 2' }] });
    second = stale.applyBufferEdit({ path: 'src/a.ts', expectedRevision: first.revision, edits: [{ oldText: 'a = 2', newText: 'a = 3' }] });
    replayed = stale.applyBufferEdit({ path: 'src/a.ts', expectedRevision: bufferRevision(A.code), edits: [{ oldText: 'a = 1', newText: 'a = 9' }] });
  });

  const one = 'export const a = 2;\n';
  const two = 'export const a = 3;\n';
  assert.deepEqual(first, { outcome: 'applied', revision: bufferRevision(one) });
  assert.deepEqual(second, { outcome: 'applied', revision: bufferRevision(two) }, 'the second edit saw the first');
  assert.deepEqual(replayed, { outcome: 'conflict', revision: bufferRevision(two) }, 'a replay of the first read conflicts');
  assert.equal(session.latest().tabsById[1].workingCode, two);
  assert.equal(session.latest().isTabDirty(1), true);
  assert.deepEqual(engine, [[1, one], [1, two]], 'the live document took each text in its turn');
  assert.deepEqual(persisted, [[1, one], [1, two]], 'the piece mirror took each text');

  stopEngine();
  await session.unmount();
});

test('an edit sees typing from the same turn', async () => {
  const session = await mountSession();
  await act(async () => { session.latest().openFromSelection([A]); });
  const stale = session.latest();
  let result;
  await act(async () => {
    stale.updateWorkingCode(1, 'typed\n');
    result = stale.applyBufferEdit({ path: 'src/a.ts', expectedRevision: bufferRevision('typed\n'), edits: [{ oldText: 'typed', newText: 'edited' }] });
  });
  assert.equal(result.outcome, 'applied');
  assert.equal(session.latest().tabsById[1].workingCode, 'edited\n');
  await session.unmount();
});

test('anything but applied changes nothing', async () => {
  const session = await mountSession();
  const engine = [];
  const stopEngine = registerEngineCapabilities({ applyBufferText: (tabId, text) => { engine.push([tabId, text]); return true; } });
  await act(async () => { session.latest().openFromSelection([A]); });
  const outcomes = [];
  await act(async () => {
    const s = session.latest();
    outcomes.push(s.applyBufferEdit({ path: 'src/a.ts', expectedRevision: 'b1-stale', edits: [{ oldText: 'a = 1', newText: 'x' }] }).outcome);
    outcomes.push(s.applyBufferEdit({ path: 'src/a.ts', expectedRevision: bufferRevision(A.code), edits: [{ oldText: 'nope', newText: 'x' }] }).outcome);
    outcomes.push(s.applyBufferEdit({ path: 'src/b.ts', expectedRevision: bufferRevision(A.code), edits: [{ oldText: 'a', newText: 'x' }] }).outcome);
    outcomes.push(s.applyBufferEdit(null).outcome);
  });
  assert.deepEqual(outcomes, ['conflict', 'noMatch', 'notInSession', 'invalid']);
  assert.equal(session.latest().tabsById[1].workingCode, A.code);
  assert.equal(session.latest().isTabDirty(1), false);
  assert.deepEqual(engine, []);
  stopEngine();
  await session.unmount();
});
