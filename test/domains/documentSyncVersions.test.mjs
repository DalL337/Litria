import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// Codex review of P5, F2 (2026-10-11): a server's publishDiagnostics names a
// document version, not an opening. When a reopen started the versions over at
// 1, a late publish computed for the earlier opening's version 1 arrived
// looking exactly like one for the new opening, and the Project API reported
// it current. Versions now keep counting across a close and reopen, so every
// version Litria sends for a document is new.
//
// Drives the REAL documentSync; only Tauri's `invoke` is stubbed.

register('../support/tauri-invoke-stub.mjs', import.meta.url);

const sent = [];
globalThis.__INVOKE__ = async (command, payload) => {
  if (command === 'lsp_notify') sent.push(payload);
};

const { didOpen, didChange, didClose } = await import('../../src/lsp/documentSync.js');

const URI = 'file:///alice/project/a.py';
const versions = () => sent
  .filter((p) => p.params.textDocument.uri === URI && p.method !== 'textDocument/didClose')
  .map((p) => p.params.textDocument.version);

test('a reopened document keeps counting versions', async () => {
  didOpen('python', 'p', URI, 'python', 'x = 1');
  didChange('python', 'p', URI, 'x = 2');
  await new Promise((resolve) => setTimeout(resolve, 250)); // past the change debounce
  didClose('python', 'p', URI);
  didOpen('python', 'p', URI, 'python', 'x = 2');
  assert.deepEqual(versions(), [1, 2, 3]);
});
