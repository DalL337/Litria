import test from 'node:test';
import assert from 'node:assert/strict';

import { createThemeDomain } from '../../src/app/themeDomain.js';

test('ThemeDomain falls back to built-in glass theme when appearance is missing', () => {
  const domain = createThemeDomain({ appearance: null });
  const activeTheme = domain.selectors.getActiveTheme();

  assert.equal(activeTheme.id, 'glass');
  assert.equal(activeTheme.name, 'Glass');
  assert.equal(typeof activeTheme.tokens.connectionStroke, 'string');
  assert.equal(typeof activeTheme.tokens.connectionValid, 'string');
  assert.equal(typeof activeTheme.tokens.glassBlurRadius, 'string');
});

test('ThemeDomain resolves active custom theme and ignores invalid token values', () => {
  const domain = createThemeDomain({
    appearance: {
      activeThemeId: 'custom',
      themes: {
        custom: {
          id: 'custom',
          name: 'My Theme',
          tokens: {
            connectionStroke: '#123456',
            connectionWarning: '#999999',
            invalid: 10
          }
        }
      }
    }
  });

  const activeTheme = domain.selectors.getActiveTheme();
  assert.equal(activeTheme.id, 'custom');
  assert.equal(activeTheme.name, 'My Theme');
  assert.equal(activeTheme.tokens.connectionStroke, '#123456');
  assert.equal(activeTheme.tokens.connectionWarning, '#999999');
  assert.equal(activeTheme.tokens.invalid, undefined);
});

test('ThemeDomain initializeFromProject updates active theme summary', () => {
  const domain = createThemeDomain({ appearance: null });
  domain.commands.initializeFromProject({
    appearance: {
      activeThemeId: 'custom',
      themes: {
        custom: { id: 'custom', name: 'Custom', tokens: {} }
      }
    }
  });

  const summary = domain.selectors.getSettingsSummary();
  assert.equal(summary.activeThemeId, 'custom');
  assert.equal(summary.activeThemeName, 'Custom');
  assert.equal(summary.canDeleteActiveTheme, true);
});

test('ThemeDomain updateThemeTokens patches active theme tokens', () => {
  const domain = createThemeDomain({ appearance: null });
  domain.commands.updateThemeTokens({
    patch: {
      nodeSelectedStroke: '#112233',
      glassBlurRadius: '10'
    }
  });

  const activeTheme = domain.selectors.getActiveTheme();
  assert.equal(activeTheme.tokens.nodeSelectedStroke, '#112233');
  assert.equal(activeTheme.tokens.glassBlurRadius, '10');
});

test('ThemeDomain resetThemeTokens removes overridden keys', () => {
  const domain = createThemeDomain({ appearance: null });
  domain.commands.updateThemeTokens({
    patch: {
      nodeSelectedStroke: '#112233'
    }
  });
  domain.commands.resetThemeTokens({
    keys: ['nodeSelectedStroke']
  });

  const activeTheme = domain.selectors.getActiveTheme();
  assert.equal(activeTheme.tokens.nodeSelectedStroke, '#00BFFF');
});

test('ThemeDomain can create, activate, rename, and delete custom themes', () => {
  const domain = createThemeDomain({ appearance: null });

  const created = domain.commands.createThemeFromBase({
    baseThemeId: 'glass',
    name: 'Ocean'
  });
  assert.equal(created.activeThemeId.startsWith('ocean'), true);
  const createdThemeId = created.activeThemeId;
  assert.equal(Boolean(created.themes[createdThemeId]), true);
  assert.equal(created.themes[createdThemeId].name, 'Ocean');

  domain.commands.renameTheme({
    themeId: createdThemeId,
    name: 'Ocean Dark'
  });
  let summary = domain.selectors.getSettingsSummary();
  assert.equal(summary.activeThemeName, 'Ocean Dark');

  domain.commands.setActiveTheme({ themeId: 'glass' });
  summary = domain.selectors.getSettingsSummary();
  assert.equal(summary.activeThemeId, 'glass');
  assert.equal(summary.canDeleteActiveTheme, false);

  domain.commands.setActiveTheme({ themeId: createdThemeId });
  summary = domain.selectors.getSettingsSummary();
  assert.equal(summary.canDeleteActiveTheme, true);

  const deleted = domain.commands.deleteCustomTheme({ themeId: createdThemeId });
  assert.equal(deleted.themes[createdThemeId], undefined);
  assert.equal(deleted.activeThemeId, 'glass');
});

test('ThemeDomain prevents deleting and renaming built-in glass theme', () => {
  const domain = createThemeDomain({ appearance: null });

  const beforeDelete = domain.selectors.getAppearance();
  domain.commands.deleteCustomTheme({ themeId: 'glass' });
  const afterDelete = domain.selectors.getAppearance();
  assert.deepEqual(afterDelete, beforeDelete);

  domain.commands.renameTheme({ themeId: 'glass', name: 'Nope' });
  const summary = domain.selectors.getSettingsSummary();
  assert.equal(summary.activeThemeName, 'Glass');
});

test('applyEnergyLevel: live is the identity; calm merges low-stimulus overrides', async () => {
  const { applyEnergyLevel, CALM_TOKEN_OVERRIDES } = await import('../../src/app/themeDomain.js');
  const theme = { id: 'glass', name: 'Glass', tokens: { glassRimWidth: 1.5, nodeLedSize: 28, foo: 'bar' } };

  // Live → same theme object, untouched.
  assert.equal(applyEnergyLevel(theme, 'live'), theme);

  // Calm → new theme with overrides merged over the originals, others preserved.
  const calm = applyEnergyLevel(theme, 'calm');
  assert.notEqual(calm, theme, 'calm returns a new object');
  assert.equal(calm.tokens.glassRimWidth, CALM_TOKEN_OVERRIDES.glassRimWidth);
  assert.equal(calm.tokens.nodeLedSize, CALM_TOKEN_OVERRIDES.nodeLedSize);
  assert.equal(calm.tokens.foo, 'bar', 'non-overridden tokens preserved');
  assert.equal(theme.tokens.glassRimWidth, 1.5, 'original theme not mutated');
});

test('Calm overrides pastelize the left-edge color: lower saturation, higher lightness', async () => {
  const { CALM_TOKEN_OVERRIDES } = await import('../../src/app/themeDomain.js');
  assert.ok(CALM_TOKEN_OVERRIDES.nodeEdgeSaturation < 1, 'calm desaturates the edge');
  assert.ok(CALM_TOKEN_OVERRIDES.nodeEdgeLightness > 1, 'calm lightens the edge');
});

test('applyEnergyLevel: tolerates null theme', async () => {
  const { applyEnergyLevel } = await import('../../src/app/themeDomain.js');
  assert.equal(applyEnergyLevel(null, 'calm'), null);
});
