import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  RUN_STATES,
  canNavigate,
  cancelMode,
  firstInvalidPage,
  resolveJump,
  canSubmit,
  submitLabel,
} from '../../src/scaffold/wizardNavigation.js';
import { createBuildLogDomain } from '../../src/app/buildLogDomain.js';

// ADR-028 §6: one run state; every permission is a pure function of it.

const complete = { name: 'app', folder: 'C:\\p', wrapper: 'web', framework: 'react', lang: 'ts' };

test('navigation is allowed only while nothing runs and nothing has been created (F18, F20)', () => {
  assert.deepEqual(RUN_STATES, ['idle', 'running', 'held', 'opening', 'failed']);
  assert.equal(canNavigate('idle'), true);
  assert.equal(canNavigate('failed'), true, 'a failed scaffold created nothing');
  assert.equal(canNavigate('failed', true), false, 'a failed OPEN leaves the project on disk');
  assert.equal(canNavigate('running'), false, 'Alt+Left / stepper / Back during a run');
  assert.equal(canNavigate('held'), false, 'review rows cannot drift from the created project');
  assert.equal(canNavigate('opening'), false);
});

test('cancel mode follows the run state and whether a project exists on disk (F18)', () => {
  assert.equal(cancelMode('idle', false), 'discard');
  assert.equal(cancelMode('failed', false), 'discard', 'a failed scaffold created nothing');
  assert.equal(cancelMode('held', true), 'close', 'never "discard" for a created project');
  assert.equal(cancelMode('failed', true), 'close', 'a failed OPEN still has the project on disk');
  assert.equal(cancelMode('running', false), 'abort');
  assert.equal(cancelMode('opening', true), null);
});

test('reached steps are re-validated: a jump never lands past an invalid earlier page (F19)', () => {
  assert.equal(firstInvalidPage(complete), null);
  assert.equal(firstInvalidPage({ ...complete, name: '' }), 0);
  assert.equal(firstInvalidPage({ ...complete, framework: null, lang: null }), 1);
  assert.equal(firstInvalidPage({ ...complete, wrapper: 'blank', framework: null, lang: null }), null);
  // Reached Create, went back and changed the runtime: framework/lang reset.
  assert.equal(resolveJump({ ...complete, framework: null, lang: null }, 3), 1);
  assert.equal(resolveJump({ ...complete, name: '' }, 2), 0);
  assert.equal(resolveJump(complete, 3), 3);
  assert.equal(resolveJump(complete, 1), 1);
});

test('submit needs an idle/failed state, complete pages, and a selectable plan', () => {
  assert.equal(canSubmit(complete, 'idle', true), true);
  assert.equal(canSubmit(complete, 'failed', true), true);
  assert.equal(canSubmit(complete, 'failed', true, true), false, 'never re-scaffold a created project');
  assert.equal(canSubmit(complete, 'running', true), false);
  assert.equal(canSubmit(complete, 'held', true), false);
  assert.equal(canSubmit(complete, 'opening', true), false);
  assert.equal(canSubmit({ ...complete, name: '' }, 'idle', true), false, 'cleared name after reaching Create');
  assert.equal(canSubmit({ ...complete, framework: null, lang: null }, 'idle', true), false, 'runtime changed after reaching Create');
  assert.equal(canSubmit(complete, 'idle', false), false, 'unverified combination');
});

test('the Create caption names the phase', () => {
  assert.equal(submitLabel('idle'), 'Create Project');
  assert.equal(submitLabel('running', { isBlank: true }), 'Creating...');
  assert.equal(submitLabel('running', { isPython: true }), 'Creating...');
  assert.equal(submitLabel('running'), 'Scaffolding...');
  assert.equal(submitLabel('opening'), 'Opening...');
  assert.equal(submitLabel('held'), 'Created');
});

// ---- build log: issues survive trace truncation (F24) ----

