import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GRID_DEFINITION,
  GRID_PRESETS,
  GRID_SCHEMA_VERSION,
  deriveGridSteps,
  gridLevelAt,
  isOnStep,
  latticeCandidates,
  lineIndexRange,
  roundToStep,
  sameGridDefinition,
  validateGridDefinition,
} from '../../src/utils/gridGeometry.js';

const def = (overrides = {}) => ({ ...DEFAULT_GRID_DEFINITION, ...overrides });

test('the default is the owner-ruled 100 · 20 · 10 square lattice', () => {
  const steps = deriveGridSteps(DEFAULT_GRID_DEFINITION);
  assert.deepEqual(steps, { majorX: 100, majorY: 100, minorX: 20, minorY: 20, subX: 10, subY: 10 });
  assert.equal(validateGridDefinition(DEFAULT_GRID_DEFINITION).ok, true);
});

test('every preset is valid and keeps the sub step a divisor of 10', () => {
  for (const preset of GRID_PRESETS) {
    const result = validateGridDefinition(def(preset));
    assert.equal(result.ok, true, preset.label);
    const steps = deriveGridSteps(result.definition);
    assert.equal(10 % steps.subX, 0, preset.label);
    assert.equal(10 % steps.subY, 0, preset.label);
  }
});

test('validation accepts a rectangular definition and normalizes the envelope', () => {
  const result = validateGridDefinition({ majorX: 100, majorY: 130, minorDivisions: 5, subDivisions: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.definition, {
    schemaVersion: GRID_SCHEMA_VERSION,
    coordinateSystem: 'canvas-2d',
    origin: { x: 0, y: 0 },
    majorX: 100,
    majorY: 130,
    minorDivisions: 5,
    subDivisions: 2,
  });
});

test('validation rejects non-finite, out-of-range and fractional values', () => {
  const cases = [
    def({ majorX: Number.NaN }),
    def({ majorY: Infinity }),
    def({ majorX: 5 }),
    def({ majorY: 5000 }),
    def({ minorDivisions: 2.5 }),
    def({ subDivisions: 0 }),
    def({ subDivisions: 11 }),
    def({ majorX: '100' }),
    null,
    'grid',
  ];
  for (const raw of cases) {
    const result = validateGridDefinition(raw);
    assert.equal(result.ok, false, JSON.stringify(raw));
    assert.equal(result.definition, null);
    assert.ok(result.errors.length > 0);
  }
});

test('validation refuses a moved origin or a different coordinate system', () => {
  assert.equal(validateGridDefinition(def({ origin: { x: 10, y: 0 } })).ok, false);
  assert.equal(validateGridDefinition(def({ coordinateSystem: 'room-3d' })).ok, false);
});

test('a newer schema is reported as future, not invalid data to replace', () => {
  const result = validateGridDefinition(def({ schemaVersion: GRID_SCHEMA_VERSION + 1 }));
  assert.equal(result.ok, false);
  assert.equal(result.futureVersion, true);
});

test('sameGridDefinition compares the lattice, not the envelope', () => {
  assert.equal(sameGridDefinition(def(), { majorX: 100, majorY: 100, minorDivisions: 5, subDivisions: 2 }), true);
  assert.equal(sameGridDefinition(def(), def({ subDivisions: 4 })), false);
  assert.equal(sameGridDefinition(def(), null), false);
});

test('rounding is symmetric about the origin and never yields negative zero', () => {
  assert.equal(roundToStep(150, 100), 200);
  assert.equal(roundToStep(-150, 100), -200);
  assert.equal(roundToStep(149, 100), 100);
  assert.equal(roundToStep(-149, 100), -100);
  assert.ok(Object.is(roundToStep(-4, 10), 0), 'rounds to +0');
  assert.ok(Object.is(roundToStep(-0, 10), 0));
});

test('isOnStep tolerates floating-point noise', () => {
  assert.equal(isOnStep(0.1 + 0.2 - 0.3, 10), true);
  assert.equal(isOnStep(300.0000000001, 100), true);
  assert.equal(isOnStep(305, 10), false);
});

test('gridLevelAt reports the strongest level at an intersection', () => {
  const steps = deriveGridSteps(DEFAULT_GRID_DEFINITION);
  assert.equal(gridLevelAt(200, -300, steps), 'major');
  assert.equal(gridLevelAt(220, -300, steps), 'minor');
  assert.equal(gridLevelAt(230, -310, steps), 'sub');
  assert.equal(gridLevelAt(233, 0, steps), 'off-grid');
  assert.equal(gridLevelAt(200, 20, steps), 'minor', 'a major line meets a minor line at a minor intersection');
});

test('lattice candidates go ring by ring with deterministic order at negative ties', () => {
  // The anchor sits exactly between four intersections: every ring-0/1
  // tie is broken by y then x.
  const anchor = { x: -50, y: -50 };
  const first = [...take(latticeCandidates(anchor, 100, 100, 1), 9)];
  assert.deepEqual(first[0], { x: -100, y: -100, distance: Math.hypot(50, 50) });
  const again = [...take(latticeCandidates(anchor, 100, 100, 1), 9)];
  assert.deepEqual(again, first);
  // Nothing in the first ring is farther out than the ring allows.
  for (const point of first) {
    assert.ok(Math.abs(point.x + 100) <= 100 && Math.abs(point.y + 100) <= 100);
    assert.ok(!Object.is(point.x, -0) && !Object.is(point.y, -0));
  }
});

test('lineIndexRange covers the span with integer indices', () => {
  assert.deepEqual(lineIndexRange(-250, 250, 100), { first: -3, last: 3 });
  assert.deepEqual(lineIndexRange(1e6, 1e6 + 5, 10), { first: 100000, last: 100001 });
});

function* take(iterable, count) {
  let n = 0;
  for (const item of iterable) {
    if (n++ >= count) return;
    yield item;
  }
}
