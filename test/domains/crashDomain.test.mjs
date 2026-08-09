import test from 'node:test';
import assert from 'node:assert/strict';

import {
  pushCrumb,
  serializeRingJsonl,
  shouldCaptureRejection,
  dedupeKey,
  isDuplicate,
  buildCrashRecord,
  normalizeErrorLike,
  scrubText,
  buildIssueUrl,
  RING_CAP,
  REPORT_URL_MAX
} from '../../src/crash/crashDomain.js';

// ── Ring ────────────────────────────────────────────────────────────────────

test('pushCrumb evicts oldest past the cap', () => {
  const arr = [];
  for (let i = 0; i < RING_CAP + 25; i++) {
    pushCrumb(arr, { n: i });
  }
  assert.equal(arr.length, RING_CAP);
  assert.equal(arr[0].n, 25); // oldest 25 evicted
  assert.equal(arr[arr.length - 1].n, RING_CAP + 24);
});

test('serializeRingJsonl emits one JSON object per line', () => {
  const lines = serializeRingJsonl([{ a: 1 }, { b: 2 }]).split('\n');
  assert.equal(lines.length, 2);
  assert.deepEqual(JSON.parse(lines[0]), { a: 1 });
  assert.deepEqual(JSON.parse(lines[1]), { b: 2 });
});

// ── Filters & dedupe ────────────────────────────────────────────────────────

test('Monaco Canceled rejections are filtered; real errors are not', () => {
  assert.equal(shouldCaptureRejection({ name: 'Canceled', message: 'Canceled' }), false);
  assert.equal(shouldCaptureRejection(new Error('boom')), true);
  assert.equal(shouldCaptureRejection('string reason'), true);
  assert.equal(shouldCaptureRejection(undefined), true);
});

test('isDuplicate suppresses the same error within the window, allows it after', () => {
  const recent = new Map();
  const key = dedupeKey('boom', 'at foo.js:1');
  assert.equal(isDuplicate(recent, key, 1000), false);
  assert.equal(isDuplicate(recent, key, 1500), true); // 500ms later — dupe
  assert.equal(isDuplicate(recent, key, 9000), false); // window expired
});

test('dedupeKey distinguishes same message with different top frames', () => {
  const a = dedupeKey('boom', 'at foo.js:1\nat bar.js:2');
  const b = dedupeKey('boom', 'at baz.js:9\nat bar.js:2');
  assert.notEqual(a, b);
});

// ── Record building ─────────────────────────────────────────────────────────

test('buildCrashRecord truncates oversized fields and caps breadcrumbs', () => {
  const record = buildCrashRecord({
    layer: 'js',
    message: 'x'.repeat(10000),
    stack: 'y'.repeat(50000),
    breadcrumbs: Array.from({ length: 500 }, (_, i) => ({ n: i })),
    litriaVersion: '1.0.0-5',
    os: 'windows'
  });
  assert.equal(record.schema, 1);
  assert.equal(record.error.message.length, 4000);
  assert.equal(record.error.stack.length, 16000);
  assert.equal(record.breadcrumbs.length, RING_CAP);
  assert.equal(record.breadcrumbs[0].n, 400); // newest tail kept
});

test('normalizeErrorLike handles Error, object, string, and garbage', () => {
  assert.equal(normalizeErrorLike(new Error('e')).message, 'e');
  assert.equal(normalizeErrorLike({ message: 'm', stack: 's' }).stack, 's');
  assert.equal(normalizeErrorLike('plain').message, 'plain');
  assert.equal(normalizeErrorLike(42).message, 'unknown error');
  assert.equal(normalizeErrorLike(null, 'fb').message, 'fb');
});

// ── Scrubbing & issue URL ───────────────────────────────────────────────────

test('scrubText replaces home and project paths in both separator styles', () => {
  const out = scrubText(
    'at C:\\Users\\alice\\proj\\src/a.js and C:/Users/alice/other.txt',
    { home: 'C:\\Users\\alice', projectRoot: 'C:\\Users\\alice\\proj' }
  );
  assert.ok(!out.includes('C:\\Users\\alice'));
  assert.ok(!out.includes('C:/Users/alice'));
  assert.ok(out.includes('<project>'));
  assert.ok(out.includes('~'));
});

test('buildIssueUrl targets the Litria repo and scrubs paths from the body', () => {
  const url = buildIssueUrl({
    record: {
      layer: 'js',
      timestamp: '2026-07-06T00:00:00Z',
      litriaVersion: '1.0.0-5',
      os: 'windows',
      error: { message: 'boom at C:\\Users\\alice\\app', stack: 'C:\\Users\\alice\\app\\x.js:1' },
      breadcrumbs: [{ t: 't', kind: 'command', name: 'write_project_file:ok' }]
    },
    filePath: 'C:\\Users\\alice\\.litria\\logs\\crashes\\crash-1-2-js.json',
    home: 'C:\\Users\\alice'
  });
  assert.ok(url.startsWith('https://github.com/DalL337/litria/issues/new?title='));
  assert.ok(!decodeURIComponent(url).includes('C:\\Users\\alice'));
});

test('buildIssueUrl stays under the cap for huge inputs (field caps do the work)', () => {
  const url = buildIssueUrl({
    record: {
      layer: 'js',
      error: { message: 'm'.repeat(9000), stack: 'z'.repeat(50000) },
      breadcrumbs: Array.from({ length: 100 }, (_, i) => ({ t: 't', kind: 'k', name: `n${i}` }))
    }
  });
  assert.ok(url.length <= REPORT_URL_MAX + 200, `url length ${url.length}`);
});

test('buildIssueUrl truncation engages under a tight cap AND lands under it', () => {
  const url = buildIssueUrl({
    record: {
      layer: 'js',
      error: { message: 'boom', stack: 'z'.repeat(3000) },
      breadcrumbs: []
    },
    maxLen: 1200
  });
  assert.ok(decodeURIComponent(url).includes('truncated'));
  assert.ok(url.length <= 1200, `url length ${url.length}`);
});
