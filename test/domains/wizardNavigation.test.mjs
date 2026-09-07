import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  WIZARD_STEPS,
  WIZARD_STEP_COUNT,
  stepState,
  canAdvance,
  isWizardDirty,
  ROVING_KEYS,
  rovingTarget
} from '../../src/scaffold/wizardNavigation.js';

// Slice 2 of brief-wizard-robustness.md: labelled stepper, keyboard model,
// cards as real buttons. The rules are pure (above); the JSX contract is
// held by text below because the suite has no DOM.

const base = { name: '', folder: '', wrapper: null, framework: null, lang: null };

test('four labelled steps, in order', () => {
  assert.equal(WIZARD_STEP_COUNT, 4);
  assert.deepEqual(WIZARD_STEPS.map((s) => s.label), ['Identity', 'Stack', 'Workspace', 'Create']);
  for (const step of WIZARD_STEPS) {
    assert.ok(step.key && step.title && step.sub, `${step.label} carries key, title and subtitle`);
  }
});

test('stepState: current wins, reached steps stay done after stepping back', () => {
  assert.equal(stepState(1, 1, 1), 'current');
  assert.equal(stepState(0, 1, 1), 'done');
  assert.equal(stepState(2, 1, 1), 'todo');
  // Reached Create, went back to Identity: Stack/Workspace/Create are done
  // (jumpable), not todo — that is what preserves the user's work.
  assert.deepEqual([0, 1, 2, 3].map((i) => stepState(i, 0, 3)), ['current', 'done', 'done', 'done']);
});

test('canAdvance: Identity needs name and location', () => {
  assert.equal(canAdvance({ ...base }, 0), false);
  assert.equal(canAdvance({ ...base, name: 'x' }, 0), false);
  assert.equal(canAdvance({ ...base, name: '  ', folder: '/p' }, 0), false);
  assert.equal(canAdvance({ ...base, name: 'app', folder: '/p' }, 0), true);
});

test('canAdvance: Stack — Blank alone completes, others need the cascade', () => {
  assert.equal(canAdvance({ ...base, wrapper: 'blank' }, 1), true);
  assert.equal(canAdvance({ ...base, wrapper: 'web' }, 1), false);
  assert.equal(canAdvance({ ...base, wrapper: 'web', framework: 'react' }, 1), false);
  assert.equal(canAdvance({ ...base, wrapper: 'web', framework: 'react', lang: 'ts' }, 1), true);
  // Python: archetype + auto-locked language, no interpreter gate (ADR-020).
  assert.equal(canAdvance({ ...base, wrapper: 'python', framework: 'py-lib', lang: 'py' }, 1), true);
});

test('canAdvance: Workspace always may; Create has no Next', () => {
  assert.equal(canAdvance({ ...base }, 2), true);
  assert.equal(canAdvance({ ...base }, 3), false);
});

test('isWizardDirty ignores seeded values and notices typed or chosen ones', () => {
  assert.equal(isWizardDirty({ ...base, folder: '/seeded/from/prefs' }, 0), false);
  assert.equal(isWizardDirty({ ...base, name: 'a' }, 0), true);
  assert.equal(isWizardDirty({ ...base, wrapper: 'web' }, 0), true);
  assert.equal(isWizardDirty({ ...base }, 1), true);
});

test('rovingTarget wraps at both ends and refuses degenerate groups', () => {
  assert.equal(rovingTarget(0, 5, ROVING_KEYS.ArrowRight), 1);
  assert.equal(rovingTarget(4, 5, ROVING_KEYS.ArrowDown), 0);
  assert.equal(rovingTarget(0, 5, ROVING_KEYS.ArrowLeft), 4);
  assert.equal(rovingTarget(2, 5, ROVING_KEYS.ArrowUp), 1);
  assert.equal(rovingTarget(-1, 5, 1), null, 'focus outside the group');
  assert.equal(rovingTarget(0, 1, 1), null, 'single option');
  assert.equal(rovingTarget(0, 5, 0), null, 'not an arrow');
});

// ---- JSX contract (text) ----
const here = dirname(fileURLToPath(import.meta.url));
const jsx = readFileSync(join(here, '../../src/components/NewProjectWizard.jsx'), 'utf8');

test('every selectable card is a real button, never a clickable div', () => {
  assert.doesNotMatch(jsx, /<div\s+key=\{\w+\.id\}\s+className=\{`npw-(card|theme-card|mode-card)/, 'a <div> card cannot be tabbed to or activated from the keyboard');
  const radios = (jsx.match(/role="radio"/g) ?? []).length;
  assert.ok(radios >= 7, `expected the single-select card kinds to be radios, found ${radios}`);
  assert.ok(/role="radiogroup"/.test(jsx), 'single-select rows are radiogroups');
  assert.ok(/aria-pressed=\{isSelected\}/.test(jsx), 'add-ons (multi-select) use aria-pressed');
});

test('the stepper is labelled and announces the current step', () => {
  assert.ok(/WIZARD_STEPS\.map\(/.test(jsx), 'the stepper renders from WIZARD_STEPS');
  assert.ok(/aria-current=\{status === 'current' \? 'step' : undefined\}/.test(jsx), 'the current step carries aria-current="step"');
  assert.doesNotMatch(jsx, /className="npw-dots"/, 'the unlabelled dots are gone');
});

test('the keyboard model is wired on the modal and advertised on the buttons', () => {
  assert.ok(/onKeyDown=\{handleKeyDown\}/.test(jsx), 'the modal owns the key handler');
  for (const key of ["'Escape'", "'Enter'", 'ROVING_KEYS[e.key]', 'e.altKey']) {
    assert.ok(jsx.includes(key), `handles ${key}`);
  }
  assert.ok(/aria-keyshortcuts="Escape"/.test(jsx) && /aria-keyshortcuts="Enter"/.test(jsx), 'shortcuts are declared for assistive tech');
  assert.ok((jsx.match(/className="npw-key"/g) ?? []).length >= 3, 'visible key chips on Cancel, Next and Create');
});
