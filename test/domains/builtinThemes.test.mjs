import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BUILTIN_THEME_IDS,
  BUILTIN_THEME_PRESETS,
  isBuiltinThemeId,
  mergeGlassThemeTokens
} from '../../src/theme/themeDefaults.js';
import { normalizeAppearance } from '../../src/project/manifest.js';
import { createThemeDomain } from '../../src/app/themeDomain.js';

// The revised material cut: two dispatched materials, four presets.
//   Glass material (effect):  glass · obsidian
//   Matte material (flat):    parchment · terminal
const EXPECTED_MATERIAL = {
  glass: 'glass',
  obsidian: 'glass',
  parchment: 'matte',
  terminal: 'matte'
};

test('BUILTIN_THEME_PRESETS covers exactly the four ships-with presets', () => {
  assert.deepEqual([...BUILTIN_THEME_IDS].sort(), ['glass', 'obsidian', 'parchment', 'terminal']);
});

test('each preset resolves to the expected material (color ⊥ material data contract)', () => {
  for (const id of BUILTIN_THEME_IDS) {
    const tokens = mergeGlassThemeTokens(BUILTIN_THEME_PRESETS[id].tokens);
    assert.equal(tokens.nodeMaterial, EXPECTED_MATERIAL[id], `${id} material`);
  }
});

test('matte presets are opaque (nodeSurfaceAlpha 1) with a border; glass baseline stays material glass', () => {
  const parchment = mergeGlassThemeTokens(BUILTIN_THEME_PRESETS.parchment.tokens);
  const terminal = mergeGlassThemeTokens(BUILTIN_THEME_PRESETS.terminal.tokens);
  for (const t of [parchment, terminal]) {
    assert.equal(t.nodeMaterial, 'matte');
    assert.equal(t.nodeSurfaceAlpha, '1', 'matte surface is opaque');
    assert.equal(typeof t.matteBorderColor, 'string');
  }
  // Glass baseline: no overrides needed — merges to the default material.
  const glass = mergeGlassThemeTokens(BUILTIN_THEME_PRESETS.glass.tokens);
  assert.equal(glass.nodeMaterial, 'glass');
});

// Selection / hover / group-outline chrome. If a non-Glass preset omits any of
// these, that state falls back to the Glass BLUE default and the workspace looks
// half-themed (the bug the parchment screenshot exposed). Guard against regression.
const SELECTION_FAMILY_KEYS = [
  'groupPillSelectedFill',
  'groupPillSelectedStroke',
  'groupPillSelectedGlow',
  'groupPillHoverStroke',
  'groupPillHoverGlow',
  'groupPillDivider',
  'selectionGroupOutline'
];

test('every non-Glass preset overrides the full selection/hover/outline chrome family', () => {
  const glassDefaults = mergeGlassThemeTokens(BUILTIN_THEME_PRESETS.glass.tokens);
  for (const id of BUILTIN_THEME_IDS) {
    if (id === 'glass') continue;
    const overrides = BUILTIN_THEME_PRESETS[id].tokens;
    for (const key of SELECTION_FAMILY_KEYS) {
      assert.equal(typeof overrides[key], 'string', `${id} must set ${key}`);
      assert.notEqual(overrides[key], glassDefaults[key], `${id}.${key} must not be the Glass default`);
    }
  }
});

test('normalizeAppearance seeds all four built-ins when appearance is empty, defaulting to glass', () => {
  const appearance = normalizeAppearance(null);
  assert.equal(appearance.activeThemeId, 'glass');
  for (const id of BUILTIN_THEME_IDS) {
    assert.ok(appearance.themes[id], `${id} seeded`);
    assert.equal(appearance.themes[id].name, BUILTIN_THEME_PRESETS[id].name);
  }
});

test('normalizeAppearance preserves a user-forked built-in rather than reseeding it', () => {
  const appearance = normalizeAppearance({
    activeThemeId: 'obsidian',
    themes: {
      obsidian: { id: 'obsidian', name: 'My Obsidian', tokens: { nodeSurfaceTint: '#010203' } }
    }
  });
  // The user's edited copy survives untouched…
  assert.equal(appearance.themes.obsidian.name, 'My Obsidian');
  assert.equal(appearance.themes.obsidian.tokens.nodeSurfaceTint, '#010203');
  // …and the other absent built-ins are still seeded.
  assert.ok(appearance.themes.parchment);
  assert.ok(appearance.themes.terminal);
});

test('create-time seed round-trip: selecting a preset opens with it active and its material', () => {
  // Mirrors useProjectLaunch: normalizeAppearance({ activeThemeId: chosen, themes: {} }).
  const seeded = normalizeAppearance({ activeThemeId: 'terminal', themes: {} });
  const domain = createThemeDomain({ appearance: seeded });
  const active = domain.selectors.getActiveTheme();
  assert.equal(active.id, 'terminal');
  assert.equal(active.tokens.nodeMaterial, 'matte');
  assert.equal(active.tokens.nodeText, '#8affa0');
});

test('all four built-ins are protected from delete and rename', () => {
  for (const id of BUILTIN_THEME_IDS) {
    assert.equal(isBuiltinThemeId(id), true);
    const domain = createThemeDomain({ appearance: { activeThemeId: id, themes: {} } });

    domain.commands.renameTheme({ themeId: id, name: 'Nope' });
    assert.equal(domain.selectors.getThemeById(id).name, BUILTIN_THEME_PRESETS[id].name, `${id} rename blocked`);

    const before = domain.selectors.getAppearance();
    domain.commands.deleteCustomTheme({ themeId: id });
    assert.ok(domain.selectors.getAppearance().themes[id], `${id} delete blocked`);
    assert.deepEqual(domain.selectors.getAppearance(), before);

    assert.equal(domain.selectors.getSettingsSummary().canDeleteActiveTheme, false, `${id} not deletable`);
  }
});

test('a custom theme forked from a built-in remains deletable and renamable', () => {
  const domain = createThemeDomain({ appearance: null });
  const created = domain.commands.createThemeFromBase({ baseThemeId: 'terminal', name: 'My Terminal' });
  const customId = created.activeThemeId;
  assert.equal(isBuiltinThemeId(customId), false);
  // Fork inherits the base material.
  assert.equal(domain.selectors.getThemeById(customId).tokens.nodeMaterial, 'matte');
  assert.equal(domain.selectors.getSettingsSummary().canDeleteActiveTheme, true);
  domain.commands.deleteCustomTheme({ themeId: customId });
  assert.equal(domain.selectors.getAppearance().themes[customId], undefined);
});
