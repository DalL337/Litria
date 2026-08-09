import test from 'node:test';
import assert from 'node:assert/strict';

import {
  updateFileDiagnostics,
  clearFileDiagnostics,
  clearAllDiagnostics,
  getDiagnosticsForFile,
  getDiagnosticsByKey,
  pieceFileToKey,
  subscribeToDiagnostics,
  normalizeUri,
} from '../../src/lsp/diagnosticStore.js';

// Each test starts from a clean store. clearAllDiagnostics is the public reset.
function reset() {
  clearAllDiagnostics();
}

test('updateFileDiagnostics counts errors and warnings by LSP severity', () => {
  reset();
  const uri = 'file:///c:/proj/src/foo.ts';
  updateFileDiagnostics(uri, [
    { severity: 1 }, // error
    { severity: 1 }, // error
    { severity: 2 }, // warning
    { severity: 3 }, // info — ignored
    { severity: 4 }, // hint — ignored
  ]);
  const counts = getDiagnosticsByKey(pieceFileToKey('src/foo.ts', 'c:/proj'));
  assert.deepEqual(counts, { errors: 2, warnings: 1 });
});

test('updateFileDiagnostics with empty array sets zero counts', () => {
  reset();
  const uri = 'file:///c:/proj/src/foo.ts';
  updateFileDiagnostics(uri, []);
  const counts = getDiagnosticsByKey(pieceFileToKey('src/foo.ts', 'c:/proj'));
  assert.deepEqual(counts, { errors: 0, warnings: 0 });
});

test('updateFileDiagnostics is a no-op when counts are unchanged (skipEqual)', () => {
  reset();
  const uri = 'file:///c:/proj/src/foo.ts';
  let calls = 0;
  const unsub = subscribeToDiagnostics(() => { calls += 1; });

  updateFileDiagnostics(uri, [{ severity: 1 }]);
  assert.equal(calls, 1, 'first set notifies');

  updateFileDiagnostics(uri, [{ severity: 1 }]);
  assert.equal(calls, 1, 'identical second set is suppressed');

  updateFileDiagnostics(uri, [{ severity: 1 }, { severity: 2 }]);
  assert.equal(calls, 2, 'changed counts notify again');

  unsub();
});

test('updateFileDiagnostics transitions from non-zero to zero (the original LED bug case)', () => {
  reset();
  const uri = 'file:///c:/proj/src/foo.ts';
  let calls = 0;
  const unsub = subscribeToDiagnostics(() => { calls += 1; });

  updateFileDiagnostics(uri, [{ severity: 1 }, { severity: 1 }]);
  assert.equal(calls, 1);

  updateFileDiagnostics(uri, []);
  assert.equal(calls, 2, 'clear must fire a notification — this is the regression that broke the LED');

  const counts = getDiagnosticsByKey(pieceFileToKey('src/foo.ts', 'c:/proj'));
  assert.deepEqual(counts, { errors: 0, warnings: 0 });
  unsub();
});

test('clearFileDiagnostics removes the entry and notifies', () => {
  reset();
  const uri = 'file:///c:/proj/src/foo.ts';
  let calls = 0;
  const unsub = subscribeToDiagnostics(() => { calls += 1; });

  updateFileDiagnostics(uri, [{ severity: 1 }]);
  assert.equal(calls, 1);

  clearFileDiagnostics(uri);
  assert.equal(calls, 2);
  assert.equal(getDiagnosticsByKey(pieceFileToKey('src/foo.ts', 'c:/proj')), null);

  // Clearing again is a no-op (entry already gone).
  clearFileDiagnostics(uri);
  assert.equal(calls, 2);
  unsub();
});

test('clearAllDiagnostics wipes every entry and notifies once', () => {
  reset();
  let calls = 0;
  const unsub = subscribeToDiagnostics(() => { calls += 1; });

  updateFileDiagnostics('file:///c:/proj/a.ts', [{ severity: 1 }]);
  updateFileDiagnostics('file:///c:/proj/b.ts', [{ severity: 2 }]);
  assert.equal(calls, 2);

  clearAllDiagnostics();
  assert.equal(calls, 3, 'one notification covers the bulk wipe');
  assert.equal(getDiagnosticsByKey(pieceFileToKey('a.ts', 'c:/proj')), null);
  assert.equal(getDiagnosticsByKey(pieceFileToKey('b.ts', 'c:/proj')), null);

  // Empty store: another wipe is a no-op.
  clearAllDiagnostics();
  assert.equal(calls, 3);
  unsub();
});

