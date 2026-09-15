import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NOTICE_RATE_LIMIT_MS,
  READ_ONLY_PILL_TEXT,
  canPersist,
  clearNotices,
  createNoticeState,
  describeWriteFailure,
  dismissNotice,
  expireNotice,
  isPersistenceWrite,
  reduceWriteFailure
} from '../../src/project/persistenceNotices.js';

const readOnlyError = { category: 'AccessDenied', code: 'db.read_only', message: 'Failed to save viewport: attempt to write a readonly database' };
const busyError = { category: 'Conflict', code: 'db.busy', message: 'Failed to move piece 3: database is locked' };
const corruptError = { category: 'Internal', code: 'db.corrupt', message: 'Failed to save editor state: database disk image is malformed. Move or delete the project\'s .litria folder to rebuild the workspace from litria.toml; your files are untouched, the canvas layout will be reset.' };

const instance = (overrides = {}) => ({
  instanceId: 'litria-1',
  rootPath: '/home/alice/proj',
  manifestPath: '/home/alice/proj/.litria/workspace.db',
  readOnly: false,
  ...overrides
});

test('isPersistenceWrite: mutating commands yes, reads and lifecycle no', () => {
  for (const cmd of [
    'db_create_piece', 'db_create_pieces_batch', 'db_batch_move_pieces', 'db_update_piece',
    'db_delete_piece', 'db_create_group', 'db_update_group', 'db_delete_group',
    'db_add_piece_to_group', 'db_remove_piece_from_group', 'db_create_connection',
    'db_save_editor_state', 'db_save_viewport', 'db_add_hidden_path',
    'db_remove_hidden_path', 'db_register_project', 'db_remove_project',
    'db_pin_project', 'db_save_preference'
  ]) {
    assert.equal(isPersistenceWrite(cmd), true, cmd);
  }
  for (const cmd of [
    'db_open_project', 'db_bootstrap_project', 'db_close_project',
    'db_load_editor_state', 'db_list_recent_projects', 'db_load_preferences',
    'read_project_file', '', undefined, null
  ]) {
    assert.equal(isPersistenceWrite(cmd), false, String(cmd));
  }
});

test('canPersist: writable workspace only', () => {
  assert.equal(canPersist(instance()), true);
  assert.equal(canPersist(instance({ readOnly: true })), false);
  assert.equal(canPersist(instance({ manifestPath: null })), false, 'single-file session');
  assert.equal(canPersist(instance({ rootPath: '' })), false);
  assert.equal(canPersist(instance({ instanceId: null })), false);
  assert.equal(canPersist(null), false);
  assert.equal(canPersist(undefined), false);
  // readOnly absent (older instance shapes) counts as writable.
  const legacy = instance();
  delete legacy.readOnly;
  assert.equal(canPersist(legacy), true);
});

test('describeWriteFailure: classified codes get user wording, others keep the backend text', () => {
  const ro = describeWriteFailure('db_save_viewport', readOnlyError);
  assert.equal(ro.code, 'db.read_only');
  assert.equal(ro.command, 'db_save_viewport');
  assert.match(ro.message, /read-only/);

  const busy = describeWriteFailure('db_batch_move_pieces', busyError);
  assert.equal(busy.code, 'db.busy');
  assert.match(busy.message, /busy/);

  const corrupt = describeWriteFailure('db_save_editor_state', corruptError);
  assert.equal(corrupt.code, 'db.corrupt');
  assert.match(corrupt.message, /litria\.toml/, 'recovery sentence survives');

  const plain = describeWriteFailure('db_create_piece', new Error('boom'));
  assert.equal(plain.code, null);
  assert.equal(plain.message, 'Layout change not saved: boom');

  const text = describeWriteFailure('db_create_piece', 'string rejection');
  assert.equal(text.message, 'Layout change not saved: string rejection');

  const empty = describeWriteFailure('db_create_piece', undefined);
  assert.equal(empty.message, 'Layout change not saved: unknown error');
});

test('reduceWriteFailure: first failure shows a notice stamped at now', () => {
  const failure = describeWriteFailure('db_save_viewport', busyError);
  const next = reduceWriteFailure(createNoticeState(), failure, { now: 1000 });
  assert.equal(next.lastShownAt, 1000);
  assert.equal(next.notice.at, 1000);
  assert.equal(next.notice.code, 'db.busy');
  assert.equal(next.notice.suppressed, 0);
});

