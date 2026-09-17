import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ADDON_CLI_VERSIONS,
  CREATE_CLI_VERSIONS,
  SCAFFOLD_POSTURE_NOTE,
  scaffoldPostureNote,
} from '../../src/scaffold/create-cli-versions.js';
import { COMPAT } from '../../src/scaffold/compatibility-matrix.js';
import { RECIPES, resolveRoute } from '../../src/scaffold/recipeRegistry.js';

// ADR-021 §1: exact versions only — never ranges, tags, or `latest`.
// ADR-028 §1: the values are projections of recipes.json; this file keeps
// the pin contract observable from the display side.
const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// Runtimes whose scaffold path runs npm create-* CLIs (python is offline
// blueprints per ADR-020 and must never gain a silent npm pin).
const NPM_RUNTIMES = Object.keys(COMPAT.runtimes).filter((r) => RECIPES.wrappers[r].kind === 'npm');

test('every npm runtime in the compatibility matrix routes to a pinned create CLI', () => {
  assert.deepEqual(NPM_RUNTIMES.sort(), ['electron', 'tauri', 'web']);
  for (const runtime of NPM_RUNTIMES) {
    const wrapper = RECIPES.wrappers[runtime];
    const tool = RECIPES.tools[wrapper.route.tool];
    assert.ok(tool, `runtime "${runtime}" names a pinned tool`);
    assert.equal(CREATE_CLI_VERSIONS[tool.invoke], tool.version);
  }
  // A concrete route resolves to the same version the projection shows.
  assert.equal(resolveRoute('web', 'react', 'ts').version, CREATE_CLI_VERSIONS.vite);
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
  assert.deepEqual(Object.keys(ADDON_CLI_VERSIONS).sort(), ['shadcn', 'shadcn-svelte', 'shadcn-vue']);
});

test('python and blank have no npm create path', () => {
  assert.equal(RECIPES.wrappers.python.route, undefined);
  assert.equal(RECIPES.wrappers.blank.route, undefined);
  assert.equal(resolveRoute('python', 'py-lib', 'py'), null);
  assert.equal(resolveRoute('blank', null, null), null);
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

test('posture note is per manager and never claims npm coverage for Yarn or pnpm (ADR-028 §5, F29)', () => {
  const npm = scaffoldPostureNote('npm').toLowerCase();
  assert.ok(npm.includes('(npm)') && npm.includes('scripts off by default') && npm.includes('npm audit at create'));
  const pnpm = scaffoldPostureNote('pnpm').toLowerCase();
  assert.ok(pnpm.includes('(pnpm)'), 'names the manager');
  assert.ok(pnpm.includes("pnpm's own default"), 'scripts-off is pnpm-native');
  assert.ok(pnpm.includes('no audit at create'), 'pnpm gets no npm audit');
  assert.ok(pnpm.includes('minimumreleaseage'), 'the cooldown the runner writes');
  const yarn = scaffoldPostureNote('yarn').toLowerCase();
  assert.ok(yarn.includes('(yarn)'));
  assert.ok(yarn.includes('not disabled'), 'yarn scripts run — the note must say so');
  assert.ok(yarn.includes('no audit at create'));
  assert.ok(yarn.includes('npmminimalagegate'), 'the 24h gate the recipe writes for yarn');
  assert.ok(!yarn.includes('scripts off'), 'never the npm wording for yarn');
  for (const n of [npm, pnpm, yarn]) {
    assert.match(n, /transitive/);
    assert.ok(!n.includes('provenance') && !n.includes('guarantee') && !n.includes('safe from'));
  }
  assert.equal(scaffoldPostureNote('nope'), scaffoldPostureNote('npm'), 'unknown manager falls back to npm');
});
