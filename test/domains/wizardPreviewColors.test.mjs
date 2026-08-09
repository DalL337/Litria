import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveWizardPreviewColors, resolveWizardPreviewSurface } from '../../src/app/selectors/wizardPreviewColors.js';
import { parseColorToRgb, rgbToHsl } from '../../src/utils/color.js';

test('Live: preview shows chosen colors verbatim', () => {
  const { groupColor, memberEdge, standaloneEdge } = resolveWizardPreviewColors({
    energyLevel: 'live',
    groupColor: '#26a69a',
    nodeColorMode: 'custom',
    nodeColor: '#42a5f5'
  });
  assert.equal(groupColor, '#26a69a');
  assert.equal(memberEdge, '#26a69a', 'member inherits the group color');
  assert.equal(standaloneEdge, '#42a5f5', 'standalone shows the custom node color');
});

test('Calm: chosen colors render as their pastel equivalents (neon → pastel)', () => {
  const live = resolveWizardPreviewColors({
    energyLevel: 'live',
    groupColor: '#00ff66',
    nodeColorMode: 'custom',
    nodeColor: '#00ff66'
  });
  const calm = resolveWizardPreviewColors({
    energyLevel: 'calm',
    groupColor: '#00ff66',
    nodeColorMode: 'custom',
    nodeColor: '#00ff66'
  });

  assert.notEqual(calm.memberEdge, live.memberEdge, 'calm transforms the member edge');

  const before = rgbToHsl(parseColorToRgb(live.memberEdge));
  const after = rgbToHsl(parseColorToRgb(calm.memberEdge));
  assert.ok(after.s < before.s, 'saturation drops');
  assert.ok(after.l > before.l, 'lightness rises');
  assert.equal(Math.round(after.h), Math.round(before.h), 'hue (the "green") is preserved');
});

test('inherit mode: standalone has no edge until grouped or set', () => {
  const { standaloneEdge } = resolveWizardPreviewColors({
    energyLevel: 'calm',
    groupColor: '#26a69a',
    nodeColorMode: 'inherit',
    nodeColor: '#42a5f5'
  });
  assert.equal(standaloneEdge, null);
});

test('tolerates undefined state', () => {
  const result = resolveWizardPreviewColors(undefined);
  assert.equal(result.groupColor, null);
  assert.equal(result.memberEdge, null);
  assert.equal(result.standaloneEdge, null);
});

test('preview surface: glass presets render translucent + blurred with light ink', () => {
  for (const id of ['glass', 'obsidian']) {
    const s = resolveWizardPreviewSurface(id);
    assert.equal(s.material, 'glass', `${id} material`);
    assert.match(s.backdropFilter, /^blur\(/, `${id} has backdrop blur`);
    assert.match(s.background, /^rgba\(/, `${id} surface is translucent`);
    assert.equal(s.color, '#f3f6ff', `${id} uses light auto ink`);
  }
});

test('preview surface: matte presets render opaque + bordered with their own ink, no blur', () => {
  const parchment = resolveWizardPreviewSurface('parchment');
  assert.equal(parchment.material, 'matte');
  assert.equal(parchment.background, '#f2e4c4', 'opaque warm fill');
  assert.equal(parchment.color, '#3b2a14', 'tannin ink');
  assert.equal(parchment.backdropFilter, 'none');
  assert.match(parchment.border, /solid/);

  const terminal = resolveWizardPreviewSurface('terminal');
  assert.equal(terminal.material, 'matte');
  assert.equal(terminal.background, '#12220f', 'opaque dark-green fill');
  assert.equal(terminal.color, '#8affa0', 'phosphor-green ink');
  assert.equal(terminal.backdropFilter, 'none');
});

test('preview surface: unknown/undefined theme falls back to glass', () => {
  assert.equal(resolveWizardPreviewSurface('nope').material, 'glass');
  assert.equal(resolveWizardPreviewSurface(undefined).material, 'glass');
});
