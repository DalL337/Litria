import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_RECORDS,
  PROGRAM_STATUS_REPLY,
  createProgramStatusRecords,
  displayText,
  parseProgramStatus
} from '../../src/terminal/programStatus.js';

// The Program Status Protocol, terminal side, revision 0.4 (track T slice
// T2a-2). Everything in a report is untrusted input; these pin the rules the
// spec sets for ignoring, skipping and discarding it.

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');

test("Claude Code's report shape parses", () => {
  // Built the way Claude Code 2.1.303 builds it (Cvr in its bundle).
  const body = `state=blocked:app=claude-code:kind=permission:title=${b64('Fix the build')}:msg=${b64('Allow edit to src/app.js?')}`;
  assert.deepEqual(parseProgramStatus(body), {
    state: 'blocked',
    id: '',
    kind: 'permission',
    progress: null,
    app: 'claude-code',
    title: 'Fix the build',
    msg: 'Allow edit to src/app.js?'
  });
});

test('the feature reply lists every state and kind and ends with ST', () => {
  assert.equal(
    PROGRAM_STATUS_REPLY,
    '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'
  );
});

test('whitespace is stripped, malformed pairs skipped, unknown keys ignored, the last repeat wins', () => {
  const report = parseProgramStatus(' state = idle : nokey : =x : bad key=1 : app=a b : color=red : app=cargo : app=ca$h ');
  assert.equal(report.state, 'idle');
  assert.equal(report.app, 'cargo', 'a malformed repeat is skipped, not taken');
  assert.equal('color' in report, false);
});

test('a report with no state, or an unknown one, is ignored', () => {
  assert.equal(parseProgramStatus('app=cargo'), null);
  assert.equal(parseProgramStatus('state=sleeping'), null);
  assert.equal(parseProgramStatus(''), null);
});

test('an invalid id makes the report ignored, never the root record', () => {
  assert.equal(parseProgramStatus('state=idle:id=a/b').id, 'a/b');
  assert.equal(parseProgramStatus('state=idle:id=a//b'), null);
  assert.equal(parseProgramStatus(`state=idle:id=${'x'.repeat(33)}`), null);
  assert.equal(parseProgramStatus(`state=idle:id=${Array(9).fill('a').join('/')}`), null);
  assert.equal(parseProgramStatus(`state=idle:id=${Array(5).fill('y'.repeat(32)).join('/')}`), null, 'over 128 in all');
  assert.equal(parseProgramStatus('state=idle:id=a,b'), null, 'a comma is a value byte but not an id byte');
});

test('text that does not decode cleanly discards the whole report', () => {
  const skipped = parseProgramStatus('state=blocked:msg=***');
  assert.equal(skipped.state, 'blocked', 'a byte outside the value set skips that pair only');
  assert.equal(skipped.msg, null);
  assert.equal(parseProgramStatus('state=blocked:msg=A'), null, 'not base64 (length 1 mod 4)');
  assert.equal(parseProgramStatus(`state=blocked:msg=${Buffer.from([0xff, 0xfe]).toString('base64')}`), null, 'not UTF-8');
  assert.equal(parseProgramStatus(`state=blocked:msg=${b64('line one\nline two')}`), null, 'a control character');
  assert.equal(parseProgramStatus(`state=blocked:msg=${b64('\x1b[31mred')}`), null, 'an escape');
  assert.equal(parseProgramStatus(`state=blocked:msg=${b64('a\u0085b')}`), null, 'a C1 control');
});

test('padding is optional', () => {
  const padded = b64('ok?');
  assert.equal(parseProgramStatus(`state=blocked:msg=${b64('ok')}`).msg, 'ok');
  assert.equal(parseProgramStatus(`state=blocked:msg=${b64('ok').replace(/=+$/, '')}`).msg, 'ok');
  assert.equal(parseProgramStatus(`state=blocked:msg=${padded}`).msg, 'ok?');
});

test('a report over any limit is discarded whole', () => {
  assert.equal(parseProgramStatus(`state=idle:msg=${b64('m'.repeat(2048))}`).msg.length, 2048);
  assert.equal(parseProgramStatus(`state=idle:msg=${b64('m'.repeat(2049))}`), null);
  assert.equal(parseProgramStatus(`state=idle:title=${b64('t'.repeat(192))}`).title.length, 192);
  assert.equal(parseProgramStatus(`state=idle:title=${b64('t'.repeat(193))}`), null);
  assert.equal(parseProgramStatus(`state=idle:app=${'a'.repeat(32)}`).app.length, 32);
  assert.equal(parseProgramStatus(`state=idle:app=${'a'.repeat(33)}`), null);
  assert.equal(parseProgramStatus(`state=idle:${'k'.repeat(17)}=1`), null, 'a key over 16 bytes');
  assert.equal(parseProgramStatus(`state=idle:${'k'.repeat(16)}=1`).state, 'idle');
  assert.equal(parseProgramStatus(`state=idle:pad=${'p'.repeat(4096)}`), null, 'the whole sequence over 4096 bytes');
});

