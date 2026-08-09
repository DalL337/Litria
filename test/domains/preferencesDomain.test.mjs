import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PREFERENCE_REGISTRY,
  PREFERENCE_SCOPES,
  PREFERENCE_PROPAGATIONS,
  entriesForPlace
} from '../../src/preferences/registry.js';
import { createPreferencesDomain } from '../../src/preferences/preferencesDomain.js';
import { BUILTIN_THEME_IDS } from '../../src/theme/themeDefaults.js';

// ---------------------------------------------------------------------------
// Registry shape (ADR-019: every entry declares scope, propagation, caption,
// and place — surfaces render registry queries, never hand-picked lists)
// ---------------------------------------------------------------------------

test('every registry entry declares the full ADR-019 contract', () => {
  assert.ok(PREFERENCE_REGISTRY.length > 0);
  for (const entry of PREFERENCE_REGISTRY) {
    assert.equal(typeof entry.key, 'string');
    assert.ok(entry.key.length > 0, 'key must be non-empty');
    assert.ok(PREFERENCE_SCOPES.includes(entry.scope), `${entry.key}: bad scope ${entry.scope}`);
    assert.ok(
      PREFERENCE_PROPAGATIONS.includes(entry.propagation),
      `${entry.key}: bad propagation ${entry.propagation}`
    );
    assert.ok(['enum', 'boolean', 'json', 'text'].includes(entry.type), `${entry.key}: bad type ${entry.type}`);
    assert.ok(entry.label?.length > 0, `${entry.key}: label required`);
    assert.ok(entry.caption?.length > 0, `${entry.key}: always-visible caption required`);
    assert.ok(Array.isArray(entry.place) && entry.place.length > 0, `${entry.key}: place required`);
  }
});

test('registry keys are unique', () => {
  const keys = PREFERENCE_REGISTRY.map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
});

test('enum entries carry their values and a valid default', () => {
  for (const entry of PREFERENCE_REGISTRY.filter((e) => e.type === 'enum')) {
    assert.ok(Array.isArray(entry.values) && entry.values.length >= 2, `${entry.key}: enum needs values`);
    assert.ok(entry.values.includes(entry.defaultValue), `${entry.key}: default must be a valid value`);
  }
});

test('boolean entries carry a boolean default (ADR-024)', () => {
  for (const entry of PREFERENCE_REGISTRY.filter((e) => e.type === 'boolean')) {
    assert.equal(typeof entry.defaultValue, 'boolean', `${entry.key}: boolean default required`);
  }
});

// ---------------------------------------------------------------------------
// splashScreen (ADR-024): global-only boolean, splash-on by default
// ---------------------------------------------------------------------------

test('splashScreen entry: global boolean, default on, not project-overridable', () => {
  const entry = PREFERENCE_REGISTRY.find((e) => e.key === 'splashScreen');
  assert.ok(entry, 'splashScreen missing from registry');
  assert.equal(entry.type, 'boolean');
  assert.equal(entry.scope, 'global');
  assert.equal(entry.propagation, 'inherit');
  assert.equal(entry.defaultValue, true);
  assert.equal(entry.projectOverridable, false, 'splash plays before any project is open');
  assert.deepEqual(entry.place, ['preferences.global']);
});

test('boolean setValue accepts true/false and rejects everything else', () => {
  const domain = createPreferencesDomain({ values: {} });
  const off = domain.commands.setValue({ key: 'splashScreen', value: false });
  assert.equal(off.splashScreen, false);
  const on = domain.commands.setValue({ key: 'splashScreen', value: true });
  assert.equal(on.splashScreen, true);
  assert.throws(() => domain.commands.setValue({ key: 'splashScreen', value: 'off' }), /invalid value/i);
  assert.throws(() => domain.commands.setValue({ key: 'splashScreen', value: 1 }), /invalid value/i);
  assert.throws(() => domain.commands.setValue({ key: 'splashScreen', value: null }), /invalid value/i);
});

test('boolean getEffective: stored false wins, invalid coerces to default', () => {
  assert.equal(
    createPreferencesDomain({ values: {} }).selectors.getEffective('splashScreen'),
    true
  );
  assert.equal(
    createPreferencesDomain({ values: { splashScreen: false } }).selectors.getEffective('splashScreen'),
    false
  );
  assert.equal(
    createPreferencesDomain({ values: { splashScreen: 'nope' } }).selectors.getEffective('splashScreen'),
    true
  );
});

test('slice-1 registry covers energyLevel, appearance, terminalDrawerClose', () => {
  const keys = new Set(PREFERENCE_REGISTRY.map((e) => e.key));
  assert.ok(keys.has('energyLevel'));
  assert.ok(keys.has('appearance'));
  assert.ok(keys.has('terminalDrawerClose'));
});

