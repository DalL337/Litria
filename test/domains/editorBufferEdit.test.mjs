import test from 'node:test';
import assert from 'node:assert/strict';

// Compare-and-apply, the plan (Project API build plan W1b; contract brief
// §13): an exact-text edit applies only when the session text is still the
// revision the caller read, and every `oldText` matches exactly once. Pure
// session logic, no engine.

import {
  editorSessionReducer,
  initialEditorSessionState,
  planBufferEdit,
} from '../../src/editor/editorSessionDomain.js';
import { bufferRevision } from '../../src/app/projectApiBridge.js';

function sessionWith(pieces, closedIds = []) {
  let state = editorSessionReducer(initialEditorSessionState, { type: 'OPEN_FROM_SELECTION', pieces });
  for (const id of closedIds) state = editorSessionReducer(state, { type: 'CLOSE_TAB', tabId: id });
  return state;
}

const A = { id: 1, filename: 'src/a.ts', code: 'export const a = 1;\nexport const b = 2;\n' };
const plan = (state, request) => planBufferEdit(state, request, bufferRevision);

test('a matching revision applies every edit in order', () => {
  const state = sessionWith([A]);
  const result = plan(state, {
    path: 'src/a.ts',
    expectedRevision: bufferRevision(A.code),
    edits: [
      { oldText: 'a = 1', newText: 'a = 10' },
      { oldText: 'a = 10;\nexport', newText: 'a = 10; // first edit applied\nexport' },
    ],
  });
  const text = 'export const a = 10; // first edit applied\nexport const b = 2;\n';
  assert.deepEqual(result, { outcome: 'applied', tabId: 1, text, revision: bufferRevision(text) });
});

test('another revision is a conflict that names the current one', () => {
  const state = sessionWith([A]);
  const result = plan(state, { path: 'src/a.ts', expectedRevision: bufferRevision('stale'), edits: [{ oldText: 'a', newText: 'b' }] });
  assert.deepEqual(result, { outcome: 'conflict', revision: bufferRevision(A.code) });
});

test('oldText must match exactly once, counting overlaps', () => {
  const state = sessionWith([{ id: 2, filename: 'x.txt', code: 'aaa' }]);
  const at = (edits) => plan(state, { path: 'x.txt', expectedRevision: bufferRevision('aaa'), edits });
  assert.deepEqual(at([{ oldText: 'zz', newText: 'y' }]), { outcome: 'noMatch', edit: 0 });
  assert.deepEqual(at([{ oldText: 'aa', newText: 'y' }]), { outcome: 'ambiguous', edit: 0 }, '"aa" occurs at 0 and at 1');
  assert.deepEqual(at([{ oldText: '', newText: 'y' }]), { outcome: 'ambiguous', edit: 0 }, 'empty text matches everywhere');
  assert.deepEqual(at([{ oldText: 'aaa', newText: 'b' }]).outcome, 'applied');
});

test('all or nothing: a later failing edit applies none', () => {
  const state = sessionWith([A]);
  const result = plan(state, {
    path: 'src/a.ts',
    expectedRevision: bufferRevision(A.code),
    edits: [{ oldText: 'a = 1', newText: 'a = 3' }, { oldText: 'missing', newText: 'x' }],
  });
  assert.deepEqual(result, { outcome: 'noMatch', edit: 1 });
});

test('each edit sees the text the earlier ones left', () => {
  const state = sessionWith([{ id: 3, filename: 'y.txt', code: 'one two\n' }]);
  const result = plan(state, {
    path: 'y.txt',
    expectedRevision: bufferRevision('one two\n'),
    edits: [{ oldText: 'one', newText: 'two' }, { oldText: 'two two', newText: 'three' }],
  });
  assert.equal(result.outcome, 'applied');
  assert.equal(result.text, 'three\n');
});

test('the new text is held as the session holds text, and revised so', () => {
  const state = sessionWith([A]);
  const result = plan(state, { path: 'src/a.ts', expectedRevision: bufferRevision(A.code), edits: [{ oldText: 'a = 1;\n', newText: 'a = 1;\r\n' }] });
  assert.equal(result.text, A.code, 'CRLF becomes LF, as in every session update');
  assert.equal(result.revision, bufferRevision(result.text));
  // Applying it is what UPDATE_WORKING_CODE stores: the revision stays true.
  const next = editorSessionReducer(state, { type: 'UPDATE_WORKING_CODE', tabId: 1, workingCode: result.text });
  assert.equal(bufferRevision(next.tabsById[1].workingCode), result.revision);
});

test('the path is the session path; one the session does not hold is notInSession', () => {
  const state = sessionWith([A]);
  const request = (path) => ({ path, expectedRevision: bufferRevision(A.code), edits: [{ oldText: 'a = 1', newText: 'a = 2' }] });
  assert.equal(plan(state, request('/src/a.ts')).outcome, 'applied', 'a leading slash is the same path');
  assert.equal(plan(state, request('src\\a.ts')).outcome, 'applied', 'backslashes are the same path');
  assert.deepEqual(plan(state, request('src/missing.ts')), { outcome: 'notInSession' });
});

