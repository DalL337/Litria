import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADDON_CLI_VERSIONS,
  CREATE_CLI_VERSIONS,
  SCAFFOLD_POSTURE_NOTE,
  pinnedAddonSpecs,
  pinnedCreateSpec,
  previewCreateLabel
} from '../../src/scaffold/create-cli-versions.js';
import { COMPAT } from '../../src/scaffold/compatibility-matrix.js';

// ADR-021 §1: exact versions only — never ranges, tags, or `latest`.
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Runtimes whose scaffold path runs npm create-* CLIs (python is offline
// blueprints per ADR-020 and must never gain a silent npm pin).
const NPM_RUNTIMES = Object.keys(COMPAT.runtimes).filter((r) => r !== 'python');

test('every npm runtime in the compatibility matrix has a pinned create CLI', () => {
  for (const runtime of NPM_RUNTIMES) {
    const spec = pinnedCreateSpec(runtime);
    assert.match(spec, /^[a-z][a-z0-9-]*@\d/, `runtime "${runtime}" resolves a spec`);
  }
});

test('all create-CLI pins are exact versions (no ranges, tags, or latest)', () => {
  for (const [name, version] of Object.entries(CREATE_CLI_VERSIONS)) {
    assert.match(version, EXACT_VERSION, `${name} pin "${version}" must be exact`);
  }
});

test('all addon-CLI pins are exact versions (no ranges, tags, or latest)', () => {
  for (const [name, version] of Object.entries(ADDON_CLI_VERSIONS)) {
    assert.match(version, EXACT_VERSION, `${name} pin "${version}" must be exact`);
  }
});

test('pinnedCreateSpec returns name@version drawn from the registry', () => {
  assert.equal(pinnedCreateSpec('tauri'), `tauri-app@${CREATE_CLI_VERSIONS['tauri-app']}`);
  assert.equal(pinnedCreateSpec('web'), `vite@${CREATE_CLI_VERSIONS['vite']}`);
  assert.equal(pinnedCreateSpec('electron'), `electron-app@${CREATE_CLI_VERSIONS['electron-app']}`);
});

test('pinnedCreateSpec throws for wrappers without an npm create path', () => {
  assert.throws(() => pinnedCreateSpec('python'), /No pinned create CLI/);
  assert.throws(() => pinnedCreateSpec('blank'), /No pinned create CLI/);
  assert.throws(() => pinnedCreateSpec(undefined), /No pinned create CLI/);
});

test('pinnedAddonSpecs maps every addon CLI to an exact spec', () => {
  const specs = pinnedAddonSpecs();
  assert.deepEqual(Object.keys(specs).sort(), Object.keys(ADDON_CLI_VERSIONS).sort());
  for (const [name, spec] of Object.entries(specs)) {
    assert.equal(spec, `${name}@${ADDON_CLI_VERSIONS[name]}`);
  }
});

test('posture note states the gate honestly (ADR-021 §5)', () => {
  const note = SCAFFOLD_POSTURE_NOTE.toLowerCase();
  // Must name each part of the gate…
  for (const required of ['pinned', '24h release-age gate', 'scripts off', 'npm audit']) {
    assert.ok(note.includes(required), `note must mention "${required}"`);
  }
  // …and its one gap.
  assert.match(note, /transitive/);
  // Forbidden claims (ADR-021 §5): each is false and each appeared in the
  // wild as false comfort. The note may never drift into them.
  assert.ok(!note.includes('provenance'), 'provenance is not a safety signal');
  assert.ok(!note.includes('npm enforces'), 'npm has no native cooldown');
  assert.ok(!note.includes('guarantee'), 'the gate contains, it does not guarantee');
  assert.ok(!note.includes('safe from'), 'no blanket safety claims');
});

test('previewCreateLabel shows the long package name with the pinned version', () => {
  assert.equal(previewCreateLabel('web'), `create-vite@${CREATE_CLI_VERSIONS['vite']}`);
  assert.equal(previewCreateLabel('tauri'), `create-tauri-app@${CREATE_CLI_VERSIONS['tauri-app']}`);
  assert.equal(previewCreateLabel('electron'), `create-electron-app@${CREATE_CLI_VERSIONS['electron-app']}`);
  assert.equal(previewCreateLabel('python'), null);
});
