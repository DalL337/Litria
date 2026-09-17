#!/usr/bin/env node
// ---------------------------------------------------------------------------
// scaffold-recipe-evidence-apply.mjs — fold one or more evidence files
// produced by scaffold-recipe-evidence.mjs into recipes.json `coverage`.
//
// Each (wrapper, framework, language, manager, platform) gets ONE entry: the
// newest evidence replaces an older one for the same key. `verified` and
// `failing` come straight from the run; `unsupported` results are dropped
// (the registry already refuses those combinations by construction).
//
// Usage: node scripts/scaffold-recipe-evidence-apply.mjs <evidence.json>...
// Review the diff to recipes.json before committing — the evidence is the
// support claim (ADR-028 §10, dependency-change policy Rule 6).
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const registryPath = join(here, '../src/scaffold/recipes.json');
const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('usage: node scripts/scaffold-recipe-evidence-apply.mjs <evidence.json>...');
  process.exit(2);
}

const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
const key = (e) => [e.wrapper, e.framework, e.language, e.manager, e.platform].join('|');
const addonKey = (e) => [key(e), [...(e.addons ?? [])].sort().join('+'), e.backend ?? ''].join('|');
const byKey = new Map(registry.coverage.entries.map((e) => [key(e), e]));
registry.addonCoverage ??= { entries: [] };
const addonByKey = new Map(registry.addonCoverage.entries.map((e) => [addonKey(e), e]));

// The pins a run was recorded against (ADR-028 §10, dependency policy Rule 5):
// the route's tool version plus every `name@x.y.z` spec the executed steps
// installed or ran that the registry pins. Both sides compare these with the
// registry's current pins; a bump invalidates the entry until it is re-run.
const pinned = new Set([
  ...Object.keys(registry.tools),
  ...Object.keys(registry.packages).filter((k) => k !== '$comment'),
]);
function pinsOf(r) {
  const pins = {};
  if (r.recipe?.package && r.recipe?.version) pins[r.recipe.package] = r.recipe.version;
  const spec = /(@?[a-z0-9][\w.-]*(?:\/[\w.-]+)?)@(\d+\.\d+\.\d+(?:-[\w.]+)?)/g;
  for (const step of r.steps ?? []) {
    for (const m of String(step).matchAll(spec)) {
      if (pinned.has(m[1])) pins[m[1]] = m[2];
    }
  }
  return pins;
}
let applied = 0;
for (const file of files) {
  const evidence = JSON.parse(readFileSync(file, 'utf8'));
  for (const r of evidence.results) {
    if (r.status === 'unsupported') continue;
    const checks = r.checks.filter((c) => c.ok === true).map((c) => c.check);
    const pins = pinsOf(r);
    const skipped = r.checks.filter((c) => c.ok === null).map((c) => `${c.check}: ${c.detail}`);
    const isAddonRun = Array.isArray(r.addons) && (r.addons.length > 0 || r.backend);
    if (isAddonRun) {
      // An add-on run is evidence for the add-ons/backend it exercised — not
      // a primary-combination entry (the primary was verified on its own).
      const entry = {
        wrapper: r.wrapper, framework: r.framework, language: r.language, manager: r.manager, platform: r.platform,
        addons: r.addons, backend: r.backend ?? null,
        status: r.status,
        evidence: { date: r.date, pins, steps: r.steps, versions: r.versions, checks, ...(skipped.length ? { notExercised: skipped } : {}), source: 'scripts/scaffold-recipe-evidence.mjs' },
        ...(r.status === 'failing' ? { reason: r.reason } : {}),
      };
      addonByKey.set(addonKey(entry), entry);
      applied += 1;
      // A verified add-on run also exercised the primary path (same create
      // argv, install and build; the add-on steps only add files). When the
      // primary combination has no direct entry, record it as
      // covered-by-equivalence naming this run — the explicit mapping brief
      // §6 requires. A direct primary run still wins when present; an older
      // equivalence record is refreshed (its pins move with this run).
      const existing = byKey.get(key(entry));
      if (r.status === 'verified' && (!existing || existing.status === 'covered-by-equivalence')) {
        byKey.set(key(entry), {
          wrapper: r.wrapper, framework: r.framework, language: r.language, manager: r.manager, platform: r.platform,
          status: 'covered-by-equivalence',
          evidence: {
            date: r.date,
            representative: `addon run ${r.wrapper}/${r.framework}/${r.language} ${r.manager} ${r.platform} [${r.addons.join('+')}${r.backend ? ` +${r.backend}` : ''}]`,
            rationale: 'same create argv, install and build as the primary path; the add-on steps only add files before the build',
            pins: { [r.recipe.package]: r.recipe.version },
            recipe: { package: r.recipe.package, version: r.recipe.version, template: r.recipe.template, argv: r.recipe.argv },
            versions: r.versions,
            source: 'scripts/scaffold-recipe-evidence-apply.mjs',
          },
        });
      }
      continue;
    }
    const entry = {
      wrapper: r.wrapper,
      framework: r.framework,
      language: r.language,
      manager: r.manager,
      platform: r.platform,
      status: r.status,
      evidence: {
        date: r.date,
        pins,
        recipe: { package: r.recipe.package, version: r.recipe.version, template: r.recipe.template, argv: r.recipe.argv },
        versions: r.versions,
        checks,
        ...(skipped.length ? { notExercised: skipped } : {}),
        ...(r.generated ? { generated: { scripts: r.generated.scripts, dependencies: r.generated.dependencies, devDependencies: r.generated.devDependencies } } : {}),
        source: 'scripts/scaffold-recipe-evidence.mjs',
      },
      ...(r.status === 'failing' ? { reason: r.reason } : {}),
    };
    byKey.set(key(entry), entry);
    applied += 1;
  }
}

registry.coverage.entries = [...byKey.values()].sort((a, b) => key(a).localeCompare(key(b)));
registry.addonCoverage.entries = [...addonByKey.values()].sort((a, b) => addonKey(a).localeCompare(addonKey(b)));
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`applied ${applied} result(s); coverage now has ${registry.coverage.entries.length} primary and ${registry.addonCoverage.entries.length} add-on entr${registry.addonCoverage.entries.length === 1 ? 'y' : 'ies'}`);
