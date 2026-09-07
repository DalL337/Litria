import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { countAdvancedChanges, countColorChanges, reviewRowTarget } from '../../src/scaffold/wizardNavigation.js';

// Slice 3 of brief-wizard-robustness.md: Advanced folds with non-default
// count chips, section rules, and review-row Edit jumps.

const base = {
  wrapper: null, manager: 'npm', backend: 'none', pyEnvEngine: 'auto', pyEnvMode: 'venv', pyExistingEnv: '',
  groupColorMode: 'auto', nodeColorMode: 'inherit'
};

test('countAdvancedChanges counts only what the fold holds for this stack', () => {
  assert.equal(countAdvancedChanges({ ...base }), 0, 'no stack');
  assert.equal(countAdvancedChanges({ ...base, wrapper: 'blank', manager: 'yarn' }), 0, 'Blank has no fold');
  assert.equal(countAdvancedChanges({ ...base, wrapper: 'tauri' }), 0);
  assert.equal(countAdvancedChanges({ ...base, wrapper: 'tauri', manager: 'pnpm' }), 1);
  // Backend only exists for web: a stale backend value on tauri does not count.
  assert.equal(countAdvancedChanges({ ...base, wrapper: 'tauri', backend: 'express' }), 0);
  assert.equal(countAdvancedChanges({ ...base, wrapper: 'web', backend: 'express' }), 1);
  assert.equal(countAdvancedChanges({ ...base, wrapper: 'web', backend: 'express', manager: 'yarn' }), 2);
  // Python: engine + a filled-in existing env; the npm manager is irrelevant.
  assert.equal(countAdvancedChanges({ ...base, wrapper: 'python', manager: 'yarn' }), 0);
  assert.equal(countAdvancedChanges({ ...base, wrapper: 'python', pyEnvEngine: 'uv' }), 1);
  assert.equal(countAdvancedChanges({ ...base, wrapper: 'python', pyEnvMode: 'existing', pyExistingEnv: '  ' }), 0);
  assert.equal(countAdvancedChanges({ ...base, wrapper: 'python', pyEnvMode: 'existing', pyExistingEnv: 'C:/envs/x', pyEnvEngine: 'venv' }), 2);
});

test('countColorChanges counts the two colour modes', () => {
  assert.equal(countColorChanges({ ...base }), 0);
  assert.equal(countColorChanges({ ...base, groupColorMode: 'custom' }), 1);
  assert.equal(countColorChanges({ ...base, groupColorMode: 'custom', nodeColorMode: 'custom' }), 2);
});

test('reviewRowTarget sends each row to its owning step and opens the fold when needed', () => {
  assert.deepEqual(reviewRowTarget('Project'), { step: 0, fold: null });
  assert.deepEqual(reviewRowTarget('Location'), { step: 0, fold: null });
  assert.deepEqual(reviewRowTarget('Framework'), { step: 1, fold: null });
  assert.deepEqual(reviewRowTarget('Add-ons'), { step: 1, fold: null });
  assert.deepEqual(reviewRowTarget('Backend'), { step: 1, fold: 'advanced' });
  assert.deepEqual(reviewRowTarget('Package Manager'), { step: 1, fold: 'advanced' });
  assert.deepEqual(reviewRowTarget('Environment'), { step: 1, fold: 'advanced' });
  assert.deepEqual(reviewRowTarget('Workspace'), { step: 2, fold: null });
});

// ---- JSX + CSS contract (text) ----
const here = dirname(fileURLToPath(import.meta.url));
const jsx = readFileSync(join(here, '../../src/components/NewProjectWizard.jsx'), 'utf8');
const css = readFileSync(join(here, '../../src/styles/new-project-wizard.css'), 'utf8');

test('two Advanced folds: Stack and Workspace, each with a change-count chip', () => {
  const folds = (jsx.match(/className="npw-fold"/g) ?? []).length;
  assert.equal(folds, 2, 'one fold per step that has advanced content');
  assert.ok(/advancedChanges > 0 &&/.test(jsx), 'the Stack fold header shows its count');
  assert.ok(/colorChanges > 0 &&/.test(jsx), 'the Workspace fold header shows its count');
  // The fold's contents left the primary path.
  assert.doesNotMatch(jsx, /className="npw-env-details"/, 'the Python engine <details> moved into the fold');
  assert.doesNotMatch(jsx, /npw-subsection\$\{showBackend/, 'backend is no longer a primary cascade section');
});

test('every review row has an Edit jump to its owning step', () => {
  assert.ok(/aria-label=\{`Edit \$\{key\}`\}/.test(jsx), 'Edit control per row');
  assert.ok(/reviewRowTarget\(/.test(jsx), 'rows resolve their target through the model');
  assert.ok(/goToPage\(target\.step, \{ fold: target\.fold \}\)/.test(jsx), 'the jump opens the owning fold');
});

test('section labels are rules and the fold chrome is styled', () => {
  assert.match(css, /\.npw-section-label::after\s*\{[^}]*flex:\s*1/, 'section labels carry a rule');
  for (const cls of ['.npw-fold-summary', '.npw-fold-body', '.npw-fold-count', '.npw-review-edit', '.npw-seed-note']) {
    assert.ok(css.includes(cls), `${cls} is styled`);
  }
  assert.doesNotMatch(css, /\.npw-env-details/, 'the old inline <details> styling is gone');
});