test('hasIssues is a counter, not a scan of the capped trace (F24)', () => {
  const domain = createBuildLogDomain();
  domain.commands.startRun({ projectName: 'x' });
  domain.commands.appendEvent({ kind: 'warning', line: 'age gate fail-open' });
  for (let i = 0; i < 5200; i += 1) domain.commands.appendEvent({ kind: 'stepOutput', line: `l${i}` });
  assert.equal(domain.selectors.isTruncated(), true);
  assert.ok(!domain.selectors.getTrace().some((r) => r.kind === 'warning'), 'the warning record itself was dropped');
  assert.equal(domain.selectors.hasIssues(), true, 'pause-on-warnings must still fire');
  assert.equal(domain.selectors.getIssueCount(), 1);
  assert.equal(domain.selectors.getFailedStepCount(), 0);
  domain.commands.appendEvent({ kind: 'stepFailed', label: 'x', step: 2, error: 'boom' });
  assert.equal(domain.selectors.getIssueCount(), 2);
  assert.equal(domain.selectors.getFailedStepCount(), 1);
  domain.commands.failRun('thrown');
  assert.equal(domain.selectors.getFailedStepCount(), 2);
  domain.commands.startRun({ projectName: 'y' });
  assert.equal(domain.selectors.hasIssues(), false, 'a new run starts clean');
  domain.commands.clearRun();
  assert.equal(domain.selectors.getIssueCount(), 0);
});

// ---- JSX contract (text): the guards are wired where the brief says ----
const here = dirname(fileURLToPath(import.meta.url));
const jsx = readFileSync(join(here, '../../src/components/NewProjectWizard.jsx'), 'utf8');

test('the wizard derives every guard from runState and keeps the created payload (ADR-028 §6)', () => {
  assert.ok(/const \[runState, setRunState\] = useState\('idle'\)/.test(jsx), 'one run state');
  assert.ok(/const \[createdPayload, setCreatedPayload\]/.test(jsx), 'payload retained until the open resolves (F17)');
  assert.ok(!/isScaffolding|pendingDone/.test(jsx), 'the old flag triple is gone');
  assert.ok(/canNavigate\(runState, createdPayload !== null\)/.test(jsx), 'navigation guard from the selector');
  assert.ok(/cancelMode\(runState, createdPayload !== null\)/.test(jsx), 'cancel mode from the selector');
  assert.ok(/canSubmit\(state, runState, plan\.availability\.selectable, createdPayload !== null\)/.test(jsx), 'submit gate from the selector');
  assert.ok(/Open workspace again/.test(jsx), 'a failed open offers to open again, not to re-scaffold');
  assert.ok(/Close without opening/.test(jsx), 'a created project is closed, never "discarded"');
  assert.ok(/await finishRun\(\{\s*\.\.\.buildDonePayloadBase\(result\.projectPath\),\s*\/\/ Blueprint files/.test(jsx), 'Python ends in the shared finish (F16)');
  assert.ok(/captureError\('wizard', err, \{ source: 'python-probe' \}\)/.test(jsx) && /captureError\('wizard', err, \{ source: 'folder-picker' \}\)/.test(jsx), 'no silent catches (F23)');
  assert.ok(/if \(e\.key === 'Tab'\)/.test(jsx) && /querySelectorAll\(FOCUSABLE\)/.test(jsx), 'focus trap (F26)');
  assert.ok(/if \(state\.wrapper === action\.value\) return state;/.test(jsx), 'same-value reducer guard (F21)');
  // ADR-028 §9 (F31): only interpreters creation will accept are offered.
  assert.ok(/const interpreters = eligibleInterpreters\(found\);/.test(jsx), 'the select lists eligible entries only');
  // ADR-028 §8 (F30): Cancel during a run reaches the runner by runId; the
  // button is enabled while running and both creation paths carry the id.
  assert.ok(/invoke\('cancel_scaffold', \{ runId: runIdRef\.current \}\)/.test(jsx), 'Cancel invokes cancel_scaffold with the run id');
  assert.equal((jsx.match(/runId: runIdRef\.current/g) || []).length, 3, 'npm and python configs carry runId (plus the cancel call)');
  assert.ok(/disabled=\{cancelKind === null \|\| cancelling\}/.test(jsx), 'Cancel is enabled while running (abort mode)');
  assert.ok(!/cancelKind === 'abort' \|\| cancelKind === null\) return;/.test(jsx), 'no path still treats abort as disabled');
  assert.ok(/ineligible: found\.filter\(\(i\) => i\?\.eligible === false\)/.test(jsx), 'ineligible entries are kept to explain the empty state');
  // The existing-environment input lives in the env strip, not the Advanced fold.
  const envInput = jsx.indexOf('aria-label="Existing environment path"');
  const caption = jsx.indexOf('<div className="npw-env-caption">{PY_ENV_CAPTION}</div>');
  const fold = jsx.indexOf('<div className="npw-section-label">Environment engine</div>');
  assert.ok(envInput > 0 && envInput < caption && envInput < fold, 'existing-env input precedes the caption and the fold (F25)');
});
