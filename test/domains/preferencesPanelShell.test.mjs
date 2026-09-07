import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Preferences panel v2, slice 2 (brief-preferences-panel-v2.md §2): the
// panel renders rooms from the registry in the wizard-v2 chrome. The suite
// has no DOM, so the layout contract and the render contract are held by
// text, the same way wizardLayoutContract does for the wizard.
const here = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(here, rel), 'utf8');
const jsx = read('../../src/components/PreferencesPanel.jsx');
const css = read('../../src/styles/preferences.css');
const launchCss = read('../../src/styles/launch.css');
const app = read('../../src/App.jsx');

function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|[\\s}])${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `expected a rule for ${selector}`);
  return match[1];
}

test('the panel renders rooms from the registry, never a hand-placed list', () => {
  assert.ok(/entriesByRoom\(place\)/.test(jsx), 'rows come from entriesByRoom');
  assert.doesNotMatch(jsx, /entriesForPlace\([^)]*\)\.map\(/, 'no surface maps a flat place query into rows');
  assert.ok(/renderRoom\(/.test(jsx), 'every room goes through one room renderer');
  // Themes and Language servers are panel-owned rooms rendered after the
  // registry rooms — through the same room component.
  assert.ok(/renderRoom\(THEMES_ROOM/.test(jsx) && /renderRoom\(SERVERS_ROOM/.test(jsx));
});

test('scope is a tab row with a disabled project pill in the launcher', () => {
  assert.ok(/role="tablist"/.test(jsx), 'scope pills are tabs');
  assert.ok(/disabled=\{!projectContext\}/.test(jsx), 'the launcher shows the project pill disabled, not hidden');
  assert.ok(/Open a project to set per-project overrides\./.test(jsx), 'and says why, always visible');
});

test('the rooms rail tracks the room in view and can jump', () => {
  assert.ok(/className="pf-rail"/.test(jsx));
  assert.ok(/aria-current=\{currentRoom === room\.id\}/.test(jsx), 'the rail marks the current room');
  assert.ok(/onScroll=\{handleBodyScroll\}/.test(jsx), 'scrolling updates the current room');
  assert.ok(/onClick=\{\(\) => jumpToRoom\(room\.id\)\}/.test(jsx), 'clicking jumps');
});

test('the layout contract matches the wizard: bounded modal, pinned header/footer, one scroller', () => {
  assert.match(ruleBody('.pf-modal'), /max-height:\s*100%/);
  assert.match(ruleBody('.pf-overlay'), /padding:/);
  const body = ruleBody('.pf-body');
  assert.match(body, /overflow-y:\s*auto/);
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /position:\s*relative/, 'sections measure offsetTop against the scroller');
  for (const pinned of ['.pf-header', '.pf-footer']) {
    assert.match(ruleBody(pinned), /flex:\s*0 0 auto/, `${pinned} stays pinned`);
  }
  assert.match(ruleBody('.pf-row'), /grid-template-columns:\s*minmax\(0, 1fr\) 240px/, 'a fixed control column');
  assert.match(css, /@media\s*\(max-height:\s*\d+px\)/, 'short windows tighten the chrome');
});

test('the footer says changes save as they go, and Escape is advertised', () => {
  assert.ok(/Changes save as you go/.test(jsx));
  assert.ok(/aria-keyshortcuts="Escape"/.test(jsx));
  assert.ok(/e\.key !== 'Escape'/.test(jsx) || /e\.key === 'Escape'/.test(jsx), 'Escape is handled');
});

test('the old prefs styles are retired and the new sheet is loaded', () => {
  assert.doesNotMatch(launchCss, /\.prefs-/, 'launch.css no longer carries the old panel styles');
  assert.doesNotMatch(jsx, /className="(prefs|launch)-/, 'the panel uses only pf- classes');
  assert.ok(/import '\.\/styles\/preferences\.css';/.test(app), 'App.jsx loads preferences.css');
  assert.doesNotMatch(css, /:has\(> :only-child\)/, 'no lone-child stretching (the Install button bug)');
});
