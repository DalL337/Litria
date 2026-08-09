import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MANAGED_LANGUAGE_EXTENSIONS,
  MANAGED_LANGUAGE_IDS,
  managedLanguageForFilename,
  desiredManagedLanguages,
  shouldTeardownManagedOnProjectTransition
} from '../../src/app/useManagedLspLifecycle.js';
import { getManagedSessionLanguageFromFilename } from '../../src/editor/editorLanguage.js';

test('managed language matcher maps registry extensions to language ids', () => {
  assert.equal(managedLanguageForFilename('src/main.rs'), 'rust');
  assert.equal(managedLanguageForFilename('SRC/MAIN.RS'), 'rust');
  assert.equal(managedLanguageForFilename('lib/util.c'), 'cpp');
  assert.equal(managedLanguageForFilename('lib/util.h'), 'cpp');
  assert.equal(managedLanguageForFilename('app/view.cpp'), 'cpp');
  assert.equal(managedLanguageForFilename('app/view.hpp'), 'cpp');
  assert.equal(managedLanguageForFilename('app/view.cc'), 'cpp');
  assert.equal(managedLanguageForFilename('app/view.cxx'), 'cpp');
  assert.equal(managedLanguageForFilename('cmd/main.go'), 'go');
  assert.equal(managedLanguageForFilename('app.py'), null);
  assert.equal(managedLanguageForFilename('index.ts'), null);
  assert.equal(managedLanguageForFilename('noext'), null);
  assert.equal(managedLanguageForFilename('.rs'), null);
  assert.equal(managedLanguageForFilename(null), null);
});

test('desired managed languages unions both panes (ADR-017 split)', () => {
  assert.deepEqual([...desiredManagedLanguages(['main.rs', 'util.c'])].sort(), ['cpp', 'rust']);
  assert.deepEqual([...desiredManagedLanguages(['main.rs', 'lib.rs'])], ['rust']);
  assert.deepEqual([...desiredManagedLanguages(['main.go', 'util.c'])].sort(), ['cpp', 'go']);
  assert.deepEqual([...desiredManagedLanguages(['app.py', 'index.ts'])], []);
  assert.deepEqual([...desiredManagedLanguages([])], []);
});

test('managed teardown fires only on real project transitions', () => {
  assert.equal(shouldTeardownManagedOnProjectTransition(null, 'p1'), false);
  assert.equal(shouldTeardownManagedOnProjectTransition('p1', 'p1'), false);
  assert.equal(shouldTeardownManagedOnProjectTransition('p1', 'p2'), true);
  assert.equal(shouldTeardownManagedOnProjectTransition('p1', null), true);
});

// ---------------------------------------------------------------------------
// Registry contract — the hook's extension table and editorLanguage's
// managed-session map both mirror the baked registry. This test fails the
// suite if any of the three drift (registry bumps are data changes; these
// two JS tables must follow).
//
// Registry ⊆ hook, not equality: go (ADR-005 Slice 6.5) is toolchain-tier —
// deliberately absent from the registry (gopls ships no prebuilt binaries)
// while still riding the generic lifecycle. Toolchain-tier extras are
// enumerated explicitly below so an accidental registry omission still fails.
// ---------------------------------------------------------------------------

const registry = JSON.parse(readFileSync(
  new URL('../../src-tauri/resources/language-server-registry.json', import.meta.url),
  'utf8'
));

const TOOLCHAIN_TIER_LANGUAGES = ['go'];

test('hook extension table covers the baked language-server registry exactly', () => {
  const registryLanguages = Object.keys(registry.servers).sort();
  const hookRegistryLanguages = MANAGED_LANGUAGE_IDS
    .filter((id) => !TOOLCHAIN_TIER_LANGUAGES.includes(id))
    .sort();
  assert.deepEqual(hookRegistryLanguages, registryLanguages);

  for (const [languageId, entry] of Object.entries(registry.servers)) {
    assert.deepEqual(
      [...MANAGED_LANGUAGE_EXTENSIONS[languageId]].sort(),
      [...entry.extensions].map((e) => e.toLowerCase()).sort(),
      `extension drift for registry language '${languageId}'`
    );
  }
});

test('toolchain-tier languages stay OUT of the registry by design', () => {
  for (const languageId of TOOLCHAIN_TIER_LANGUAGES) {
    assert.equal(
      registry.servers[languageId],
      undefined,
      `'${languageId}' is class-3 (toolchain-mediated) — a registry entry would claim a verified-artifact install path that does not exist`
    );
    assert.ok(
      MANAGED_LANGUAGE_IDS.includes(languageId),
      `'${languageId}' must still ride the generic lifecycle`
    );
  }
  assert.deepEqual([...MANAGED_LANGUAGE_EXTENSIONS.go], ['.go']);
});

test('editorLanguage managed-session map agrees with the registry', () => {
  for (const [languageId, entry] of Object.entries(registry.servers)) {
    for (const ext of entry.extensions) {
      assert.equal(
        getManagedSessionLanguageFromFilename(`file${ext}`),
        languageId,
        `editorLanguage does not claim '${ext}' for '${languageId}'`
      );
    }
  }
});
