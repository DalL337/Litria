import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizePath,
  getBasename,
  getDirname,
  toFolderSegment,
  uniqueFolderSegment,
  splitPathAtLastSeparator,
  isFiniteNumber,
  findReservedDeviceSegment,
} from '../../src/utils/path.js';

// ---------------------------------------------------------------------------
// findReservedDeviceSegment
// ---------------------------------------------------------------------------

test('findReservedDeviceSegment flags bare device names and any extension', () => {
  assert.equal(findReservedDeviceSegment('con'), 'con');
  assert.equal(findReservedDeviceSegment('con.py'), 'con.py');
  assert.equal(findReservedDeviceSegment('CON.tar.gz'), 'CON.tar.gz');
  assert.equal(findReservedDeviceSegment('Com1.js'), 'Com1.js');
  assert.equal(findReservedDeviceSegment('lpt9'), 'lpt9');
  assert.equal(findReservedDeviceSegment('NUL.txt'), 'NUL.txt');
});

test('findReservedDeviceSegment checks every segment of a path', () => {
  assert.equal(findReservedDeviceSegment('src/con/deep.py'), 'con');
  assert.equal(findReservedDeviceSegment('src\\aux.py'), 'aux.py');
  assert.equal(findReservedDeviceSegment('src/main/app.py'), null);
});

test('findReservedDeviceSegment allows near-misses', () => {
  assert.equal(findReservedDeviceSegment('console.py'), null, 'longer stem is not a device');
  assert.equal(findReservedDeviceSegment('com.py'), null, 'bare COM is not reserved — only COM1-9');
  assert.equal(findReservedDeviceSegment('com0.py'), null, 'COM0 is not reserved');
  assert.equal(findReservedDeviceSegment('.con'), null, 'leading dot means empty stem');
  assert.equal(findReservedDeviceSegment('nullable.py'), null);
});

test('findReservedDeviceSegment tolerates non-strings and empties', () => {
  assert.equal(findReservedDeviceSegment(null), null);
  assert.equal(findReservedDeviceSegment(undefined), null);
  assert.equal(findReservedDeviceSegment(''), null);
  assert.equal(findReservedDeviceSegment('  con.py  '), 'con.py', 'whitespace-trimmed per segment');
});

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------

test('normalizePath converts Windows backslashes to forward slashes', () => {
  assert.equal(normalizePath('src\\app\\App.jsx'), 'src/app/App.jsx');
});

test('normalizePath leaves POSIX paths unchanged', () => {
  assert.equal(normalizePath('src/app/App.jsx'), 'src/app/App.jsx');
});

test('normalizePath handles mixed separators', () => {
  assert.equal(normalizePath('src\\app/sub\\file.js'), 'src/app/sub/file.js');
});

test('normalizePath strips leading slashes', () => {
  assert.equal(normalizePath('/foo/bar'), 'foo/bar');
  assert.equal(normalizePath('//foo/bar'), 'foo/bar');
});

test('normalizePath returns empty string for non-string input', () => {
  assert.equal(normalizePath(null), '');
  assert.equal(normalizePath(undefined), '');
  assert.equal(normalizePath(42), '');
  assert.equal(normalizePath({}), '');
});

test('normalizePath returns empty string for empty string input', () => {
  assert.equal(normalizePath(''), '');
});

// ---------------------------------------------------------------------------
// getBasename
// ---------------------------------------------------------------------------

test('getBasename returns the last segment of a POSIX path', () => {
  assert.equal(getBasename('src/utils/path.js'), 'path.js');
});

test('getBasename returns the last segment of a Windows path', () => {
  assert.equal(getBasename('src\\utils\\path.js'), 'path.js');
});

test('getBasename returns the path itself when there is no separator', () => {
  assert.equal(getBasename('file.js'), 'file.js');
});

test('getBasename returns empty string for non-string input', () => {
  assert.equal(getBasename(null), '');
  assert.equal(getBasename(undefined), '');
});

test('getBasename falls back to the normalized path when last segment is empty', () => {
  // Trailing-slash characterization: split produces an empty trailing element,
  // and the function returns the normalized path as a fallback. This locks in
  // the current (pre-extraction) behavior.
  assert.equal(getBasename('src/utils/'), 'src/utils/');
});

// ---------------------------------------------------------------------------
// getDirname
// ---------------------------------------------------------------------------

test('getDirname returns the directory portion of a POSIX path', () => {
  assert.equal(getDirname('src/utils/path.js'), 'src/utils');
});

test('getDirname returns the directory portion of a Windows path', () => {
  assert.equal(getDirname('src\\utils\\path.js'), 'src/utils');
});

test('getDirname returns empty string when there is no separator', () => {
  assert.equal(getDirname('file.js'), '');
});

test('getDirname returns empty string for non-string input', () => {
  assert.equal(getDirname(null), '');
  assert.equal(getDirname(undefined), '');
});

test('getDirname handles deeply nested paths', () => {
  assert.equal(getDirname('a/b/c/d/e/f.js'), 'a/b/c/d/e');
});

// ---------------------------------------------------------------------------
// toFolderSegment
// ---------------------------------------------------------------------------

test('toFolderSegment replaces spaces with hyphens', () => {
  assert.equal(toFolderSegment('My Group Name'), 'My-Group-Name');
});

