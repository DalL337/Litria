// ---------------------------------------------------------------------------
// sync-labels.mjs — make the repo's GitHub labels match .github/labels.json.
// Design: docs/plans/ideas/githandling/brief-github-labels.md.
//
//   npm run labels:sync                          preview, changes nothing
//   npm run labels:sync -- --apply               create and update labels
//   npm run labels:sync -- --repo owner/name     another repo (default: this clone's)
//
// It never deletes a label: labels missing from the file are listed as
// "not managed" and left alone. Every gh call is an argument array with no
// shell, because names contain ": " and spaces and descriptions contain
// apostrophes. The decisions live in labels-plan.mjs, which the tests cover.
// ---------------------------------------------------------------------------

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { planSync, validateLabels } from './labels-plan.mjs';

const LABELS_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', '.github', 'labels.json');
const LIST_LIMIT = 200; // gh lists 30 by default, which would silently miss labels
const USAGE = 'Usage: npm run labels:sync -- [--apply] [--repo owner/name]';

let applying = false;

function stop(message) {
  console.error(`\nStopped: ${message}`);
  if (applying) console.error('Labels shown above as created or updated are done. Fix the problem and rerun; they will show as keep.');
  process.exit(1);
}

function run(args) {
  const result = spawnSync('gh', args, { encoding: 'utf8' });
  if (result.error?.code === 'ENOENT') {
    stop('the GitHub CLI (gh) is not installed or not on PATH. Install it from https://cli.github.com, then rerun.');
  }
  if (result.error) stop(`could not run gh: ${result.error.message}`);
  return result;
}

function gh(args, doing) {
  const result = run(args);
  if (result.status !== 0) stop(`gh failed while ${doing}:\n${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

const row = (mark, word, text) => console.log(`${mark} ${word.padEnd(13)} ${text}`);
const describe = (changes, from) =>
  changes.map((change) => (change === 'name' ? `renamed from "${from}"` : change)).join(', ');

// 1. Arguments.
let options;
try {
  ({ values: options } = parseArgs({
    options: { apply: { type: 'boolean', default: false }, repo: { type: 'string' } },
    strict: true,
  }));
} catch (error) {
  stop(`${error.message}\n${USAGE}`);
}
if (options.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(options.repo)) {
  stop(`--repo must look like owner/name, got "${options.repo}".\n${USAGE}`);
}

// 2. The labels file, checked before anything touches GitHub.
let labels;
try {
  labels = JSON.parse(readFileSync(LABELS_FILE, 'utf8'));
} catch (error) {
  stop(`could not read .github/labels.json: ${error.message}`);
}
const problems = validateLabels(labels);
if (problems.length) {
  stop(`.github/labels.json has ${problems.length} problem(s), so nothing was sent to GitHub:\n  - ${problems.join('\n  - ')}`);
}

// 3. gh is installed and logged in.
const auth = run(['auth', 'status']);
if (auth.status !== 0) stop(`gh is not logged in. Run \`gh auth login\`, then rerun.\n${(auth.stderr || auth.stdout).trim()}`);

// 4. Target repo, printed first and passed to every later call.
const repo = options.repo
  ?? gh(['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], "finding this clone's repo").trim();
console.log(`Target repo: ${repo}\n`);

// 5. What is on GitHub now.
const existing = JSON.parse(gh(
  ['label', 'list', '--repo', repo, '--limit', String(LIST_LIMIT), '--json', 'name,color,description'],
  'listing labels',
));
if (existing.length >= LIST_LIMIT) {
  stop(`the repo has ${LIST_LIMIT} or more labels, so the list may be cut off. Raise LIST_LIMIT in scripts/sync-labels.mjs.`);
}

// 6. The plan, in plain English.
const plan = planSync(labels, existing);
for (const label of plan.create) row('+', 'create', label.name);
for (const { label, from, changes } of plan.update) row('~', 'update', `${label.name} (${describe(changes, from)})`);
for (const label of plan.keep) row('=', 'keep', label.name);
for (const label of plan.unmanaged) row('?', 'not managed', label.name);
console.log(`\n${plan.create.length} to create, ${plan.update.length} to update, ${plan.keep.length} unchanged, ${plan.unmanaged.length} not managed.`);

const writes = plan.create.length + plan.update.length;
if (!writes) {
  console.log('Nothing to change.');
  process.exit(0);
}
if (!options.apply) {
  console.log('Preview only. Nothing changed. Run `npm run labels:sync -- --apply` to apply.');
  process.exit(0);
}

// 7. Apply. Stops at the first failure; a rerun picks up where it stopped.
applying = true;
console.log('\nApplying:');
for (const label of plan.create) {
  gh(['label', 'create', label.name, '--repo', repo, '--color', label.color, '--description', label.description],
    `creating "${label.name}"`);
  row('+', 'created', label.name);
}
for (const { label, from, changes } of plan.update) {
  const rename = changes.includes('name') ? ['--name', label.name] : [];
  gh(['label', 'edit', from, '--repo', repo, ...rename, '--color', label.color, '--description', label.description],
    `updating "${from}"`);
  row('~', 'updated', label.name);
}
console.log('\nDone. Run `npm run labels:sync` again: it should show nothing to create or update.');