test('a closed tab the session still holds dirty is edited too', () => {
  let state = sessionWith([A, { id: 4, filename: 'src/z.ts', code: 'z\n' }]);
  state = editorSessionReducer(state, { type: 'UPDATE_WORKING_CODE', tabId: 1, workingCode: 'dirty\n' });
  state = editorSessionReducer(state, { type: 'CLOSE_TAB', tabId: 1 });
  assert.equal(state.openTabIds.includes(1), false, 'precondition: closed');
  const result = plan(state, { path: 'src/a.ts', expectedRevision: bufferRevision('dirty\n'), edits: [{ oldText: 'dirty', newText: 'still dirty' }] });
  assert.equal(result.outcome, 'applied');
  assert.equal(result.tabId, 1);
});

test('a malformed request is invalid, never applied', () => {
  const state = sessionWith([A]);
  const revision = bufferRevision(A.code);
  for (const request of [
    {},
    { path: 'src/a.ts', expectedRevision: revision },
    { path: 'src/a.ts', expectedRevision: revision, edits: [] },
    { path: 'src/a.ts', expectedRevision: revision, edits: [{ oldText: 'a' }] },
    { path: 'src/a.ts', expectedRevision: revision, edits: [{ oldText: 1, newText: 'x' }] },
    { path: 'src/a.ts', edits: [{ oldText: 'a = 1', newText: 'x' }] },
  ]) {
    assert.deepEqual(plan(state, request), { outcome: 'invalid' }, JSON.stringify(request));
  }
});

// ─── W3c: documents the session does not hold with text of its own ──────────

test('a closed entry without unsaved text is planned against the disk, never the entry', () => {
  // The agent read it from disk (a disk revision), as reads serve closed
  // clean entries: the session's copy is not what it read.
  const state = sessionWith([A], [1]);
  const result = plan(state, { path: 'src/a.ts', expectedRevision: bufferRevision(A.code), edits: [{ oldText: 'a = 1', newText: 'a = 2' }] });
  assert.deepEqual(result, { outcome: 'notInSession' });
});

test('a closed entry WITH unsaved text is still the session\'s', () => {
  let state = sessionWith([A], [1]);
  state = editorSessionReducer(state, { type: 'UPDATE_WORKING_CODE', tabId: 1, workingCode: 'export const a = 7;\n' });
  const result = plan(state, { path: 'src/a.ts', expectedRevision: bufferRevision('export const a = 7;\n'), edits: [{ oldText: '7', newText: '8' }] });
  assert.equal(result.outcome, 'applied');
});

const B = { id: 2, filename: 'src/b.ts', code: 'export const b = 1;\n' };
const C = { id: 3, filename: 'src/c.ts' };

test('an agent\'s edit opens in a background tab: the active tab, the focus and the drawer stay', () => {
  const state = sessionWith([A, B]);
  const before = { active: state.activeTabIdByPane, focused: state.focusedPaneId, isOpen: state.isOpen };
  const next = editorSessionReducer(state, {
    type: 'OPEN_IN_BACKGROUND', piece: C, code: 'export const c = 1;\n', workingCode: 'export const c = 2;\n'
  });
  assert.ok(next.openTabIds.includes(3), 'a tab beside the open ones');
  assert.deepEqual(next.tabsById[3], {
    id: 3, pieceId: 3, filename: 'src/c.ts',
    code: 'export const c = 1;\n', workingCode: 'export const c = 2;\n', paneId: state.focusedPaneId
  }, 'the disk text is the saved baseline; the edit is unsaved');
  assert.deepEqual(
    { active: next.activeTabIdByPane, focused: next.focusedPaneId, isOpen: next.isOpen },
    before
  );
});

test('with every tab slot taken, the edit is held unsaved without a tab, and no tab is closed', () => {
  const pieces = Array.from({ length: 8 }, (_, index) => ({ id: index + 10, filename: `f${index}.ts`, code: '' }));
  const state = sessionWith(pieces);
  assert.equal(state.openTabIds.length, 8);
  const next = editorSessionReducer(state, {
    type: 'OPEN_IN_BACKGROUND', piece: { id: 3, filename: 'a.ts' }, code: 'x\n', workingCode: 'y\n'
  });
  assert.deepEqual(next.openTabIds, state.openTabIds, 'nothing evicted, even a name that sorts after it');
  assert.equal(next.tabsById[3].workingCode, 'y\n', 'held as an unsaved closed entry');
});

test('a closed clean entry is replaced by the disk text and the edit', () => {
  const state = sessionWith([A, B], [1]);
  const next = editorSessionReducer(state, {
    type: 'OPEN_IN_BACKGROUND', piece: A, code: 'export const a = 5;\n', workingCode: 'export const a = 6;\n'
  });
  assert.equal(next.tabsById[1].code, 'export const a = 5;\n');
  assert.equal(next.tabsById[1].workingCode, 'export const a = 6;\n');
  assert.ok(next.openTabIds.includes(1));
});

test('line endings are normalized as for every session document', () => {
  const next = editorSessionReducer(sessionWith([A]), {
    type: 'OPEN_IN_BACKGROUND', piece: C, code: 'a\r\nb\r\n', workingCode: 'a\r\nc\r\n'
  });
  assert.equal(next.tabsById[3].code, 'a\nb\n');
  assert.equal(next.tabsById[3].workingCode, 'a\nc\n');
});
