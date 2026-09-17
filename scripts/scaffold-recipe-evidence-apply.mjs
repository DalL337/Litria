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
const byKey = new Map(registry.coverage.entries.map((e) => [key(e), e]));

let applied = 0;
for (const file of files) {
  const evidence = JSON.parse(readFileSync(file, 'utf8'));
  for (const r of evidence.results) {
    if (r.status === 'unsupported') continue;
    const checks = r.checks.filter((c) => c.ok === true).map((c) => c.check);
    const skipped = r.checks.filter((c) => c.ok === null).map((c) => `${c.check}: ${c.detail}`);
    const entry = {
      wrapper: r.wrapper,
      framework: r.framework,
      language: r.language,
      manager: r.manager,
      platform: r.platform,
      status: r.status,
      evidence: {
        date: r.date,
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
writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
console.log(`applied ${applied} result(s); coverage now has ${registry.coverage.entries.length} entr${registry.coverage.entries.length === 1 ? 'y' : 'ies'}`);
