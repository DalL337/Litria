import test from 'node:test';
import assert from 'node:assert/strict';

import {
  formatBytes,
  groupInventoryRows,
  reverifyMessage,
  rowActions,
  rowStatusLine,
  tierBadge,
  uninstallSummary
} from '../../src/app/serverInventoryModel.js';

const MANAGED_ROW = {
  languageId: 'rust',
  name: 'Rust',
  server: 'rust-analyzer',
  registryVersion: '2026-07-06',
  tier: 'managed',
  installedVersion: '2026-07-06',
  installedAt: '2026-07-13T18:22:00Z',
  installKind: 'managed',
  sizeBytes: 40 * 1024 * 1024,
  updateAvailable: false,
  canUninstall: true
};

const AVAILABLE_ROW = {
  languageId: 'cpp',
  name: 'C/C++',
  server: 'clangd',
  registryVersion: '22.1.6',
  tier: null,
  installedVersion: null,
  updateAvailable: false,
  canUninstall: false
};

const GO_ROW = {
  languageId: 'go',
  name: 'Go',
  server: 'gopls',
  registryVersion: null,
  tier: null,
  installedVersion: null,
  updateAvailable: false,
  canUninstall: false
};

const BUNDLED_ROW = {
  languageId: 'python',
  name: 'Python',
  server: 'pyright-langserver',
  registryVersion: null,
  tier: 'bundled',
  installedVersion: null,
  updateAvailable: false,
  canUninstall: false
};

test('formatBytes is settings-grade', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(40 * 1024 * 1024), '40.0 MB');
  assert.equal(formatBytes(undefined), null);
  assert.equal(formatBytes(-1), null);
});

test('tier badges cover every resolver answer', () => {
  assert.equal(tierBadge(MANAGED_ROW), 'Managed');
  assert.equal(tierBadge(BUNDLED_ROW), 'Bundled');
  assert.equal(tierBadge({ tier: 'global' }), 'On PATH');
  assert.equal(tierBadge(AVAILABLE_ROW), 'Not installed');
});

test('status lines carry provenance per tier', () => {
  const managed = rowStatusLine(MANAGED_ROW);
  assert.match(managed, /rust-analyzer 2026-07-06 \(managed\)/);
  assert.match(managed, /installed 2026-07-13/);
  assert.match(managed, /40\.0 MB/);

  assert.match(rowStatusLine(BUNDLED_ROW), /ships with Litria/);
  assert.match(rowStatusLine({ ...MANAGED_ROW, installedVersion: null, tier: 'global' }), /found on your system/);
  assert.match(rowStatusLine(AVAILABLE_ROW), /22\.1\.6 available \(verified download\)/);
  assert.match(rowStatusLine(GO_ROW), /Go toolchain/);
  assert.match(
    rowStatusLine({ ...MANAGED_ROW, installKind: 'custom' }),
    /integrity not verifiable/
  );
});

test('row actions gate honestly per row shape', () => {
  assert.deepEqual(rowActions(MANAGED_ROW), ['reverify', 'uninstall']);
  assert.deepEqual(rowActions({ ...MANAGED_ROW, updateAvailable: true }), ['update', 'reverify', 'uninstall']);
  assert.deepEqual(rowActions(AVAILABLE_ROW), ['install']);
  // go: class-3 — settings never offers an install button for it.
  assert.deepEqual(rowActions(GO_ROW), []);
  assert.deepEqual(rowActions(BUNDLED_ROW), []);
  assert.deepEqual(rowActions(null), []);
});

test('grouping splits resolved from unresolved rows', () => {
  const groups = groupInventoryRows([MANAGED_ROW, AVAILABLE_ROW, GO_ROW, BUNDLED_ROW]);
  assert.deepEqual(groups.installed.map((r) => r.languageId), ['rust', 'python']);
  assert.deepEqual(groups.available.map((r) => r.languageId), ['cpp', 'go']);
  assert.deepEqual(groupInventoryRows(null), { installed: [], available: [] });
});

test('reverify messages state the consequence, not just the status', () => {
  assert.match(reverifyMessage({ status: 'verified' }), /matches/);
  assert.match(reverifyMessage({ status: 'mismatch' }), /MISMATCH/);
  assert.match(reverifyMessage({ status: 'mismatch' }), /reinstall/i);
  assert.match(reverifyMessage({ status: 'unrecorded' }), /No baseline/);
  assert.match(reverifyMessage({ status: 'binary_missing' }), /missing/);
  assert.match(reverifyMessage(null), /did not complete/);
});

test('uninstall summary reports freed space when known', () => {
  assert.equal(
    uninstallSummary({ server: 'clangd', freedBytes: 1536 }),
    'clangd removed — 1.5 KB freed.'
  );
  assert.equal(uninstallSummary({ server: 'clangd' }), 'clangd removed.');
});
