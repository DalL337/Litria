import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RECIPES,
  orderAddons,
  deriveScaffoldSteps,
  describeStep,
  addonAvailability,
  backendAvailability,
  getFrameworks,
  getLanguages,
  listWrappers,
  wrapperKind,
  isExactVersion,
} from '../../src/scaffold/recipeRegistry.js';
import { buildScaffoldPlan } from '../../src/scaffold/scaffoldPlan.js';

// ADR-028 §4: add-ons integrate what they promise, in dependency order, from
// one registry that both the wizard and the runner read.

const here = dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(join(here, '../fixtures/scaffold-plans/step-cases.json'), 'utf8')).cases;

const project = (s) => ({ source: s.source, op: s.op, ...(s.path ? { path: s.path } : {}), ...(s.argv ? { argv: s.argv } : {}) });

test('shared step cases derive exactly (the Rust suite runs the same file)', () => {
  assert.ok(CASES.length >= 5);
  for (const c of CASES) {
    const steps = deriveScaffoldSteps(c.input).map(project);
    assert.deepEqual(steps, c.expect, c.name);
  }
});

test('add-ons run prerequisites first regardless of selection order (F6)', () => {
  assert.deepEqual(orderAddons(['shadcn', 'tailwind']), ['tailwind', 'shadcn']);
  assert.deepEqual(orderAddons(['router', 'shadcn']), ['tailwind', 'shadcn', 'router'], 'a missing prerequisite is pulled in');
  assert.deepEqual(orderAddons([]), []);
  assert.deepEqual(orderAddons(['nope']), []);
});

test('every package a recipe installs is pinned exactly in `packages` and every exec CLI in `tools`', () => {
  const pinned = new Set(Object.entries(RECIPES.packages).filter(([k]) => !k.startsWith('$')).map(([k, v]) => `${v.name ?? k}@${v.version}`));
  for (const [, v] of Object.entries(RECIPES.packages)) {
    if (v.version) assert.ok(isExactVersion(v.version));
  }
  const walk = (entries, where) => {
    for (const r of entries ?? []) {
      for (const s of r.steps) {
        if (s.op === 'install') for (const p of s.packages) assert.ok(pinned.has(p), `${where}: ${p} is not pinned in packages`);
        if (s.op === 'exec') assert.equal(RECIPES.tools[s.cli]?.kind, 'addon-cli', `${where}: ${s.cli} must be a pinned addon CLI`);
      }
    }
  };
  for (const [id, a] of Object.entries(RECIPES.addons)) walk(a.recipes, `addon ${id}`);
  for (const [id, r] of Object.entries(RECIPES.backends.recipes)) walk(r, `backend ${id}`);
  for (const [fw, r] of Object.entries(RECIPES.wrappers.electron.frameworkRecipes)) walk(r, `electron ${fw}`);
});

test('every npm combination that offers an add-on has an entry file for the steps that need one', () => {
  for (const wrapper of listWrappers()) {
    if (wrapperKind(wrapper) !== 'npm') continue;
    for (const framework of getFrameworks(wrapper)) {
      for (const language of getLanguages(framework)) {
        const addons = RECIPES.frameworks[framework].addons;
        const steps = deriveScaffoldSteps({ wrapper, framework, language, manager: 'npm', addons, backend: null, projectName: 'x' });
        for (const s of steps) {
          for (const field of ['path', 'text', 'content', 'with']) {
            if (typeof s[field] === 'string') assert.doesNotMatch(s[field], /\{(entry|ext|jsx|name)\}/, `${wrapper}/${framework}/${language}: ${s.source} ${s.op} leaves a placeholder in ${field}`);
          }
          if (s.op === 'exec') assert.ok(s.argv, `${wrapper}/${framework}/${language}: ${s.source} exec has no pinned CLI`);
        }
        // Tailwind must end up imported somewhere for every framework that offers it.
        if (addons.includes('tailwind')) {
          const tw = steps.filter((s) => s.source === 'addon:tailwind');
          assert.ok(tw.some((s) => ['prepend', 'append', 'write'].includes(s.op) && (s.text ?? s.content ?? '').includes('tailwind')), `${wrapper}/${framework}/${language}: tailwind is installed but never imported`);
        }
      }
    }
  }
});

