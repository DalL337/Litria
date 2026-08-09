import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  editorSessionReducer as reduce,
  initialEditorSessionState as initial,
  getPaneTabIds,
  isSplit,
  getFocusedActiveTabId,
  canSplit,
  getPaneTagsByPieceId,
  serializeTabPaneAssignments,
  applyPaneAssignments,
  clampPaneRatio,
  PANE_RATIO_MIN,
  PANE_RATIO_MAX,
  PANE_RATIO_DEFAULT,
  MAX_OPEN_TABS,
  MAIN_PANE,
  SIDE_PANE
} from '../../src/editor/editorSessionDomain.js';

const piece = (id, filename, code = `// ${filename}`) => ({ id, filename, code });

function openPieces(state, ...pieces) {
  return pieces.reduce((s, p) => reduce(s, { type: 'OPEN_FOR_PIECE', piece: p }), state);
}

// Baseline: two tabs open in pane 1 (a.py active, opened last).
function twoTabState() {
  return openPieces(initial, piece(1, 'b.py'), piece(2, 'a.py'));
}

/* ── Baseline single-pane behavior (unchanged contract) ── */

test('open-for-piece defaults to pane 1, focuses it, sorts by filename', () => {
  const s = twoTabState();
  assert.deepEqual(s.openTabIds, [2, 1]); // a.py before b.py
  assert.equal(s.tabsById[1].paneId, MAIN_PANE);
  assert.equal(s.tabsById[2].paneId, MAIN_PANE);
  assert.equal(s.activeTabIdByPane[MAIN_PANE], 2);
  assert.equal(s.focusedPaneId, MAIN_PANE);
  assert.equal(isSplit(s), false);
  assert.equal(getFocusedActiveTabId(s), 2);
});

test('single-pane mode: close last tab collapses isOpen', () => {
  let s = openPieces(initial, piece(1, 'a.py'));
  s = reduce(s, { type: 'CLOSE_TAB', tabId: 1 });
  assert.equal(s.isOpen, false);
  assert.equal(s.openTabIds.length, 0);
  assert.equal(getFocusedActiveTabId(s), null);
});

test('MAX_OPEN_TABS cap still enforced', () => {
  let s = initial;
  for (let i = 1; i <= MAX_OPEN_TABS + 3; i++) {
    s = reduce(s, { type: 'OPEN_FOR_PIECE', piece: piece(i, `f${String(i).padStart(2, '0')}.py`) });
  }
  assert.equal(s.openTabIds.length, MAX_OPEN_TABS);
});

/* ── Split creation + move semantics ── */

test('send-to-pane 2 creates the split and focuses the moved file there', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  assert.equal(isSplit(s), true);
  assert.deepEqual(getPaneTabIds(s, MAIN_PANE), [2]);
  assert.deepEqual(getPaneTabIds(s, SIDE_PANE), [1]);
  assert.equal(s.activeTabIdByPane[SIDE_PANE], 1, 'moved tab becomes side active');
  assert.equal(s.focusedPaneId, SIDE_PANE, 'focus follows intent');
});

test('single-file invariant: opening an open file in the other pane MOVES it', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  // b.py (id 1) now lives in pane 2. Open it again targeting pane 1:
  s = reduce(s, { type: 'OPEN_FOR_PIECE', piece: piece(1, 'b.py'), paneId: MAIN_PANE });
  assert.equal(s.tabsById[1].paneId, MAIN_PANE, 'moved back, not duplicated');
  assert.equal(s.openTabIds.filter((id) => id === 1).length, 1);
  assert.equal(isSplit(s), false, 'pane 2 emptied -> split collapsed');
});

test('move preserves the buffer (dirty workingCode survives a move)', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'UPDATE_WORKING_CODE', tabId: 1, workingCode: 'edited' });
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  assert.equal(s.tabsById[1].workingCode, 'edited');
  s = reduce(s, { type: 'OPEN_FOR_PIECE', piece: piece(1, 'b.py'), paneId: MAIN_PANE });
  assert.equal(s.tabsById[1].workingCode, 'edited');
});

test('send-to-pane on its own pane just focuses (no structural change)', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  const before = getPaneTabIds(s, SIDE_PANE);
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  assert.deepEqual(getPaneTabIds(s, SIDE_PANE), before);
  assert.equal(s.focusedPaneId, SIDE_PANE);
});

/* ── Focus rules ── */

test('set-active-tab focuses the tab in ITS pane', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  s = reduce(s, { type: 'SET_ACTIVE_TAB', tabId: 2 }); // a.py lives in pane 1
  assert.equal(s.focusedPaneId, MAIN_PANE);
  assert.equal(s.activeTabIdByPane[MAIN_PANE], 2);
  assert.equal(s.activeTabIdByPane[SIDE_PANE], 1, 'side active untouched');
});

