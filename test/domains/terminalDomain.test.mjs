import test from 'node:test';
import assert from 'node:assert/strict';

import { createTerminalDomain } from '../../src/terminal/terminalDomain.js';

test('TerminalDomain start/end lifecycle proxies adapter calls', async () => {
  const calls = [];
  const domain = createTerminalDomain({
    adapters: {
      start: async (projectId, projectRoot, executable) => {
        calls.push(['start', projectId, projectRoot, executable]);
        return {
          ok: true,
          data: {
            projectId,
            sessionId: 'term-1'
          }
        };
      },
      end: async (projectId) => {
        calls.push(['end', projectId]);
        return { ok: true, data: { projectId, sessionId: 'term-1' } };
      },
      teardownAll: async () => {
        calls.push(['teardownAll']);
        return { ok: true, data: 1 };
      }
    }
  });

  const started = await domain.commands.startForProject({
    projectId: 'p1',
    projectRoot: '/tmp/p1'
  });
  assert.equal(started, true);
  assert.deepEqual(domain.selectors.getActiveSession(), {
    projectId: 'p1',
    sessionId: 'term-1'
  });

  const ended = await domain.commands.endForProject('p1');
  assert.equal(ended, true);
  assert.equal(domain.selectors.getActiveSession(), null);

  const tornDown = await domain.commands.teardownAll();
  assert.equal(tornDown, true);
  assert.deepEqual(calls, [
    ['start', 'p1', '/tmp/p1', null],
    ['end', 'p1'],
    ['teardownAll']
  ]);
});

test('TerminalDomain sendInput/resize use active session id', async () => {
  const calls = [];
  const domain = createTerminalDomain({
    adapters: {
      start: async () => ({
        ok: true,
        data: {
          projectId: 'p2',
          sessionId: 'term-2'
        }
      }),
      input: async (projectId, sessionId, input) => {
        calls.push(['input', projectId, sessionId, input]);
        return { ok: true };
      },
      resize: async (projectId, sessionId, cols, rows) => {
        calls.push(['resize', projectId, sessionId, cols, rows]);
        return { ok: true };
      }
    }
  });

  await domain.commands.startForProject({
    projectId: 'p2',
    projectRoot: '/tmp/p2'
  });

  const inputOk = await domain.commands.sendInput({
    projectId: 'p2',
    input: 'echo hi'
  });
  const resizeOk = await domain.commands.resize({
    projectId: 'p2',
    cols: 120,
    rows: 40
  });

  assert.equal(inputOk, true);
  assert.equal(resizeOk, true);
  assert.deepEqual(calls, [
    ['input', 'p2', 'term-2', 'echo hi'],
    ['resize', 'p2', 'term-2', 120, 40]
  ]);
});

test('TerminalDomain spawnWithChannel returns channel and sets active session', async () => {
  const mockChannel = { onmessage: null };
  const calls = [];
  const domain = createTerminalDomain({
    adapters: {
      spawn: async (projectId, projectRoot, cols, rows, executable) => {
        calls.push(['spawn', projectId, projectRoot, cols, rows, executable]);
        return {
          ok: true,
          data: { projectId, sessionId: 'term-pty-1' },
          channel: mockChannel
        };
      }
    }
  });

  assert.equal(domain.selectors.getActiveChannel(), null);

  const channel = await domain.commands.spawnWithChannel({
    projectId: 'p3',
    projectRoot: '/tmp/p3',
    cols: 80,
    rows: 24
  });

  assert.equal(channel, mockChannel);
  assert.deepEqual(domain.selectors.getActiveSession(), {
    projectId: 'p3',
    sessionId: 'term-pty-1'
  });
  assert.equal(domain.selectors.getActiveChannel(), mockChannel);
  assert.deepEqual(calls, [
    ['spawn', 'p3', '/tmp/p3', 80, 24, null]
  ]);
});

test('TerminalDomain spawnWithChannel returns existing channel for same project', async () => {
  const mockChannel = { onmessage: null };
  let spawnCount = 0;
  const domain = createTerminalDomain({
    adapters: {
      spawn: async (projectId) => {
        spawnCount += 1;
        return {
          ok: true,
          data: { projectId, sessionId: 'term-pty-2' },
          channel: mockChannel
        };
      }
    }
  });

  await domain.commands.spawnWithChannel({
    projectId: 'p4',
    projectRoot: '/tmp/p4',
    cols: 80,
    rows: 24
  });
  const second = await domain.commands.spawnWithChannel({
    projectId: 'p4',
    projectRoot: '/tmp/p4',
    cols: 80,
    rows: 24
  });

  assert.equal(second, mockChannel);
  assert.equal(spawnCount, 1, 'should not spawn again for same project');
});

