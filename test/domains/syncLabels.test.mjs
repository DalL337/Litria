import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { planSync, validateLabels } from '../../scripts/labels-plan.mjs';

// scripts/sync-labels.mjs only talks to gh; every decision it acts on comes
// from these two functions (brief: docs/plans/ideas/githandling/brief-github-labels.md).

const label = (name, color = 'ef5350', description = 'It is broken') => ({ name, color, description });

test('the committed labels file is valid and keeps GitHub\'s contributor names exact', () => {
  const labels = JSON.parse(readFileSync(new URL('../../.github/labels.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateLabels(labels), []);
  const names = labels.map((l) => l.name);
  assert.ok(names.includes('good first issue'));
  assert.ok(names.includes('help wanted'));
});

test('a valid file has no problems', () => {
  assert.deepEqual(validateLabels([label('type: bug'), label('area: canvas', '78909C', '')]), []);
});

test('duplicate names are caught, including ones that differ only in case', () => {
  const problems = validateLabels([label('type: bug'), label('Type: Bug'), label('area: lsp'), label('area: lsp')]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /"Type: Bug" \(entry 2\): duplicates entry 1/);
  assert.match(problems[1], /"area: lsp" \(entry 4\): duplicates entry 3/);
});

test('colors must be 6 hex digits without #', () => {
  for (const color of ['#ef5350', 'ef535', 'ef53500', 'gg5350', 42]) {
    const problems = validateLabels([label('type: bug', color)]);
    assert.equal(problems.length, 1, `color ${JSON.stringify(color)}`);
    assert.match(problems[0], /color must be 6 hex digits without #/);
  }
});

test('a description over 100 characters is caught; exactly 100 is fine', () => {
  assert.deepEqual(validateLabels([label('type: bug', 'ef5350', 'x'.repeat(100))]), []);
  const problems = validateLabels([label('type: bug', 'ef5350', 'x'.repeat(101))]);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /description is 101 characters, GitHub allows 100/);
});

test('every problem is reported, not just the first', () => {
  const problems = validateLabels([
    { name: '', color: 'nope', description: 7 },
    { name: ' padded ', color: 'ef5350', description: '', colour: 'ef5350' },
    'not an object',
  ]);
  assert.deepEqual(problems, [
    'entry 1: name must be a non-empty string',
    'entry 1: color must be 6 hex digits without #, got "nope"',
    'entry 1: description must be a string',
    '" padded " (entry 2): name has leading or trailing spaces',
    '" padded " (entry 2): unknown field colour',
    'entry 3: must be an object with name, color, description',
  ]);
  assert.deepEqual(validateLabels({}), ['the file must be a JSON array of labels']);
});

test('a color that differs only in case is kept, not updated', () => {
  const plan = planSync([label('type: bug', 'EF5350')], [label('type: bug', 'ef5350')]);
  assert.deepEqual(plan.keep.map((l) => l.name), ['type: bug']);
  assert.deepEqual(plan.update, []);
});

test('a changed description is an update that names the field', () => {
  const plan = planSync([label('help wanted', '26a69a', 'Maintainer would welcome outside help')],
    [label('help wanted', '26a69a', 'Extra attention is needed')]);
  assert.deepEqual(plan.update, [{
    label: label('help wanted', '26a69a', 'Maintainer would welcome outside help'),
    from: 'help wanted',
    changes: ['description'],
  }]);
});

test('a name that differs only in case is an update that renames from the GitHub name', () => {
  const plan = planSync([label('type: bug')], [label('Type: Bug', 'd73a4a')]);
  assert.equal(plan.update.length, 1);
  assert.equal(plan.update[0].from, 'Type: Bug');
  assert.deepEqual(plan.update[0].changes, ['name', 'color']);
});

test('a GitHub description of null compares as empty', () => {
  const plan = planSync([label('type: bug', 'ef5350', '')], [{ name: 'type: bug', color: 'ef5350', description: null }]);
  assert.equal(plan.keep.length, 1);
});

test('labels on GitHub but not in the file are unmanaged and never created or updated', () => {
  const wontfix = label('wontfix', 'ffffff', 'This will not be worked on');
  const plan = planSync([label('type: bug')], [wontfix]);
  assert.deepEqual(plan.create.map((l) => l.name), ['type: bug']);
  assert.deepEqual(plan.unmanaged, [wontfix]);
});

test('after applying a plan, planning again changes nothing', () => {
  const desired = [
    label('type: bug', 'EF5350', "It's broken"),
    label('type: docs', 'ffca28', "It isn't explained"),
    label('good first issue', '66bb6a', 'Small, well-scoped, good entry point'),
  ];
  const before = [
    label('type: docs', 'FFCA28', 'Improvements or additions to documentation'),
    label('good first issue', '7057ff', 'Good for newcomers'),
    label('question', 'd876e3', 'Further information is requested'),
  ];
  const first = planSync(desired, before);
  assert.equal(first.create.length, 1);
  assert.equal(first.update.length, 2);

  // What GitHub holds after --apply: every managed label as written (gh
  // returns colors lowercase), the unmanaged ones untouched.
  const after = [...desired.map((l) => ({ ...l, color: l.color.toLowerCase() })), ...first.unmanaged];
  const second = planSync(desired, after);
  assert.deepEqual(second.create, []);
  assert.deepEqual(second.update, []);
  assert.equal(second.keep.length, 3);
  assert.deepEqual(second.unmanaged.map((l) => l.name), ['question']);
});
