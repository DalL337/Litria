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
// With `--addons a,b` and/or `--backend x` the run also executes the
// registry's post-scaffold steps for the selection — the SAME step list the
// runner derives (deriveScaffoldSteps), interpreted here with a small JS
// executor that mirrors src-tauri/src/scaffold_runner.rs apply_file_step —
// and records an `addonCoverage` result (ADR-028 §4/§10). Electron projects
// have no build script; their renderer is built with the project's own Vite
// (`vite build -c vite.renderer.config.*`) as the runnable-stage check.
//
// Usage:
//   node scripts/scaffold-recipe-evidence.mjs [--manager npm] [--only web/react/ts,...]
//        [--addons tailwind,shadcn] [--backend express] [--skip-install] [--out <file>] [--keep]
// Network is required (the CLIs download). Nothing in the repo is touched.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { RECIPES, listWrappers, getWrapper, getLanguages, resolveRoute, assemblePrimaryArgv, deriveScaffoldSteps, describeStep, getAddons, getBackendOptions } from '../src/scaffold/recipeRegistry.js';

const args = process.argv.slice(2);
const opt = (name, fallback = null) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(name);

const manager = opt('--manager', 'npm');
const only = opt('--only') ? new Set(opt('--only').split(',')) : null;
const skipInstall = flag('--skip-install');
const addonsWanted = opt('--addons') ? opt('--addons').split(',').filter(Boolean) : [];
const backendWanted = opt('--backend') || null;
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

// ---- step executor (mirror of scaffold_runner.rs apply_file_step) ---------

// JSONC → JSON (mirror of scaffold_runner.rs strip_jsonc): comments outside
// strings and trailing commas, which create-vite's tsconfig files contain.
function stripJsonc(text) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 1; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i += 1; i -= 1; continue; }
    if (c === '/' && text[i + 1] === '*') { i += 2; while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1; i += 1; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

function deepMerge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

function applyFileStep(projectDir, step) {
  const target = join(projectDir, step.path);
  const read = () => readFileSync(target, 'utf8');
  const write = (text) => { mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, text); };
  switch (step.op) {
    case 'write':
      if (step.mode !== 'replace' && existsSync(target)) throw new Error(`${step.path}: already exists`);
      write(step.content); return 'wrote';
    case 'prepend': case 'append': {
      const cur = read();
      if (cur.includes(step.text)) return 'already present';
      write(step.op === 'prepend' ? step.text + cur : cur + (cur.endsWith('\n') || cur === '' ? '' : '\n') + step.text);
      return `${step.op}ed`;
    }
    case 'replace': {
      const cur = read();
      if (cur.includes(step.with)) return 'already patched';
      const finds = Array.isArray(step.find) ? step.find : [step.find];
      const found = finds.find((f) => cur.includes(f));
      if (!found) throw new Error(`${step.path}: none of the expected markers found (${finds.join(' | ')})`);
      write(cur.replace(found, step.with)); return 'patched';
    }
    case 'insertBefore': {
      const cur = read();
      if (cur.includes(step.text)) return 'already patched';
      const idx = cur.indexOf(step.marker);
      if (idx < 0) throw new Error(`${step.path}: marker not found`);
      write(cur.slice(0, idx) + step.text + cur.slice(idx)); return 'patched';
    }
    case 'mergeJson': {
      if (!existsSync(target)) {
        if (step.create) write('{}\n');
        else if (step.optional) return 'absent, skipped';
        else throw new Error(`${step.path}: not found`);
      }
      const json = JSON.parse(stripJsonc(read()));
      write(`${JSON.stringify(deepMerge(json, step.value), null, 2)}\n`); return 'merged';
    }
    case 'delete':
      rmSync(target); return 'removed';
    default:
      throw new Error(`unknown op ${step.op}`);
  }
}

function runSteps(projectDir, steps) {
  const results = [];
  for (const step of steps) {
    const label = describeStep(step, manager);
    if (step.op === 'install' || step.op === 'exec') {
      const args = step.op === 'install' && manager === 'npm' ? [...step.argv.slice(0, 1), '--ignore-scripts', ...step.argv.slice(1)] : step.argv;
      const r = pmRun(args, projectDir);
      results.push({ step: label, ok: r.ok, ms: r.ms, tail: r.ok ? '' : r.tail });
      if (!r.ok) return { ok: false, results, failed: label };
      continue;
    }
    try {
      const outcome = applyFileStep(projectDir, step);
      results.push({ step: label, ok: true, detail: outcome });
    } catch (e) {
      results.push({ step: label, ok: false, tail: String(e.message ?? e) });
      return { ok: false, results, failed: label };
    }
  }
  return { ok: true, results };
}

