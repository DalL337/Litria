import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScaffoldPlan,
  createScaffoldDomain,
  getScaffoldAddons,
  getScaffoldFrameworks,
  getScaffoldLanguages
} from '../../src/scaffold/scaffoldDomain.js';

test('ScaffoldDomain exposes MVP-only language registry', () => {
  const ids = getScaffoldLanguages().map((language) => language.id);
  assert.deepEqual(ids, ['javascript', 'typescript', 'python', 'json']);
});

test('ScaffoldDomain keeps add-ons disabled for MVP hardening', () => {
  assert.deepEqual(getScaffoldAddons('javascript'), []);
  assert.deepEqual(getScaffoldAddons('python'), []);
});

test('ScaffoldDomain builds a JavaScript plan with secret-safe defaults', () => {
  const frameworks = getScaffoldFrameworks('javascript');
  assert.equal(frameworks.length, 1);
  assert.equal(frameworks[0].id, 'node');

  const plan = buildScaffoldPlan({
    projectName: 'sample-app',
    languageId: 'javascript',
    frameworkId: 'node',
    addonIds: ['docker']
  });

  assert.equal(plan.languageId, 'javascript');
  assert.equal(plan.frameworkId, 'node');
  assert.deepEqual(plan.addons, []);
  assert.equal(plan.files.includes('.env.example'), true);
  assert.equal(plan.files.includes('.env'), false);
});

test('ScaffoldDomain API wrapper delegates selectors/commands', () => {
  const scaffoldDomain = createScaffoldDomain();
  const plan = scaffoldDomain.commands.buildPlan({
    projectName: 'cfg',
    languageId: 'json',
    frameworkId: 'config',
    addonIds: []
  });

  assert.equal(Array.isArray(scaffoldDomain.selectors.getLanguages()), true);
  assert.equal(plan.coreFiles.includes('config/settings.json'), true);
});

test('ScaffoldDomain builds a TypeScript Node plan with core TS dependencies', () => {
  const frameworks = getScaffoldFrameworks('typescript');
  assert.equal(frameworks.length, 1);
  assert.equal(frameworks[0].id, 'node');

  const plan = buildScaffoldPlan({
    projectName: 'ts-app',
    languageId: 'typescript',
    frameworkId: 'node',
    addonIds: []
  });

  assert.equal(plan.languageId, 'typescript');
  assert.equal(plan.frameworkId, 'node');
  assert.equal(plan.files.includes('tsconfig.json'), true);
  assert.equal(plan.files.includes('src/index.ts'), true);
  assert.deepEqual(plan.dependencies, ['typescript', 'tsx', '@types/node']);
  assert.equal(plan.installCommand, 'npm install typescript tsx @types/node');
});
