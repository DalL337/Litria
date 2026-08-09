import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NPM_SCRIPTS_FLAGS,
  NPM_SCRIPTS_PENDING_KEY,
  buildNpmScriptsOffer,
  buildNpmScriptsOfferMessage,
  decideNpmScriptsFirstOpen
} from '../../src/scaffold/npmScriptsFirstOpenModel.js';

test('no offer without the pending marker', () => {
  assert.equal(decideNpmScriptsFirstOpen({ scriptsPending: false }), null);
  assert.equal(decideNpmScriptsFirstOpen({ scriptsPending: undefined }), null);
});

test('pending marker raises the enable-scripts offer', () => {
  assert.equal(
    decideNpmScriptsFirstOpen({ scriptsPending: true }),
    'enable-scripts'
  );
});

test('actioned flag suppresses the offer forever', () => {
  assert.equal(
    decideNpmScriptsFirstOpen({
      scriptsPending: true,
      flags: { 'enable-scripts': true }
    }),
    null
  );
});

test('dismissed-but-unactioned returns next open (flags absent = offer)', () => {
  assert.equal(
    decideNpmScriptsFirstOpen({ scriptsPending: true, flags: {} }),
    'enable-scripts'
  );
});

test('offer names npm rebuild as both command and display', () => {
  const offer = buildNpmScriptsOffer();
  assert.equal(offer.command, 'npm rebuild');
  assert.equal(offer.display, 'npm rebuild');
});

test('pill copy names the exact command and the reason', () => {
  const message = buildNpmScriptsOfferMessage('npm rebuild');
  assert.match(message, /npm rebuild/);
  assert.match(message, /supply-chain/);
  assert.match(message, /terminal/);
});

test('editor_state keys are stable contracts', () => {
  // Persisted keys — renaming them orphans existing projects' markers.
  assert.equal(NPM_SCRIPTS_PENDING_KEY, 'npm.scriptsPending');
  assert.equal(NPM_SCRIPTS_FLAGS['enable-scripts'], 'hint.npm.scriptsOffered');
});
