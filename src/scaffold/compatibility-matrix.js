// ---------------------------------------------------------------------------
// Compatibility Matrix — a PROJECTION of src/scaffold/recipes.json (ADR-028 §1).
//
// The wizard reads these helpers to populate each cascade step. Nothing here
// carries data of its own any more: to add or change a combination, edit the
// registry (and its coverage evidence), never this file.
//
// History: until ADR-028 this file owned its own tables, and its `web`
// runtime listed Angular even though create-vite ships no Angular template
// (F1). The registry's template manifests make that class of drift a test
// failure (test/domains/scaffoldRecipes.test.mjs).
// ---------------------------------------------------------------------------

import {
  RECIPES,
  getFrameworks,
  getLanguages,
  getAddons,
  getAddonDeps,
  isLanguageLocked,
  getBackendOptions,
} from './recipeRegistry.js';

/** Legacy shape kept for tests and callers that read the matrix as data. */
const COMPAT = Object.freeze({
  runtimes: Object.freeze(Object.fromEntries(
    Object.entries(RECIPES.wrappers)
      .filter(([, w]) => w.kind !== 'blank')
      .map(([id, w]) => [id, { frameworks: w.frameworks }])
  )),
  frameworks: Object.freeze(Object.fromEntries(
    Object.entries(RECIPES.frameworks).map(([id, f]) => [id, { languages: f.languages, addons: f.addons }])
  )),
  addonDeps: Object.freeze(Object.fromEntries(
    Object.entries(RECIPES.addons)
      .filter(([, a]) => a.requires.length > 0)
      .map(([id, a]) => [id, a.requires])
  )),
  backends: getBackendOptions('web'),
});

export { COMPAT, getFrameworks, getLanguages, getAddons, getAddonDeps, isLanguageLocked, getBackendOptions };
