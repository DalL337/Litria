import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canProceedAfterSave,
  saveOneTab,
  saveTabsFromBatch,
  saveTabsSequentially
} from '../../src/editor/saveCoordinator.js';

const tab = (id, workingCode) => ({ id, pieceId: id, workingCode });

test('single save failure stays dirty by dispatching no baseline action', async () => {
  const actions = [];
  const saved = await saveOneTab({
    tab: tab(1, 'edited'),
    persist: async () => false,
    dispatch: (action) => actions.push(action)
  });
  assert.equal(saved, false);
  assert.deepEqual(actions, []);
});

test('single save dispatches the snapshot captured before the await', async () => {
  const actions = [];
  const target = tab(1, 'snapshot');
  let release;
  const pending = saveOneTab({
    tab: target,
    persist: () => new Promise((resolve) => { release = resolve; }),
    dispatch: (action) => actions.push(action)
  });
  target.workingCode = 'typed later';
  release(true);
  assert.equal(await pending, true);
  assert.deepEqual(actions, [
    { type: 'SAVE_TAB', tabId: 1, savedCode: 'snapshot' }
  ]);
});

test('save-all advances successful tabs individually and leaves failures dirty', async () => {
  const actions = [];
  const saved = await saveTabsFromBatch({
    tabs: [tab(1, 'one'), tab(2, 'two'), tab(3, 'three')],
    persistAll: async () => [
      { tabId: 1, saved: true, savedCode: 'one' },
      { tabId: 2, saved: false, savedCode: 'two' },
      { tabId: 3, saved: true, savedCode: 'three' }
    ],
    dispatch: (action) => actions.push(action)
  });
  assert.equal(saved, false);
  assert.deepEqual(actions, [
    { type: 'SAVE_TAB', tabId: 1, savedCode: 'one' },
    { type: 'SAVE_TAB', tabId: 3, savedCode: 'three' }
  ]);
});

test('untitled save-all stays sequential and records each success', async () => {
  const actions = [];
  const calls = [];
  const saved = await saveTabsSequentially({
    tabs: [tab(1, 'one'), tab(2, 'two')],
    persist: async (entry) => {
      calls.push(entry.id);
      return entry.id === 1;
    },
    dispatch: (action) => actions.push(action)
  });
  assert.equal(saved, false);
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(actions, [
    { type: 'SAVE_TAB', tabId: 1, savedCode: 'one' }
  ]);
});

test('the unsaved-changes gate aborts its transition after a failed save', async () => {
  assert.equal(await canProceedAfterSave(async () => false), false);
  assert.equal(await canProceedAfterSave(async () => true), true);
});