test('every entry declares projectOverridable explicitly', () => {
  for (const entry of PREFERENCE_REGISTRY) {
    assert.equal(typeof entry.projectOverridable, 'boolean', `${entry.key}: projectOverridable required`);
  }
});

test('project-overridable entries surface in the project place', () => {
  const projectKeys = entriesForPlace('preferences.project').map((e) => e.key);
  assert.ok(projectKeys.includes('energyLevel'));
  assert.ok(!projectKeys.includes('appearance'), 'appearance override deferred to the drawer refit slice');
});

test('terminalDrawerClose is live — hide capability shipped 2026-08-01', () => {
  const entry = PREFERENCE_REGISTRY.find((e) => e.key === 'terminalDrawerClose');
  assert.ok(entry, 'terminalDrawerClose missing from registry');
  assert.equal(entry.comingSoon, undefined, 'the comingSoon gate must be gone');
  assert.deepEqual(entry.values, ['end', 'hide']);
  assert.equal(entry.defaultValue, 'end');
  assert.equal(entry.scope, 'global');
  assert.equal(entry.projectOverridable, false, 'global by the ADR-019 classification table');
});

// ---------------------------------------------------------------------------
// Place/state queries (the HUD pattern promoted to configuration)
// ---------------------------------------------------------------------------

test('entriesForPlace returns only entries declaring that place, in registry order', () => {
  const globalPlace = entriesForPlace('preferences.global');
  assert.ok(globalPlace.length >= 3);
  const keys = globalPlace.map((e) => e.key);
  const registryOrder = PREFERENCE_REGISTRY.filter((e) => e.place.includes('preferences.global')).map((e) => e.key);
  assert.deepEqual(keys, registryOrder);
  assert.deepEqual(entriesForPlace('no.such.place'), []);
});

test('entriesForPlace honors the optional when(state) predicate', () => {
  const synthetic = [
    { key: 'always', place: ['spot'] },
    { key: 'gated', place: ['spot'], when: (state) => state?.projectOpen === true }
  ];
  assert.deepEqual(entriesForPlace('spot', {}, synthetic).map((e) => e.key), ['always']);
  assert.deepEqual(
    entriesForPlace('spot', { projectOpen: true }, synthetic).map((e) => e.key),
    ['always', 'gated']
  );
});

// ---------------------------------------------------------------------------
// Domain: resolution + pure setValue
// ---------------------------------------------------------------------------

test('getEffective falls back to the registry default when unset', () => {
  const domain = createPreferencesDomain({ values: {} });
  assert.equal(domain.selectors.getEffective('energyLevel'), 'live');
});

test('getEffective returns the stored value when valid', () => {
  const domain = createPreferencesDomain({ values: { energyLevel: 'calm' } });
  assert.equal(domain.selectors.getEffective('energyLevel'), 'calm');
});

test('getEffective coerces an invalid stored enum back to the default', () => {
  const domain = createPreferencesDomain({ values: { energyLevel: 'chaotic' } });
  assert.equal(domain.selectors.getEffective('energyLevel'), 'live');
});

test('getEffective on an unknown key throws', () => {
  const domain = createPreferencesDomain({ values: {} });
  assert.throws(() => domain.selectors.getEffective('nope'), /unknown preference/i);
});

test('setValue returns a new values object and leaves the original untouched', () => {
  const values = { energyLevel: 'live' };
  const domain = createPreferencesDomain({ values });
  const next = domain.commands.setValue({ key: 'energyLevel', value: 'calm' });
  assert.equal(next.energyLevel, 'calm');
  assert.equal(values.energyLevel, 'live');
  assert.notEqual(next, values);
});

test('setValue rejects invalid enum values, unknown keys, and null json', () => {
  const domain = createPreferencesDomain({ values: {} });
  assert.throws(() => domain.commands.setValue({ key: 'energyLevel', value: 'chaotic' }), /invalid value/i);
  assert.throws(() => domain.commands.setValue({ key: 'nope', value: 'x' }), /unknown preference/i);
  assert.throws(() => domain.commands.setValue({ key: 'appearance', value: null }), /object/i);
});

test('setValue accepts a plain object for json entries', () => {
  const domain = createPreferencesDomain({ values: {} });
  const appearance = { activeThemeId: 'glass', themes: {} };
  const next = domain.commands.setValue({ key: 'appearance', value: appearance });
  assert.deepEqual(next.appearance, appearance);
});

test('setValue accepts terminalDrawerClose values now the capability shipped', () => {
  const domain = createPreferencesDomain({ values: {} });
  const next = domain.commands.setValue({ key: 'terminalDrawerClose', value: 'hide' });
  assert.equal(next.terminalDrawerClose, 'hide');
  assert.throws(
    () => domain.commands.setValue({ key: 'terminalDrawerClose', value: 'sideways' }),
    /invalid value/i
  );
  // The comingSoon refusal mechanism in validateForSet stays in the domain
  // for future gated entries; with no comingSoon entry registered, it has
  // no exercisable path from the shipped registry.
});