test('reduceWriteFailure: inside the window the slot keeps its time, takes the latest message, counts repeats', () => {
  const first = reduceWriteFailure(createNoticeState(), describeWriteFailure('db_save_viewport', busyError), { now: 1000 });
  const second = reduceWriteFailure(first, describeWriteFailure('db_create_piece', new Error('later')), { now: 1000 + NOTICE_RATE_LIMIT_MS - 1 });
  assert.equal(second.lastShownAt, 1000, 'no new notice inside the window');
  assert.equal(second.notice.at, 1000);
  assert.equal(second.notice.message, 'Layout change not saved: later', 'latest wins');
  assert.equal(second.notice.command, 'db_create_piece');
  assert.equal(second.notice.suppressed, 1);

  const third = reduceWriteFailure(second, describeWriteFailure('db_create_piece', new Error('latest')), { now: 1500 });
  assert.equal(third.notice.suppressed, 2);
  assert.equal(third.notice.message, 'Layout change not saved: latest');
});

test('reduceWriteFailure: after the window a fresh notice is shown', () => {
  const first = reduceWriteFailure(createNoticeState(), describeWriteFailure('db_save_viewport', busyError), { now: 1000 });
  const later = reduceWriteFailure(first, describeWriteFailure('db_create_piece', new Error('again')), { now: 1000 + NOTICE_RATE_LIMIT_MS });
  assert.equal(later.lastShownAt, 1000 + NOTICE_RATE_LIMIT_MS);
  assert.equal(later.notice.at, 1000 + NOTICE_RATE_LIMIT_MS);
  assert.equal(later.notice.suppressed, 0);
  assert.equal(later.notice.message, 'Layout change not saved: again');
});

test('reduceWriteFailure: a dismissed slot inside the window shows again on the next failure', () => {
  const first = reduceWriteFailure(createNoticeState(), describeWriteFailure('db_save_viewport', busyError), { now: 1000 });
  const dismissed = dismissNotice(first);
  assert.equal(dismissed.notice, null);
  const again = reduceWriteFailure(dismissed, describeWriteFailure('db_create_piece', new Error('x')), { now: 2000 });
  assert.notEqual(again.notice, null, 'nothing visible to update, so a notice is shown');
});

test('reduceWriteFailure: read-only workspace suppresses db.read_only but not other codes', () => {
  const state = createNoticeState();
  const ro = reduceWriteFailure(state, describeWriteFailure('db_save_viewport', readOnlyError), { now: 1000, readOnly: true });
  assert.equal(ro, state, 'the pill already explains a read-only write');

  const busy = reduceWriteFailure(state, describeWriteFailure('db_save_viewport', busyError), { now: 1000, readOnly: true });
  assert.notEqual(busy.notice, null);

  const writable = reduceWriteFailure(state, describeWriteFailure('db_save_viewport', readOnlyError), { now: 1000, readOnly: false });
  assert.notEqual(writable.notice, null, 'on a writable workspace a read-only failure is news');
});

test('expireNotice: ages out after the window, keeps the rate stamp', () => {
  const shown = reduceWriteFailure(createNoticeState(), describeWriteFailure('db_save_viewport', busyError), { now: 1000 });
  assert.equal(expireNotice(shown, 1000 + NOTICE_RATE_LIMIT_MS - 1), shown);
  const expired = expireNotice(shown, 1000 + NOTICE_RATE_LIMIT_MS);
  assert.equal(expired.notice, null);
  assert.equal(expired.lastShownAt, 1000);
  assert.equal(expireNotice(expired, 99999), expired, 'nothing to expire');
});

test('clearNotices: project switch resets everything', () => {
  const shown = reduceWriteFailure(createNoticeState(), describeWriteFailure('db_save_viewport', busyError), { now: 1000 });
  assert.deepEqual(clearNotices(shown), createNoticeState());
});

test('read-only pill copy is the ruled text', () => {
  assert.equal(READ_ONLY_PILL_TEXT, "Read-only workspace — layout changes won't be saved.");
});
