import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RECIPES,
  COVERAGE_STATUSES,
  PLATFORMS,
  isExactVersion,
  listWrappers,
  wrapperKind,
  getFrameworks,
  getLanguages,
  getAddons,
  getAddonDeps,
  listManagers,
  getManager,
  pinnedSpec,
  addonCli,
  resolveRoute,
  assemblePrimaryArgv,
  getCoverage,
  pinsOutOfDate,
  SELECTABLE_STATUSES,
  availability,
  selectableLanguages,
} from '../../src/scaffold/recipeRegistry.js';
import { COMPAT } from '../../src/scaffold/compatibility-matrix.js';
import { CREATE_CLI_VERSIONS, ADDON_CLI_VERSIONS } from '../../src/scaffold/create-cli-versions.js';

// ---------------------------------------------------------------------------
// ADR-028 §1 — recipes.json is the single source of truth. These tests hold
// the registry to its own invariants and run the shared plan cases that the
// Rust side (scaffold_recipes.rs) runs too.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const CASES = JSON.parse(readFileSync(join(here, '../fixtures/scaffold-plans/cases.json'), 'utf8')).cases;

test('every tool pin is an exact version with a recorded publish date', () => {
  for (const [name, tool] of Object.entries(RECIPES.tools)) {
    assert.ok(isExactVersion(tool.version), `${name} pin "${tool.version}" must be exact`);
    assert.match(tool.publishedAt, /^\d{4}-\d{2}-\d{2}$/, `${name} records its publish date`);
    assert.ok(['initializer', 'addon-cli', 'exec'].includes(tool.kind), `${name} has a known kind`);
    if (tool.kind === 'exec') assert.ok(!tool.invoke, `${name} exec tools run under their real package name`);
    if (tool.kind === 'initializer') assert.ok(tool.invoke, `${name} names its npm-create short name`);
  }
  assert.equal(pinnedSpec('create-vite'), `create-vite@${RECIPES.tools['create-vite'].version}`);
  assert.equal(pinnedSpec('nope'), null);
});

test('every npm route names a tool that exists and args that only use known placeholders', () => {
  for (const [id, wrapper] of Object.entries(RECIPES.wrappers)) {
    if (wrapper.kind !== 'npm') continue;
    assert.ok(RECIPES.tools[wrapper.route.tool], `${id} route tool ${wrapper.route.tool} is pinned`);
    for (const arg of wrapper.route.args) {
      const placeholders = arg.match(/\{[a-z]+\}/g) ?? [];
      for (const p of placeholders) {
        assert.ok(['{template}', '{manager}', '{name}'].includes(p), `${id}: unknown placeholder ${p}`);
      }
    }
  }
});

test('every route template exists in the pinned tool\'s published template manifest (F1 regression)', () => {
  for (const [id, wrapper] of Object.entries(RECIPES.wrappers)) {
    if (wrapper.kind !== 'npm') continue;
    const manifest = RECIPES.templateManifests[wrapper.route.tool];
    assert.ok(Array.isArray(manifest) && manifest.length > 0, `${wrapper.route.tool} has a template manifest`);
    for (const [framework, byLang] of Object.entries(wrapper.templates)) {
      assert.ok(wrapper.frameworks.includes(framework), `${id}: template for ${framework} but framework not listed`);
      assert.ok(!wrapper.routes?.[framework], `${id}/${framework}: a template AND an override route is ambiguous`);
      for (const [lang, template] of Object.entries(byLang)) {
        assert.ok(getLanguages(framework).includes(lang), `${id}/${framework}: language ${lang} unknown`);
        assert.ok(manifest.includes(template), `${id}/${framework}/${lang}: template "${template}" is not shipped by ${wrapper.route.tool}@${RECIPES.tools[wrapper.route.tool].version}`);
      }
    }
  }
});

test('web + angular is an exec route through the pinned Angular CLI, never a create-vite template (F1, ADR-028 §3)', () => {
  const route = resolveRoute('web', 'angular', 'ts');
  assert.equal(route.kind, 'exec');
  assert.equal(route.package, '@angular/cli');
  assert.equal(route.invoke, '@angular/cli');
  assert.equal(RECIPES.tools['@angular/cli'].kind, 'exec');
  const argv = assemblePrimaryArgv({ route, managerId: 'npm', projectName: 'demo' });
  assert.deepEqual(argv.slice(0, 4), ['exec', '--yes', '--', `@angular/cli@${route.version}`]);
  assert.ok(argv.includes('--defaults') && argv.includes('--skip-git'), 'non-interactive flags');
  assert.ok(!argv.includes('--template'), 'no create-vite template is ever named for Angular');
  // The pin must satisfy the bundled Node (24.14.0): Angular CLI 22.x needs 24.15+.
  assert.match(route.version, /^21\.2\./);
});

