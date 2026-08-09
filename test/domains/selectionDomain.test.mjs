import test from 'node:test';
import assert from 'node:assert/strict';

import { createSelectionDomain } from '../../src/app/selectionDomain.js';

test('SelectionDomain commands delegate to selection behavior', () => {
  const calls = [];
  const selection = {
    select(id) {
      calls.push(['select', id]);
    },
    toggle(id) {
      calls.push(['toggle', id]);
    },
    clear() {
      calls.push(['clear']);
    },
    selectMultiple(ids) {
      calls.push(['selectMultiple', ids]);
    },
    selectedIds: [],
    count: 0,
    hasSelection: false,
    isSelected() {
      return false;
    }
  };

  const domain = createSelectionDomain(selection);

  domain.commands.select(10);
  domain.commands.toggle(11);
  domain.commands.clear();
  domain.commands.selectMultiple([1, 2]);

  assert.deepEqual(calls, [
    ['select', 10],
    ['toggle', 11],
    ['clear'],
    ['selectMultiple', [1, 2]]
  ]);
});

test('SelectionDomain selectors read from selection behavior', () => {
  const selection = {
    select() {},
    toggle() {},
    clear() {},
    selectMultiple() {},
    selectedIds: [3, 4],
    count: 2,
    hasSelection: true,
    isSelected(id) {
      return id === 3;
    }
  };

  const domain = createSelectionDomain(selection);

  assert.deepEqual(domain.selectors.getSelectedIds(), [3, 4]);
  assert.equal(domain.selectors.getCount(), 2);
  assert.equal(domain.selectors.hasSelection(), true);
  assert.equal(domain.selectors.isSelected(3), true);
  assert.equal(domain.selectors.isSelected(8), false);
});

