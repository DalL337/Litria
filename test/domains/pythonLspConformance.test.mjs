/**
 * Python LSP Conformance Tests
 *
 * Targeted tests for conformance checklist items:
 * - 1.2 Runtime capability contract (version extraction, launch contract)
 * - 1.3 Lifecycle contract (activation guards, session idempotency, teardown)
 * - 1.4 Error contract (all D5 canonical error codes have retry hints)
 * - 1.5 UX consistency (setup commands are concrete copyable strings)
 * - D3  Launch contract (command, args, cwd policy)
 * - D5  Canonical error codes mapped
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLanguageSupportDomain } from '../../src/app/languageSupportDomain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installedAdapters(overrides = {}) {
  return {
    detectPythonRuntime: async () => ({ available: true, command: 'python', version: '3.12.0' }),
    detectNodeRuntime: async () => ({ available: true, command: 'node', version: '22.5.0' }),
    detectPyrightServer: async () => ({ available: true, command: 'pyright-langserver', version: '1.1.390' }),
    startPythonLsp: async ({ projectId }) => ({
      ok: true,
      data: { projectId, sessionId: `py-${projectId}`, ready: true }
    }),
    stopPythonLsp: async () => ({ ok: true }),
    ...overrides
  };
}

async function domainWithActiveSession(adapterOverrides = {}) {
  const domain = createLanguageSupportDomain({ adapters: installedAdapters(adapterOverrides) });
  await domain.commands.detectPythonSupport();
  await domain.commands.activatePythonForProject({
    projectId: 'project-1',
    projectRoot: '/tmp/project-1'
  });
  return domain;
}

// ---------------------------------------------------------------------------
// 1.2 Runtime Capability Contract — version extraction
// ---------------------------------------------------------------------------

test('detectPythonSupport preserves version strings for all prerequisites', async () => {
  const domain = createLanguageSupportDomain({ adapters: installedAdapters() });
  const result = await domain.commands.detectPythonSupport();

  assert.equal(result.prerequisites.python.version, '3.12.0');
  assert.equal(result.prerequisites.python.command, 'python');
  assert.equal(result.prerequisites.node.version, '22.5.0');
  assert.equal(result.prerequisites.node.command, 'node');
  assert.equal(result.prerequisites.server.version, '1.1.390');
  assert.equal(result.prerequisites.server.command, 'pyright-langserver');
});

test('detectPythonSupport normalizes missing version to null', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: true, command: 'python3' }),
      detectNodeRuntime: async () => ({ available: true, command: 'node' }),
      detectPyrightServer: async () => ({ available: true, command: 'pyright-langserver' })
    }
  });
  const result = await domain.commands.detectPythonSupport();

  assert.equal(result.prerequisites.python.version, null);
  assert.equal(result.prerequisites.python.command, 'python3');
  assert.equal(result.status, 'Installed');
});

test('getPackState exposes prerequisite versions via selector after detection', async () => {
  const domain = createLanguageSupportDomain({ adapters: installedAdapters() });
  await domain.commands.detectPythonSupport();
  const packState = domain.selectors.getPackState('python');

  assert.equal(packState.prerequisites.python.version, '3.12.0');
  assert.equal(packState.prerequisites.server.version, '1.1.390');
  assert.equal(packState.prerequisites.node.version, '22.5.0');
});

// ---------------------------------------------------------------------------
// 1.2 Runtime Capability — launch contract (D3)
// ---------------------------------------------------------------------------

test('Python launch contract matches D3 defaults', () => {
  const domain = createLanguageSupportDomain();
  const launch = domain.selectors.getPackLaunch('python');

  assert.equal(launch.command, 'pyright-langserver');
  assert.deepEqual(launch.args, ['--stdio']);
  assert.equal(launch.cwdPolicy, 'project_root');
  assert.deepEqual(launch.envAllowlist, []);
});

// ---------------------------------------------------------------------------
// 1.3 Lifecycle Contract — activation guards
// ---------------------------------------------------------------------------

test('activatePythonForProject rejects when prerequisites are not ready', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: false }),
      detectNodeRuntime: async () => ({ available: true }),
      detectPyrightServer: async () => ({ available: false })
    }
  });
  await domain.commands.detectPythonSupport();

  const activated = await domain.commands.activatePythonForProject({
    projectId: 'p1',
    projectRoot: '/tmp/p1'
  });
  assert.equal(activated, false);
  assert.equal(domain.selectors.getActiveSession('python'), null);
});

test('activatePythonForProject rejects with missing projectId or projectRoot', async () => {
  const domain = createLanguageSupportDomain({ adapters: installedAdapters() });
  await domain.commands.detectPythonSupport();

  assert.equal(await domain.commands.activatePythonForProject({ projectId: '', projectRoot: '/tmp' }), false);
  assert.equal(await domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '' }), false);
  assert.equal(await domain.commands.activatePythonForProject({ projectId: null, projectRoot: '/tmp' }), false);
});

// ---------------------------------------------------------------------------
// 1.3 Lifecycle Contract — session idempotency
// ---------------------------------------------------------------------------

test('activating same project twice returns true without restarting', async () => {
  let startCount = 0;
  const domain = createLanguageSupportDomain({
    adapters: installedAdapters({
      startPythonLsp: async ({ projectId }) => {
        startCount++;
        return { ok: true, data: { projectId, sessionId: `py-${projectId}`, ready: true } };
      }
    })
  });
  await domain.commands.detectPythonSupport();

  assert.equal(await domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '/tmp/p1' }), true);
  assert.equal(await domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '/tmp/p1' }), true);
  assert.equal(startCount, 1, 'should not restart for same project');
});

// ---------------------------------------------------------------------------
// 1.3 Lifecycle Contract — deactivation no-op when no session
// ---------------------------------------------------------------------------

test('deactivating with no active session returns true', async () => {
  const domain = createLanguageSupportDomain({ adapters: installedAdapters() });
  const result = await domain.commands.deactivatePythonForProject();
  assert.equal(result, true);
});

test('deactivating for mismatched projectId returns true', async () => {
  const domain = await domainWithActiveSession();
  const result = await domain.commands.deactivatePythonForProject('nonexistent-project');
  assert.equal(result, true);
  assert.notEqual(domain.selectors.getActiveSession('python'), null);
});

// ---------------------------------------------------------------------------
// 1.3 Lifecycle Contract — startup timeout (ready=false)
// ---------------------------------------------------------------------------

test('activation fails with timeout error when server reports ready=false', async () => {
  const domain = createLanguageSupportDomain({
    adapters: installedAdapters({
      startPythonLsp: async ({ projectId }) => ({
        ok: true,
        data: { projectId, sessionId: `py-${projectId}`, ready: false }
      })
    })
  });
  await domain.commands.detectPythonSupport();

  const activated = await domain.commands.activatePythonForProject({
    projectId: 'p1',
    projectRoot: '/tmp/p1'
  });
  assert.equal(activated, false);
  assert.equal(domain.selectors.getPackStatus('python'), 'Error');
  assert.match(domain.selectors.getPackError('python').code, /timeout/i);
});

// ---------------------------------------------------------------------------
// 1.3 Lifecycle Contract — activation emits typed events
// ---------------------------------------------------------------------------

test('successful activation emits progress and completed events', async () => {
  const domain = createLanguageSupportDomain({ adapters: installedAdapters() });
  await domain.commands.detectPythonSupport();

  const progressEvents = [];
  const completedEvents = [];
  const offP = domain.events.onActivationProgress((e) => progressEvents.push(e));
  const offC = domain.events.onActivationCompleted((e) => completedEvents.push(e));

  await domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '/tmp/p1' });
  offP();
  offC();

  assert.equal(progressEvents.length, 1);
  assert.equal(progressEvents[0].step, 'start_lsp');
  assert.equal(progressEvents[0].projectId, 'p1');
  assert.equal(completedEvents.length, 1);
  assert.equal(completedEvents[0].packId, 'python');
  assert.equal(completedEvents[0].projectId, 'p1');
  assert.ok(completedEvents[0].session.sessionId);
});

test('failed activation emits progress and failed events', async () => {
  const domain = createLanguageSupportDomain({
    adapters: installedAdapters({
      startPythonLsp: async () => ({
        ok: false,
        error: { category: 'Internal', code: 'python_lsp.start.failed', message: 'boom' }
      })
    })
  });
  await domain.commands.detectPythonSupport();

  const failedEvents = [];
  const offF = domain.events.onActivationFailed((e) => failedEvents.push(e));

  await domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '/tmp/p1' });
  offF();

  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].packId, 'python');
  assert.equal(failedEvents[0].error.code, 'python_lsp.start.failed');
});

// ---------------------------------------------------------------------------
// 1.3 Lifecycle Contract — project switch stops previous session
// ---------------------------------------------------------------------------

test('switching projects stops previous session before starting new one', async () => {
  const calls = [];
  const domain = createLanguageSupportDomain({
    adapters: installedAdapters({
      startPythonLsp: async ({ projectId }) => {
        calls.push(['start', projectId]);
        return { ok: true, data: { projectId, sessionId: `py-${projectId}`, ready: true } };
      },
      stopPythonLsp: async ({ projectId }) => {
        calls.push(['stop', projectId]);
        return { ok: true };
      }
    })
  });
  await domain.commands.detectPythonSupport();

  await domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '/tmp/p1' });
  await domain.commands.activatePythonForProject({ projectId: 'p2', projectRoot: '/tmp/p2' });

  assert.deepEqual(calls, [
    ['start', 'p1'],
    ['stop', 'p1'],
    ['start', 'p2']
  ]);
  assert.equal(domain.selectors.getActiveSession('python').projectId, 'p2');
});

// ---------------------------------------------------------------------------
// 1.4 Error Contract — all D5 canonical error codes have retry hints
// ---------------------------------------------------------------------------

const D5_ERROR_CODES = [
  'python_lsp.runtime.python_missing',
  'python_lsp.runtime.node_missing',
  'python_lsp.server.missing',
  'python_lsp.start.timeout',
  'python_lsp.start.failed',
  'python_lsp.transport.failed',
  'python_lsp.shutdown.failed'
];

test('every D5 canonical error code produces a non-empty retry hint via reportPythonRuntimeError', () => {
  const domain = createLanguageSupportDomain();
  for (const code of D5_ERROR_CODES) {
    const error = domain.commands.reportPythonRuntimeError({
      projectId: 'test',
      sessionId: 'test',
      error: { category: 'Internal', code, message: `test ${code}` }
    });
    assert.ok(error.retryHint, `missing retryHint for ${code}`);
    assert.ok(error.retryHint.length > 0, `empty retryHint for ${code}`);
  }
});

test('every error includes category, code, message, and retryHint fields', () => {
  const domain = createLanguageSupportDomain();
  for (const code of D5_ERROR_CODES) {
    const error = domain.commands.reportPythonRuntimeError({
      projectId: 'test',
      sessionId: 'test',
      error: { category: 'Internal', code, message: `test ${code}` }
    });
    assert.equal(typeof error.category, 'string');
    assert.equal(typeof error.code, 'string');
    assert.equal(typeof error.message, 'string');
    assert.equal(typeof error.retryHint, 'string');
  }
});

// ---------------------------------------------------------------------------
// 1.5 UX Consistency — setup commands are concrete copyable strings
// ---------------------------------------------------------------------------

test('setup commands for win32 are concrete shell commands', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: false }),
      detectNodeRuntime: async () => ({ available: false }),
      detectPyrightServer: async () => ({ available: false }),
      detectPlatform: () => 'win32'
    }
  });
  const result = await domain.commands.detectPythonSupport();

  assert.ok(result.setupPlan.commands.length > 0);
  for (const cmd of result.setupPlan.commands) {
    assert.equal(typeof cmd, 'string');
    assert.ok(cmd.length > 0);
    assert.ok(!cmd.includes('undefined'), `command contains undefined: ${cmd}`);
  }
  assert.ok(result.setupPlan.commands.some((c) => c.includes('winget')));
});

test('setup commands for darwin use brew', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: false }),
      detectNodeRuntime: async () => ({ available: false }),
      detectPyrightServer: async () => ({ available: false }),
      detectPlatform: () => 'darwin'
    }
  });
  const result = await domain.commands.detectPythonSupport();

  assert.ok(result.setupPlan.commands.some((c) => c.includes('brew')));
  assert.ok(result.setupPlan.commands.some((c) => c.includes('npm install -g pyright')));
});

test('setup commands for linux use apt-get', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: false }),
      detectNodeRuntime: async () => ({ available: false }),
      detectPyrightServer: async () => ({ available: false }),
      detectPlatform: () => 'linux'
    }
  });
  const result = await domain.commands.detectPythonSupport();

  assert.ok(result.setupPlan.commands.some((c) => c.includes('apt-get')));
  assert.ok(result.setupPlan.commands.some((c) => c.includes('npm install -g pyright')));
});

test('getPackSetupCommands selector returns same commands as detection result', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: false }),
      detectNodeRuntime: async () => ({ available: true }),
      detectPyrightServer: async () => ({ available: false }),
      detectPlatform: () => 'win32'
    }
  });
  const result = await domain.commands.detectPythonSupport();
  const fromSelector = domain.selectors.getPackSetupCommands('python');

  assert.deepEqual(fromSelector, result.setupPlan.commands);
});

// ---------------------------------------------------------------------------
// 1.5 UX Consistency — diagnostics are actionable strings
// ---------------------------------------------------------------------------

test('diagnostics for missing prerequisites are human-readable strings', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: false }),
      detectNodeRuntime: async () => ({ available: false }),
      detectPyrightServer: async () => ({ available: false })
    }
  });
  await domain.commands.detectPythonSupport();
  const diags = domain.selectors.getPackDiagnostics('python');

  assert.equal(diags.length, 3);
  for (const d of diags) {
    assert.equal(typeof d, 'string');
    assert.ok(d.length > 5, 'diagnostic too short to be actionable');
  }
});

// ---------------------------------------------------------------------------
// Lifecycle — teardown clears session and listeners
// ---------------------------------------------------------------------------

test('teardownPythonLifecycle stops session and detaches listeners', async () => {
  let unlistenCalled = false;
  const domain = createLanguageSupportDomain({
    adapters: installedAdapters({
      listenPythonLspEvents: async () => () => { unlistenCalled = true; },
      stopPythonLsp: async () => ({ ok: true })
    })
  });
  await domain.commands.detectPythonSupport();
  await domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '/tmp/p1' });
  await domain.commands.attachPythonListeners({ onDiagnostics: () => {} });

  await domain.commands.teardownPythonLifecycle();

  assert.equal(unlistenCalled, true);
  assert.equal(domain.selectors.getActiveSession('python'), null);
});
