import test from 'node:test';
import assert from 'node:assert/strict';

import { generateScaffoldSecret } from '../../src/scaffold/secretGenerator.js';

test('generateScaffoldSecret returns 64-char hex by default', () => {
  const secret = generateScaffoldSecret();
  assert.equal(secret.length, 64);
  assert.match(secret, /^[a-f0-9]{64}$/);
});

test('generateScaffoldSecret returns unique values across calls', () => {
  const one = generateScaffoldSecret();
  const two = generateScaffoldSecret();
  assert.notEqual(one, two);
});
