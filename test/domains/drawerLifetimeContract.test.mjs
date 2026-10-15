import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Drawers express the person's focus and never own a resource's lifetime
// (docs/Orchestration.md §1.2, amended 2026-10-14, track T slice T2a). The
// terminal drawer used to start its shell when it became visible and end it
// when it stopped being visible, so hiding the drawer killed the person's
// work. A view may forward a person's gesture (a click on New or End) to the
// domain; it may never start or end a session from an effect, because effects
// run on mount, unmount and visibility changes, not on intent.
//
// This text contract finds every useEffect / useLayoutEffect callback in the
// drawers and in the terminal renderer, and fails if one calls a session's
// start or end.

const ROOT = new URL('../../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LIFETIME_CALLS = /\b(startSession|ensureSession|endSession|removeSession|endProject|teardownAll|spawnWithChannel|endForProject)\b/;

function viewFiles() {
  const drawers = join(ROOT, 'src', 'drawers');
  return [
    ...readdirSync(drawers).filter((f) => /\.jsx?$/.test(f)).map((f) => join(drawers, f)),
    join(ROOT, 'src', 'components', 'TerminalRenderer.jsx')
  ];
}

/** The argument list of every effect hook call, by bracket matching that
 * skips strings, template literals and comments. */
export function effectBodies(source) {
  const bodies = [];
  const hook = /\buse(?:Layout)?Effect\s*\(/g;
  let match;
  while ((match = hook.exec(source))) {
    let depth = 0;
    let i = match.index + match[0].length - 1;
    const start = i;
    for (; i < source.length; i++) {
      const ch = source[i];
      const next = source[i + 1];
      if (ch === '/' && next === '/') { i = source.indexOf('\n', i); if (i < 0) break; continue; }
      if (ch === '/' && next === '*') { i = source.indexOf('*/', i + 2) + 1; if (i <= 0) break; continue; }
      if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        for (i += 1; i < source.length && source[i] !== quote; i++) {
          if (source[i] === '\\') i += 1;
        }
        continue;
      }
      if (ch === '(') depth += 1;
      if (ch === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    bodies.push(source.slice(start, i + 1));
  }
  return bodies;
}

test('the scanner finds a planted lifetime call inside an effect', () => {
  const planted = `
    useEffect(() => {
      if (isVisible) terminalDomain.commands.startSession(); // ")" in a comment
      const s = ')';
    }, [isVisible]);
    const onClick = () => terminalDomain.commands.endSession(key);
  `;
  const bodies = effectBodies(planted);
  assert.equal(bodies.length, 1);
  assert.match(bodies[0], LIFETIME_CALLS);
  assert.doesNotMatch(bodies[0], /endSession/, 'a click handler outside the effect is not part of it');
});

test('no drawer or terminal renderer effect starts or ends a session', () => {
  const files = viewFiles();
  assert.ok(files.some((f) => f.endsWith('DrawerContentTerminal.jsx')), 'the terminal drawer is scanned');
  for (const file of files) {
    for (const body of effectBodies(readFileSync(file, 'utf8'))) {
      assert.doesNotMatch(body, LIFETIME_CALLS, `${file}: an effect decides a session's lifetime`);
    }
  }
});
