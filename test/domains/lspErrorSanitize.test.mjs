import test from 'node:test';
import assert from 'node:assert/strict';

import { scrubPaths, sanitizeLspError } from '../../src/lsp/lspErrorSanitize.js';

test('scrubPaths removes Windows drive paths', () => {
  const out = scrubPaths("Project root 'C:\\Users\\alice\\proj' is not accessible.");
  assert.ok(!out.includes('alice'), 'username must not leak');
  assert.ok(!out.includes('C:\\Users'), 'drive path must not leak');
  assert.ok(out.includes('<path>'));
});

test('scrubPaths removes Unix home paths', () => {
  const out = scrubPaths('spawn failed at /home/alice/.local/bin/pyright');
  assert.ok(!out.includes('/home/alice'), 'home path must not leak');
  assert.ok(out.includes('<path>'));
});

test('scrubPaths removes UNC paths', () => {
  const out = scrubPaths('cannot read \\\\server\\share\\secret');
  assert.ok(!out.includes('server\\share'));
  assert.ok(out.includes('<path>'));
});

test('sanitizeLspError preserves category + code, scrubs message', () => {
  const raw = {
    category: 'InvalidPath',
    code: 'python_lsp.invalid_project_root',
    message: "Project root 'C:\\Users\\alice\\proj' is not accessible.",
  };
  const clean = sanitizeLspError(raw);
  assert.equal(clean.category, 'InvalidPath', 'category preserved');
  assert.equal(clean.code, 'python_lsp.invalid_project_root', 'code preserved');
  assert.ok(!clean.message.includes('alice'), 'message path scrubbed');
  assert.ok(clean.message.includes('<path>'));
});

test('sanitizeLspError handles string and non-object errors', () => {
  assert.equal(sanitizeLspError('boom at C:\\x\\y').includes('<path>'), true);
  assert.equal(sanitizeLspError(null), null);
  assert.deepEqual(sanitizeLspError({ code: 'x' }), { code: 'x' }); // no message → unchanged
});
