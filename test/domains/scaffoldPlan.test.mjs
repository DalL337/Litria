import test from 'node:test';
import assert from 'node:assert/strict';

import { buildScaffoldPlan, BLANK_FILES, normalizePlatform } from '../../src/scaffold/scaffoldPlan.js';
import { RECIPES } from '../../src/scaffold/recipeRegistry.js';

// ADR-028 §2: preview, validation and payload come from one derivation.

const base = {
  name: 'demo', folder: 'C:\\proj', wrapper: null, framework: null, lang: null,
  backend: 'none', addons: [], manager: 'npm', theme: 'glass',
  pyInterpreter: null, pyEnvMode: 'venv', pyEnvEngine: 'auto', pyExistingEnv: '', pyRequiresFloor: null,
};
const probe = { interpreters: [], uvAvailable: false };
const WIN = { platform: 'windows' };

function verifiedOn(wrapper, framework, language, manager, platform) {
  return RECIPES.coverage.entries.some((e) =>
    e.wrapper === wrapper && e.framework === framework && e.language === language
    && e.manager === manager && e.platform === platform
    && (e.status === 'verified' || e.status === 'covered-by-equivalence'));
}

test('blank plan: preview names the substrate and the payload is name + location only', () => {
  const plan = buildScaffoldPlan({ ...base, wrapper: 'blank', name: ' demo ' }, probe, WIN);
  assert.equal(plan.kind, 'blank');
  assert.deepEqual(plan.files, [...BLANK_FILES]);
  assert.equal(plan.availability.selectable, true);
  assert.deepEqual(plan.payload, { projectName: 'demo', projectLocation: 'C:\\proj' });
  assert.equal(plan.preview[0].text, 'blank');
  assert.match(plan.preview[2].text, /README\.md \+ \.gitignore \+ \.editorconfig/);
});

test('python plan: engine resolved once for preview and payload', () => {
  const state = { ...base, wrapper: 'python', framework: 'py-cli', lang: 'py', pyInterpreter: 'C:\\Py\\python.exe' };
  const withUv = buildScaffoldPlan(state, { interpreters: [{ path: 'C:\\Py\\python.exe', version: '3.13.1' }], uvAvailable: true }, WIN);
  assert.equal(withUv.kind, 'python');
  assert.equal(withUv.payload.envEngine, 'uv');
  assert.ok(withUv.preview.some((p) => p.text.includes('uv venv')));
  const withoutUv = buildScaffoldPlan(state, { interpreters: [{ path: 'C:\\Py\\python.exe', version: '3.13.1' }], uvAvailable: false }, WIN);
  assert.equal(withoutUv.payload.envEngine, 'venv');
  assert.ok(withoutUv.preview.some((p) => p.text.includes('-m venv')));
  assert.deepEqual(Object.keys(withUv.payload).sort(), [
    'addons', 'archetype', 'distName', 'envEngine', 'envMode', 'existingEnv', 'interpreterPath',
    'moduleName', 'projectLocation', 'projectName', 'requiresFloor',
  ]);
});

test('python plan: every runner refusal is a reason up front (F32, F33, F36)', () => {
  const state = { ...base, wrapper: 'python', framework: 'py-lib', lang: 'py' };
  assert.equal(buildScaffoldPlan(state, probe, WIN).availability.selectable, true);
  const keyword = buildScaffoldPlan({ ...state, name: 'class' }, probe, WIN);
  assert.equal(keyword.availability.selectable, false);
  assert.match(keyword.availability.reason, /"class" is a Python keyword/);
  assert.equal(keyword.payload.moduleName, 'class', 'the payload still says what the wizard derived');
  const floor = buildScaffoldPlan({ ...state, pyRequiresFloor: '3.13.' }, probe, WIN);
  assert.equal(floor.availability.selectable, false);
  assert.match(floor.availability.reason, /requires-python must look like 3\.13/);
  const existing = buildScaffoldPlan({ ...state, pyEnvMode: 'existing', pyExistingEnv: '' }, probe, WIN);
  assert.equal(existing.availability.selectable, false);
  assert.equal(existing.availability.reason, 'Enter the path of the existing environment.');
  assert.equal(existing.payload.existingEnv, null);
  const none = buildScaffoldPlan({ ...state, framework: null }, probe, WIN);
  assert.equal(none.availability.reason, 'Pick a project type.');
});

test('npm plan: the registry limits ride in the plan record (ADR-028 §8)', () => {
  const plan = buildScaffoldPlan({ ...base, wrapper: 'web', framework: 'react', lang: 'ts', manager: 'npm' }, probe, WIN);
  const { primary, command, env } = RECIPES.limits;
  assert.deepEqual(plan.payload.plan.limits, { primary, command, env });
  for (const pair of [primary, command, env]) {
    assert.ok(Number.isInteger(pair.idleSeconds) && pair.idleSeconds > 0);
    assert.ok(Number.isInteger(pair.deadlineSeconds) && pair.deadlineSeconds >= pair.idleSeconds, 'a deadline never shorter than the idle limit');
  }
  assert.ok(!('$comment' in plan.payload.plan.limits), 'the comment stays in the registry');
});