test('a listed framework without a template or an override is refused with a reason, never silently routed', () => {
  // Electron lists no Angular at all; a framework/language the registry does
  // not know resolves to an explicit reason instead of a guessed template.
  const missing = resolveRoute('electron', 'angular', 'ts');
  assert.ok(missing.unsupported, 'electron + angular resolves to an unsupported route');
  assert.equal(assemblePrimaryArgv({ route: missing, managerId: 'npm', projectName: 'x' }), null);
  const noJs = resolveRoute('web', 'angular', 'js');
  assert.ok(noJs.unsupported, 'angular has no js variant');
  // Every framework a wrapper lists either has templates, an override route, or a stated reason.
  for (const [id, wrapper] of Object.entries(RECIPES.wrappers)) {
    if (wrapper.kind !== 'npm') continue;
    for (const framework of wrapper.frameworks) {
      const hasTemplate = Boolean(wrapper.templates[framework]);
      const hasOverride = Boolean(wrapper.routes?.[framework]);
      const hasReason = Boolean(wrapper.unsupported?.[framework]);
      assert.ok(hasTemplate || hasOverride || hasReason, `${id}/${framework}: neither a template, an override route, nor a stated reason`);
    }
  }
  // Override routes name a pinned exec tool and never a create-* initializer.
  for (const [id, wrapper] of Object.entries(RECIPES.wrappers)) {
    for (const [framework, override] of Object.entries(wrapper.routes ?? {})) {
      assert.equal(override.kind, 'exec', `${id}/${framework} override is an exec route`);
      assert.equal(RECIPES.tools[override.tool]?.kind, 'exec', `${id}/${framework} override tool is pinned as exec`);
    }
  }
});

test('shared plan cases derive exactly (the Rust suite runs the same file)', () => {
  assert.ok(CASES.length >= 10);
  for (const c of CASES) {
    const route = resolveRoute(c.input.wrapper, c.input.framework, c.input.language);
    if (c.expect.unsupported) {
      assert.ok(!route || route.unsupported, `${c.name}: expected unsupported`);
      continue;
    }
    assert.ok(route && !route.unsupported, `${c.name}: route resolves`);
    assert.equal(route.kind, c.expect.routeKind, c.name);
    assert.equal(route.package, c.expect.package, c.name);
    assert.equal(route.version, c.expect.version, c.name);
    assert.equal(route.template, c.expect.template, c.name);
    const argv = assemblePrimaryArgv({ route, managerId: c.input.manager, projectName: c.input.projectName });
    assert.deepEqual(argv, c.expect.argv, c.name);
  }
});

test('managers carry every verb the runner needs', () => {
  assert.deepEqual(listManagers(), ['npm', 'pnpm', 'yarn']);
  for (const id of listManagers()) {
    const m = getManager(id);
    for (const key of ['create', 'exec', 'install']) {
      assert.ok(Array.isArray(m[key]) && m[key].length > 0, `${id}.${key}`);
    }
    assert.ok(typeof m.devFlag === 'string');
    assert.ok(['env+flag', 'native', 'none'].includes(m.scriptsOff), `${id}.scriptsOff`);
    assert.equal(typeof m.auditAtCreate, 'boolean');
  }
  // npm must forward create-* flags behind `--`; pnpm/yarn must not.
  assert.equal(getManager('npm').forwardSeparator, '--');
  assert.equal(getManager('pnpm').forwardSeparator, null);
  assert.equal(getManager('yarn').forwardSeparator, null);
});

test('frameworks, languages, addons and dependencies are consistent', () => {
  for (const wrapper of listWrappers()) {
    for (const framework of getFrameworks(wrapper)) {
      assert.ok(RECIPES.frameworks[framework], `${wrapper} lists unknown framework ${framework}`);
    }
  }
  for (const [id, f] of Object.entries(RECIPES.frameworks)) {
    assert.ok(f.languages.length >= 1, `${id} has a language`);
    for (const addon of f.addons) {
      assert.ok(RECIPES.addons[addon], `${id} lists unknown addon ${addon}`);
      for (const dep of getAddonDeps(addon)) {
        assert.ok(f.addons.includes(dep), `${id}: addon ${addon} requires ${dep}, which the framework does not offer`);
      }
    }
  }
  // shadcn has a CLI per framework that offers it, and that CLI is pinned.
  for (const [id, f] of Object.entries(RECIPES.frameworks)) {
    if (!f.addons.includes('shadcn')) continue;
    const cli = addonCli('shadcn', id);
    assert.ok(cli, `${id} offers shadcn but names no CLI`);
    assert.ok(RECIPES.tools[cli], `${cli} is pinned`);
  }
  assert.deepEqual(getAddons('angular'), ['tailwind']);
  assert.equal(wrapperKind('python'), 'blueprint');
  assert.equal(wrapperKind('blank'), 'blank');
});

