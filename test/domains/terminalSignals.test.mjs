import test from 'node:test';
import assert from 'node:assert/strict';

import { MAX_OSC_PAYLOAD, createTerminalSignalScanner } from '../../src/terminal/terminalSignals.js';

// The scanner reads a terminal program's signals out of a session's raw
// output (track T slice T2a-2). It must ring only where xterm.js would: a
// BEL that ends an OSC is a terminator. Claude Code ends every Program Status
// report and its query with BEL, and shells end every window title with BEL,
// so a scanner that counted bytes would flag every prompt and every agent.

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;

function record() {
  const events = [];
  const scanner = createTerminalSignalScanner({
    onBell: () => events.push('bell'),
    onStatus: (body) => events.push(`status:${body}`),
    onQuery: () => events.push('query'),
    onPrompt: () => events.push('prompt'),
    onReset: () => events.push('reset')
  });
  return { events, push: (chunk) => scanner.push(chunk) };
}

const scan = (...chunks) => {
  const r = record();
  for (const chunk of chunks) r.push(chunk);
  return r.events;
};

test('a bare BEL rings', () => {
  assert.deepEqual(scan(`build finished${BEL}`), ['bell']);
});

test('a BEL that ends a window title is not a bell', () => {
  // What PowerShell, bash and zsh prompts set on every prompt.
  assert.deepEqual(scan(`${ESC}]0;C:\\projects\\p1${BEL}PS> `), []);
  assert.deepEqual(scan(`${ESC}]2;title${ST}`), []);
});

test("Claude Code's startup probe is one query and no bell", () => {
  // The bytes Claude Code 2.1.303 sent at startup through the sideloaded
  // ConPTY (live capture, 2026-10-24): the query, then DA1.
  assert.deepEqual(scan(`${ESC}]7501;?${BEL}${ESC}[c${ESC}[2GLet's`), ['query']);
});

test('a status report ends with BEL or ST and keeps its body', () => {
  assert.deepEqual(scan(`${ESC}]7501;state=working:app=claude-code${BEL}`), ['status:state=working:app=claude-code']);
  assert.deepEqual(scan(`${ESC}]7501;state=idle${ST}`), ['status:state=idle']);
});

test('the 8-bit C1 introducers and ST are honoured', () => {
  assert.deepEqual(scan('\x9d7501;state=done\x9c'), ['status:state=done']);
  assert.deepEqual(scan(`\x9b1;2H${BEL}`), ['bell']);
});

test('any ESC ends an OSC, as in xterm', () => {
  assert.deepEqual(scan(`${ESC}]7501;state=blocked${ESC}[0m${BEL}`), ['status:state=blocked', 'bell']);
});

test('CAN and SUB abort an OSC without dispatching it', () => {
  assert.deepEqual(scan(`${ESC}]7501;state=blocked\x18${BEL}`), ['bell']);
  assert.deepEqual(scan(`${ESC}]7501;?\x1a${BEL}`), ['bell']);
});

test('a BEL inside DCS, SOS, PM or APC content is neither a bell nor a terminator', () => {
  assert.deepEqual(scan(`${ESC}Pq#0;2;0;0;0${BEL}#0!10~${ST}`), []);
  assert.deepEqual(scan(`${ESC}_Gf=100;${BEL}AAAA${ST}${BEL}`), ['bell']);
  assert.deepEqual(scan(`${ESC}X${BEL}${ST}`, `${ESC}^${BEL}${ST}`), []);
});

test('a BEL inside a CSI sequence still rings (C0 controls execute there)', () => {
  assert.deepEqual(scan(`${ESC}[1${BEL}m`), ['bell']);
});

test('RIS resets; an ESC c with an intermediate does not', () => {
  assert.deepEqual(scan(`${ESC}c`), ['reset']);
  assert.deepEqual(scan(`${ESC}(c`), []);
});

test('OSC 133;A marks a new prompt; other 133 marks do not', () => {
  assert.deepEqual(scan(`${ESC}]133;A${ST}`, `${ESC}]133;A;cl=m${BEL}`, `${ESC}]133;B${ST}`), ['prompt', 'prompt']);
});

test('other OSCs are tracked to their end but never kept', () => {
  const clipboard = `${ESC}]52;c;${'QUFB'.repeat(5000)}${BEL}`;
  assert.deepEqual(scan(clipboard, BEL), ['bell']);
  assert.deepEqual(scan(`${ESC}]75010;state=idle${BEL}`), []);
});

test('an over-long report is dropped and the scanner recovers', () => {
  const long = `${ESC}]7501;state=idle:msg=${'A'.repeat(MAX_OSC_PAYLOAD)}${BEL}`;
  assert.deepEqual(scan(long, `${ESC}]7501;state=done${BEL}`, BEL), ['status:state=done', 'bell']);
});

test('signals split across chunks at every position read the same as whole', () => {
  const stream = [
    `${ESC}]0;title${BEL}`,
    'text',
    BEL,
    `${ESC}]7501;?${BEL}`,
    `${ESC}[c`,
    `${ESC}]7501;state=blocked:kind=permission${ST}`,
    `${ESC}P1$r${BEL}${ST}`,
    `${ESC}]133;A${ST}`,
    `${ESC}c`,
    '\x9d7501;state=idle\x9c',
    BEL
  ].join('');
  const whole = scan(stream);
  assert.deepEqual(whole, [
    'bell', 'query', 'status:state=blocked:kind=permission', 'prompt', 'reset', 'status:state=idle', 'bell'
  ]);
  for (let at = 0; at <= stream.length; at++) {
    assert.deepEqual(scan(stream.slice(0, at), stream.slice(at)), whole, `split at ${at}`);
  }
  assert.deepEqual(scan(...stream), whole, 'one character at a time');
});