function electronRendererBuild(projectDir) {
  const cfg = ['vite.renderer.config.ts', 'vite.renderer.config.mts', 'vite.renderer.config.mjs', 'vite.renderer.config.js'].find((f) => existsSync(join(projectDir, f)));
  if (!cfg) return { ok: null, detail: 'no renderer config' };
  const vite = join(projectDir, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!existsSync(vite)) return { ok: null, detail: 'vite not installed' };
  return run(process.execPath, [vite, 'build', '-c', cfg], projectDir);
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
      // Only add-ons this framework offers; a backend only where the wrapper has them.
      const addons = addonsWanted.filter((a) => getAddons(framework).includes(a));
      const backend = backendWanted && getBackendOptions(wrapper).includes(backendWanted) ? backendWanted : null;
      combos.push({ wrapper, framework, language, route, addons, backend });
    }
  }
}

const root = mkdtempSync(join(tmpdir(), 'litria-recipe-evidence-'));
console.log(`fixture root: ${root}\nplatform: ${platform}, manager: ${manager}, combos: ${combos.length}`);
const versions = toolVersions();

for (const { wrapper, framework, language, route, addons, backend } of combos) {
  const name = `fx-${wrapper}-${framework}-${language}`.toLowerCase();
  const cwd = join(root, `${wrapper}-${framework}-${language}`);
  rmSync(cwd, { recursive: true, force: true });
  mkdirSync(cwd, { recursive: true });
  const argv = assemblePrimaryArgv({ route, managerId: manager, projectName: name });
  const checks = [];
  const steps = deriveScaffoldSteps({ wrapper, framework, language, manager, addons, backend, projectName: name });
  const record = {
    wrapper, framework, language, manager, platform,
    ...(addons.length || backend ? { addons, backend, steps: steps.map((s) => describeStep(s, manager)) } : {}),
    recipe: { package: route.package, version: route.version, template: route.template, argv: [manager, ...argv] },
    versions,
    date: new Date().toISOString().slice(0, 10),
    checks,
    status: 'verified',
  };
  console.log(`\n== ${wrapper}/${framework}/${language}${addons.length ? ` +${addons.join('+')}` : ''}${backend ? ` +backend:${backend}` : ''}: ${manager} ${argv.join(' ')}`);

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
    // Post-scaffold steps (add-ons / backend / Electron framework wiring), the
    // same list the runner executes, before the build proves them.
    if (steps.length) {
      const ran = runSteps(projectDir, steps);
      checks.push({ check: 'steps', ok: ran.ok, steps: ran.results });
      if (!ran.ok) {
        record.status = 'failing';
        record.reason = `step failed: ${ran.failed}`;
        results.push(record);
        console.log(`   FAIL: ${record.reason}\n${ran.results.at(-1)?.tail ?? ''}`);
        continue;
      }
    }
    if (pkg.scripts?.build) {
      const build = pmRun(['run', 'build'], projectDir);
      checks.push({ check: 'build', ok: build.ok, ms: build.ms, tail: build.ok ? '' : build.tail });
      if (!build.ok) {
        record.status = 'failing';
        record.reason = `build exited ${build.status}`;
        console.log(`   FAIL: ${record.reason}\n${build.tail}`);
      }
    } else if (wrapper === 'electron') {
      const build = electronRendererBuild(projectDir);
      checks.push({ check: 'renderer build (vite)', ok: build.ok, ms: build.ms, detail: build.detail, tail: build.ok ? '' : build.tail });
      if (build.ok === false) {
        record.status = 'failing';
        record.reason = `renderer build exited ${build.status}`;
        console.log(`   FAIL: ${record.reason}\n${build.tail}`);
      }
      checks.push({ check: 'package', ok: null, detail: 'electron-forge package needs the Electron binary (consented scripts) — runnable stage not exercised' });
    } else {
      checks.push({ check: 'build', ok: null, detail: 'no build script — creation-stage evidence only (runnable stage needs consented scripts)' });
    }
    if (backend && record.status === 'verified') {
      // The server file must at least parse and start resolving imports.
      const serverFile = ['server/index.ts', 'server/index.js'].find((f) => existsSync(join(projectDir, f)));
      const check = serverFile ? run(process.execPath, ['--check', serverFile], projectDir) : { ok: false, tail: 'server file missing' };
      checks.push({ check: 'server syntax (node --check)', ok: check.ok, tail: check.ok ? '' : check.tail });
      if (!check.ok) { record.status = 'failing'; record.reason = 'server file does not parse'; }
    }
  }
  results.push(record);
  console.log(`   ${record.status}: ${checks.map((c) => `${c.check}=${c.ok === null ? 'n/a' : c.ok ? 'ok' : 'FAIL'}`).join(' ')}`);
  if (!keep) rmSync(cwd, { recursive: true, force: true });
}

writeFileSync(outFile, JSON.stringify({ registry: { schemaVersion: RECIPES.schemaVersion, recordedAt: RECIPES.recordedAt }, platform, manager, addons: addonsWanted, backend: backendWanted, results }, null, 2));
console.log(`\nwrote ${outFile}`);
if (!keep) rmSync(root, { recursive: true, force: true });
