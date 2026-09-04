import test from 'node:test';
import assert from 'node:assert/strict';

import { isDestinationError } from '../../src/scaffold/creationErrors.js';

// ---------------------------------------------------------------------------
// Project-creation failure classification (2026-08-31)
//
// A macOS tester hit "Read-only file system (os error 30)" creating a project
// and the wizard offered "Create as Blank instead". Blank writes to the same
// destination, so that fallback could only fail identically. Destination
// failures must offer a different LOCATION, never the Blank fallback.
// Journal: .research/2026-08-31-macos-tilde-default-path.md
// ---------------------------------------------------------------------------

test('destination failures are recognised across every command prefix', () => {
  // The same failure reaches us under three prefixes depending on the template.
  for (const code of [
    'blank_project.root.mkdir',
    'python_scaffold.root.mkdir',
    'blank_project.location.invalid',
    'python_scaffold.location.invalid',
    'scaffold.location.invalid',
    'blank_project.location.required',
    'python_scaffold.root.not_empty',
    'blank_project.root.not_dir',
    'blank_project.root.read',
  ]) {
    assert.equal(isDestinationError({ code }), true, `${code} should be a destination failure`);
  }
});

test('destination codes that do not follow the prefix.area.detail shape', () => {
  assert.equal(isDestinationError({ code: 'scaffold.location_create_failed' }), true);
  assert.equal(isDestinationError({ code: 'scaffold.target_exists' }), true);
});

test('scaffold-phase failures are NOT destination failures', () => {
  // These must keep the Create-as-Blank fallback.
  for (const code of [
    'scaffold.thread_error',
    'scaffold.command_failed',
    'python_scaffold.thread_error',
    'python_scaffold.interpreter.invalid',
    'blank_project.name.invalid',
  ]) {
    assert.equal(isDestinationError({ code }), false, `${code} should keep the Blank fallback`);
  }
});

test('the real macOS failure classifies as a destination failure', () => {
  // Exactly what the tester hit: python template, EROFS on mkdir.
  const err = {
    category: 'InvalidPath',
    code: 'python_scaffold.root.mkdir',
    message: 'Unable to create project directory: Read-only file system (os error 30)',
  };
  assert.equal(isDestinationError(err), true);
});

test('a bare code string is accepted as well as an error object', () => {
  assert.equal(isDestinationError('blank_project.root.mkdir'), true);
  assert.equal(isDestinationError('scaffold.thread_error'), false);
});

test('unknown and unstructured errors keep the historical fallback', () => {
  // Fail open: an unrecognised shape must not silently remove the escape hatch.
  assert.equal(isDestinationError(null), false);
  assert.equal(isDestinationError(undefined), false);
  assert.equal(isDestinationError({}), false);
  assert.equal(isDestinationError({ message: 'something went wrong' }), false);
  assert.equal(isDestinationError(new Error('boom')), false);
  assert.equal(isDestinationError(''), false);
  assert.equal(isDestinationError(42), false);
});

test('substring matches do not count — the suffix must be a whole segment', () => {
  // `.root.mkdir` must not match something merely ending in those letters.
  assert.equal(isDestinationError({ code: 'scaffold.reroot.mkdirx' }), false);
  assert.equal(isDestinationError({ code: 'location.invalid' }), false, 'needs a command prefix');
});
