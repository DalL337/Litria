import test from 'node:test';
import assert from 'node:assert/strict';

// The reopen pill's words (Project API build plan W4b): it names only what an
// interrupted agent change can have left — new files on disk — and says the
// unsaved edits are gone, because the editor keeps no unsaved text across a
// restart.

import { describeInterruptedOperation } from '../../src/app/interruptedOperations.js';

const LEAD = "An agent's change was interrupted when Litria closed, and was not run again.";

test('new files that may be on disk, and the unsaved edits lost', () => {
  assert.equal(
    describeInterruptedOperation({ files: ['src/made.ts', 'src/maybe.ts'], unsavedEdits: 2 }),
    `${LEAD} Check src/made.ts and src/maybe.ts: they may have been created. Its unsaved edits to 2 files were lost.`
  );
});

test('one file, no edits', () => {
  assert.equal(
    describeInterruptedOperation({ files: ['notes.md'], unsavedEdits: 0 }),
    `${LEAD} Check notes.md: it may have been created.`
  );
});

test('edits only: nothing on disk changed', () => {
  assert.equal(
    describeInterruptedOperation({ files: [], unsavedEdits: 1 }),
    `${LEAD} Its unsaved edits to 1 file were lost; nothing on disk changed.`
  );
});

test('a long list is shortened', () => {
  assert.equal(
    describeInterruptedOperation({ files: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], unsavedEdits: 0 }),
    `${LEAD} Check a.ts, b.ts, c.ts and 2 more: they may have been created.`
  );
  assert.equal(
    describeInterruptedOperation({ files: ['a.ts', 'b.ts', 'c.ts'], unsavedEdits: 0 }),
    `${LEAD} Check a.ts, b.ts and c.ts: they may have been created.`
  );
});

test('nothing to say, or a malformed report: no pill', () => {
  assert.equal(describeInterruptedOperation({ files: [], unsavedEdits: 0 }), null);
  assert.equal(describeInterruptedOperation(null), null);
  assert.equal(describeInterruptedOperation({ files: 'a.ts', unsavedEdits: -1 }), null);
});