test('coverage entries are well-formed and only selectable statuses are offered', () => {
  for (const e of RECIPES.coverage.entries) {
    assert.ok(COVERAGE_STATUSES.includes(e.status), `${JSON.stringify(e)} status`);
    assert.ok(PLATFORMS.includes(e.platform), `${JSON.stringify(e)} platform`);
    assert.ok(listManagers().includes(e.manager), `${JSON.stringify(e)} manager`);
    assert.ok(getFrameworks(e.wrapper).includes(e.framework), `${JSON.stringify(e)} framework`);
    assert.ok(getLanguages(e.framework).includes(e.language), `${JSON.stringify(e)} language`);
    if (e.status === 'verified') {
      assert.ok(e.evidence?.date && e.evidence?.checks?.length, `${JSON.stringify(e)} verified needs evidence`);
    }
    if (e.status === 'covered-by-equivalence') {
      assert.ok(e.evidence?.representative && e.evidence?.rationale, `${JSON.stringify(e)} equivalence needs a representative and rationale`);
    }
    if (e.status === 'failing') {
      assert.ok(e.reason, `${JSON.stringify(e)} failing needs a reason`);
    }
  }
  // Missing entry ⇒ unverified ⇒ not selectable (brief §6).
  const missing = getCoverage({ wrapper: 'web', framework: 'react', language: 'ts', manager: 'yarn', platform: 'linux' });
  assert.equal(missing.status, 'unverified');
  const avail = availability({ wrapper: 'web', framework: 'react', language: 'ts', manager: 'yarn', platform: 'linux' });
  assert.equal(avail.selectable, false);
  assert.match(avail.reason, /not been verified/);
  // Offline wrappers never depend on manager evidence.
  assert.equal(availability({ wrapper: 'python', framework: 'py-lib', language: 'py', manager: 'npm', platform: 'linux' }).selectable, true);
  assert.equal(availability({ wrapper: 'blank', framework: null, language: null, manager: 'npm', platform: 'linux' }).selectable, true);
});

test('evidence recorded against other pins is stale, by name (ADR-028 §10, dependency policy Rule 5)', () => {
  const vite = RECIPES.tools['create-vite'].version;
  const tailwind = RECIPES.packages.tailwindcss.version;
  assert.equal(pinsOutOfDate({ pins: { 'create-vite': vite, tailwindcss: tailwind } }), null);
  const stale = pinsOutOfDate({ pins: { 'create-vite': '0.0.1', tailwindcss: tailwind } });
  assert.match(stale, /create-vite@0\.0\.1/);
  assert.match(stale, new RegExp(`create-vite@${vite.replace(/\./g, '\\.')}`));
  assert.match(pinsOutOfDate(undefined), /predates pin tracking/);
  assert.match(pinsOutOfDate({ pins: {} }), /predates pin tracking/);
  assert.equal(pinsOutOfDate({ pins: { 'left-pad': '1.0.0' } }), null, 'a name the registry does not pin is not a trigger');
});

test('every offered coverage entry was recorded against the current pins', () => {
  // A pin bump must come with re-run evidence or a downgraded status: the
  // wizard would otherwise disable the entry at runtime with this reason.
  for (const e of RECIPES.coverage.entries) {
    if (SELECTABLE_STATUSES.has(e.status)) {
      assert.equal(pinsOutOfDate(e.evidence), null, `${e.wrapper}/${e.framework}/${e.language} ${e.manager} ${e.platform}`);
      assert.equal(getCoverage(e).status, e.status);
    }
  }
  for (const e of RECIPES.addonCoverage.entries) {
    if (SELECTABLE_STATUSES.has(e.status)) {
      assert.equal(pinsOutOfDate(e.evidence), null, `${e.wrapper}/${e.framework}/${e.language} ${e.addons?.join('+')}`);
    }
  }
});

test('selectableLanguages narrows to what has evidence', () => {
  // No entries for yarn on linux anywhere → nothing selectable.
  assert.deepEqual(selectableLanguages({ wrapper: 'web', framework: 'react', manager: 'yarn', platform: 'linux' }), []);
});

test('the legacy projections agree with the registry', () => {
  assert.deepEqual(Object.keys(COMPAT.runtimes).sort(), ['electron', 'python', 'tauri', 'web']);
  assert.deepEqual(COMPAT.runtimes.web.frameworks, RECIPES.wrappers.web.frameworks);
  assert.deepEqual(COMPAT.addonDeps, { shadcn: ['tailwind'] });
  assert.deepEqual(COMPAT.backends, ['none', 'express', 'fastify']);
  assert.equal(CREATE_CLI_VERSIONS.vite, RECIPES.tools['create-vite'].version);
  assert.equal(CREATE_CLI_VERSIONS['tauri-app'], RECIPES.tools['create-tauri-app'].version);
  assert.equal(ADDON_CLI_VERSIONS['shadcn-vue'], RECIPES.tools['shadcn-vue'].version);
});
