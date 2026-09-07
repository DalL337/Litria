import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

// Windows 1.0.3 first-run report: opening Preferences "ran a script window
// and closed it" — several times. A release build of Litria is a GUI-
// subsystem process with no console, so every console child it spawns
// (cmd /C, where, node, go) gets a brand-new console window unless the
// spawn carries CREATE_NO_WINDOW. `tauri dev` hides this: the dev parent
// HAS a console, children inherit it, nothing flashes.
//
// Rule: in non-test Rust code, a `Command::new(` must set
// `creation_flags(` within a few lines, or go through
// `platform::hidden_command`, which sets it. The scan cuts each file at
// its `#[cfg(test)]` module — tests may spawn however they like.
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../src-tauri/src');

function rustFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) rustFiles(full, out);
    else if (entry.name.endsWith('.rs')) out.push(full);
  }
  return out;
}

const WINDOW = 14;

function bareSpawns() {
  const offenders = [];
  for (const file of rustFiles(root)) {
    const rel = relative(root, file).replace(/\\/g, '/');
    // platform.rs owns the helper; its one Command::new is the point.
    if (rel === 'platform.rs') continue;
    let src = readFileSync(file, 'utf8');
    const cut = src.indexOf('#[cfg(test)]');
    if (cut >= 0) src = src.slice(0, cut);
    const lines = src.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!/\bCommand::new\(/.test(line) || /^\s*\/\//.test(line)) return;
      const window = lines.slice(i, i + WINDOW).join('\n');
      if (!/creation_flags\(/.test(window)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
    });
  }
  return offenders;
}

test('every non-test process spawn in src-tauri hides its console window on Windows', () => {
  const offenders = bareSpawns();
  assert.deepEqual(
    offenders,
    [],
    `Command::new without creation_flags (use platform::hidden_command):\n  ${offenders.join('\n  ')}`
  );
});

test('platform::hidden_command exists and sets CREATE_NO_WINDOW', () => {
  const platform = readFileSync(join(root, 'platform.rs'), 'utf8');
  assert.match(platform, /pub fn hidden_command/);
  assert.match(platform, /CREATE_NO_WINDOW/);
  assert.match(platform, /creation_flags\(/);
});