test('npm plan: incomplete stack has no preview and is not submittable', () => {
  const plan = buildScaffoldPlan({ ...base, wrapper: 'web', framework: 'react' }, probe, WIN);
  assert.equal(plan.preview, null);
  assert.equal(plan.availability.selectable, false);
  assert.equal(plan.payload, null);
});

test('npm plan: preview tokens are exactly the argv the payload carries (F14)', () => {
  const plan = buildScaffoldPlan({ ...base, wrapper: 'web', framework: 'react', lang: 'ts', manager: 'npm', addons: ['tailwind'] }, probe, WIN);
  assert.equal(plan.kind, 'npm');
  assert.deepEqual(plan.argv, ['create', '--yes', 'vite@9.1.1', 'demo', '--', '--template', 'react-ts']);
  const shown = plan.preview.filter((p) => p.type !== 'comment').map((p) => p.text.trim());
  assert.deepEqual(shown, ['npm', ...plan.argv]);
  assert.deepEqual(plan.payload.plan.argv, plan.argv);
  assert.equal(plan.payload.plan.routeKind, 'initializer');
  assert.equal(plan.payload.plan.package, 'create-vite');
  assert.equal(plan.payload.plan.template, 'react-ts');
  assert.equal(plan.payload.plan.platform, 'windows');
  assert.ok(plan.preview.some((p) => p.type === 'comment' && p.text.includes('addon:tailwind')), 'the preview lists the tailwind steps');
  // No --manager for the web wrapper: the runner never sends one.
  assert.ok(!plan.argv.includes('--manager'));
});

test('npm plan: tauri carries --manager and --yes because the runner does', () => {
  const plan = buildScaffoldPlan({ ...base, wrapper: 'tauri', framework: 'vue', lang: 'js', manager: 'npm' }, probe, WIN);
  assert.deepEqual(plan.argv, ['create', '--yes', 'tauri-app@4.6.2', 'demo', '--', '--yes', '--template', 'vue', '--manager', 'npm']);
});

test('npm plan: the payload argv uses the real name, the preview the display fallback', () => {
  const plan = buildScaffoldPlan({ ...base, name: '', wrapper: 'web', framework: 'vue', lang: 'ts' }, probe, WIN);
  assert.equal(plan.argv[3], 'my-app');
  assert.equal(plan.payload.plan.argv[3], '');
});

test('npm plan: web + angular previews and submits the Angular CLI exec route (F1, ADR-028 §3)', () => {
  const plan = buildScaffoldPlan({ ...base, wrapper: 'web', framework: 'angular', lang: 'ts' }, probe, WIN);
  assert.equal(plan.kind, 'npm');
  assert.equal(plan.route.kind, 'exec');
  assert.equal(plan.payload.plan.routeKind, 'exec');
  assert.equal(plan.payload.plan.package, '@angular/cli');
  assert.deepEqual(plan.argv.slice(0, 5), ['exec', '--yes', '--', `@angular/cli@${plan.route.version}`, 'new']);
  const shown = plan.preview.filter((p) => p.type !== 'comment').map((p) => p.text.trim());
  assert.deepEqual(shown, ['npm', ...plan.argv]);
  assert.equal(plan.availability.selectable, verifiedOn('web', 'angular', 'ts', 'npm', 'windows'));
});

test('npm plan: availability follows the coverage table for platform + manager', () => {
  const selection = { ...base, wrapper: 'web', framework: 'react', lang: 'ts' };
  // Yarn has no evidence on Linux (no yarn here to produce it).
  const linuxYarn = buildScaffoldPlan({ ...selection, manager: 'yarn' }, probe, { platform: 'linux' });
  assert.equal(linuxYarn.availability.selectable, false);
  assert.match(linuxYarn.availability.reason, /not been verified/);
  assert.ok(linuxYarn.preview.some((p) => p.type === 'comment' && p.text.includes('not offered')));
  // Whatever the registry says for windows/npm, the plan agrees with it.
  const winNpm = buildScaffoldPlan(selection, probe, WIN);
  assert.equal(winNpm.availability.selectable, verifiedOn('web', 'react', 'ts', 'npm', 'windows'));
});

test('unknown platforms are normalized and never selectable for npm routes', () => {
  assert.equal(normalizePlatform('freebsd'), 'unknown');
  assert.equal(normalizePlatform(undefined), 'unknown');
  const plan = buildScaffoldPlan({ ...base, wrapper: 'web', framework: 'react', lang: 'ts' }, probe, {});
  assert.equal(plan.availability.selectable, false);
});
