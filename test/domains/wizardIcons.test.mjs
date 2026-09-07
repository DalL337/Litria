import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Slice 4 of brief-wizard-robustness.md: the New Project wizard renders
// Lucide glyphs through one icon map — no emoji, no brand marks (macOS
// canary feedback, item 1). Held by text: the suite has no DOM and the map
// module pulls in React + lucide-react.
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
const wizard = read('../../src/components/NewProjectWizard.jsx');
const pyModel = read('../../src/scaffold/pythonWizardModel.js');
const icons = read('../../src/components/wizardIcons.js');

// Keys declared in the map: `  name: Glyph,` or `  'kebab-name': Glyph,`.
const declaredKeys = new Set(
  [...icons.matchAll(/^\s+'?([a-z][a-z-]*)'?:\s*[A-Z]\w*,/gm)].map((m) => m[1])
);

test('the icon map declares a real vocabulary', () => {
  assert.ok(declaredKeys.size >= 20, `expected a full vocabulary, found ${declaredKeys.size}`);
  assert.match(icons, /from 'lucide-react'/, 'glyphs come from lucide-react (ISC, already a dependency)');
});

test('every card icon key in the wizard and the Python model resolves to a glyph', () => {
  for (const [file, text] of [['NewProjectWizard.jsx', wizard], ['pythonWizardModel.js', pyModel]]) {
    const used = [...text.matchAll(/icon:\s*'([^']*)'/g)].map((m) => m[1]);
    assert.ok(used.length > 0, `${file} declares card icons`);
    for (const key of used) {
      assert.ok(/^[a-z][a-z-]*$/.test(key), `${file}: icon '${key}' must be a key, not a glyph`);
      assert.ok(declaredKeys.has(key), `${file}: icon key '${key}' has no glyph in wizardIcons.js`);
    }
  }
});

test('no emoji or loose glyphs remain in the wizard UI', () => {
  // Escaped pictographs (\u{1F...}), variation selectors, the old symbol
  // set, and literal geometric/arrow glyphs the mode cards used.
  const banned = /\\u\{1F[0-9A-F]+\}|\\uFE0F|\\u26A1|\\u2726|\\u2713|[✦◈↳◆⌨]/u;
  for (const [file, text] of [['NewProjectWizard.jsx', wizard], ['pythonWizardModel.js', pyModel]]) {
    const hit = text.match(banned);
    assert.equal(hit, null, `${file} still carries an emoji/glyph: ${hit && JSON.stringify(hit[0])}`);
  }
  // Card tiles, mode tiles and the selected check render components.
  assert.ok((wizard.match(/<WizardIcon name=/g) ?? []).length >= 7, 'card and mode tiles render WizardIcon');
  assert.doesNotMatch(wizard, /npw-card-icon[^\n]*>\{\w+\.icon\}<\/span>/, 'no tile renders the icon key as text');
});

test('no brand logos: the map holds category glyphs only', () => {
  // Lucide 1.0 removed brand icons; a brand-mark import here would mean a
  // second icon source and a per-mark trademark review.
  assert.doesNotMatch(icons, /simple-icons|react-icons|@icons-pack/, 'only lucide-react');
});
