import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { normalizeQuery, textMatches, entryMatches, filterRooms, highlight } from '../../src/preferences/search.js';
import { entriesByRoom } from '../../src/preferences/registry.js';

// Preferences panel v2, slice 4 (brief-preferences-panel-v2.md §2 "Search"
// + "Keyboard"): the exhaustive home is searchable, and the keyboard model
// is advertised on screen.

test('normalizeQuery trims and lowercases; empty and whitespace mean no query', () => {
  assert.equal(normalizeQuery('  Build '), 'build');
  assert.equal(normalizeQuery(''), '');
  assert.equal(normalizeQuery('   '), '');
  assert.equal(normalizeQuery(null), '');
});

test('textMatches is a case-insensitive substring test; empty query matches all', () => {
  assert.equal(textMatches('Keep the build trace on screen', 'BUILD'), true);
  assert.equal(textMatches('Keep the build trace on screen', 'wire'), false);
  assert.equal(textMatches('anything', ''), true);
  assert.equal(textMatches(undefined, 'x'), false);
});

test('entryMatches searches the label and the always-visible caption', () => {
  const entry = { label: 'Energy', caption: 'Live keeps the canvas vivid. Calm softens colors.' };
  assert.equal(entryMatches(entry, 'energy'), true);
  assert.equal(entryMatches(entry, 'calm'), true, 'caption text is searchable — captions are where the meaning is');
  assert.equal(entryMatches(entry, 'splash'), false);
});

test('filterRooms narrows entries but keeps every room with its total', () => {
  const rooms = entriesByRoom('preferences.global');
  const filtered = filterRooms(rooms, 'build');
  assert.deepEqual(filtered.map((r) => r.id), rooms.map((r) => r.id), 'no room is dropped');
  const creation = filtered.find((r) => r.id === 'projectCreation');
  assert.deepEqual(creation.entries.map((e) => e.key), ['buildTracePause', 'buildLogAutoSend']);
  assert.equal(creation.total, 4);
  const appearance = filtered.find((r) => r.id === 'appearance');
  assert.equal(appearance.entries.length, 0);
  assert.equal(appearance.total, 2);
  // Empty query: everything, totals equal counts.
  for (const room of filterRooms(rooms, '')) assert.equal(room.entries.length, room.total);
});

test('highlight splits text into hit / non-hit segments, preserving case', () => {
  assert.deepEqual(highlight('Keep the build trace', 'BUILD'), [
    { text: 'Keep the ', hit: false }, { text: 'build', hit: true }, { text: ' trace', hit: false }
  ]);
  assert.deepEqual(highlight('aXa', 'a'), [{ text: 'a', hit: true }, { text: 'X', hit: false }, { text: 'a', hit: true }]);
  assert.deepEqual(highlight('no match here', 'zzz'), [{ text: 'no match here', hit: false }]);
  assert.deepEqual(highlight('plain', ''), [{ text: 'plain', hit: false }]);
  assert.deepEqual(highlight('', 'x'), [{ text: '', hit: false }]);
  // Round-trips: the segments concatenate back to the original.
  const text = 'Save build logs automatically — build trace';
  assert.equal(highlight(text, 'build').map((s) => s.text).join(''), text);
});

// ---- Panel contract (text) ----
const here = dirname(fileURLToPath(import.meta.url));
const jsx = readFileSync(join(here, '../../src/components/PreferencesPanel.jsx'), 'utf8');
const css = readFileSync(join(here, '../../src/styles/preferences.css'), 'utf8');

test('the panel searches through the pure module and highlights matches', () => {
  assert.ok(/filterRooms\(entriesByRoom\(place\), query\)/.test(jsx), 'rooms are filtered by the query');
  assert.ok(/highlight\(text, query\)/.test(jsx), 'labels and captions render highlight segments');
  assert.ok(/className="pf-mark"/.test(jsx), 'hits render as <mark>');
  assert.ok(/no matches/.test(jsx), 'an emptied room says so instead of vanishing');
  assert.ok(/aria-label="Find a setting"/.test(jsx), 'the search field is labelled');
});

test('the keyboard model is wired and advertised', () => {
  assert.ok(/e\.key === '\/'/.test(jsx), '/ focuses search');
  assert.ok(/e\.key\.toLowerCase\(\) === 'f'/.test(jsx) && /e\.ctrlKey \|\| e\.metaKey/.test(jsx), 'Ctrl/Cmd+F focuses search');
  assert.ok(/ROVING_KEYS\[e\.key\]/.test(jsx) && /rovingTarget\(/.test(jsx), 'arrows rove inside pill groups and tabs');
  assert.ok(/\[role="radiogroup"\], \[role="tablist"\]/.test(jsx), 'roving covers pill groups and the scope tabs');
  assert.ok(/className="pf-key pf-search-key"/.test(jsx), 'the / chip is visible on the search field');
  assert.ok(css.includes('.pf-search') && css.includes('.pf-mark'), 'search field and highlight are styled');
});
