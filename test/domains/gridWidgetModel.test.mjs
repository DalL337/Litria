import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeSpacing,
  gridSectionChips,
  scaleReadout,
  stepText,
  wiresThatFit,
} from '../../src/app/gridWidgetModel.js';
import { DEFAULT_GRID_DEFINITION, GRID_PRESETS } from '../../src/utils/gridGeometry.js';

const def = (overrides = {}) => ({ ...DEFAULT_GRID_DEFINITION, ...overrides });

test('the default spacing reads 100·20·10 with the Strict gaps the brief quotes', () => {
  const d = describeSpacing(def());
  assert.equal(d.label, '100·20·10');
  assert.equal(d.strictSideBySide, '20 (1 wire, 33% ink)');
  assert.equal(d.strictStacked, '90 (5 wires, 100% ink)');
  assert.deepEqual(d.warnings, []);
});

test('the 50·10·5 preset leaves 20 and 40', () => {
  const d = describeSpacing(def(GRID_PRESETS.find((p) => p.id === '50-10-5')));
  assert.equal(d.label, '50·10·5');
  assert.match(d.strictSideBySide, /^20 /);
  assert.match(d.strictStacked, /^40 /);
});

test('a rectangular step shows both axes', () => {
  assert.equal(stepText(100, 130), '100×130');
  assert.equal(describeSpacing(def({ majorY: 130 })).label, '100×130·20×26·10×13');
});

test('spacing warnings: fractional steps and a sub step that misses 10', () => {
  const d = describeSpacing(def({ majorX: 100, majorY: 100, minorDivisions: 3, subDivisions: 2 }));
  assert.equal(d.warnings.length, 2);
  const eights = describeSpacing(def({ majorX: 80, majorY: 80, minorDivisions: 5, subDivisions: 2 }));
  assert.ok(eights.warnings.some((w) => w.includes("doesn't divide 10")));
});

test('wire capacity follows the seam and corridor constants', () => {
  assert.equal(wiresThatFit(19), 0);
  assert.equal(wiresThatFit(20), 1);
  assert.equal(wiresThatFit(36), 2);
  assert.equal(wiresThatFit(90), 5);
});

test('scale readout: none, one scale, or Mixed', () => {
  assert.equal(scaleReadout([]), '');
  assert.equal(scaleReadout([{ scale: 1.25 }, { scale: 1.25 }]), '125%');
  assert.equal(scaleReadout([{ scale: 1 }, { scale: 1.5 }]), 'Mixed');
  assert.equal(scaleReadout([{}]), '100%');
});

test('folded subsection chips carry the current values', () => {
  const chips = gridSectionChips({
    preferences: { snapMode: 'flex', smartGuides: true, settleMs: 150, reduceMotion: false },
    definition: def(),
    selectedPieces: [],
    themeName: 'Glass',
    energyLevel: 'live',
  });
  assert.deepEqual(chips, {
    placement: 'Flex · guides',
    spacing: '100·20·10',
    settle: '150 ms',
    node: '',
    look: 'Glass · Live',
  });
  const instant = gridSectionChips({
    preferences: { snapMode: 'strict', smartGuides: false, settleMs: 150, reduceMotion: true },
    definition: def(),
    selectedPieces: [{ scale: 1.5 }],
    themeName: 'Terminal',
    energyLevel: 'calm',
  });
  assert.equal(instant.placement, 'Strict');
  assert.equal(instant.settle, 'instant');
  assert.equal(instant.node, '150%');
  assert.equal(instant.look, 'Terminal · Calm');
});
