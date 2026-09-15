import test from 'node:test';
import assert from 'node:assert/strict';

import {
  containsTextFocus,
  registerEngineCapabilities
} from '../../src/editor/engineCapabilities.js';

test('default text-focus detection covers portable editable controls', () => {
  assert.equal(containsTextFocus(null), false);
  assert.equal(containsTextFocus({ tagName: 'DIV' }), false);
  assert.equal(containsTextFocus({ tagName: 'INPUT' }), true);
  assert.equal(containsTextFocus({ tagName: 'TEXTAREA' }), true);
  assert.equal(containsTextFocus({ tagName: 'SELECT' }), true);
  assert.equal(containsTextFocus({ tagName: 'DIV', isContentEditable: true }), true);
});

test('registration adds engine-owned text focus without losing portable controls', () => {
  const engineElement = { engineOwnsFocus: true, tagName: 'DIV' };
  const unregister = registerEngineCapabilities({
    containsTextFocus: (element) => element?.engineOwnsFocus === true
  });
  assert.equal(containsTextFocus(engineElement), true);
  assert.equal(containsTextFocus({ tagName: 'INPUT' }), true);
  unregister();
});

test('unregister restores the default predicate and is idempotent', () => {
  const engineElement = { engineOwnsFocus: true, tagName: 'DIV' };
  const unregister = registerEngineCapabilities({
    containsTextFocus: (element) => element?.engineOwnsFocus === true
  });
  assert.equal(containsTextFocus(engineElement), true);
  unregister();
  unregister();
  assert.equal(containsTextFocus(engineElement), false);
  assert.equal(containsTextFocus({ tagName: 'TEXTAREA' }), true);
});

test('a stale cleanup cannot remove a newer engine registration', () => {
  const first = registerEngineCapabilities({
    containsTextFocus: (element) => element?.owner === 'first'
  });
  const second = registerEngineCapabilities({
    containsTextFocus: (element) => element?.owner === 'second'
  });
  first();
  assert.equal(containsTextFocus({ owner: 'second' }), true);
  second();
  assert.equal(containsTextFocus({ owner: 'second' }), false);
});
