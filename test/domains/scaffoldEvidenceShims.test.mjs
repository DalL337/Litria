import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { writeManagerShim, withPathFirst, corepackDefaultActivation } from '../../scripts/scaffold-evidence-shims.mjs';

// `scripts/scaffold-recipe-evidence.mjs --corepack <v>` runs the outer manager
// as `node corepack.js <id>@<v> …`, but child CLIs (`ng new --package-manager`,
// shadcn) call the manager BY NAME. With nothing on PATH, pnpm + Angular
// "failed" with `'pnpm' is not recognized` (2026-09-17 first pass, and again
// in the 2026-10-03 1.1.0 refresh). A hand-made shim for pnpm only let
// `ng new`'s inner `yarn` fall through to corepack's default Yarn Classic: a
// false failing record, since a real run uses one manager throughout.

test('the shim runs corepack with the pinned manager, on both platforms', () => {
  const dir = mkdtempSync(join(tmpdir(), 'litria-shim-'));
  try {
    const win = writeManagerShim({ dir, id: 'pnpm', version: '12.4.2', nodePath: 'C:\\node\\node.exe', corepackPath: 'C:\\node\\corepack.js', platform: 'win32' });
    assert.equal(win, join(dir, 'pnpm.cmd'));
    assert.equal(readFileSync(win, 'utf8'), '@"C:\\node\\node.exe" "C:\\node\\corepack.js" pnpm@12.4.2 %*\r\n');
    const posix = writeManagerShim({ dir, id: 'yarn', version: '4.18.0', nodePath: '/usr/bin/node', corepackPath: '/usr/lib/corepack.js', platform: 'linux' });
    assert.equal(posix, join(dir, 'yarn'));
    assert.equal(readFileSync(posix, 'utf8'), '#!/bin/sh\nexec "/usr/bin/node" "/usr/lib/corepack.js" yarn@4.18.0 "$@"\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('only pnpm and yarn with an exact version get a shim', () => {
  const base = { dir: tmpdir(), nodePath: 'node', corepackPath: 'corepack.js', platform: 'linux' };
  assert.throws(() => writeManagerShim({ ...base, id: 'npm', version: '11.0.0' }), /pnpm or yarn/);
  assert.throws(() => writeManagerShim({ ...base, id: 'pnpm', version: 'latest' }), /exact version/);
  assert.throws(() => writeManagerShim({ ...base, id: 'pnpm', version: '12.4.2 & calc' }), /exact version/);
});

test('the shim directory goes first on PATH, under the key the environment already uses', () => {
  // On Windows, spreading process.env yields `Path`; adding a second `PATH`
  // key makes the child's environment block ambiguous.
  const win = withPathFirst({ Path: 'C:\\Windows', Other: '1' }, 'C:\\shims', 'win32');
  assert.deepEqual(win, { Path: 'C:\\shims;C:\\Windows', Other: '1' });
  assert.deepEqual(withPathFirst({ PATH: '/usr/bin' }, '/shims', 'linux'), { PATH: '/shims:/usr/bin' });
  assert.deepEqual(withPathFirst({}, '/shims', 'linux'), { PATH: '/shims' });
  const env = { PATH: '/usr/bin' };
  withPathFirst(env, '/shims', 'linux');
  assert.deepEqual(env, { PATH: '/usr/bin' }, 'the input is not mutated');
});

test('a child process calling the manager by name reaches corepack with the pinned version', () => {
  // A stand-in corepack.js that prints the arguments it was given, so the
  // check needs no network and no real pnpm.
  const dir = mkdtempSync(join(tmpdir(), 'litria-shim-'));
  try {
    const fakeCorepack = join(dir, 'fake-corepack.js');
    writeFileSync(fakeCorepack, 'console.log(JSON.stringify(process.argv.slice(2)));\n');
    const shims = join(dir, 'shims');
    writeManagerShim({ dir: shims, id: 'pnpm', version: '12.4.2', nodePath: process.execPath, corepackPath: fakeCorepack });
    const env = withPathFirst(process.env, shims);
    const child = process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'pnpm --version'], { env, encoding: 'utf8' })
      : spawnSync('/bin/sh', ['-c', 'pnpm --version'], { env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout.trim()), ['pnpm@12.4.2', '--version']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the run makes its manager corepack\'s default in a COREPACK_HOME of its own', () => {
  // `yarn dlx` puts a wrapper first on the child's PATH that runs corepack's
  // yarn.js with no version, so a PATH shim never sees `ng new`'s install;
  // corepack's own default answered it: Yarn Classic 1.22 (2026-10-04).
  const env = { Path: 'C:\Windows', corepack_home: 'C:\Users\alice\AppData\Local\node\corepack' };
  const activation = corepackDefaultActivation({
    home: 'C:\fixture\.corepack', id: 'yarn', version: '4.18.0', corepackPath: 'C:\node\corepack.js', env,
  });
  assert.deepEqual(activation.argv, ['C:\node\corepack.js', 'install', '-g', 'yarn@4.18.0']);
  // The user's own COREPACK_HOME, however it is cased, is replaced for the run only.
  assert.deepEqual(activation.env, { Path: 'C:\Windows', COREPACK_HOME: 'C:\fixture\.corepack' });
  assert.equal(env.corepack_home, 'C:\Users\alice\AppData\Local\node\corepack', 'the input is not mutated');
  assert.throws(() => corepackDefaultActivation({ home: 'h', id: 'npm', version: '11.0.0', corepackPath: 'c', env: {} }), /pnpm or yarn/);
  assert.throws(() => corepackDefaultActivation({ home: 'h', id: 'yarn', version: 'stable', corepackPath: 'c', env: {} }), /exact version/);
});
