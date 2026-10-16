// Track T slice T3a: files changed outside Litria — the judgement on a file
// whose stamp moved, and the channel between the save path and the notice.
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RENAME_CANDIDATES,
  pairRenames,
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
  assert.deepEqual(pieceAfter(before, 'touched', read('old', 's9')), { ...before, diskStamp: 's9', diskMissing: false });
  assert.deepEqual(pieceAfter(before, 'reload', read('new', 's9')), { ...before, code: 'new', workingCode: 'new', diskStamp: 's9', diskMissing: false });
  // A conflict keeps the person's text and the base it was typed on: only the
  // stamp, so the same version is not offered twice.
  assert.deepEqual(pieceAfter(before, 'conflict', read('new', 's9')), { ...before, diskStamp: 's9', diskMissing: false });
  // T3b: a deleted file's piece stays, marked missing; any version on disk
  // clears the mark.
  assert.deepEqual(pieceAfter(before, 'deleted', null), { ...before, diskStamp: null, diskMissing: true });
  assert.deepEqual(pieceAfter(before, 'gone', null), { ...before, diskStamp: null, diskMissing: true });
  assert.equal(pieceAfter({ ...before, diskMissing: true }, 'touched', read('old')).diskMissing, false);
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

// --- T3b: another program's renames -------------------------------------------

const gone = (id, filename, code) => ({ id, filename, code, diskMissing: true });

test('a missing file follows the one new file with exactly its text', () => {
  assert.deepEqual(
    pairRenames([gone(1, 'src/a.ts', 'A'), gone(2, 'src/b.ts', 'B')], [{ path: 'lib/a.ts', text: 'A' }, { path: 'lib/c.ts', text: 'C' }]),
    [{ pieceId: 1, from: 'src/a.ts', to: 'lib/a.ts' }]
  );
});

test('an ambiguous or empty text pairs nothing', () => {
  // Two new files with the same text.
  assert.deepEqual(pairRenames([gone(1, 'a.ts', 'X')], [{ path: 'b.ts', text: 'X' }, { path: 'c.ts', text: 'X' }]), []);
  // Two missing files with the same text.
  assert.deepEqual(pairRenames([gone(1, 'a.ts', 'X'), gone(2, 'b.ts', 'X')], [{ path: 'c.ts', text: 'X' }]), []);
  // Empty files are too common to say which is which.
  assert.deepEqual(pairRenames([gone(1, 'a.ts', '')], [{ path: 'b.ts', text: '' }]), []);
  // A text that changed in the move is not a rename this can see.
  assert.deepEqual(pairRenames([gone(1, 'a.ts', 'old')], [{ path: 'b.ts', text: 'old, edited' }]), []);
  // The same path is no move.
  assert.deepEqual(pairRenames([gone(1, 'a.ts', 'X')], [{ path: 'a.ts', text: 'X' }]), []);
});

test('a folder rename pairs each file by its own text', () => {
  const pairs = pairRenames(
    [gone(1, 'old/a.ts', 'A'), gone(2, 'old/b.ts', 'B'), gone(3, 'old/c.ts', 'C')],
    [{ path: 'new/a.ts', text: 'A' }, { path: 'new/b.ts', text: 'B' }, { path: 'new/c.ts', text: 'C' }]
  );
  assert.deepEqual(pairs.map((pair) => [pair.from, pair.to]), [['old/a.ts', 'new/a.ts'], ['old/b.ts', 'new/b.ts'], ['old/c.ts', 'new/c.ts']]);
  assert.ok(MAX_RENAME_CANDIDATES >= 100, 'a folder of files fits one check');
});
