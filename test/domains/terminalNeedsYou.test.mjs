import test from 'node:test';
import assert from 'node:assert/strict';

import { createTerminalDomain } from '../../src/terminal/terminalDomain.js';
import { createTerminalEventStream } from '../../src/terminal/terminalStorage.js';
import { PROGRAM_STATUS_REPLY } from '../../src/terminal/programStatus.js';

// "Needs you" on a terminal tab (track T slice T2a-2). The signal's producer
// is the domain's tap reading a session's output, so every test here feeds
// raw output through the REAL event stream and the REAL scanner and parser;
// only Tauri's calls are faked (test-authoring policy Rule 1).

const ESC = '\x1b';
const BEL = '\x07';
const ST = `${ESC}\\`;
const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const report = (pairs) => `${ESC}]7501;${pairs}${BEL}`;
const output = (chunk) => ({ event: 'Output', data: { chunk } });
const exited = (exitCode) => ({ event: 'Exited', data: { exitCode } });

function fakeBackend() {
  const calls = [];
  const spawns = [];
  let nextId = 1;
  return {
    calls,
    spawns,
    inputs: () => calls.filter(([op]) => op === 'input'),
    adapters: {
      spawn: (request) => {
        const channel = { onmessage: null, emit(event) { this.onmessage?.(event); } };
        const stream = createTerminalEventStream(channel, { onEvent: request.onEvent });
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        const sessionId = `s${nextId++}`;
        spawns.push({
          channel,
          stream,
          emit: (event) => channel.emit(event),
          resolve: () => resolve({ ok: true, data: { sessionId, projectId: request.projectId }, stream })
        });
        return promise;
      },
      end: async () => ({ ok: true }),
      endProject: async () => ({ ok: true }),
      teardownAll: async () => ({ ok: true }),
      input: async (projectId, sessionId, input) => { calls.push(['input', projectId, sessionId, input]); return { ok: true }; },
      resize: async () => ({ ok: true }),
      pause: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
      busy: async () => ({ ok: true, data: [] }),
      takeReloadReport: async () => ({ ok: true, data: 0 })
    }
  };
}

async function setup(count = 1) {
  const backend = fakeBackend();
  const domain = createTerminalDomain({ adapters: backend.adapters, setTimer: () => {} });
  domain.commands.setCurrentProject({ id: 'p1', root: '/projects/p1' });
  const sessions = [];
  for (let i = 0; i < count; i++) {
    const pending = domain.commands.startSession();
    const spawn = backend.spawns.at(-1);
    spawn.resolve();
    const { key } = await pending;
    sessions.push({ key, emit: (chunk) => spawn.emit(output(chunk)), exit: (code) => spawn.emit(exited(code)), stream: spawn.stream });
  }
  const tab = (key) => domain.selectors.getProject('p1').tabs.find((t) => t.key === key);
  const needsYouKey = () => domain.selectors.getProject('p1').needsYouKey;
  return { backend, domain, sessions, tab, needsYouKey };
}

test('a bell from a session out of sight marks it; seeing it clears the mark', async () => {
  const { domain, sessions: [a], tab, needsYouKey } = await setup();
  a.emit(`make: done${BEL}`);
  assert.equal(tab(a.key).needsYou, true);
  assert.equal(needsYouKey(), a.key);
  domain.commands.setSessionInView('p1', a.key);
  assert.equal(tab(a.key).needsYou, false);
  assert.equal(needsYouKey(), null);
});

test('a bell from the session on screen asks nothing', async () => {
  const { domain, sessions: [a], tab } = await setup();
  domain.commands.setSessionInView('p1', a.key);
  a.emit(BEL);
  assert.equal(tab(a.key).needsYou, false);
  domain.commands.setSessionInView('p1', null);
  assert.equal(tab(a.key).needsYou, false, 'hiding the drawer does not bring the bell back');
});

test('a shell setting its title on every prompt never marks the tab', async () => {
  const { sessions: [a], tab } = await setup();
  for (let i = 0; i < 5; i++) a.emit(`${ESC}]0;C:\\projects\\p1${BEL}PS C:\\projects\\p1> `);
  assert.equal(tab(a.key).needsYou, false);
});

