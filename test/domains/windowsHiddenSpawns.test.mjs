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
// `platform::hidden_command`, which sets it. Tests may spawn however they
// like: `#[cfg(test)]` items and test-only module files are skipped.
//
// 2026-10-11: the scan used to cut each file at its FIRST `#[cfg(test)]` and
// match only the literal `Command::new(`. Both let
// `use std::process::Command as WhereCmd; WhereCmd::new("where")` in
// lsp/transport.rs — production code below the test module — flash a console
// on every JS/TS language-server start since 1.0.0. The scan now removes only
// the test items themselves and follows `Command as Alias` imports.
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

// Index just past the literal or comment starting at `i`, or -1 if none
// starts there. Braces inside them must not count.
function skipLiteral(src, i) {
  const c = src[i];
  if (c === '/' && src[i + 1] === '/') {
    const end = src.indexOf('\n', i);
    return end < 0 ? src.length : end;
  }
  if (c === '/' && src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  const raw = /^r(#*)"/.exec(src.slice(i, i + 12));
  if (raw && !/\w/.test(src[i - 1] ?? '')) {
    const close = `"${raw[1]}`;
    const end = src.indexOf(close, i + raw[0].length);
    return end < 0 ? src.length : end + close.length;
  }
  if (c === '"') {
    let j = i + 1;
    while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
    return j + 1;
  }
  // Char literals ('{', '\n', '\''); a lifetime ('a) has no closing quote.
  if (c === "'") {
    if (src[i + 1] === '\\') {
      const end = src.indexOf("'", i + 3);
      return end < 0 ? -1 : end + 1;
    }
    if (src[i + 2] === "'") return i + 3;
  }
  return -1;
}

// Blank every `#[cfg(test)]` item (a braced block, or a `;`-terminated one
// such as `mod tests;`), keeping newlines so line numbers stay true.
export function blankTestItems(src) {
  // Only a real attribute — at the start of a line — counts: a comment that
  // mentions #[cfg(test)] must not blank the production code after it.
  const attr = /^[ \t]*#\[cfg\(test\)\]/gm;
  let out = src;
  let from = 0;
  for (;;) {
    attr.lastIndex = from;
    const found = attr.exec(out);
    if (!found) return out;
    const at = found.index;
    let i = at + found[0].length;
    let end = out.length;
    let depth = 0;
    while (i < out.length) {
      const skipped = skipLiteral(out, i);
      if (skipped >= 0) { i = skipped; continue; }
      const ch = out[i];
      if (ch === ';' && depth === 0) { end = i + 1; break; }
      if (ch === '{') depth++;
      if (ch === '}' && --depth === 0) { end = i + 1; break; }
      i++;
    }
    out = out.slice(0, at) + out.slice(at, end).replace(/[^\n]/g, ' ') + out.slice(end);
    from = end;
  }
}

// Files compiled only for tests: the target of `#[cfg(test)] mod name;`.
function testOnlyFiles(files) {
  const set = new Set();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const base = /[\\/](mod|lib|main)\.rs$/.test(file) ? dirname(file) : file.replace(/\.rs$/, '');
    for (const m of src.matchAll(/#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/g)) {
      set.add(join(base, `${m[1]}.rs`));
      set.add(join(base, m[1], 'mod.rs'));
    }
  }
  return set;
}

// Spawns in `src` (already free of test items) that never set creation_flags.
export function spawnOffenders(src, rel) {
  const names = new Set(['Command']);
  for (const m of src.matchAll(/\bCommand\s+as\s+(\w+)/g)) names.add(m[1]);
  const spawn = new RegExp(`\\b(?:${[...names].join('|')})::new\\(`);
  const lines = src.split(/\r?\n/);
  const offenders = [];
  lines.forEach((line, i) => {
    if (!spawn.test(line) || /^\s*\/\//.test(line)) return;
    const window = lines.slice(i, i + WINDOW).join('\n');
    if (!/creation_flags\(/.test(window)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
  });
  return offenders;
}

function bareSpawns() {
  const files = rustFiles(root);
  const testOnly = testOnlyFiles(files);
  const offenders = [];
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/');
    // platform.rs owns the helper; its one Command::new is the point.
    if (rel === 'platform.rs' || testOnly.has(file)) continue;
    offenders.push(...spawnOffenders(blankTestItems(readFileSync(file, 'utf8')), rel));
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

const scan = (src) => spawnOffenders(blankTestItems(src), 'fixture.rs');

test('guard sees production code that follows a test module (2026-10-11 hole)', () => {
  const src = [
    'fn before() {}',
    '#[cfg(test)]',
    'mod tests {',
    '    fn t() { let s = "}"; let c = \'{\'; std::process::Command::new("ok-in-tests"); }',
    '}',
    'fn after() {',
    '    let out = Command::new("where").output();',
    '}',
  ].join('\n');
  assert.deepEqual(scan(src), ['fixture.rs:7  let out = Command::new("where").output();']);
});

test('guard follows `Command as Alias` imports (2026-10-11 hole)', () => {
  const src = [
    'fn resolve() {',
    '    use std::process::Command as WhereCmd;',
    '    let out = WhereCmd::new("where").arg("x.cmd").output();',
    '}',
  ].join('\n');
  assert.deepEqual(scan(src), ['fixture.rs:3  let out = WhereCmd::new("where").arg("x.cmd").output();']);
});

test('a comment mentioning #[cfg(test)] does not hide the code after it', () => {
  const src = [
    '// tests live under #[cfg(test)] below',
    'fn prod() { let c = Command::new("cmd"); }',
  ].join('\n');
  assert.deepEqual(scan(src), ['fixture.rs:2  fn prod() { let c = Command::new("cmd"); }']);
});

test('guard still skips test items and accepts creation_flags', () => {
  const src = [
    '#[cfg(test)]',
    'fn helper() { Command::new("fine"); }',
    'fn prod() {',
    '    let mut c = Command::new("node");',
    '    c.creation_flags(0x0800_0000);',
    '}',
  ].join('\n');
  assert.deepEqual(scan(src), []);
});
