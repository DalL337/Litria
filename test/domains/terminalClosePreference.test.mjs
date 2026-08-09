import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveTerminalCloseBehavior } from '../../src/terminal/terminalClosePreference.js';

// ---------------------------------------------------------------------------
// ADR-019 terminalDrawerClose — close-time resolution (hide-don't-kill)
// ---------------------------------------------------------------------------

test('missing prefs resolve to the registry default (end)', () => {
  assert.equal(resolveTerminalCloseBehavior(null), 'end');
  assert.equal(resolveTerminalCloseBehavior(undefined), 'end');
  assert.equal(resolveTerminalCloseBehavior({}), 'end');
});

test('stored values are honored', () => {
  assert.equal(resolveTerminalCloseBehavior({ terminalDrawerClose: 'hide' }), 'hide');
  assert.equal(resolveTerminalCloseBehavior({ terminalDrawerClose: 'end' }), 'end');
});

test('unrecognized stored values fail safe to end — never a leaked session', () => {
  assert.equal(resolveTerminalCloseBehavior({ terminalDrawerClose: 'keep' }), 'end');
  assert.equal(resolveTerminalCloseBehavior({ terminalDrawerClose: true }), 'end');
  assert.equal(resolveTerminalCloseBehavior({ terminalDrawerClose: null }), 'end');
});
