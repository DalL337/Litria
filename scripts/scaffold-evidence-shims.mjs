// ---------------------------------------------------------------------------
// scaffold-evidence-shims.mjs — give child CLIs the same package manager as
// the evidence run (scripts/scaffold-recipe-evidence.mjs `--corepack <v>`).
//
// The outer manager runs as `node corepack.js <id>@<v> …`, but child CLIs
// (`ng new --package-manager`, shadcn) call the manager BY NAME. With nothing
// on PATH, pnpm + Angular failed with `'pnpm' is not recognized` (2026-09-17,
// and again 2026-10-03). A hand-made shim for pnpm only let `ng new`'s inner
// `yarn` fall through to corepack's default Yarn Classic: a false failing
// record, since a real run uses one manager throughout. The run therefore
// writes a shim for its own manager and puts it first on PATH.
//
// PATH alone does not reach every call. `yarn dlx` puts its own `yarn`
// wrapper first on the child's PATH, and that wrapper runs corepack's
// `yarn.js` with NO version, so corepack picks its default yarn for the new
// folder, Yarn Classic 1.22 (2026-10-04: `ng new`'s install wrote a v1
// lockfile). The run therefore also makes its manager corepack's DEFAULT,
// in a COREPACK_HOME of its own; the user's corepack is never touched.
// ---------------------------------------------------------------------------

import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SHIMMED = new Set(['pnpm', 'yarn']);

function checkManager(id, version) {
  if (!SHIMMED.has(id)) throw new Error(`a manager shim is for pnpm or yarn, not ${id}`);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`a manager shim needs an exact version, not ${version}`);
}

/** A copy of `env` with `name` set to `value`, replacing any differently cased key. */
function withEnvKey(env, name, value) {
  const next = {};
  for (const [key, existing] of Object.entries(env)) {
    if (key.toUpperCase() !== name.toUpperCase()) next[key] = existing;
  }
  next[name] = value;
  return next;
}

/**
 * Write a shim that runs `<nodePath> <corepackPath> <id>@<version> …args` as
 * `<id>.cmd` (Windows) or an executable `<id>` (POSIX) in `dir`. Returns its path.
 */
export function writeManagerShim({ dir, id, version, nodePath, corepackPath, platform = process.platform }) {
  checkManager(id, version);
  mkdirSync(dir, { recursive: true });
  if (platform === 'win32') {
    const file = join(dir, `${id}.cmd`);
    writeFileSync(file, `@"${nodePath}" "${corepackPath}" ${id}@${version} %*\r\n`);
    return file;
  }
  const file = join(dir, id);
  writeFileSync(file, `#!/bin/sh\nexec "${nodePath}" "${corepackPath}" ${id}@${version} "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

/**
 * A copy of `env` with `dir` first on PATH. It keeps the key the environment
 * already uses: on Windows a spread `process.env` has `Path`, and adding a
 * second `PATH` key makes the child's environment block ambiguous.
 */
export function withPathFirst(env, dir, platform = process.platform) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
  const separator = platform === 'win32' ? ';' : ':';
  return { ...env, [key]: env[key] ? `${dir}${separator}${env[key]}` : dir };
}

/**
 * What makes `<id>@<version>` corepack's default for this run: `env` with
 * COREPACK_HOME pointed at `home`, and the argv (after node) that activates
 * the version there (`corepack install -g <id>@<version>`). Version-less
 * calls, such as the wrapper `yarn dlx` puts on the child's PATH, then
 * resolve to the run's manager instead of corepack's own default.
 */
export function corepackDefaultActivation({ home, id, version, corepackPath, env }) {
  checkManager(id, version);
  return {
    env: withEnvKey(env, 'COREPACK_HOME', home),
    argv: [corepackPath, 'install', '-g', `${id}@${version}`],
  };
}
