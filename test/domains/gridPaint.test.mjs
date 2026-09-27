import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_BACKGROUND,
  GRID_SUB_OPACITY_RATIO,
  gridInkColor,
  gridInkGain,
  gridPaintOverrideKey,
  gridStrokeStyle,
  readOpacity,
  resolveGridPaint,
  themeGridOpacities,
} from '../../src/theme/gridPaint.js';
import { BUILTIN_THEME_PRESETS, GLASS_THEME_TOKEN_DEFAULTS } from '../../src/theme/themeDefaults.js';
import { applyEnergyLevel } from '../../src/app/themeDomain.js';
import { parseColorToRgb } from '../../src/utils/color.js';

const tokensFor = (presetId) => ({
  ...GLASS_THEME_TOKEN_DEFAULTS,
  ...(BUILTIN_THEME_PRESETS[presetId]?.tokens ?? {}),
});

const luma = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

test('theme ink is the theme wire color unless the theme declares a grid color', () => {
  assert.deepEqual(gridInkColor({ connectionStroke: '#42a5f5' }), { r: 66, g: 165, b: 245 });
  assert.deepEqual(gridInkColor({ connectionStroke: '#42a5f5', canvasGridColor: '#ff0000' }), { r: 255, g: 0, b: 0 });
  assert.deepEqual(gridInkColor({ connectionStroke: 'not a color' }), { r: 255, g: 255, b: 255 });
  assert.deepEqual(gridInkColor({ connectionStroke: '#42a5f5' }, 'neutral'), { r: 255, g: 255, b: 255 });
});

test('neutral ink keeps today\'s opacities exactly', () => {
  assert.equal(gridInkGain({ r: 255, g: 255, b: 255 }), 1);
  const opacities = themeGridOpacities(GLASS_THEME_TOKEN_DEFAULTS, 'neutral');
  assert.equal(opacities.minor, 0.03);
  assert.equal(opacities.major, 0.06);
  assert.ok(Math.abs(opacities.sub - 0.03 * GRID_SUB_OPACITY_RATIO) < 1e-12);
});

test('every built-in theme\'s tinted lines are exactly as visible as white ones', () => {
  const bg = luma(parseColorToRgb(CANVAS_BACKGROUND));
  for (const presetId of Object.keys(BUILTIN_THEME_PRESETS)) {
    for (const energy of ['live', 'calm']) {
      const tokens = applyEnergyLevel({ tokens: tokensFor(presetId) }, energy).tokens;
      const ink = gridInkColor(tokens);
      const tinted = themeGridOpacities(tokens, 'theme');
      const white = themeGridOpacities(tokens, 'neutral');
      for (const level of ['major', 'minor', 'sub']) {
        // Luma lift over the background at each opacity.
        const tintedLift = tinted[level] * (luma(ink) - bg);
        const whiteLift = white[level] * (255 - bg);
        assert.ok(Math.abs(tintedLift - whiteLift) < 1e-9, `${presetId}/${energy}/${level}`);
      }
    }
  }
});

test('an explicit zero opacity survives; junk falls back', () => {
  assert.equal(readOpacity('0', 0.03), 0);
  assert.equal(readOpacity('', 0.03), 0.03);
  assert.equal(readOpacity('abc', 0.03), 0.03);
  assert.equal(readOpacity('2', 0.03), 1);
  const opacities = themeGridOpacities({ canvasGridOpacity: '0', canvasGridAccentOpacity: '0' }, 'neutral');
  assert.deepEqual(opacities, { major: 0, minor: 0, sub: 0 });
});

test('a declared sub opacity wins over the derived ratio', () => {
  const opacities = themeGridOpacities({ canvasGridOpacity: '0.05', canvasGridSubOpacity: '0.01' }, 'neutral');
  assert.equal(opacities.sub, 0.01);
});

test('a personal override applies only to its own theme, energy and ink', () => {
  const tokens = tokensFor('terminal');
  const key = gridPaintOverrideKey('terminal', 'live', 'theme');
  assert.equal(key, 'terminal:live:theme');
  const overrides = { [key]: { major: 0.2, minor: 0.1, sub: 0.05 } };
  const painted = resolveGridPaint(tokens, { themeId: 'terminal', energyLevel: 'live', ink: 'theme', overrides });
  assert.equal(painted.overridden, true);
  assert.equal(painted.major, 0.2);
  const calm = resolveGridPaint(tokens, { themeId: 'terminal', energyLevel: 'calm', ink: 'theme', overrides });
  assert.equal(calm.overridden, false);
  const neutral = resolveGridPaint(tokens, { themeId: 'terminal', energyLevel: 'live', ink: 'neutral', overrides });
  assert.equal(neutral.overridden, false);
});

test('a malformed override is ignored', () => {
  const overrides = { 'glass:live:theme': { major: 'x', minor: 0.1, sub: 0.1 } };
  const painted = resolveGridPaint(GLASS_THEME_TOKEN_DEFAULTS, { themeId: 'glass', overrides });
  assert.equal(painted.overridden, false);
});

test('stroke style carries the ink and opacity', () => {
  assert.equal(gridStrokeStyle({ r: 1, g: 2, b: 3 }, 0.5), 'rgba(1, 2, 3, 0.5)');
});

test('grid theme parameters name real grid tokens; the sub level shows its derived default', async () => {
  const { GRID_PARAMETERS, GRID_COLOR_TOKEN } = await import('../../src/theme/gridParams.js');
  const tokens = GRID_PARAMETERS.map((p) => p.token);
  assert.deepEqual(tokens, ['canvasGridAccentOpacity', 'canvasGridOpacity', 'canvasGridSubOpacity']);
  assert.equal(GRID_COLOR_TOKEN, 'canvasGridColor');
  const sub = GRID_PARAMETERS.find((p) => p.token === 'canvasGridSubOpacity');
  assert.ok(Math.abs(sub.fallbackValue({ canvasGridOpacity: '0.05' }) - 0.03) < 1e-12);
});
