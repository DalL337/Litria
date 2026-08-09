import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Posture test for the Tauri capability surface (audit #2). Litria's filesystem
// access goes through custom, path-guarded commands — NOT the fs plugin — so the
// capability set must stay minimal: no fs-plugin permission (an unscoped fs
// surface is exactly the finding), and nothing outside a reviewed allowlist.
const here = dirname(fileURLToPath(import.meta.url));
const caps = JSON.parse(
  readFileSync(join(here, '../../src-tauri/capabilities/default.json'), 'utf8')
);
const perms = caps.permissions.map((p) => (typeof p === 'string' ? p : p.identifier));

test('no filesystem-plugin permission is granted', () => {
  const fsPerms = perms.filter((p) => p.startsWith('fs:'));
  assert.deepEqual(fsPerms, [], 'fs plugin must not be granted — path_guard is the boundary');
});

test('capability permissions stay within the reviewed minimal allowlist', () => {
  // Adding a new plugin capability (e.g. re-granting opener, or shell/http)
  // fails here until it is deliberately reviewed and added to this allowlist.
  const allowedPrefixes = ['core:', 'dialog:'];
  const unexpected = perms.filter((p) => !allowedPrefixes.some((pre) => p.startsWith(pre)));
  assert.deepEqual(unexpected, [], `unexpected capability permissions: ${unexpected.join(', ')}`);
});

test('the opener plugin is not exposed to the webview', () => {
  // The opener plugin is used server-side only (Rust OpenerExt, which bypasses
  // the capability); the webview must not be able to invoke it.
  assert.ok(!perms.some((p) => p.startsWith('opener:')), 'opener IPC must not be granted to the webview');
});
