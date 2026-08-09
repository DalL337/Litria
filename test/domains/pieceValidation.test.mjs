import test from 'node:test';
import assert from 'node:assert/strict';

import { validateFilename } from '../../src/utils/pieceValidation.js';

test('validateFilename blocks duplicate basename across different folders', () => {
  const result = validateFilename('app.py', [
    { filename: 'src/app.py' },
    { filename: 'tests/test_main.py' }
  ]);

  assert.equal(result, 'Filename already exists in this project.');
});

test('validateFilename blocks duplicate basename case-insensitively', () => {
  const result = validateFilename('App.PY', [{ filename: 'src/app.py' }]);
  assert.equal(result, 'Filename already exists in this project.');
});

test('validateFilename allows unique basenames', () => {
  const result = validateFilename('app_1.py', [{ filename: 'src/app.py' }]);
  assert.equal(result, '');
});

test('validateFilename rejects reserved Windows device names', () => {
  assert.equal(validateFilename('con.py', []), '"con.py" is a reserved name on Windows.');
  assert.equal(validateFilename('COM1.js', []), '"COM1.js" is a reserved name on Windows.');
});

test('validateFilename rejects reserved names in any path segment', () => {
  assert.equal(validateFilename('src/aux/tool.py', []), '"aux" is a reserved name on Windows.');
});

test('validateFilename allows near-miss device names', () => {
  assert.equal(validateFilename('console.py', []), '');
  assert.equal(validateFilename('com.py', []), '');
});

test('validateFilename rejects filename without extension', () => {
  const result = validateFilename('testdev1', []);
  assert.equal(result, 'File extension is required (e.g. .py, .js).');
});

test('validateFilename rejects filename ending with dot', () => {
  const result = validateFilename('testdev1.', []);
  assert.equal(result, 'File extension is required (e.g. .py, .js).');
});

test('validateFilename rejects dotfile without extension', () => {
  const result = validateFilename('.gitignore', []);
  assert.equal(result, 'File extension is required (e.g. .py, .js).');
});

test('validateFilename accepts filename with extension', () => {
  const result = validateFilename('main.py', []);
  assert.equal(result, '');
});
