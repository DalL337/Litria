#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scaffold-recipe-evidence.mjs — execute scaffold recipes on disposable
// fixtures and record the evidence ADR-028 §10 / dependency-change policy
// Rule 4 require before a combination may be offered.
//
// For every npm-kind (wrapper, framework, language) with a template, using
// the requested manager (default npm), on THIS platform:
//   1. run the registry's exact primary argv in a fresh temp directory;
//   2. check that the project directory and its package.json exist;
//   3. `<pm> install --ignore-scripts` (creation-stage: nothing executes);
//   4. `<pm> run build` when the template defines a build script.
// Each result is written as JSON the maintainer copies into
// recipes.json `coverage.entries` (status verified/failing + evidence).
//
// Usage:
//   node scripts/scaffold-recipe-evidence.mjs [--manager npm] [--only web/react/ts,...]
//        [--skip-install] [--out <file>] [--keep]
// Network is required (the CLIs download). Nothing in the repo is touched.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RECIPES, listWrappers, getWrapper, getLanguages, resolveRoute, assemblePrimaryArgv } from '../src/scaffold/recipeRegistry.js';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);

const manager = opt('--manager', 'npm');
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
const skipInstall = flag('--skip-install');
const keep = flag('--keep');
const outFile = opt('--out', join(process.cwd(), `scaffold-evidence-${manager}-${Date.now()}.json`));
const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';

// Spawn the manager the way the runner does: never a `.cmd` shim by bare name
// (Node ≥ 20 refuses without a shell, and a shell re-parses argv). npm runs as
// `node <npm-cli.js>` from this Node's own install; other managers must be
// resolvable as an absolute executable via `where`/`which`.
function resolveManager(id) {
  if (id === 'npm') {
    const cli = join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (!existsSync(cli)) throw new Error(`npm-cli.js not found beside node: ${cli}`);
    return { exe: process.execPath, prefix: [cli] };
  }
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', [id], { encoding: 'utf8' });
  const lines = (probe.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean);
  const exe = lines.find((l) => /\.(exe|cmd|bat|com)$/i.test(l)) ?? lines[0];
  if (!exe) throw new Error(`${id} is not installed`);
  return { exe, prefix: [] };
}
const pm = resolveManager(manager);

function run(cmd, cmdArgs, cwd, extraEnv = {}) {
  const started = Date.now();
  const res = spawnSync(cmd, cmdArgs, {
    cwd,
    encoding: 'utf8',
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CI: 'true', npm_config_ignore_scripts: 'true', ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    ok: res.status === 0,
    status: res.status,
    ms: Date.now() - started,
    tail: `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim().split('\n').slice(-12).join('\n'),
  };
}

function pmRun(cmdArgs, cwd) {
  return run(pm.exe, [...pm.prefix, ...cmdArgs], cwd);
}

function toolVersions() {
  return { node: process.version, [manager]: pmRun(['--version'], process.cwd()).tail.split('\n').pop() };
}

const results = [];
const combos = [];
for (const wrapper of listWrappers()) {
  const w = getWrapper(wrapper);
  if (w.kind !== 'npm') continue;
  for (const framework of w.frameworks) {
    for (const language of getLanguages(framework)) {
      const id = `${wrapper}/${framework}/${language}`;
      if (only && !only.has(id)) continue;
      const route = resolveRoute(wrapper, framework, language);
      if (!route || route.unsupported) {
        results.push({ wrapper, framework, language, manager, platform, status: 'unsupported', reason: route?.unsupported ?? 'no route' });
        continue;
      }
      combos.push({ wrapper, framework, language, route });
    }
  }
}

const root = mkdtempSync(join(tmpdir(), 'litria-recipe-evidence-'));
console.log(`fixture root: ${root}\nplatform: ${platform}, manager: ${manager}, combos: ${combos.length}`);
const versions = toolVersions();

for (const { wrapper, framework, language, route } of combos) {
  const name = `fx-${wrapper}-${framework}-${language}`.toLowerCase();
  const cwd = join(root, `${wrapper}-${framework}-${language}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const argv = assemblePrimaryArgv({ route, managerId: manager, projectName: name });
  const checks = [];
  const record = {
    wrapper, framework, language, manager, platform,
    recipe: { package: route.package, version: route.version, template: route.template, argv: [manager, ...argv] },
    versions,
    date: new Date().toISOString().slice(0, 10),
    checks,
    status: 'verified',
  };
  console.log(`\n== ${wrapper}/${framework}/${language}: ${manager} ${argv.join(' ')}`);

  const create = pmRun(argv, cwd);
  checks.push({ check: 'create', ok: create.ok, ms: create.ms, tail: create.tail });
  const projectDir = join(cwd, name);
  const filesOk = existsSync(join(projectDir, 'package.json'));
  checks.push({ check: 'files', ok: filesOk, detail: filesOk ? 'package.json present' : 'package.json missing' });
  if (!create.ok || !filesOk) {
    record.status = 'failing';
    record.reason = !create.ok ? `create exited ${create.status}` : 'no package.json generated';
    results.push(record);
    console.log(`   FAIL: ${record.reason}\n${create.tail}`);
    continue;
  }

  let pkg = {};
  try { pkg = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')); } catch { /* recorded below */ }
  record.generated = { name: pkg.name ?? null, scripts: Object.keys(pkg.scripts ?? {}), dependencies: pkg.dependencies ?? {}, devDependencies: pkg.devDependencies ?? {} };

  if (!skipInstall) {
    const install = pmRun(['install', '--ignore-scripts', '--no-audit', '--no-fund', '--fetch-retries=1'], projectDir);
    checks.push({ check: 'install (scripts off)', ok: install.ok, ms: install.ms, tail: install.ok ? '' : install.tail });
    if (!install.ok) {
      record.status = 'failing';
      record.reason = `install exited ${install.status}`;
      results.push(record);
      console.log(`   FAIL: ${record.reason}\n${install.tail}`);
      continue;
    }
    if (pkg.scripts?.build) {
      const build = pmRun(['run', 'build'], projectDir);
      checks.push({ check: 'build', ok: build.ok, ms: build.ms, tail: build.ok ? '' : build.tail });
      if (!build.ok) {
        record.status = 'failing';
        record.reason = `build exited ${build.status}`;
        console.log(`   FAIL: ${record.reason}\n${build.tail}`);
      }
    } else {
      checks.push({ check: 'build', ok: null, detail: 'no build script — creation-stage evidence only (runnable stage needs consented scripts)' });
    }
  }
  results.push(record);
  console.log(`   ${record.status}: ${checks.map((c) => `${c.check}=${c.ok === null ? 'n/a' : c.ok ? 'ok' : 'FAIL'}`).join(' ')}`);
  if (!keep) rmSync(cwd, { recursive: true, force: true });
}

writeFileSync(outFile, JSON.stringify({ registry: { schemaVersion: RECIPES.schemaVersion, recordedAt: RECIPES.recordedAt }, platform, manager, results }, null, 2));
console.log(`\nwrote ${outFile}`);
if (!keep) rmSync(root, { recursive: true, force: true });