// ---------------------------------------------------------------------------
// Seed entries (Slice 4): consumed by the wizard at project creation
// ---------------------------------------------------------------------------

test('seed entries exist, are seed-propagated, and are not project-overridable', () => {
  for (const key of ['defaultProjectLocation', 'defaultBaseTheme']) {
    const entry = PREFERENCE_REGISTRY.find((e) => e.key === key);
    assert.ok(entry, `${key} missing from registry`);
    assert.equal(entry.propagation, 'seed', `${key}: seeds are copied at creation, not inherited`);
    assert.equal(entry.projectOverridable, false, `${key}: seeds are consumed at creation, not overridden`);
    assert.ok(entry.place.includes('preferences.global'));
  }
});

test('defaultBaseTheme values track the builtin preset ids (drift guard)', () => {
  const entry = PREFERENCE_REGISTRY.find((e) => e.key === 'defaultBaseTheme');
  assert.deepEqual([...entry.values].sort(), [...BUILTIN_THEME_IDS].sort());
  assert.equal(entry.defaultValue, 'glass');
});

test('text entries accept strings (including empty) and reject non-strings', () => {
  const domain = createPreferencesDomain({ values: {} });
  const next = domain.commands.setValue({ key: 'defaultProjectLocation', value: 'C:\\dev' });
  assert.equal(next.defaultProjectLocation, 'C:\\dev');
  const cleared = domain.commands.setValue({ key: 'defaultProjectLocation', value: '' });
  assert.equal(cleared.defaultProjectLocation, '');
  assert.throws(() => domain.commands.setValue({ key: 'defaultProjectLocation', value: 42 }), /invalid value/i);
});

test('text entries resolve to their default when unset', () => {
  const domain = createPreferencesDomain({ values: {} });
  assert.equal(domain.selectors.getEffective('defaultProjectLocation'), '');
});

// ---------------------------------------------------------------------------
// Two-layer resolution (Slice 2): project override -> global -> default
// ---------------------------------------------------------------------------

test('project override wins over global for overridable entries', () => {
  const domain = createPreferencesDomain({
    values: { energyLevel: 'live' },
    projectValues: { energyLevel: 'calm' }
  });
  assert.equal(domain.selectors.getEffective('energyLevel'), 'calm');
  assert.equal(domain.selectors.getLayer('energyLevel'), 'project');
});

test('invalid project override falls through to global', () => {
  const domain = createPreferencesDomain({
    values: { energyLevel: 'calm' },
    projectValues: { energyLevel: 'chaotic' }
  });
  assert.equal(domain.selectors.getEffective('energyLevel'), 'calm');
  assert.equal(domain.selectors.getLayer('energyLevel'), 'global');
});

test('non-overridable entries ignore the project layer entirely', () => {
  const appearance = { activeThemeId: 'obsidian', themes: {} };
  const domain = createPreferencesDomain({
    values: { appearance },
    projectValues: { appearance: { activeThemeId: 'terminal', themes: {} } }
  });
  assert.deepEqual(domain.selectors.getEffective('appearance'), appearance);
  assert.equal(domain.selectors.getLayer('appearance'), 'global');
});

test('getLayer reports default when neither layer holds a value', () => {
  const domain = createPreferencesDomain({ values: {}, projectValues: {} });
  assert.equal(domain.selectors.getLayer('energyLevel'), 'default');
});

test('setProjectValue returns next project values; original untouched', () => {
  const projectValues = {};
  const domain = createPreferencesDomain({ values: {}, projectValues });
  const next = domain.commands.setProjectValue({ key: 'energyLevel', value: 'calm' });
  assert.equal(next.energyLevel, 'calm');
  assert.deepEqual(projectValues, {});
});

test('setProjectValue refuses non-overridable and invalid values', () => {
  const domain = createPreferencesDomain({ values: {}, projectValues: {} });
  assert.throws(
    () => domain.commands.setProjectValue({ key: 'appearance', value: { activeThemeId: 'glass' } }),
    /not project-overridable/i
  );
  assert.throws(() => domain.commands.setProjectValue({ key: 'energyLevel', value: 'chaotic' }), /invalid value/i);
});

test('clearProjectValue removes the override (reset to global)', () => {
  const domain = createPreferencesDomain({
    values: { energyLevel: 'live' },
    projectValues: { energyLevel: 'calm' }
  });
  const next = domain.commands.clearProjectValue({ key: 'energyLevel' });
  assert.ok(!('energyLevel' in next));
});

test('domain exposes the commands contract', () => {
  const domain = createPreferencesDomain({ values: {} });
  assert.equal(typeof domain.commands, 'object');
  assert.equal(typeof domain.commands.setValue, 'function');
  assert.equal(typeof domain.selectors.entriesForPlace, 'function');
});
