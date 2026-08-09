import test from 'node:test';
import assert from 'node:assert/strict';

import { parsePythonDefinitions, advanceTripleQuoteState } from '../../src/app/pythonSymbolParser.js';

const FILE = '/proj/oAuth.py';

test('parses top-level def, async def, class, and assignments with the Definition shape', () => {
  const text = [
    'import base64',
    '',
    'TOKEN_TTL_SECONDS = 3600',
    '',
    'def generate_state() -> str:',
    '    return "x"',
    '',
    'async def fetch_token(url):',
    '    ...',
    '',
    'class TokenStore:',
    '    def get(self):',
    '        ...',
  ].join('\n');

  const defs = parsePythonDefinitions(text, FILE);
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));

  assert.deepEqual(Object.keys(byName).sort(), ['TokenStore', 'TOKEN_TTL_SECONDS', 'fetch_token', 'generate_state'].sort());
  assert.equal(byName.generate_state.definitionKind, 'function');
  assert.equal(byName.fetch_token.definitionKind, 'function');
  assert.equal(byName.TokenStore.definitionKind, 'class');
  assert.equal(byName.TOKEN_TTL_SECONDS.definitionKind, 'variable');
  // Nested method `get` is NOT a module symbol.
  assert.equal(byName.get, undefined);
  // Definition shape parity with the JS parser.
  assert.equal(byName.TokenStore.symbolId, `${FILE}::TokenStore`);
  assert.equal(byName.TokenStore.language, 'python');
  assert.equal(byName.TokenStore.exportKind, 'named');
  assert.equal(byName.TokenStore.exported, true);
  assert.equal(byName.TOKEN_TTL_SECONDS.line, 3);
  assert.deepEqual(byName.TokenStore.meta, {});
});

test('underscore-prefixed names are non-public; annotated assignments parse', () => {
  const text = [
    '_cache: dict[str, str] = {}',
    'RATE_LIMIT: int = 10',
    'def _internal(): ...',
    'def public(): ...',
  ].join('\n');
  const defs = parsePythonDefinitions(text, FILE);
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  assert.equal(byName._cache.exported, false);
  assert.equal(byName._cache.exportKind, null);
  assert.equal(byName.RATE_LIMIT.exported, true);
  assert.equal(byName._internal.exported, false);
  assert.equal(byName.public.exported, true);
});

test('a literal __all__ defines the public set exactly and is itself excluded', () => {
  const text = [
    "__all__ = ['shout', '_secret']",
    'def shout(): ...',
    'def whisper(): ...',
    'def _secret(): ...',
  ].join('\n');
  const defs = parsePythonDefinitions(text, FILE);
  const byName = Object.fromEntries(defs.map((d) => [d.name, d]));
  assert.equal(byName.__all__, undefined);
  assert.equal(byName.shout.exported, true);
  assert.equal(byName.whisper.exported, false); // public-looking but not in __all__
  assert.equal(byName._secret.exported, true);  // __all__ overrides the underscore rule
});

test('module docstrings hide column-0 text; comments and comparisons are not definitions', () => {
  const text = [
    '"""Module docstring.',
    'def fake_in_docstring(): ...',
    'CONSTANT_IN_DOCSTRING = 1',
    '"""',
    '# def commented(): ...',
    'x == 1',
    'total += 2',
    'def real(): ...',
  ].join('\n');
  const defs = parsePythonDefinitions(text, FILE);
  assert.deepEqual(defs.map((d) => d.name), ['real']);
});

test('duplicate top-level names keep the first definition line', () => {
  const text = 'def dup(): ...\ndef dup(): ...\n';
  const defs = parsePythonDefinitions(text, FILE);
  assert.equal(defs.length, 1);
  assert.equal(defs[0].line, 1);
});

test('empty and null-ish input parse to no definitions', () => {
  assert.deepEqual(parsePythonDefinitions('', FILE), []);
  assert.deepEqual(parsePythonDefinitions(null, FILE), []);
});

test('advanceTripleQuoteState tracks open/close across delimiter kinds', () => {
  assert.equal(advanceTripleQuoteState('"""open', null), '"""');
  assert.equal(advanceTripleQuoteState('still inside', '"""'), '"""');
  assert.equal(advanceTripleQuoteState('closes"""', '"""'), null);
  assert.equal(advanceTripleQuoteState('"""one-liner"""', null), null);
  assert.equal(advanceTripleQuoteState("'''mixed", null), "'''");
  // A # comment cannot open a string.
  assert.equal(advanceTripleQuoteState('# """not real', null), null);
});
