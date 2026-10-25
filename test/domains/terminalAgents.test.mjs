import test from 'node:test';
import assert from 'node:assert/strict';

import { createTerminalDomain } from '../../src/terminal/terminalDomain.js';
import { createTerminalEventStream } from '../../src/terminal/terminalStorage.js';

// Starting the person's own agent as a terminal session (track T slice
// T2b-1). Rust finds the program and builds its command line; the domain
// names the agent only. Only Tauri's calls are faked; every stream is the
// real event stream.

function fakeBackend({ agents = { claude: true, codex: false } } = {}) {
  const calls = [];
  let nextId = 1;
  let detections = 0;
  const backend = {
    calls,
    agents,
    detections: () => detections,
    adapters: {
      spawn: async (request) => {
        calls.push(['spawn', request.projectId, request.executable ?? null]);
        const channel = { onmessage: null, emit(event) { this.onmessage?.(event); } };
        const stream = createTerminalEventStream(channel, { onEvent: request.onEvent });
        return { ok: true, data: { sessionId: `s${nextId++}` }, stream };
      },
      spawnAgent: async (request) => {
        calls.push(['spawnAgent', request.projectId, request.projectRoot, request.agent]);
        if (!backend.agents[request.agent]) {
          return { ok: false, error: { code: 'agent.not_installed', message: `${request.agent} is not installed.` } };
        }
        const channel = { onmessage: null, emit(event) { this.onmessage?.(event); } };
        const stream = createTerminalEventStream(channel, { onEvent: request.onEvent });
        return { ok: true, data: { sessionId: `s${nextId++}` }, stream };
      },
      detectAgents: async () => {
        detections += 1;
        return { ok: true, data: { ...backend.agents } };
      },
      installGuide: async (agent) => { calls.push(['installGuide', agent]); return { ok: true }; },
      end: async () => ({ ok: true }),
      endProject: async () => ({ ok: true }),
      teardownAll: async () => ({ ok: true }),
      input: async (_projectId, sessionId, input) => { calls.push(['input', sessionId, input]); return { ok: true }; },
      resize: async () => ({ ok: true }),
      pause: async () => ({ ok: true }),
      resume: async () => ({ ok: true }),
      busy: async () => ({ ok: true, data: [] }),
      takeReloadReport: async () => ({ ok: true, data: 0 })
    }
  };
  return backend;
}

function domainWith(backend) {
  const domain = createTerminalDomain({ adapters: backend.adapters, setTimer: () => {} });
  domain.commands.setCurrentProject({ id: 'p1', root: '/projects/p1' });
  return domain;
}

const tabsOf = (domain) => domain.selectors.getProject('p1').tabs;

test('an agent starts as its own session, named the way Litria names it', async () => {
  const backend = fakeBackend({ agents: { claude: true, codex: true } });
  const domain = domainWith(backend);
  const claude = await domain.commands.startSession({ agent: 'claude' });
  const codex = await domain.commands.startSession({ agent: 'codex' });
  assert.equal(claude.ok && codex.ok, true);
  assert.deepEqual(backend.calls.filter(([op]) => op === 'spawnAgent'), [
    ['spawnAgent', 'p1', '/projects/p1', 'claude'],
    ['spawnAgent', 'p1', '/projects/p1', 'codex']
  ]);
  assert.deepEqual(tabsOf(domain).map((t) => [t.kind, t.label, t.status]), [
    ['claude', 'Claude Agent 1', 'running'],
    ['codex', 'Codex 1', 'running']
  ]);
});

test('shells and each agent count their own tabs', async () => {
  const backend = fakeBackend({ agents: { claude: true, codex: true } });
  const domain = domainWith(backend);
  await domain.commands.startSession();
  await domain.commands.startSession({ agent: 'claude' });
  await domain.commands.startSession();
  await domain.commands.startSession({ agent: 'claude' });
  assert.deepEqual(tabsOf(domain).map((t) => t.label), ['Terminal 1', 'Claude Agent 1', 'Terminal 2', 'Claude Agent 2']);
  await domain.commands.endProject('p1');
  domain.commands.setCurrentProject({ id: 'p1', root: '/projects/p1' });
  await domain.commands.startSession({ agent: 'claude' });
  assert.deepEqual(tabsOf(domain).map((t) => t.label), ['Claude Agent 1'], 'a closed project starts its counts again');
});

test('nothing is ever typed into an agent for Litria', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  // A pill's command never rides along with an agent start.
  const started = await domain.commands.startSession({ agent: 'claude', initialInput: 'npm install\r' });
  backend.calls.length = 0;
  // Even after the agent prints its first screen.
  tabsOf(domain); // snapshot
  const tab = tabsOf(domain).find((t) => t.key === started.key);
  tab.stream.channel.emit({ event: 'Output', data: { chunk: 'Welcome' } });
  assert.deepEqual(backend.calls.filter(([op]) => op === 'input'), []);
});

test('an agent that is not installed leaves an ended tab that says so', async () => {
  const backend = fakeBackend({ agents: { claude: false, codex: false } });
  const domain = domainWith(backend);
  const result = await domain.commands.startSession({ agent: 'codex' });
  assert.equal(result.ok, false);
  const [tab] = tabsOf(domain);
  assert.equal(tab.status, 'ended');
  assert.equal(tab.kind, 'codex');
  assert.match(tab.error.message, /not installed/);
});

test('only the agents Litria knows can be started', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  for (const agent of ['gemini', 'CLAUDE', '', 'claude --dangerously-skip-permissions', 0]) {
    const result = await domain.commands.startSession({ agent });
    assert.equal(result.ok, false, String(agent));
    assert.equal(result.error.code, 'agent.unknown');
  }
  assert.deepEqual(backend.calls, [], 'nothing reached Rust');
  assert.deepEqual(tabsOf(domain), []);
});

test('looking for agents: one look at a time, and the menu learns the answer', async () => {
  const backend = fakeBackend({ agents: { claude: true, codex: false } });
  const domain = domainWith(backend);
  assert.deepEqual(domain.selectors.getAgents(), { claude: null, codex: null }, 'not looked yet');
  let notified = 0;
  domain.subscribe(() => { notified += 1; });
  const [a, b] = await Promise.all([domain.commands.detectAgents(), domain.commands.detectAgents()]);
  assert.equal(backend.detections(), 1, 'one look in flight');
  assert.deepEqual(a, { claude: true, codex: false });
  assert.equal(a, b);
  assert.deepEqual(domain.selectors.getAgents(), { claude: true, codex: false });
  assert.equal(notified, 1);
  // An install made since shows on the next look; an unchanged answer is quiet.
  await domain.commands.detectAgents();
  assert.equal(notified, 1);
  backend.agents.codex = true;
  await domain.commands.detectAgents();
  assert.deepEqual(domain.selectors.getAgents(), { claude: true, codex: true });
  assert.equal(notified, 2);
});

test('a failed look reads as not installed', async () => {
  const backend = fakeBackend();
  backend.adapters.detectAgents = async () => ({ ok: false, error: { code: 'agent.detect_failed' } });
  const domain = domainWith(backend);
  assert.deepEqual(await domain.commands.detectAgents(), { claude: false, codex: false });
});

test('the install guide opens only for an agent Litria knows', async () => {
  const backend = fakeBackend();
  const domain = domainWith(backend);
  assert.equal(await domain.commands.openInstallGuide('codex'), true);
  assert.equal(await domain.commands.openInstallGuide('https://example.com'), false);
  assert.deepEqual(backend.calls, [['installGuide', 'codex']]);
});