test('TerminalDomain spawnWithChannel returns null on failure', async () => {
  const domain = createTerminalDomain({
    adapters: {
      spawn: async () => ({
        ok: false,
        error: { category: 'Internal', code: 'test', message: 'fail' }
      })
    }
  });

  const result = await domain.commands.spawnWithChannel({
    projectId: 'p5',
    projectRoot: '/tmp/p5',
    cols: 80,
    rows: 24
  });

  assert.equal(result, null);
  assert.equal(domain.selectors.getActiveSession(), null);
  assert.equal(domain.selectors.getActiveChannel(), null);
});

test('TerminalDomain pauseOutput/resumeOutput proxy adapter calls', async () => {
  const calls = [];
  const domain = createTerminalDomain({
    adapters: {
      spawn: async (projectId) => ({
        ok: true,
        data: { projectId, sessionId: 'term-pty-3' },
        channel: { onmessage: null }
      }),
      pause: async (projectId) => {
        calls.push(['pause', projectId]);
        return { ok: true };
      },
      resume: async (projectId) => {
        calls.push(['resume', projectId]);
        return { ok: true };
      }
    }
  });

  // Without active session, should return false
  assert.equal(await domain.commands.pauseOutput({ projectId: 'p6' }), false);
  assert.equal(await domain.commands.resumeOutput({ projectId: 'p6' }), false);

  await domain.commands.spawnWithChannel({
    projectId: 'p6',
    projectRoot: '/tmp/p6',
    cols: 80,
    rows: 24
  });

  assert.equal(await domain.commands.pauseOutput({ projectId: 'p6' }), true);
  assert.equal(await domain.commands.resumeOutput({ projectId: 'p6' }), true);
  assert.deepEqual(calls, [
    ['pause', 'p6'],
    ['resume', 'p6']
  ]);
});

test('TerminalDomain teardownAll clears channel reference', async () => {
  const domain = createTerminalDomain({
    adapters: {
      spawn: async (projectId) => ({
        ok: true,
        data: { projectId, sessionId: 'term-pty-4' },
        channel: { onmessage: null }
      }),
      teardownAll: async () => ({ ok: true, data: 1 })
    }
  });

  await domain.commands.spawnWithChannel({
    projectId: 'p7',
    projectRoot: '/tmp/p7',
    cols: 80,
    rows: 24
  });
  assert.notEqual(domain.selectors.getActiveChannel(), null);

  await domain.commands.teardownAll();
  assert.equal(domain.selectors.getActiveSession(), null);
  assert.equal(domain.selectors.getActiveChannel(), null);
});

// ---------------------------------------------------------------------------
// createTerminalEventStream — early-event buffering (blank-terminal fix).
// Tauri's Channel drops in-order messages that arrive before onmessage is
// assigned; the stream wrapper buffers from creation and replays on
// subscribe. Exposed by the sideloaded ConPTY host (PR #106) painting the
// shell prompt before TerminalRenderer's effect attached.
// ---------------------------------------------------------------------------

function fakeChannel() {
  return {
    onmessage: null,
    emit(event) { this.onmessage?.(event); }
  };
}

test('terminal event stream buffers pre-subscribe events and replays them in order', async () => {
  const { createTerminalEventStream } = await import('../../src/terminal/terminalStorage.js');
  const channel = fakeChannel();
  const stream = createTerminalEventStream(channel);

  channel.emit({ event: 'Output', data: { chunk: 'banner' } });
  channel.emit({ event: 'Output', data: { chunk: 'prompt> ' } });

  const seen = [];
  stream.subscribe((event) => seen.push(event.data.chunk));
  assert.deepEqual(seen, ['banner', 'prompt> ']);

  channel.emit({ event: 'Output', data: { chunk: 'live' } });
  assert.deepEqual(seen, ['banner', 'prompt> ', 'live']);
});

test('terminal event stream re-buffers after unsubscribe and replays on resubscribe', async () => {
  const { createTerminalEventStream } = await import('../../src/terminal/terminalStorage.js');
  const channel = fakeChannel();
  const stream = createTerminalEventStream(channel);

  const first = [];
  stream.subscribe((event) => first.push(event.data.chunk));
  channel.emit({ event: 'Output', data: { chunk: 'a' } });
  stream.unsubscribe();

  // Arrives while no consumer is attached — must not throw, must not vanish.
  channel.emit({ event: 'Output', data: { chunk: 'b' } });

  const second = [];
  stream.subscribe((event) => second.push(event.data.chunk));
  assert.deepEqual(first, ['a']);
  assert.deepEqual(second, ['b']);
});