test("the program's question is answered once, through its own session", async () => {
  const { backend, sessions: [a, b] } = await setup(2);
  b.emit(`${ESC}]7501;?${BEL}${ESC}[c`);
  assert.deepEqual(backend.inputs(), [['input', 'p1', 's2', PROGRAM_STATUS_REPLY]]);
  // A view that mounts gets the output replayed; the domain does not answer again.
  b.stream.subscribe(() => {});
  b.stream.subscribe(() => {});
  assert.equal(backend.inputs().length, 1);
  assert.equal(a.key !== b.key, true);
});

test('a question asked before the start resolves is answered when the session id arrives', async () => {
  const backend = fakeBackend();
  const domain = createTerminalDomain({ adapters: backend.adapters, setTimer: () => {} });
  domain.commands.setCurrentProject({ id: 'p1', root: '/projects/p1' });
  // An agent started as the session's own process asks at once (T2b).
  let notifiedBeforeReply = false;
  domain.subscribe(() => {
    const tab = domain.selectors.getProject('p1').tabs[0];
    if (tab?.sessionId && backend.inputs().length === 0) notifiedBeforeReply = true;
  });
  const pending = domain.commands.startSession();
  const spawn = backend.spawns[0];
  spawn.emit(output(`${ESC}]7501;?${BEL}${ESC}[c`));
  assert.deepEqual(backend.inputs(), [], 'no session id to answer through yet');
  spawn.resolve();
  await pending;
  assert.deepEqual(backend.inputs(), [['input', 'p1', 's1', PROGRAM_STATUS_REPLY]]);
  assert.equal(notifiedBeforeReply, false, 'answered before any view can mount and answer the DA1');
});

test('a program blocked on the person needs them, with its reason', async () => {
  const { sessions: [a], tab, needsYouKey } = await setup();
  a.emit(report(`state=working:app=claude-code`));
  assert.equal(tab(a.key).activity, 'working');
  assert.equal(tab(a.key).needsYou, false);
  a.emit(report(`state=blocked:app=claude-code:kind=permission:msg=${b64('Allow edit to \u202Esj.ppa\u202C?')}`));
  const t = tab(a.key);
  assert.equal(t.needsYou, true);
  assert.equal(t.activity, 'blocked');
  assert.equal(t.statusKind, 'permission');
  assert.equal(t.statusApp, 'claude-code');
  assert.equal(t.statusText, 'Allow edit to sj.ppa?', 'invisible overrides are stripped');
  assert.equal(needsYouKey(), a.key);
  a.emit(report('state=working:app=claude-code'));
  assert.equal(tab(a.key).needsYou, false, 'answered: back to work');
});

test('being blocked shows even while the tab is on screen; seeing it does not answer it', async () => {
  const { domain, sessions: [a], tab, needsYouKey } = await setup();
  domain.commands.setSessionInView('p1', a.key);
  a.emit(report('state=blocked:kind=question'));
  assert.equal(tab(a.key).needsYou, true);
  assert.equal(needsYouKey(), null, 'the person is looking at it');
  domain.commands.setSessionInView('p1', null);
  assert.equal(needsYouKey(), a.key, 'out of sight and still waiting');
});

test('a finished result waits to be seen; seeing it clears it', async () => {
  const { domain, sessions: [a], tab } = await setup();
  a.emit(report(`state=done:app=cargo:msg=${b64('Build finished')}`));
  assert.equal(tab(a.key).activity, 'done');
  assert.equal(tab(a.key).needsYou, false, 'done is news, not a request');
  domain.commands.setSessionInView('p1', a.key);
  assert.equal(tab(a.key).activity, null);
  a.emit(report('state=error:app=cargo'));
  assert.equal(tab(a.key).activity, null, 'finished on screen: already seen');
});

