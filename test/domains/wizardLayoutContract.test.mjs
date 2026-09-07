import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Layout contract for the New Project wizard (brief-wizard-robustness.md,
// slice 1). Origin: macOS canary feedback, 2026-09-07 — the modal had no
// max-height, the centred overlay clipped the header AND the footer once the
// Stack page outgrew the window, and the Create button became unreachable.
// The suite has no DOM, so this holds the stylesheet and the JSX to the
// contract by text: the shapes below are exactly what regressed.
const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(here, '../../src/styles/new-project-wizard.css'), 'utf8');
const jsx = readFileSync(join(here, '../../src/components/NewProjectWizard.jsx'), 'utf8');

// First declaration block for a bare selector (`.npw-body {` — not
// `.npw-body-x {` and not a compound like `.npw-subsection.visible {`).
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `expected a rule for ${selector}`);
  return match[1];
}

test('the modal is bounded so it can never outgrow the window', () => {
  const modal = ruleBody('.npw-modal');
  assert.match(modal, /max-height:\s*100%/, '.npw-modal must cap its height at the overlay content box');
  const overlay = ruleBody('.npw-overlay');
  assert.match(overlay, /padding:/, '.npw-overlay pads the modal away from the window edges');
});

test('the body is the only scrolling region and can shrink inside the bounded modal', () => {
  const body = ruleBody('.npw-body');
  assert.match(body, /overflow-y:\s*auto/, '.npw-body scrolls');
  assert.match(body, /min-height:\s*0/, '.npw-body needs min-height 0 to shrink as a flex child');
  assert.doesNotMatch(body, /min-height:\s*\d+px/, 'a px min-height on .npw-body pushes the footer out of short windows');
  for (const pinned of ['.npw-header', '.npw-footer']) {
    assert.match(ruleBody(pinned), /flex:\s*0 0 auto/, `${pinned} stays pinned (does not flex or scroll)`);
  }
});

test('cascade subsections never use a px max-height cap', () => {
  // A fixed cap silently clips anything taller than it (a wrapped card row,
  // the no-Python guidance). Every .npw-subsection rule, compound or not.
  const subsectionRules = [...css.matchAll(/\.npw-subsection[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
  assert.ok(subsectionRules.length > 0, 'expected .npw-subsection rules');
  for (const body of subsectionRules) {
    assert.doesNotMatch(body, /max-height:\s*\d+px/, 'no px max-height cap on cascade subsections');
  }
  assert.match(ruleBody('.npw-subsection'), /grid-template-rows:\s*0fr/, 'collapse animates through grid rows');
  assert.match(ruleBody('.npw-subsection.visible'), /grid-template-rows:\s*1fr/, 'expand animates through grid rows');
});

test('every cascade subsection wraps its content in the single measured child', () => {
  // grid-template-rows: 0fr measures exactly one child; a second direct
  // child would render at its natural height outside the animated row.
  const openings = (jsx.match(/className=\{`npw-subsection[ $]/g) ?? []).length;
  const inners = (jsx.match(/className="npw-subsection-inner"/g) ?? []).length;
  assert.ok(openings >= 5, `expected the five cascade subsections, found ${openings}`);
  assert.equal(inners, openings, 'each .npw-subsection needs exactly one .npw-subsection-inner');
});

test('short windows get the compact header treatment', () => {
  assert.match(css, /@media\s*\(max-height:\s*\d+px\)/, 'a max-height media query tightens the chrome on short windows');
});
