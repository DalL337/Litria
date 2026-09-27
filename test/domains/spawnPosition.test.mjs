import test from 'node:test';
import assert from 'node:assert/strict';

import { computeSpawnPosition } from '../../src/utils/spawnPosition.js';
import { DEFAULT_GRID_DEFINITION, deriveGridSteps } from '../../src/utils/gridGeometry.js';

const grid = { mode: 'flex', steps: deriveGridSteps(DEFAULT_GRID_DEFINITION) };
const view = { x: -500, y: -300, width: 1000, height: 600 }; // centered on the origin

test('with a grid, a new node lands on the major intersection nearest the viewport center', () => {
  const at = computeSpawnPosition({ visibleBounds: view, pieces: [], pieceWidth: 180, pieceHeight: 110, grid });
  // The body's corner for a centered node is (-90, -55); nearest major is (-100, -100).
  assert.deepEqual(at, { x: -100, y: -100 });
});

test('an occupied center moves the spawn to the next free intersection, deterministically', () => {
  const pieces = [{ id: 1, x: -100, y: -100 }];
  const first = computeSpawnPosition({ visibleBounds: view, pieces, pieceWidth: 180, pieceHeight: 110, grid });
  const again = computeSpawnPosition({ visibleBounds: view, pieces, pieceWidth: 180, pieceHeight: 110, grid });
  assert.deepEqual(first, again);
  assert.equal(first.x % 100 === 0 && first.y % 100 === 0, true);
  const overlaps = first.x < -100 + 180 && first.x + 180 > -100 && first.y < -100 + 110 && first.y + 110 > -100;
  assert.equal(overlaps, false);
});

test('scaled neighbors block by their scaled bodies', () => {
  const pieces = [{ id: 1, x: -300, y: -100, scale: 1.5 }]; // reaches x = -30
  const at = computeSpawnPosition({ visibleBounds: view, pieces, pieceWidth: 180, pieceHeight: 110, grid });
  const blockedRect = { x: -300, y: -100, width: 270, height: 165 };
  const overlaps = at.x < blockedRect.x + blockedRect.width && at.x + 180 > blockedRect.x
    && at.y < blockedRect.y + blockedRect.height && at.y + 110 > blockedRect.y;
  assert.equal(overlaps, false);
});

test('a crowded canvas falls back to the centered intersection, never a random spot', () => {
  const pieces = [];
  for (let i = -30; i <= 30; i++) {
    for (let j = -30; j <= 30; j++) pieces.push({ id: `${i}_${j}`, x: i * 100, y: j * 100 });
  }
  const a = computeSpawnPosition({ visibleBounds: view, pieces, pieceWidth: 180, pieceHeight: 110, grid });
  const b = computeSpawnPosition({ visibleBounds: view, pieces, pieceWidth: 180, pieceHeight: 110, grid });
  assert.deepEqual(a, b);
  assert.deepEqual(a, { x: -100, y: -100 });
});
