import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveGridPreferences, withPaintOverride } from '../../src/app/gridPreferences.js';

test('with nothing stored, the grid settings are the playground defaults', () => {
  assert.deepEqual(resolveGridPreferences({}), {
    snapMode: 'flex',
    smartGuides: true,
    settleMs: 150,
    settleEasing: 'cubic',
    reduceMotionSetting: 'system',
    reduceMotion: false,
    ink: 'theme',
    showMajor: true,
    showMinor: true,
    showSub: true,
    showOrigin: true,
    paintOverrides: {},
  });
});

test('valid stored values win; invalid ones fall back to the default', () => {
  const prefs = resolveGridPreferences({
    gridSnapMode: 'strict',
    gridSettleMs: 0,
    gridSmartGuides: false,
    gridInk: 'sepia',
    gridSettleEasing: 42,
  });
  assert.equal(prefs.snapMode, 'strict');
  assert.equal(prefs.settleMs, 0, 'an instant settle is a real choice');
  assert.equal(prefs.smartGuides, false);
  assert.equal(prefs.ink, 'theme');
  assert.equal(prefs.settleEasing, 'cubic');
});

test('reduce motion follows the system unless forced', () => {
  assert.equal(resolveGridPreferences({}, { systemReducedMotion: true }).reduceMotion, true);
  assert.equal(resolveGridPreferences({ gridReduceMotion: 'never' }, { systemReducedMotion: true }).reduceMotion, false);
  assert.equal(resolveGridPreferences({ gridReduceMotion: 'always' }, { systemReducedMotion: false }).reduceMotion, true);
});

test('a paint override is set per theme, energy and ink and cleared by Reset', () => {
  const context = { themeId: 'obsidian', energyLevel: 'calm', ink: 'theme' };
  const set = withPaintOverride({ 'glass:live:theme': { major: 1, minor: 1, sub: 1 } }, context, { major: 0.2, minor: 0.1, sub: 0.05, extra: 9 });
  assert.deepEqual(set['obsidian:calm:theme'], { major: 0.2, minor: 0.1, sub: 0.05 });
  assert.ok(set['glass:live:theme'], 'other themes keep theirs');
  const cleared = withPaintOverride(set, context, null);
  assert.equal(cleared['obsidian:calm:theme'], undefined);
  assert.ok(cleared['glass:live:theme']);
});