test('set-focused-pane ignores an empty side pane', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SET_FOCUSED_PANE', paneId: SIDE_PANE });
  assert.equal(s.focusedPaneId, MAIN_PANE);
});

/* ── Collapse rules ── */

test('closing the side pane last tab collapses the split and refocuses pane 1', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  s = reduce(s, { type: 'CLOSE_TAB', tabId: 1 });
  assert.equal(isSplit(s), false);
  assert.equal(s.focusedPaneId, MAIN_PANE);
  assert.equal(s.activeTabIdByPane[SIDE_PANE], null);
  assert.equal(s.isOpen, true, 'drawer stays open — pane 1 still has a tab');
});

test('emptying pane 1 promotes pane 2 tabs to become the main pane', () => {
  let s = openPieces(initial, piece(1, 'b.py'), piece(2, 'a.py'), piece(3, 'c.py'));
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 3, paneId: SIDE_PANE });
  // pane 1 = [a.py], pane 2 = [b.py, c.py]. Close a.py:
  s = reduce(s, { type: 'CLOSE_TAB', tabId: 2 });
  assert.equal(isSplit(s), false, 'remaining pane becomes the main pane');
  assert.deepEqual(getPaneTabIds(s, MAIN_PANE), [1, 3]);
  assert.equal(s.tabsById[1].paneId, MAIN_PANE);
  assert.equal(s.tabsById[3].paneId, MAIN_PANE);
  assert.equal(s.focusedPaneId, MAIN_PANE);
  assert.ok([1, 3].includes(s.activeTabIdByPane[MAIN_PANE]));
});

test('closing the active tab picks the next active WITHIN its pane', () => {
  let s = openPieces(initial, piece(1, 'b.py'), piece(2, 'a.py'), piece(3, 'c.py'));
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 3, paneId: SIDE_PANE });
  // pane 1 = [a.py(2), b.py(1)], active pane-1 = 2. Close it:
  s = reduce(s, { type: 'SET_ACTIVE_TAB', tabId: 2 });
  s = reduce(s, { type: 'CLOSE_TAB', tabId: 2 });
  assert.equal(s.activeTabIdByPane[MAIN_PANE], 1, 'falls back inside pane 1');
  assert.equal(s.activeTabIdByPane[SIDE_PANE], 3, 'pane 2 untouched');
  assert.equal(isSplit(s), true);
});

/* ── Generic split verb (View > Split Editor, Ctrl+\) ── */

test('split-next moves the tab after the active into the side pane', () => {
  let s = twoTabState(); // pane 1 = [a.py(2), b.py(1)], active 2
  assert.equal(canSplit(s), true);
  s = reduce(s, { type: 'SPLIT_NEXT' });
  assert.equal(isSplit(s), true);
  assert.deepEqual(getPaneTabIds(s, MAIN_PANE), [2]);
  assert.deepEqual(getPaneTabIds(s, SIDE_PANE), [1]);
  assert.equal(s.focusedPaneId, SIDE_PANE);
});

test('split-next is a no-op with one tab or while already split', () => {
  let one = openPieces(initial, piece(1, 'a.py'));
  assert.equal(canSplit(one), false);
  assert.equal(reduce(one, { type: 'SPLIT_NEXT' }), one);

  let s = twoTabState();
  s = reduce(s, { type: 'SPLIT_NEXT' });
  assert.equal(canSplit(s), false);
  assert.equal(reduce(s, { type: 'SPLIT_NEXT' }), s);
});

/* ── Divider ratio (ADR-017 Phase C) ── */

test('clampPaneRatio bounds the divider and defaults garbage to even split', () => {
  assert.equal(clampPaneRatio(0.5), 0.5);
  assert.equal(clampPaneRatio(0.31), 0.31);
  assert.equal(clampPaneRatio(0.05), PANE_RATIO_MIN, 'floor: pane 1 stays usable');
  assert.equal(clampPaneRatio(0.95), PANE_RATIO_MAX, 'ceiling: pane 2 stays usable');
  for (const junk of [NaN, Infinity, 'wide', null, undefined, '']) {
    assert.equal(clampPaneRatio(junk), PANE_RATIO_DEFAULT, `junk=${String(junk)}`);
  }
  assert.equal(clampPaneRatio('0.65'), 0.65, 'persisted string round-trips');
});

/* ── Open-in-other-pane (shift+double-click entry, ADR-017 Phase B) ── */

test('open-in-other-pane splits from single-pane mode', () => {
  let s = twoTabState(); // both in pane 1, focus pane 1
  s = reduce(s, { type: 'OPEN_IN_OTHER_PANE', piece: piece(3, 'c.py') });
  assert.equal(isSplit(s), true);
  assert.deepEqual(getPaneTabIds(s, SIDE_PANE), [3]);
  assert.equal(s.focusedPaneId, SIDE_PANE, 'focus follows the opened file');
});

