// Track T slice T3a: files changed outside Litria — the judgement on a file
// whose stamp moved, and the channel between the save path and the notice.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  describeConflict,
  describeDeleted,
  hasUnsavedChanges,
  judgeDiskChange,
  pieceAfter,
  stampMoved
} from '../../src/app/diskChanges.js';
import {
  beginSave,
  forgetSavedTexts,
  isSaving,
  noteSavedText,
  onDiskConflict,
  reportDiskConflict,
  wasSavedText
} from '../../src/project/diskConflicts.js';

const piece = (code, extra = {}) => ({ id: 1, filename: 'src/a.ts', code, workingCode: code, diskStamp: 's1', ...extra });
const tab = (code, workingCode = code) => ({ id: 1, code, workingCode });
const read = (text, stamp = 's2') => ({ text, revision: 'd1-x', stamp });

test('another program changed a file with nothing unsaved: it reloads', () => {
  assert.equal(judgeDiskChange({ piece: piece('old'), tab: tab('old'), read: read('new') }).kind, 'reload');
  assert.equal(judgeDiskChange({ piece: piece('old'), tab: null, read: read('new') }).kind, 'reload', 'a piece with no tab');
});

test('another program changed a file with unsaved changes: the person chooses', () => {
  assert.equal(judgeDiskChange({ piece: piece('old'), tab: tab('old', 'typed'), read: read('new') }).kind, 'conflict');
});

test('only the stamp moved, or the text is what Litria itself saved', () => {
  assert.equal(judgeDiskChange({ piece: piece('same'), tab: tab('same', 'typed'), read: read('same') }).kind, 'touched');
  assert.equal(
    judgeDiskChange({ piece: piece('old'), tab: tab('old', 'typed'), read: read('mine'), savedByLitria: true }).kind,
    'touched',
    'the piece has not caught up with Litria\'s own save yet'
  );
});

test('a deleted file: a choice only if it has unsaved changes', () => {
  assert.equal(judgeDiskChange({ piece: piece('old'), tab: tab('old', 'typed'), read: null }).kind, 'deleted');
  assert.equal(judgeDiskChange({ piece: piece('old'), tab: tab('old'), read: null }).kind, 'gone');
});

test('line endings: a tab holds LF text, the piece the exact disk text', () => {
  const crlf = 'a\r\nb\r\n';
  // Unsaved changes compare as the editor does (LF either way).
  assert.equal(hasUnsavedChanges({ piece: piece(crlf), tab: tab('a\nb\n') }), false);
  // The disk text compares exactly with the piece's: the same CRLF bytes are
  // no change, and an LF rewrite is one.
  assert.equal(judgeDiskChange({ piece: piece(crlf), tab: tab('a\nb\n'), read: read(crlf) }).kind, 'touched');
  assert.equal(judgeDiskChange({ piece: piece(crlf), tab: tab('a\nb\n'), read: read('a\nb\n') }).kind, 'reload');
});

test('the stamp check reads a file again only when its stamp moved', () => {
  assert.equal(stampMoved(piece('x', { diskStamp: 's1' }), 's1'), false);
  assert.equal(stampMoved(piece('x', { diskStamp: 's1' }), 's2'), true);
  assert.equal(stampMoved(piece('x', { diskStamp: 's1' }), null), true, 'deleted');
  assert.equal(stampMoved(piece('x', { diskStamp: null }), null), false, 'already known to be gone');
  assert.equal(stampMoved(piece('x', { diskStamp: undefined }), 's1'), true, 'a piece read without a stamp');
});

test('what each judgement records on the piece', () => {
  const before = piece('old');
  assert.deepEqual(pieceAfter(before, 'touched', read('old', 's9')), { ...before, diskStamp: 's9' });
  assert.deepEqual(pieceAfter(before, 'reload', read('new', 's9')), { ...before, code: 'new', workingCode: 'new', diskStamp: 's9' });
  // A conflict keeps the person's text and the base it was typed on: only the
  // stamp, so the same version is not offered twice.
  assert.deepEqual(pieceAfter(before, 'conflict', read('new', 's9')), { ...before, diskStamp: 's9' });
  assert.deepEqual(pieceAfter(before, 'deleted', null), { ...before, diskStamp: null });
});

test('the notices name the file and never its contents', () => {
  for (const message of [describeConflict('src/a.ts'), describeDeleted('src/a.ts')]) {
    assert.match(message, /“src\/a\.ts”/);
    assert.match(message, /unsaved changes/);
  }
});

test('saves in flight are counted per piece and released once', () => {
  const first = beginSave(7);
  const second = beginSave(7);
  assert.equal(isSaving(7), true);
  first();
  first();
  assert.equal(isSaving(7), true, 'a release counts once');
  second();
  assert.equal(isSaving(7), false);
});

test('the text Litria saved is recognised until the project closes', () => {
  noteSavedText(3, 'mine');
  assert.equal(wasSavedText(3, 'mine'), true);
  assert.equal(wasSavedText(3, 'theirs'), false);
  forgetSavedTexts();
  assert.equal(wasSavedText(3, 'mine'), false);
});

test('a conflict reaches every listener, and a failing listener stops nothing', () => {
  const seen = [];
  const stopFailing = onDiskConflict(() => { throw new Error('listener failure'); });
  const stop = onDiskConflict((conflict) => seen.push(conflict));
  reportDiskConflict({ pieceId: 1, filename: 'src/a.ts', disk: 'd1-x' });
  assert.deepEqual(seen, [{ pieceId: 1, filename: 'src/a.ts', disk: 'd1-x' }]);
  stop();
  stopFailing();
  reportDiskConflict({ pieceId: 2, filename: 'src/b.ts', disk: null });
  assert.equal(seen.length, 1, 'unsubscribed');
});
