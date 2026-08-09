import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSplashEnabled } from '../../src/app/useSplashVisibility.js';

// ---------------------------------------------------------------------------
// resolveSplashEnabled (ADR-024): the pure decision the splash mount gates on.
// The splash is the shipped default — anything short of a stored boolean
// (missing key, load failure, corrupt value) resolves to the registry default.
// ---------------------------------------------------------------------------

test('stored boolean wins in both directions', () => {
  assert.equal(resolveSplashEnabled({ splashScreen: false }), false);
  assert.equal(resolveSplashEnabled({ splashScreen: true }), true);
});

test('missing key or failed load falls back to the registry default (on)', () => {
  assert.equal(resolveSplashEnabled({}), true);
  assert.equal(resolveSplashEnabled(null), true);
  assert.equal(resolveSplashEnabled(undefined), true);
});

test('non-boolean stored values are ignored, not truthy-coerced', () => {
  assert.equal(resolveSplashEnabled({ splashScreen: 'false' }), true);
  assert.equal(resolveSplashEnabled({ splashScreen: 0 }), true);
  assert.equal(resolveSplashEnabled({ splashScreen: null }), true);
});
