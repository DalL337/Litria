import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applySavedPieceBaseline,
  FILE_SAVE_COMMAND,
  FILE_SAVE_NO_TARGET,
  noSaveTargetOutcome,
  resolveSaveOutcome
} from '../../src/project/saveOutcome.js';
import {
  emitPersistenceWriteFailure,
  onPersistenceWriteFailure
} from '../../src/project/persistenceFailures.js';

test('explicit manager success is the only successful save outcome', () => {
  assert.deepEqual(resolveSaveOutcome({ managerResult: true }), {
    saved: true,
    failure: null
  });
  assert.deepEqual(resolveSaveOutcome({ managerResult: { success: true } }), {
    saved: true,
    failure: null
  });
  assert.equal(resolveSaveOutcome({ managerResult: undefined }).saved, false);
});

test('storage error is retained when the manager reports an underlying write failure', () => {
  const storageError = {
    category: 'AccessDenied',
    code: 'project_file.write.failed',
    message: 'The file is read-only.'
  };
  const outcome = resolveSaveOutcome({
    managerResult: { success: false, code: 'fs.write_failed', error: 'Cannot write' },
    relativePath: 'src/main.js',
    storageError
  });
  assert.equal(outcome.saved, false);
  assert.equal(outcome.failure.command, FILE_SAVE_COMMAND);
  assert.deepEqual(outcome.failure.error, {
    ...storageError,
    relativePath: 'src/main.js'
  });
});

test('manager refusal remains authoritative when storage was never called', () => {
  const outcome = resolveSaveOutcome({
    managerResult: {
      success: false,
      code: 'fs.reserved_name',
      error: '"con" is a reserved name on Windows'
    },
    relativePath: 'con.js',
    storageError: { code: 'stale.error', message: 'must not leak' }
  });
  assert.equal(outcome.failure.error.code, 'fs.reserved_name');
  assert.match(outcome.failure.error.message, /reserved name/);
  assert.equal(outcome.failure.error.relativePath, 'con.js');
});

test('thrown writer errors become typed file-save failures', () => {
  const outcome = resolveSaveOutcome({
    relativePath: 'main.py',
    thrownError: new Error('disk vanished')
  });
  assert.equal(outcome.saved, false);
  assert.equal(outcome.failure.error.code, 'file.save.failed');
  assert.equal(outcome.failure.error.message, 'disk vanished');
});

test('missing target has its own failure code and never reports success', () => {
  const outcome = noSaveTargetOutcome('untitled.js');
  assert.equal(outcome.saved, false);
  assert.equal(outcome.failure.command, FILE_SAVE_COMMAND);
  assert.equal(outcome.failure.error.code, FILE_SAVE_NO_TARGET);
  assert.equal(outcome.failure.error.relativePath, 'untitled.js');
});

test('the neutral failure observer carries file failures and isolates listeners', () => {
  const seen = [];
  const unsubscribeThrowing = onPersistenceWriteFailure(() => {
    throw new Error('observer bug');
  });
  const unsubscribe = onPersistenceWriteFailure((failure) => seen.push(failure));
  const failure = noSaveTargetOutcome('untitled.js').failure;

  assert.doesNotThrow(() => emitPersistenceWriteFailure(failure));
  assert.deepEqual(seen, [failure]);

  unsubscribe();
  unsubscribeThrowing();
  emitPersistenceWriteFailure(failure);
  assert.deepEqual(seen, [failure]);
});

test('a confirmed snapshot advances the piece baseline without clobbering later edits', () => {
  const original = [
    { id: 1, code: 'old', workingCode: 'typed later' },
    { id: 2, code: 'other', workingCode: 'other' }
  ];
  const next = applySavedPieceBaseline(original, 1, 'written snapshot');
  assert.equal(next[0].code, 'written snapshot');
  assert.equal(next[0].workingCode, 'typed later');
  assert.equal(next[1], original[1]);
});
