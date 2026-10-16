import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// The editor workspace's model registry (src/editor/monacoWorkspace.js), the
// two defects the Project API's write increment must not build on (contract
// brief §13; build plan W1). Both were reproduced live on 2026-10-11
// (.research/2026-10-11-w1-live/):
//
// 1. A rename kept the model's URI (`cm://tab/{id}/{oldName}`) and every
//    language-server tab map on the old name: hover, completion and
//    diagnostics all kept talking about the old file.
// 2. An edit made to a model no editor shows (the canvas-wire path writes
//    open files' models directly) never reached the session or the language
//    server, and the pane reverted it the next time the tab was shown.
//
// Drives the REAL workspace module. Only the engine (monaco-fake.mjs) and
// Tauri's `invoke` (tauri-invoke-stub.mjs) are stubbed; every language-server
// notification the workspace sends is recorded.

register('../support/tauri-invoke-stub.mjs', import.meta.url);
register('../support/jsx-hooks.mjs', import.meta.url);
register('../support/monaco-fake.mjs', import.meta.url);

const notified = [];
globalThis.__INVOKE__ = async (command, payload) => {
  if (command === 'lsp_notify') notified.push(payload);
  return null;
};

const ws = await import('../../src/editor/monacoWorkspace.js');

const ROOT = 'C:/alice/project';
const settle = () => new Promise((resolve) => setTimeout(resolve, 250)); // past the didChange debounce
const traffic = () => notified.map((n) => `${n.languageId} ${n.method} ${n.params.textDocument.uri}`);

/** The syntax adapter's file lifecycle, recorded. */
function recordingAdapter() {
  const calls = [];
  return {
    calls,
    onFileOpened: (path, text, model) => calls.push(['opened', path, model]),
    onFileChanged: (path, text) => calls.push(['changed', path, text]),
    onFileRenamed: (from, to, model) => calls.push(['renamed', from, to, model]),
    onFileClosed: (path) => calls.push(['closed', path]),
  };
}

function context(syntaxAdapter = recordingAdapter()) {
  return { projectId: 'p', projectRootPath: ROOT, syntaxAdapter };
}

function fullRange(model) {
  const lines = model.getLineCount();
  return { startLineNumber: 1, startColumn: 1, endLineNumber: lines, endColumn: model.getLineMaxColumn(lines) };
}

test('a rename moves the model and the language-server document to the new name', async () => {
  const ctx = context();
  const tab = { id: 101, filename: 'src/a.ts', workingCode: 'export const a = 1;\n' };
  const first = ws.acquireModel(tab, ctx);
  await settle();
  notified.length = 0;
  ctx.syntaxAdapter.calls.length = 0;

  const renamed = ws.acquireModel({ ...tab, filename: 'src/b.py' }, ctx);

  assert.equal(renamed.uri.toString(), 'cm://tab/101/src/b.py', 'the model is named after the file it holds');
  assert.equal(renamed.getValue(), tab.workingCode);
  assert.equal(renamed.getLanguageId(), 'python');
  assert.equal(ws.getModel(101), renamed);
  assert.ok(first.isDisposed(), 'the old model is gone');
  assert.deepEqual(traffic(), [
    `typescript textDocument/didClose file:///${ROOT}/src/a.ts`,
    `python textDocument/didOpen file:///${ROOT}/src/b.py`,
  ]);
  assert.deepEqual(ctx.syntaxAdapter.calls, [['renamed', `${ROOT}/src/a.ts`, `${ROOT}/src/b.py`, renamed]]);

  // Every later edit reaches the new document only.
  notified.length = 0;
  ws.notifyChange(101, 'b = 2\n', ctx);
  await settle();
  assert.deepEqual(traffic(), [`python textDocument/didChange file:///${ROOT}/src/b.py`]);

  ws.releaseClosedTabs([], ctx);
  notified.length = 0;
});

test('re-acquiring under the same name keeps the model', () => {
  const ctx = context();
  const tab = { id: 102, filename: 'src/same.ts', workingCode: 'x\n' };
  const model = ws.acquireModel(tab, ctx);
  assert.equal(ws.acquireModel({ ...tab }, ctx), model);
  assert.ok(!model.isDisposed());
  ws.releaseClosedTabs([], ctx);
  notified.length = 0;
});