test('when the program exits its activity ends; its finished result stays', async () => {
  const { sessions: [a, b], tab } = await setup(2);
  a.emit(report('state=blocked:id=x') + BEL);
  a.exit(1);
  assert.equal(tab(a.key).status, 'ended');
  assert.equal(tab(a.key).needsYou, false, 'nothing is waiting on a program that is gone');
  b.emit(report('state=done:id=build') + report('state=working:id=watch'));
  b.exit(0);
  assert.equal(tab(b.key).activity, 'done');
  b.emit(BEL);
  assert.equal(tab(b.key).needsYou, false, 'an ended tab ignores bells');
});

test('a new prompt ends what the program was doing', async () => {
  const { sessions: [a], tab } = await setup();
  a.emit(report('state=blocked'));
  a.emit(`${ESC}]133;A${ST}`);
  assert.equal(tab(a.key).needsYou, false);
});

test('a full reset clears every record', async () => {
  const { sessions: [a], tab } = await setup();
  a.emit(report('state=done'));
  a.emit(`${ESC}c`);
  assert.equal(tab(a.key).activity, null);
});

test('a report split across reads still lands', async () => {
  const { sessions: [a], tab } = await setup();
  const bytes = report('state=blocked:kind=auth');
  a.emit(bytes.slice(0, 9));
  assert.equal(tab(a.key).needsYou, false);
  a.emit(bytes.slice(9));
  assert.equal(tab(a.key).statusKind, 'auth');
});

test('a hostile report changes nothing', async () => {
  const { sessions: [a], tab } = await setup();
  a.emit(report(`state=blocked:msg=${b64('click\x1b]8;;evil\x07here')}`));
  a.emit(report('state=blocked:id=/etc'));
  a.emit(report(`state=blocked:app=${'x'.repeat(33)}`));
  assert.equal(tab(a.key).needsYou, false);
});

test('the person is taken to the latest session that needs them', async () => {
  const { domain, sessions: [a, b, c], needsYouKey } = await setup(3);
  domain.commands.setViewedSession('p1', a.key);
  b.emit(BEL);
  c.emit(report('state=blocked'));
  assert.equal(needsYouKey(), c.key);
  b.emit(report('state=blocked:kind=question'));
  assert.equal(needsYouKey(), b.key, 'newly blocked is the latest');
  assert.equal(domain.commands.showSessionNeedingYou(), true);
  assert.equal(domain.selectors.getProject('p1').viewedKey, b.key);
  domain.commands.setSessionInView('p1', b.key);
  assert.equal(needsYouKey(), c.key, 'the next one waiting');
});

test('with nothing waiting, opening from the rail changes nothing', async () => {
  const { domain, sessions: [a, b] } = await setup(2);
  domain.commands.setViewedSession('p1', a.key);
  assert.equal(domain.commands.showSessionNeedingYou(), false);
  assert.equal(domain.selectors.getProject('p1').viewedKey, a.key);
  assert.equal(b.key !== a.key, true);
});

test('a view report from another project never moves what is in view', async () => {
  const { domain, sessions: [a], tab } = await setup();
  domain.commands.setSessionInView('p1', a.key);
  domain.commands.setSessionInView('p2', null);
  a.emit(BEL);
  assert.equal(tab(a.key).needsYou, false, 'p1 is still on screen');
  domain.commands.setSessionInView('p2', a.key);
  domain.commands.setSessionInView('p1', null);
  a.emit(BEL);
  assert.equal(tab(a.key).needsYou, true);
});

test('ending a session on screen leaves nothing in view', async () => {
  const { domain, sessions: [a, b], tab } = await setup(2);
  domain.commands.setSessionInView('p1', a.key);
  await domain.commands.endSession(a.key);
  b.emit(BEL);
  assert.equal(tab(b.key).needsYou, true);
});

test('a report that changes nothing on screen does not re-render', async () => {
  const { domain, sessions: [a] } = await setup();
  let notified = 0;
  domain.subscribe(() => { notified += 1; });
  a.emit(report('state=working:app=cargo:progress=10'));
  assert.equal(notified, 1);
  a.emit(report('state=working:app=cargo:progress=20'));
  a.emit(report('state=working:app=cargo:progress=30'));
  assert.equal(notified, 1, 'progress is not shown');
  a.emit(report('state=blocked:app=cargo'));
  assert.equal(notified, 2);
});
