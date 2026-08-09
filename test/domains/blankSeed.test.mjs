import test from 'node:test';
import assert from 'node:assert/strict';

import { buildBlankSeedRows } from '../../src/project/blankSeed.js';

test('README is the hero: first row, at the origin, regardless of input order', () => {
  const rows = buildBlankSeedRows(['.gitignore', 'README.md', '.editorconfig']);
  assert.equal(rows[0].filePath, 'README.md');
  assert.equal(rows[0].x, 240);
  assert.equal(rows[0].y, 220);
});

test('support files stack in a column to the right of the hero', () => {
  const rows = buildBlankSeedRows(['README.md', '.gitignore', '.editorconfig']);
  const support = rows.slice(1);
  assert.equal(support.length, 2);
  // Same column, distinct rows.
  assert.ok(support.every((r) => r.x === 240 + 360));
  assert.equal(support[0].y, 220);
  assert.equal(support[1].y, 220 + 180);
  // Alphabetical within the column: .editorconfig before .gitignore.
  assert.equal(support[0].filePath, '.editorconfig');
  assert.equal(support[1].filePath, '.gitignore');
});

test('rows carry the shape dbCreatePiecesBatch expects (filePath/label/x/y/color)', () => {
  const [row] = buildBlankSeedRows(['README.md']);
  assert.deepEqual(Object.keys(row).sort(), ['color', 'filePath', 'label', 'x', 'y']);
  assert.equal(row.label, 'README.md');
  assert.equal(row.color, null);
});

test('non-string and empty entries are dropped; empty input yields no rows', () => {
  assert.deepEqual(buildBlankSeedRows([]), []);
  assert.deepEqual(buildBlankSeedRows(null), []);
  assert.deepEqual(buildBlankSeedRows(undefined), []);
  const rows = buildBlankSeedRows(['README.md', '', null, 42]);
  assert.equal(rows.length, 1);
});

test('custom layout options are honored', () => {
  const rows = buildBlankSeedRows(['README.md', 'a.txt'], {
    originX: 0, originY: 0, columnGap: 100, rowGap: 50
  });
  assert.deepEqual([rows[0].x, rows[0].y], [0, 0]);
  assert.deepEqual([rows[1].x, rows[1].y], [100, 0]);
});