test('open-in-other-pane while split targets the non-focused pane', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE }); // focus pane 2
  s = reduce(s, { type: 'OPEN_IN_OTHER_PANE', piece: piece(3, 'c.py') });
  assert.ok(getPaneTabIds(s, MAIN_PANE).includes(3), 'landed opposite the focused pane');
  assert.equal(s.focusedPaneId, MAIN_PANE);
});

test('open-in-other-pane on the lone open file self-heals (no orphan split)', () => {
  let s = openPieces(initial, piece(1, 'a.py'));
  s = reduce(s, { type: 'OPEN_IN_OTHER_PANE', piece: piece(1, 'a.py') });
  assert.equal(isSplit(s), false, 'single tab cannot orphan pane 1');
  assert.deepEqual(getPaneTabIds(s, MAIN_PANE), [1]);
  assert.equal(s.focusedPaneId, MAIN_PANE);
});

/* ── Open-from-selection (replace) ── */

test('open-from-selection preserves pane placement for surviving tabs', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  s = reduce(s, {
    type: 'OPEN_FROM_SELECTION',
    pieces: [piece(1, 'b.py'), piece(2, 'a.py'), piece(3, 'c.py')]
  });
  assert.equal(s.tabsById[1].paneId, SIDE_PANE, 'split survives the replace');
  assert.equal(s.tabsById[3].paneId, MAIN_PANE, 'new tab lands in pane 1');
  assert.equal(isSplit(s), true);
});

test('open-from-selection dropping all side-pane tabs collapses the split', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  s = reduce(s, { type: 'OPEN_FROM_SELECTION', pieces: [piece(2, 'a.py')] });
  assert.equal(isSplit(s), false);
  assert.equal(s.focusedPaneId, MAIN_PANE);
});

/* ── Snapshot restore ── */

test('snapshot restore honors paneId and collapses a deleted side pane', () => {
  const tabs = [
    { id: 1, pieceId: 1, filename: 'a.py', code: '', workingCode: '', paneId: MAIN_PANE },
    { id: 2, pieceId: 2, filename: 'b.py', code: '', workingCode: '', paneId: SIDE_PANE }
  ];
  let s = reduce(initial, { type: 'OPEN_FROM_SNAPSHOT', tabs, activeTabId: 2 });
  assert.equal(isSplit(s), true);
  assert.equal(s.activeTabIdByPane[SIDE_PANE], 2);
  assert.equal(s.focusedPaneId, SIDE_PANE);
  assert.equal(s.activeTabIdByPane[MAIN_PANE], 1, 'pane 1 active backfilled');

  // Side-pane file deleted outside Litria -> restore collapses to single pane.
  let collapsed = reduce(initial, { type: 'OPEN_FROM_SNAPSHOT', tabs: [tabs[0]], activeTabId: 2 });
  assert.equal(isSplit(collapsed), false);
  assert.equal(collapsed.activeTabIdByPane[MAIN_PANE], 1);
});

test('legacy snapshot without paneId restores everything into pane 1', () => {
  const tabs = [
    { id: 1, pieceId: 1, filename: 'a.py', code: '', workingCode: '' },
    { id: 2, pieceId: 2, filename: 'b.py', code: '', workingCode: '' }
  ];
  const s = reduce(initial, { type: 'OPEN_FROM_SNAPSHOT', tabs, activeTabId: 1 });
  assert.equal(isSplit(s), false);
  assert.deepEqual(getPaneTabIds(s, MAIN_PANE), [1, 2]);
  assert.equal(s.activeTabIdByPane[MAIN_PANE], 1);
});

/* ── Pane persistence (ADR-017 Phase B) ── */

test('serializeTabPaneAssignments is keystroke-stable and placement-sensitive', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  const before = serializeTabPaneAssignments(s);
  assert.equal(before, JSON.stringify({ 2: MAIN_PANE, 1: SIDE_PANE }));

  // Keystrokes must not change the persisted shape (the debounced editor-
  // state save keys off this string).
  const typed = reduce(s, { type: 'UPDATE_WORKING_CODE', tabId: 1, workingCode: 'edited' });
  assert.equal(serializeTabPaneAssignments(typed), before);

  // Moving a tab must change it.
  const moved = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: MAIN_PANE });
  assert.notEqual(serializeTabPaneAssignments(moved), before);
});