test('written JSON files are valid JSON and mergeJson values are objects', () => {
  const check = (entries, where) => {
    for (const r of entries ?? []) {
      for (const s of r.steps) {
        if (s.op === 'write' && s.path.endsWith('.json')) assert.doesNotThrow(() => JSON.parse(s.content), `${where}: ${s.path}`);
        if (s.op === 'mergeJson') assert.equal(typeof s.value, 'object', `${where}: ${s.path}`);
      }
    }
  };
  for (const [id, a] of Object.entries(RECIPES.addons)) check(a.recipes, `addon ${id}`);
  for (const [id, r] of Object.entries(RECIPES.backends.recipes)) check(r, `backend ${id}`);
  for (const [fw, r] of Object.entries(RECIPES.wrappers.electron.frameworkRecipes)) check(r, `electron ${fw}`);
});

test('the plan lists every step in the preview and carries them in the payload', () => {
  const state = {
    name: 'demo', folder: 'C:\\p', wrapper: 'web', framework: 'react', lang: 'ts', backend: 'express', addons: ['tailwind'], manager: 'npm', theme: 'glass',
    pyInterpreter: null, pyEnvMode: 'venv', pyEnvEngine: 'auto', pyExistingEnv: '', pyRequiresFloor: null,
  };
  const plan = buildScaffoldPlan(state, { interpreters: [], uvAvailable: false }, { platform: 'windows' });
  assert.ok(plan.steps.length >= 6);
  assert.deepEqual(plan.payload.plan.steps, plan.steps);
  const lines = plan.preview.filter((p) => p.type === 'comment').map((p) => p.text);
  for (const step of plan.steps) {
    assert.ok(lines.some((l) => l.includes(describeStep(step, 'npm'))), `preview lists ${step.source} ${step.op}`);
  }
});

test('add-ons and backends are offered only with their own evidence (ADR-028 §10)', () => {
  const key = { wrapper: 'web', framework: 'react', language: 'ts', manager: 'yarn', platform: 'linux' };
  assert.equal(addonAvailability({ ...key, addon: 'tailwind' }).selectable, false);
  assert.match(addonAvailability({ ...key, addon: 'tailwind' }).reason, /no execution evidence/);
  assert.equal(backendAvailability({ ...key, backend: 'express' }).selectable, false);
  assert.equal(backendAvailability({ ...key, backend: 'none' }).selectable, true);
  assert.equal(addonAvailability({ wrapper: 'python', framework: 'py-lib', language: 'py', manager: 'npm', platform: 'linux', addon: 'ruff' }).selectable, true);
  // A plan with an unevidenced add-on is not submittable even when the primary is.
  const state = {
    name: 'demo', folder: 'C:\\p', wrapper: 'web', framework: 'react', lang: 'ts', backend: 'none', addons: ['tailwind'], manager: 'yarn', theme: 'glass',
    pyInterpreter: null, pyEnvMode: 'venv', pyEnvEngine: 'auto', pyExistingEnv: '', pyRequiresFloor: null,
  };
  const plan = buildScaffoldPlan(state, { interpreters: [], uvAvailable: false }, { platform: 'linux' });
  assert.equal(plan.availability.selectable, false);
  // Whatever the registry says for windows/npm, the plan agrees with it.
  const win = buildScaffoldPlan({ ...state, manager: 'npm' }, { interpreters: [], uvAvailable: false }, { platform: 'windows' });
  const expected = addonAvailability({ wrapper: 'web', framework: 'react', language: 'ts', manager: 'npm', platform: 'windows', addon: 'tailwind' }).selectable;
  assert.equal(win.availability.selectable, expected);
});