test('toFolderSegment strips special characters', () => {
  assert.equal(toFolderSegment('Group #1!'), 'Group-1');
});

test('toFolderSegment collapses multiple hyphens', () => {
  assert.equal(toFolderSegment('a -- b'), 'a-b');
});

test('toFolderSegment trims leading and trailing hyphens', () => {
  assert.equal(toFolderSegment('-- hello --'), 'hello');
});

test('toFolderSegment preserves underscores and existing hyphens', () => {
  assert.equal(toFolderSegment('my_group-1'), 'my_group-1');
});

test('toFolderSegment falls back to "group" for empty or whitespace input', () => {
  assert.equal(toFolderSegment(''), 'group');
  assert.equal(toFolderSegment('   '), 'group');
});

test('toFolderSegment falls back to "group" for non-string input', () => {
  assert.equal(toFolderSegment(null), 'group');
  assert.equal(toFolderSegment(undefined), 'group');
  assert.equal(toFolderSegment(42), 'group');
});

// ---------------------------------------------------------------------------
// splitPathAtLastSeparator (separator-preserving, for OS-facing absolute paths)
// ---------------------------------------------------------------------------

test('splitPathAtLastSeparator splits a Windows absolute path preserving backslashes', () => {
  assert.deepEqual(
    splitPathAtLastSeparator('C:\\projects\\notes\\todo.md'),
    { dir: 'C:\\projects\\notes', base: 'todo.md' }
  );
});

test('splitPathAtLastSeparator splits a POSIX absolute path', () => {
  assert.deepEqual(
    splitPathAtLastSeparator('/home/dan/notes/todo.md'),
    { dir: '/home/dan/notes', base: 'todo.md' }
  );
});

test('splitPathAtLastSeparator splits at the LAST separator with mixed styles', () => {
  assert.deepEqual(
    splitPathAtLastSeparator('C:\\projects/notes\\todo.md'),
    { dir: 'C:\\projects/notes', base: 'todo.md' }
  );
});

test('splitPathAtLastSeparator returns empty dir when no separator is present', () => {
  assert.deepEqual(
    splitPathAtLastSeparator('todo.md'),
    { dir: '', base: 'todo.md' }
  );
});

test('splitPathAtLastSeparator returns empty base for a trailing separator', () => {
  assert.deepEqual(
    splitPathAtLastSeparator('C:\\projects\\notes\\'),
    { dir: 'C:\\projects\\notes', base: '' }
  );
});

test('splitPathAtLastSeparator keeps the separator for a drive-root file (C: alone is drive-relative)', () => {
  assert.deepEqual(
    splitPathAtLastSeparator('C:\\todo.md'),
    { dir: 'C:\\', base: 'todo.md' }
  );
});

test('splitPathAtLastSeparator keeps the separator for a POSIX-root file', () => {
  assert.deepEqual(
    splitPathAtLastSeparator('/todo.md'),
    { dir: '/', base: 'todo.md' }
  );
});

test('splitPathAtLastSeparator returns empty strings for non-string input', () => {
  assert.deepEqual(splitPathAtLastSeparator(null), { dir: '', base: '' });
  assert.deepEqual(splitPathAtLastSeparator(undefined), { dir: '', base: '' });
  assert.deepEqual(splitPathAtLastSeparator(42), { dir: '', base: '' });
});

// ---------------------------------------------------------------------------
// isFiniteNumber (alias of Number.isFinite — strict, non-coercing)
// ---------------------------------------------------------------------------

test('isFiniteNumber returns true for finite numbers', () => {
  assert.equal(isFiniteNumber(42), true);
  assert.equal(isFiniteNumber(0), true);
  assert.equal(isFiniteNumber(-3.14), true);
});

test('isFiniteNumber returns false for non-finite numbers', () => {
  assert.equal(isFiniteNumber(Infinity), false);
  assert.equal(isFiniteNumber(-Infinity), false);
  assert.equal(isFiniteNumber(NaN), false);
});

test('isFiniteNumber returns false for non-number values (no coercion)', () => {
  assert.equal(isFiniteNumber('42'), false);
  assert.equal(isFiniteNumber(null), false);
  assert.equal(isFiniteNumber(undefined), false);
  assert.equal(isFiniteNumber({}), false);
});

// ---------------------------------------------------------------------------
// uniqueFolderSegment (group promotion: name → unused root folder path)
// ---------------------------------------------------------------------------

test('uniqueFolderSegment derives a folder segment from a display name', () => {
  assert.equal(uniqueFolderSegment('My Group', []), 'My-Group');
  assert.equal(uniqueFolderSegment('  utils!  ', []), 'utils');
  assert.equal(uniqueFolderSegment('', []), 'group');
});

test('uniqueFolderSegment uniquifies against taken paths, case-insensitively', () => {
  assert.equal(uniqueFolderSegment('utils', ['utils']), 'utils-2');
  assert.equal(uniqueFolderSegment('Utils', ['utils', 'Utils-2']), 'Utils-3');
  assert.equal(uniqueFolderSegment('src', ['lib', 'app']), 'src');
});

test('uniqueFolderSegment normalizes taken paths before comparing', () => {
  assert.equal(uniqueFolderSegment('src', ['/src']), 'src-2');
  assert.equal(uniqueFolderSegment('My Group', ['My-Group']), 'My-Group-2');
});
