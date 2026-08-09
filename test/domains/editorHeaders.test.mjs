import test from 'node:test';
import assert from 'node:assert/strict';

import { getHeaderCommentForFilename } from '../../src/editor/editorHeaders.js';

test('editor headers keep JavaScript filename comment injection', () => {
  const header = getHeaderCommentForFilename('src/index.js');
  assert.equal(header, '// src/index.js\n');
});

test('editor headers inject valid JSON content for json files', () => {
  const header = getHeaderCommentForFilename('config/settings.json');
  assert.equal(typeof header, 'string');
  const parsed = JSON.parse(header);
  assert.equal(parsed._cm_filename, 'config/settings.json');
});