test('applyPaneAssignments restores residency and fails open to pane 1', () => {
  const tabs = [
    { id: 1, pieceId: 1, filename: 'a.py', code: '', workingCode: '' },
    { id: 2, pieceId: 2, filename: 'b.py', code: '', workingCode: '' }
  ];
  const applied = applyPaneAssignments(tabs, JSON.stringify({ 1: SIDE_PANE }));
  assert.equal(applied[0].paneId, SIDE_PANE);
  assert.equal(applied[1].paneId, MAIN_PANE, 'unlisted id defaults to main');

  // Malformed / legacy saves can never brick restore.
  for (const raw of ['not json', '', null, undefined]) {
    const safe = applyPaneAssignments(tabs, raw);
    assert.ok(safe.every((tab) => tab.paneId === MAIN_PANE), `raw=${String(raw)}`);
  }

  // Garbage pane values in a present map normalize to main.
  const junk = applyPaneAssignments(tabs, JSON.stringify({ 1: 99 }));
  assert.ok(junk.every((tab) => tab.paneId === MAIN_PANE));

  // No assignments -> tab-carried paneId survives (openFromSnapshot always
  // routes through this helper; explicit callers must not be stomped).
  const carried = applyPaneAssignments(
    [{ id: 3, pieceId: 3, filename: 'c.py', code: '', workingCode: '', paneId: SIDE_PANE }],
    null
  );
  assert.equal(carried[0].paneId, SIDE_PANE);
});

test('pane tags exist only while split, keyed by pieceId', () => {
  let s = twoTabState();
  assert.equal(getPaneTagsByPieceId(s), null, 'single pane -> no tags');

  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  const tags = getPaneTagsByPieceId(s);
  assert.ok(tags instanceof Map);
  assert.equal(tags.get(2), MAIN_PANE);
  assert.equal(tags.get(1), SIDE_PANE);
  assert.equal(tags.size, 2, 'every open tab is tagged');

  // Collapsing the split removes the tags again.
  s = reduce(s, { type: 'CLOSE_TAB', tabId: 1 });
  assert.equal(getPaneTagsByPieceId(s), null);
});

test('round-trip: split survives serialize -> snapshot restore', () => {
  let live = twoTabState();
  live = reduce(live, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  const persisted = serializeTabPaneAssignments(live);

  // Simulate the restore path: bare snapshot tabs + persisted assignments.
  const snapshotTabs = live.openTabIds.map((id) => ({
    id,
    pieceId: id,
    filename: live.tabsById[id].filename,
    code: '',
    workingCode: ''
  }));
  const restored = reduce(initial, {
    type: 'OPEN_FROM_SNAPSHOT',
    tabs: applyPaneAssignments(snapshotTabs, persisted),
    activeTabId: getFocusedActiveTabId(live)
  });

  assert.equal(isSplit(restored), true);
  assert.deepEqual(getPaneTabIds(restored, MAIN_PANE), getPaneTabIds(live, MAIN_PANE));
  assert.deepEqual(getPaneTabIds(restored, SIDE_PANE), getPaneTabIds(live, SIDE_PANE));
  assert.equal(restored.focusedPaneId, live.focusedPaneId);
});

/* ── Reset ── */

test('reset-session clears pane state', () => {
  let s = twoTabState();
  s = reduce(s, { type: 'SEND_TO_PANE', tabId: 1, paneId: SIDE_PANE });
  s = reduce(s, { type: 'RESET_SESSION' });
  assert.deepEqual(s, initial);
});

/* ── SAVE_TAB savedCode baseline (untitled Save As support) ── */

test('save-tab without savedCode baselines to live workingCode (sync save contract)', () => {
  let s = openPieces(initial, piece(1, 'a.py'));
  s = reduce(s, { type: 'UPDATE_WORKING_CODE', tabId: 1, workingCode: 'edited' });
  s = reduce(s, { type: 'SAVE_TAB', tabId: 1 });
  assert.equal(s.tabsById[1].code, 'edited');
});

test('save-tab with savedCode baselines to the written snapshot, keeping later edits dirty', () => {
  // Async save (untitled Save As): 'A' is written to disk, but the user types
  // 'AB' while the dialog/write is in flight. The tab must diff against the
  // snapshot that reached disk, not the live buffer.
  let s = openPieces(initial, piece(1, 'a.py', 'A'));
  s = reduce(s, { type: 'UPDATE_WORKING_CODE', tabId: 1, workingCode: 'AB' });
  s = reduce(s, { type: 'SAVE_TAB', tabId: 1, savedCode: 'A' });
  assert.equal(s.tabsById[1].code, 'A');
  assert.equal(s.tabsById[1].workingCode, 'AB'); // still dirty
});

test('save-tab with a non-string savedCode falls back to live workingCode', () => {
  let s = openPieces(initial, piece(1, 'a.py'));
  s = reduce(s, { type: 'UPDATE_WORKING_CODE', tabId: 1, workingCode: 'edited' });
  s = reduce(s, { type: 'SAVE_TAB', tabId: 1, savedCode: null });
  assert.equal(s.tabsById[1].code, 'edited');
});
