import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Posture test (audit #10 / ADR-023): the shipped app must carry a
// Content-Security-Policy. Tauri disables CSP entirely when `csp` is null, which
// removes the primary XSS containment layer — this test fails if it regresses.
const here = dirname(fileURLToPath(import.meta.url));
const conf = JSON.parse(readFileSync(join(here, '../../src-tauri/tauri.conf.json'), 'utf8'));
const csp = conf.app?.security?.csp;
const scriptSrc = csp && typeof csp === 'object' ? String(csp['script-src'] ?? '') : String(csp ?? '');
const policy = typeof csp === 'string' ? csp : JSON.stringify(csp);

test('a production Content-Security-Policy is configured (csp is not null)', () => {
  assert.ok(csp !== null && csp !== undefined, 'app.security.csp must not be null — CSP is the XSS containment layer');
});

test('the CSP locks down the dangerous sinks', () => {
  assert.ok(/default-src/.test(policy), 'default-src must be present');
  assert.ok(/"object-src":\s*"[^"]*'none'/.test(policy) || /object-src[^;]*'none'/.test(policy), "object-src 'none'");
});

test("script-src does not permit 'unsafe-inline' or 'unsafe-eval'", () => {
  // Tauri auto-injects nonces/hashes for the app's own bundled scripts, so the
  // production script-src stays strict. (The permissive devCsp is dev-only.)
  assert.ok(!scriptSrc.includes("'unsafe-inline'"), "production script-src must not allow 'unsafe-inline'");
  assert.ok(!scriptSrc.includes("'unsafe-eval'"), "production script-src must not allow 'unsafe-eval'");
});
