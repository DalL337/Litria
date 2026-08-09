import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HUD_WIDGETS,
  HUD_DEFAULT_POSITION,
  HUD_CLAMP_MARGIN,
  getDefaultVisibleIds,
  toggleVisibleId,
  clampHudPosition,
  normalizeHudState,
  parseHudState,
  serializeHudState,
} from '../../src/app/hudState.js';

const TEST_WIDGETS = [
  { id: 'create', title: 'Create', defaultVisible: true },
  { id: 'help', title: 'Help', defaultVisible: false },
];

test('registry entries carry the container contract fields', () => {
  for (const w of HUD_WIDGETS) {
    assert.equal(typeof w.id, 'string');
    assert.equal(typeof w.title, 'string');
    assert.equal(typeof w.defaultVisible, 'boolean');
  }
});

test('getDefaultVisibleIds returns only defaultVisible widgets', () => {
  assert.deepEqual(getDefaultVisibleIds(TEST_WIDGETS), ['create']);
});

test('toggleVisibleId adds a missing id and removes a present one', () => {
  assert.deepEqual(toggleVisibleId(['create'], 'help'), ['create', 'help']);
  assert.deepEqual(toggleVisibleId(['create', 'help'], 'create'), ['help']);
});

test('toggleVisibleId tolerates a non-array input', () => {
  assert.deepEqual(toggleVisibleId(null, 'create'), ['create']);
});

test('toggleVisibleId can empty the set (pill-only degenerate state)', () => {
  assert.deepEqual(toggleVisibleId(['create'], 'create'), []);
});

test('clampHudPosition keeps position inside the container', () => {
  const box = { hudWidth: 246, hudHeight: 100, containerWidth: 1000, containerHeight: 600 };
  assert.deepEqual(clampHudPosition({ x: -50, y: -50 }, box), { x: HUD_CLAMP_MARGIN, y: HUD_CLAMP_MARGIN });
  assert.deepEqual(clampHudPosition({ x: 5000, y: 5000 }, box), {
    x: 1000 - 246 - HUD_CLAMP_MARGIN,
    y: 600 - 100 - HUD_CLAMP_MARGIN,
  });
  assert.deepEqual(clampHudPosition({ x: 100, y: 100 }, box), { x: 100, y: 100 });
});

test('clampHudPosition pins to margin when the container is smaller than the HUD', () => {
  const box = { hudWidth: 400, hudHeight: 400, containerWidth: 200, containerHeight: 200 };
  assert.deepEqual(clampHudPosition({ x: 100, y: 100 }, box), { x: HUD_CLAMP_MARGIN, y: HUD_CLAMP_MARGIN });
});

test('clampHudPosition substitutes defaults for non-finite coordinates', () => {
  const box = { hudWidth: 246, hudHeight: 100, containerWidth: 1000, containerHeight: 600 };
  assert.deepEqual(clampHudPosition({ x: NaN, y: undefined }, box), {
    x: HUD_DEFAULT_POSITION.x,
    y: HUD_DEFAULT_POSITION.y,
  });
});

test('normalizeHudState defaults on null/garbage input', () => {
  for (const raw of [null, undefined, 'nope', 42]) {
    const s = normalizeHudState(raw, TEST_WIDGETS);
    assert.deepEqual(s, {
      x: HUD_DEFAULT_POSITION.x,
      y: HUD_DEFAULT_POSITION.y,
      visibleIds: ['create'],
      hidden: false,
    });
  }
});

test('normalizeHudState drops unknown widget ids (stale persisted state)', () => {
  const s = normalizeHudState({ x: 40, y: 60, visibleIds: ['create', 'removed-widget'], hidden: false }, TEST_WIDGETS);
  assert.deepEqual(s.visibleIds, ['create']);
  assert.equal(s.x, 40);
  assert.equal(s.y, 60);
});

test('normalizeHudState preserves an explicitly empty visible set', () => {
  const s = normalizeHudState({ x: 10, y: 10, visibleIds: [], hidden: false }, TEST_WIDGETS);
  assert.deepEqual(s.visibleIds, []);
});

test('normalizeHudState coerces hidden to a strict boolean', () => {
  assert.equal(normalizeHudState({ hidden: true }, TEST_WIDGETS).hidden, true);
  assert.equal(normalizeHudState({ hidden: 'yes' }, TEST_WIDGETS).hidden, false);
});

test('parseHudState survives corrupt JSON', () => {
  const s = parseHudState('{not json', TEST_WIDGETS);
  assert.deepEqual(s.visibleIds, ['create']);
});

test('serialize -> parse round-trips state exactly', () => {
  const original = { x: 120, y: 44, visibleIds: ['create'], hidden: true };
  const restored = parseHudState(serializeHudState(original), TEST_WIDGETS);
  assert.deepEqual(restored, original);
});

/* ── New-widget introduction (knownIds migration) ── */

test('a widget introduced after the state was saved appears with its default visibility', () => {
  // Legacy Phase A pref: no knownIds, user had only "create".
  const legacy = { x: 40, y: 60, visibleIds: ['create'], hidden: false };
  const s = normalizeHudState(legacy, HUD_WIDGETS);
  assert.ok(s.visibleIds.includes('panzoom'), 'newly introduced defaultVisible widget auto-checks');
  assert.ok(s.visibleIds.includes('create'));
});

test('an explicit uncheck of a known widget is respected on reload', () => {
  // knownIds records panzoom existed when saved; its absence from
  // visibleIds is a user choice, not a migration gap.
  const saved = { x: 0, y: 0, visibleIds: ['create'], hidden: false, knownIds: ['create', 'panzoom'] };
  const s = normalizeHudState(saved, HUD_WIDGETS);
  assert.ok(!s.visibleIds.includes('panzoom'), 'user uncheck survives reload');
});

test('serialize records the current registry as knownIds', () => {
  const json = serializeHudState({ x: 0, y: 0, visibleIds: [], hidden: false });
  const raw = JSON.parse(json);
  assert.deepEqual(raw.knownIds, HUD_WIDGETS.map((w) => w.id));
});

test('a new defaultVisible widget is not re-added if already explicitly present', () => {
  const legacy = { x: 0, y: 0, visibleIds: ['create', 'panzoom'], hidden: false };
  const s = normalizeHudState(legacy, HUD_WIDGETS);
  assert.deepEqual(s.visibleIds.filter((id) => id === 'panzoom').length, 1);
});
