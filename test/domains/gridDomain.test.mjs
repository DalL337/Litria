import test from 'node:test';
import assert from 'node:assert/strict';

import { createGridDomain } from '../../src/app/gridDomain.js';
import { DEFAULT_GRID_DEFINITION, GRID_SCHEMA_VERSION } from '../../src/utils/gridGeometry.js';

const record = (overrides = {}) => ({
  schemaVersion: GRID_SCHEMA_VERSION,
  coordinateSystem: 'canvas-2d',
  origin: { x: 0, y: 0 },
  majorX: 50,
  majorY: 50,
  minorDivisions: 5,
  subDivisions: 2,
  ...overrides,
});

test('a fresh domain shows the default and is not editable until hydrated', () => {
  const grid = createGridDomain();
  assert.equal(grid.selectors.getState().source, 'default');
  assert.equal(grid.selectors.isHydrated(), false);
  assert.equal(grid.selectors.canEdit(), false);
  assert.equal(grid.selectors.getSteps().subX, 10);
});

test('a workspace saved before the grid existed gets the compatibility definition', () => {
  const grid = createGridDomain();
  const state = grid.commands.hydrate({ record: null });
  assert.equal(state.source, 'compatibility');
  assert.equal(state.definition.majorX, DEFAULT_GRID_DEFINITION.majorX);
  assert.equal(grid.selectors.canEdit(), true);
});

test('a saved record is applied as saved', () => {
  const grid = createGridDomain();
  const state = grid.commands.hydrate({ record: record() });
  assert.equal(state.source, 'saved');
  assert.equal(state.steps.majorX, 50);
  assert.equal(state.steps.subX, 5);
});

test('an invalid record falls back diagnostically and locks editing', () => {
  const grid = createGridDomain();
  const state = grid.commands.hydrate({ record: record({ majorX: -1 }) });
  assert.equal(state.source, 'fallback');
  assert.equal(state.locked, true);
  assert.ok(state.diagnostics.length > 0);
  assert.equal(state.definition.majorX, DEFAULT_GRID_DEFINITION.majorX);
  const attempt = grid.commands.applyDefinition(record());
  assert.equal(attempt.ok, false, 'the unreadable record must not be overwritten');
});

test('a stored row the backend could not read is shown as a fallback and kept', () => {
  const grid = createGridDomain();
  const state = grid.commands.hydrate({ record: null, unreadable: true });
  assert.equal(state.source, 'fallback');
  assert.equal(grid.selectors.canEdit(), false);
});

test('a newer schema record is never overwritten', () => {
  const grid = createGridDomain();
  const state = grid.commands.hydrate({ record: record({ schemaVersion: GRID_SCHEMA_VERSION + 1 }) });
  assert.equal(state.source, 'fallback');
  assert.equal(grid.selectors.canEdit(), false);
});

test('a read-only workspace renders its grid but cannot change it', () => {
  const grid = createGridDomain();
  grid.commands.hydrate({ record: record(), readOnly: true });
  assert.equal(grid.selectors.getDefinition().majorX, 50);
  assert.equal(grid.selectors.canEdit(), false);
  assert.equal(grid.commands.applyDefinition(record({ majorX: 100 })).ok, false);
});

test('applying a definition bumps the revision and reports the previous one', () => {
  const grid = createGridDomain();
  grid.commands.hydrate({ record: record() });
  const before = grid.selectors.getRevision();
  const result = grid.commands.applyDefinition(record({ majorX: 100, majorY: 100 }));
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.equal(result.previous.majorX, 50);
  assert.equal(grid.selectors.getRevision(), before + 1);
  assert.equal(grid.selectors.getState().source, 'applied');
});

test('applying the same lattice is a no-op without a revision bump', () => {
  const grid = createGridDomain();
  grid.commands.hydrate({ record: record() });
  const before = grid.selectors.getRevision();
  const result = grid.commands.applyDefinition(record());
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(grid.selectors.getRevision(), before);
});

test('an invalid definition is refused and leaves the grid unchanged', () => {
  const grid = createGridDomain();
  grid.commands.hydrate({ record: record() });
  const result = grid.commands.applyDefinition(record({ subDivisions: 1.5 }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.length > 0);
  assert.equal(grid.selectors.getDefinition().subDivisions, 2);
});

test('reset forgets the workspace but keeps the revision moving forward', () => {
  const grid = createGridDomain();
  grid.commands.hydrate({ record: record() });
  const before = grid.selectors.getRevision();
  const state = grid.commands.reset();
  assert.equal(state.source, 'default');
  assert.equal(state.hydrated, false);
  assert.ok(state.revision > before);
});