test('URI from LSP and key from piece filename normalize to the same lookup key', () => {
  reset();
  // tsserver-style file:// URI with percent-encoded drive letter — what Litria
  // actually receives in onDiagnostics.
  const lspUri = 'file:///c%3A/Projects1/myAwesomeApp/src/App.tsx';
  updateFileDiagnostics(lspUri, [{ severity: 1 }]);

  // The piece on the canvas only knows its filename relative to the project
  // root. getDiagnosticsForFile must find the entry the LSP just wrote.
  const counts = getDiagnosticsForFile('src/App.tsx', 'C:/Projects1/myAwesomeApp');
  assert.deepEqual(counts, { errors: 1, warnings: 0 },
    'percent-encoded drive letter, mixed case, and forward slashes must all normalize to the same key');
});

test('URI normalization tolerates Windows backslashes in piece filenames', () => {
  reset();
  updateFileDiagnostics('file:///c:/proj/src/foo.ts', [{ severity: 1 }]);
  // Pieces sometimes carry filenames with backslashes (Windows path quirk).
  const counts = getDiagnosticsForFile('src\\foo.ts', 'c:\\proj');
  assert.deepEqual(counts, { errors: 1, warnings: 0 });
});

test('subscribers can unsubscribe and stop receiving notifications', () => {
  reset();
  let calls = 0;
  const unsub = subscribeToDiagnostics(() => { calls += 1; });

  updateFileDiagnostics('file:///c:/proj/a.ts', [{ severity: 1 }]);
  assert.equal(calls, 1);

  unsub();

  updateFileDiagnostics('file:///c:/proj/a.ts', [{ severity: 1 }, { severity: 2 }]);
  assert.equal(calls, 1, 'unsubscribed listener must not fire');
});

test('getDiagnosticsForFile returns null for unknown files', () => {
  reset();
  assert.equal(getDiagnosticsForFile('src/nope.ts', 'c:/proj'), null);
});

test('normalizeUri canonicalizes raw and percent-encoded Windows file URIs to the same key', () => {
  // The exact pair we observed in the LED-fix-branch logs: tsserver returned
  // the lowercased + percent-encoded form, but tabToLspUri produced the raw
  // upper-case form. Strict string equality breaks; normalizeUri must agree.
  const fromLsp = normalizeUri('file:///c%3A/Projects1/myAwesomeApp/src/main.tsx');
  const fromTabUri = normalizeUri('file:///C:/Projects1/myAwesomeApp/src/main.tsx');
  assert.equal(fromLsp, fromTabUri);
  assert.equal(fromLsp, 'c:/projects1/myawesomeapp/src/main.tsx');
});

test('normalizeUri agrees with pieceFileToKey for the same logical file', () => {
  // The store is read by computeNodeHealth via pieceFileToKey(filename, root),
  // and written by EditorMonaco via updateFileDiagnostics(lspUri, ...). Both
  // sides must converge on the same key for the LED to ever go red.
  const key1 = normalizeUri('file:///c%3A/Projects1/myAwesomeApp/src/main.tsx');
  const key2 = pieceFileToKey('src/main.tsx', 'C:/Projects1/myAwesomeApp');
  assert.equal(key1, key2);
});

test('normalizeUri handles file:// (no third slash) for non-Windows paths', () => {
  // Linux/macOS LSP servers send file:// with two slashes (no host).
  const key = normalizeUri('file:///home/user/proj/foo.ts');
  assert.equal(key, '/home/user/proj/foo.ts');
});

test('normalizeUri returns empty string for non-string input', () => {
  assert.equal(normalizeUri(null), '');
  assert.equal(normalizeUri(undefined), '');
  assert.equal(normalizeUri(42), '');
});

test('updateFileDiagnostics ignores non-array diagnostics input gracefully', () => {
  reset();
  // Defensive: in case a malformed payload arrives.
  updateFileDiagnostics('file:///c:/proj/foo.ts', null);
  updateFileDiagnostics('file:///c:/proj/foo.ts', undefined);
  updateFileDiagnostics('file:///c:/proj/foo.ts', 'not-an-array');
  const counts = getDiagnosticsByKey(pieceFileToKey('foo.ts', 'c:/proj'));
  assert.deepEqual(counts, { errors: 0, warnings: 0 });
});