test('an edit to a model no editor shows reaches the session and the language server', async () => {
  const ctx = context();
  const mirrored = [];
  const stopMirroring = ws.setSessionEditMirror?.((tabId, text) => mirrored.push([tabId, text]));
  const model = ws.acquireModel({ id: 103, filename: 'src/c.ts', workingCode: 'let c = 1;\n' }, ctx);
  model.attached = false; // shown by no pane (another tab is active)
  await settle();
  notified.length = 0;

  // What the canvas-wire path does to an open file (syntax adapter writeResultText).
  model.pushEditOperations([], [{ range: fullRange(model), text: 'let c = 2;\n' }], () => null);
  await settle();

  assert.deepEqual(mirrored, [[103, 'let c = 2;\n']], 'the session holds what the model holds');
  assert.deepEqual(traffic(), [`typescript textDocument/didChange file:///${ROOT}/src/c.ts`]);

  stopMirroring?.();
  ws.releaseClosedTabs([], ctx);
  notified.length = 0;
});

test('an edit to a model an editor shows is left to that editor', async () => {
  const ctx = context();
  const mirrored = [];
  const stopMirroring = ws.setSessionEditMirror?.((tabId, text) => mirrored.push([tabId, text]));
  const model = ws.acquireModel({ id: 104, filename: 'src/d.ts', workingCode: 'let d = 1;\n' }, ctx);
  model.attached = true; // the pane's own onChange mirrors typing
  await settle();
  notified.length = 0;

  model.pushEditOperations([], [{ range: fullRange(model), text: 'let d = 2;\n' }], () => null);
  await settle();

  assert.deepEqual(mirrored, []);
  assert.deepEqual(traffic(), []);

  stopMirroring?.();
  ws.releaseClosedTabs([], ctx);
  notified.length = 0;
});

// Compare-and-apply's engine side (build plan W1b).
test('session text reaches a live model as one edit over the changed span, with no echo', async () => {
  const ctx = context();
  const mirrored = [];
  const stopMirroring = ws.setSessionEditMirror((tabId, text) => mirrored.push([tabId, text]));
  for (const [id, attached] of [[105, true], [106, false]]) {
    const model = ws.acquireModel({ id, filename: `src/e${id}.ts`, workingCode: 'const a = 1;\nconst b = 2;\n' }, ctx);
    model.attached = attached;
    await settle();
    notified.length = 0;
    model.pushed = [];

    assert.equal(ws.applySessionText(id, 'const a = 1;\nconst b = 3;\n', ctx), true);

    assert.equal(model.getValue(), 'const a = 1;\nconst b = 3;\n');
    assert.deepEqual(model.pushed, [[{ range: { startLineNumber: 2, startColumn: 11, endLineNumber: 2, endColumn: 12 }, text: '3' }]],
      `one edit, over the changed span only (attached: ${attached})`);
    assert.equal(ws.isApplyingSessionText(), false);
    await settle();
    assert.deepEqual(traffic(), [`typescript textDocument/didChange file:///${ROOT}/src/e${id}.ts`], 'the language server hears it once');
  }
  assert.deepEqual(mirrored, [], 'the session already holds the text: nothing is sent back');
  assert.equal(ws.applySessionText(999, 'x', ctx), false, 'no live model');
  stopMirroring();
  ws.releaseClosedTabs([], ctx);
  notified.length = 0;
});

/** T3a: a version from disk (or an agent's edit) is one undo step of its own,
 *  never merged into the person's last typing. */
test('session text reaches the model as its own undo step', () => {
  const ctx = context();
  const model = ws.acquireModel({ id: 108, filename: 'src/undo.ts', workingCode: 'mine\n' }, ctx);
  model.journal = [];
  ws.applySessionText(108, 'theirs\n', ctx);
  ws.applySessionText(108, 'mine\n', ctx);
  assert.deepEqual(model.journal, ['stop', 'edit', 'stop', 'stop', 'edit', 'stop']);
  assert.equal(model.getValue(), 'mine\n');
  ws.releaseClosedTabs([], ctx);
  notified.length = 0;
});

test('the changed span never splits a surrogate pair', () => {
  const ctx = context();
  const model = ws.acquireModel({ id: 107, filename: 'notes.txt', workingCode: 'x\u{1F600}y' }, ctx);
  model.pushed = [];
  ws.applySessionText(107, 'x\u{1F603}y', ctx);
  assert.equal(model.getValue(), 'x\u{1F603}y');
  assert.equal(model.pushed[0][0].text, '\u{1F603}', 'the whole character is replaced');
  ws.releaseClosedTabs([], ctx);
  notified.length = 0;
});