test('kind belongs to blocked only; progress to working and blocked only', () => {
  assert.equal(parseProgramStatus('state=blocked:kind=question').kind, 'question');
  assert.equal(parseProgramStatus('state=blocked:kind=coffee').kind, null);
  assert.equal(parseProgramStatus('state=idle:kind=question').kind, null);
  assert.equal(parseProgramStatus('state=working:progress=42').progress, 42);
  assert.equal(parseProgramStatus('state=working:progress=250').progress, 100);
  assert.equal(parseProgramStatus('state=working:progress=4.5').progress, null);
  assert.equal(parseProgramStatus('state=done:progress=42').progress, null);
});

test('text shown outside the terminal loses invisible formatting', () => {
  // A right-to-left override would make "exe.gnp" read as "png.exe".
  assert.equal(displayText('open ‮gnp.exe‬ now'), 'open gnp.exe now');
  assert.equal(displayText('zero​width⁦ isolate⁩'), 'zerowidth isolate');
  assert.equal(displayText('  spaced   out  '), 'spaced out');
  assert.equal(displayText('​'), null);
  assert.equal(displayText('x'.repeat(300)).length, 200);
  assert.equal(displayText(null), null);
});

const parse = (body) => parseProgramStatus(body);

test('each report replaces its record; the tab shows the most pressing one', () => {
  const records = createProgramStatusRecords();
  records.apply(parse('state=working:progress=10'));
  records.apply(parse('state=idle'));
  assert.equal(records.summary().state, 'idle', 'the root record was replaced');
  records.apply(parse('state=working:id=build'));
  assert.equal(records.summary().state, 'working');
  records.apply(parse(`state=blocked:id=build/test:kind=question:msg=${b64('Which port?')}`));
  assert.equal(records.summary().state, 'blocked');
  assert.equal(records.summary().msg, 'Which port?');
  records.apply(parse('state=done:id=lint'));
  assert.equal(records.summary().state, 'blocked', 'blocked outranks done');
});

test('clear removes a record and its children, or every record', () => {
  const records = createProgramStatusRecords();
  records.apply(parse('state=working:id=build'));
  records.apply(parse('state=blocked:id=build/test'));
  records.apply(parse('state=done:id=builder'));
  assert.equal(records.apply(parse('state=clear:id=build')), true);
  assert.equal(records.summary().state, 'done', '"builder" is not a child of "build"');
  records.apply(parse('state=idle'));
  assert.equal(records.apply(parse('state=clear')), true);
  assert.equal(records.summary(), null);
  assert.equal(records.apply(parse('state=clear')), false, 'nothing left to clear');
});

test('past the cap the least recently updated record goes', () => {
  const records = createProgramStatusRecords({ maxRecords: 3 });
  records.apply(parse('state=blocked:id=a'));
  records.apply(parse('state=idle:id=b'));
  records.apply(parse('state=idle:id=c'));
  records.apply(parse('state=blocked:id=a'));
  records.apply(parse('state=idle:id=d'));
  assert.equal(records.summary().state, 'blocked', '"a" was updated recently, so "b" went');
  records.apply(parse('state=idle:id=e'));
  records.apply(parse('state=idle:id=f'));
  assert.equal(records.summary().state, 'idle', 'now "a" is the oldest and went');
  assert.equal(MAX_RECORDS, 256);
});

test('activity ends with the program or a prompt; finished results stay until seen', () => {
  const records = createProgramStatusRecords();
  records.apply(parse('state=blocked:id=a'));
  records.apply(parse('state=working:id=b'));
  records.apply(parse('state=idle:id=c'));
  records.apply(parse('state=done:id=d'));
  records.apply(parse('state=error:id=e'));
  assert.equal(records.endActivity(), true);
  assert.equal(records.summary().state, 'error');
  assert.equal(records.acknowledge(), true);
  assert.equal(records.summary(), null);
  assert.equal(records.acknowledge(), false);
});

test('a reset clears every record', () => {
  const records = createProgramStatusRecords();
  records.apply(parse('state=done'));
  assert.equal(records.reset(), true);
  assert.equal(records.summary(), null);
});
