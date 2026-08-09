import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPiecesByFolder, deriveGroupPieceIds } from '../../src/utils/groupFolders.js';

const piece = (id, filename) => ({ id, filename });
const sorted = (arr) => [...arr].sort();

// ===========================================================================
// buildPiecesByFolder
// ===========================================================================

test('maps each folder to the ids of pieces whose files live in it', () => {
  const map = buildPiecesByFolder([
    piece(1, 'src/a.py'),
    piece(2, 'src/b.py'),
    piece(3, 'lib/c.py'),
  ]);
  assert.deepEqual(sorted(map.get('src')), [1, 2]);
  assert.deepEqual(map.get('lib'), [3]);
});

test('skips pieces at the project root (no parent folder)', () => {
  const map = buildPiecesByFolder([piece(1, 'main.py'), piece(2, 'readme.md')]);
  assert.equal(map.size, 0);
});

test('keys nested folders by their exact parent directory', () => {
  const map = buildPiecesByFolder([
    piece(1, 'src/utils/helper.py'),
    piece(2, 'src/top.py'),
  ]);
  assert.deepEqual(map.get('src/utils'), [1]);
  assert.deepEqual(map.get('src'), [2]);
});

test('normalizes backslash separators', () => {
  const map = buildPiecesByFolder([piece(1, 'src\\a.py')]);
  assert.deepEqual(map.get('src'), [1]);
});

test('ignores pieces without a filename and non-array input', () => {
  assert.equal(buildPiecesByFolder([piece(1, null), { id: 2 }]).size, 0);
  assert.equal(buildPiecesByFolder(null).size, 0);
  assert.equal(buildPiecesByFolder(undefined).size, 0);
});

// ===========================================================================
// deriveGroupPieceIds
// ===========================================================================

test('derives a folder-backed group\'s members from folder structure', () => {
  const map = buildPiecesByFolder([piece(1, 'src/a.py'), piece(2, 'src/b.py')]);
  assert.deepEqual(sorted(deriveGroupPieceIds({ folderPath: 'src' }, map)), [1, 2]);
});

test('returns an empty array for a folder-backed group whose folder is empty', () => {
  const map = buildPiecesByFolder([piece(1, 'src/a.py')]);
  assert.deepEqual(deriveGroupPieceIds({ folderPath: 'empty' }, map), []);
});

test('returns null for a group without a folderPath (caller falls back)', () => {
  const map = buildPiecesByFolder([piece(1, 'src/a.py')]);
  assert.equal(deriveGroupPieceIds({ folderPath: null }, map), null);
  assert.equal(deriveGroupPieceIds({}, map), null);
});

test('normalizes the group folderPath before lookup', () => {
  const map = buildPiecesByFolder([piece(1, 'src/utils/a.py')]);
  assert.deepEqual(deriveGroupPieceIds({ folderPath: 'src\\utils' }, map), [1]);
});

// ===========================================================================
// Cross-check: derivation agrees with a piece moving between folders
// ===========================================================================

test('a piece moved to another folder is no longer a member of its old group', () => {
  // Piece 1 started in group-A's folder, now lives in group-B's folder.
  const map = buildPiecesByFolder([piece(1, 'B/a.py'), piece(2, 'A/keep.py')]);
  assert.deepEqual(deriveGroupPieceIds({ folderPath: 'A' }, map), [2]);      // stale membership gone
  assert.deepEqual(deriveGroupPieceIds({ folderPath: 'B' }, map), [1]);      // reflects the move
});
