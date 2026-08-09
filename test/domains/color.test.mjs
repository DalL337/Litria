import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseColorToRgb,
  rgbToHsl,
  hslToRgb,
  rgbToHex,
  pastelizeColor
} from '../../src/utils/color.js';

test('parseColorToRgb handles hex (3/6/8), rgb(), and rejects junk', () => {
  assert.deepEqual(parseColorToRgb('#f00'), { r: 255, g: 0, b: 0 });
  assert.deepEqual(parseColorToRgb('#ef5350'), { r: 239, g: 83, b: 80 });
  assert.deepEqual(parseColorToRgb('#ef5350ff'), { r: 239, g: 83, b: 80 });
  assert.deepEqual(parseColorToRgb('rgb(10, 20, 30)'), { r: 10, g: 20, b: 30 });
  assert.deepEqual(parseColorToRgb('rgba(10, 20, 30, 0.5)'), { r: 10, g: 20, b: 30 });
  assert.equal(parseColorToRgb('not-a-color'), null);
  assert.equal(parseColorToRgb(null), null);
});

test('rgbToHsl / hslToRgb round-trip primary colors', () => {
  assert.deepEqual(rgbToHsl({ r: 255, g: 0, b: 0 }), { h: 0, s: 1, l: 0.5 });
  const back = hslToRgb({ h: 0, s: 1, l: 0.5 });
  assert.deepEqual(back, { r: 255, g: 0, b: 0 });
  // grey → zero saturation
  assert.deepEqual(rgbToHsl({ r: 128, g: 128, b: 128 }).s, 0);
});

test('rgbToHex pads and clamps', () => {
  assert.equal(rgbToHex({ r: 255, g: 0, b: 0 }), '#ff0000');
  assert.equal(rgbToHex({ r: 1, g: 2, b: 3 }), '#010203');
});

test('pastelizeColor is the identity when both scales are 1', () => {
  assert.equal(pastelizeColor('#ef5350', { saturationScale: 1, lightnessScale: 1 }), '#ef5350');
  assert.equal(pastelizeColor('#ef5350'), '#ef5350');
});

test('pastelizeColor desaturates and lightens (Calm preset shape)', () => {
  const out = pastelizeColor('#ff0000', { saturationScale: 0.5, lightnessScale: 1.35 });
  const before = rgbToHsl(parseColorToRgb('#ff0000'));
  const after = rgbToHsl(parseColorToRgb(out));
  assert.ok(after.s < before.s, 'saturation drops');
  assert.ok(after.l > before.l, 'lightness rises');
  // hue is preserved (pure red stays red-ish)
  assert.equal(Math.round(after.h), Math.round(before.h));
});

test('pastelizeColor maxLightness caps already-light hues below white', () => {
  // A warm, light color that the lightness scale would push toward white.
  const uncapped = pastelizeColor('#ffca28', { saturationScale: 0.58, lightnessScale: 1.2 });
  const capped = pastelizeColor('#ffca28', { saturationScale: 0.58, lightnessScale: 1.2, maxLightness: 0.6 });
  const lUncapped = rgbToHsl(parseColorToRgb(uncapped)).l;
  const lCapped = rgbToHsl(parseColorToRgb(capped)).l;
  assert.ok(lCapped <= 0.601, 'capped lightness honors the ceiling');
  assert.ok(lCapped < lUncapped, 'cap actually lowered the result');
  // maxLightness alone (no scaling) still counts as a non-identity transform.
  assert.notEqual(pastelizeColor('#ffffff', { maxLightness: 0.8 }), '#ffffff');
});

test('pastelizeColor clamps lightness at white and falls back on junk', () => {
  // a near-white pushed by a big lightness scale stays valid (clamped), not NaN
  const out = pastelizeColor('#eeeeee', { saturationScale: 0.5, lightnessScale: 2 });
  assert.match(out, /^#[0-9a-f]{6}$/);
  // unparseable input returns the original string untouched
  assert.equal(pastelizeColor('inherit', { saturationScale: 0.5 }), 'inherit');
});
