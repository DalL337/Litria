import test from 'node:test';
import assert from 'node:assert/strict';

import { createInteractionModeDomain } from '../../src/app/interactionModeDomain.js';

// Drive the pure factory with mutable locals, mirroring the pieceDomain tests.
function makeDomain(initialMode = 'default', initialSubMode = 'additive') {
  let mode = initialMode;
  let subMode = initialSubMode;
  const domain = createInteractionModeDomain({
    getMode: () => mode,
    applyMode: (next) => { mode = next; },
    getSubMode: () => subMode,
    applySubMode: (next) => { subMode = next; },
  });
  return { domain, read: () => ({ mode, subMode }) };
}

test('starts in default mode with no active token', () => {
  const { domain } = makeDomain();
  assert.equal(domain.selectors.isEditMode(), false);
  assert.equal(domain.selectors.activeActionToken(), null);
  assert.equal(domain.selectors.activeToken(), null);
});

test('toggleMode flips default -> edit and resets sub-mode to additive', () => {
  const { domain, read } = makeDomain('default', 'subtractive');
  domain.commands.toggleMode();
  assert.equal(read().mode, 'edit');
  assert.equal(read().subMode, 'additive', 'entering edit resets to additive');
  assert.equal(domain.selectors.isEditMode(), true);
  assert.equal(domain.selectors.activeActionToken(), 'additive');
});

test('toggleMode flips edit -> default', () => {
  const { domain, read } = makeDomain('edit', 'additive');
  domain.commands.toggleMode();
  assert.equal(read().mode, 'default');
  assert.equal(domain.selectors.isEditMode(), false);
  assert.equal(domain.selectors.activeActionToken(), null, 'no token in default mode');
});

test('setSubMode switches sub-mode while in edit mode', () => {
  const { domain, read } = makeDomain('edit', 'additive');
  domain.commands.setSubMode('subtractive');
  assert.equal(read().subMode, 'subtractive');
  assert.equal(domain.selectors.activeActionToken(), 'subtractive');
  assert.equal(domain.selectors.activeToken()?.label, 'Remove');
});

test('setSubMode is a no-op in default mode', () => {
  const { domain, read } = makeDomain('default', 'additive');
  domain.commands.setSubMode('subtractive');
  assert.equal(read().subMode, 'additive', 'sub-mode unchanged outside edit mode');
  assert.equal(domain.selectors.activeActionToken(), null);
});

test('setSubMode ignores unknown token ids', () => {
  const { domain, read } = makeDomain('edit', 'additive');
  domain.commands.setSubMode('teleport');
  assert.equal(read().subMode, 'additive', 'unknown token ignored');
});

test('enterEditMode / exitEditMode force the mode and reset sub-mode on enter', () => {
  const { domain, read } = makeDomain('default', 'subtractive');
  domain.commands.enterEditMode();
  assert.equal(read().mode, 'edit');
  assert.equal(read().subMode, 'additive');
  domain.commands.exitEditMode();
  assert.equal(read().mode, 'default');
});
