import test from 'node:test';
import assert from 'node:assert/strict';

import { createLanguageSupportDomain } from '../../src/app/languageSupportDomain.js';

test('LanguageSupportDomain detects installed Python prerequisites as Installed', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: true, command: 'python', version: '3.12.0' }),
      detectNodeRuntime: async () => ({ available: true, command: 'node', version: '22.5.0' }),
      detectPyrightServer: async () => ({ available: true, command: 'pyright-langserver', version: '1.1.390' })
    }
  });

  const result = await domain.commands.detectPythonSupport();
  assert.equal(result.status, 'Installed');
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.prerequisites.python.available, true);
  assert.equal(result.prerequisites.server.available, true);
  assert.equal(domain.selectors.getPackStatus('python'), 'Installed');
});

test('LanguageSupportDomain reports Not Installed with actionable diagnostics when prerequisites are missing', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: false }),
      detectNodeRuntime: async () => ({ available: true, command: 'node' }),
      detectPyrightServer: async () => ({ available: false }),
      detectPlatform: () => 'win32'
    }
  });

  const result = await domain.commands.detectPythonSupport();
  assert.equal(result.status, 'Not Installed');
  assert.equal(result.diagnostics.includes('Python runtime not detected.'), true);
  assert.equal(result.diagnostics.includes('pyright-langserver is not installed.'), true);
  assert.deepEqual(result.setupPlan.commands, [
    'winget install Python.Python.3.12',
    'npm install -g pyright'
  ]);
});

test('LanguageSupportDomain maps detection failures to canonical Error state', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => {
        throw new Error('spawn failed');
      }
    }
  });

  const result = await domain.commands.detectPythonSupport();
  assert.equal(result.status, 'Error');
  assert.equal(result.error.code, 'python_lsp.detect.failed');
  assert.match(result.error.message, /spawn failed/i);
  assert.equal(domain.selectors.getPackStatus('python'), 'Error');
});

test('LanguageSupportDomain supports snapshot-based prerequisite detection adapter', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonSupportSnapshot: async () => ({
        python: { available: true, command: 'python', version: '3.12.0' },
        node: { available: true, command: 'node', version: '22.5.0' },
        server: { available: true, command: 'pyright-langserver', version: '1.1.390' }
      }),
      detectPythonRuntime: async () => {
        throw new Error('should not be called');
      }
    }
  });

  const result = await domain.commands.detectPythonSupport();
  assert.equal(result.status, 'Installed');
  assert.equal(result.prerequisites.server.command, 'pyright-langserver');
});

test('LanguageSupportDomain enforces canonical status vocabulary', () => {
  const domain = createLanguageSupportDomain();
  assert.equal(domain.commands.setPackStatus('python', 'Installing'), true);
  assert.equal(domain.selectors.getPackStatus('python'), 'Installing');
  assert.equal(domain.commands.setPackStatus('python', 'UnknownState'), false);
  assert.equal(domain.selectors.getPackStatus('python'), 'Installing');
});

test('LanguageSupportDomain exposes launch contract selector for Python pack', () => {
  const domain = createLanguageSupportDomain();
  const launch = domain.selectors.getPackLaunch('python');
  assert.deepEqual(launch, {
    command: 'pyright-langserver',
    args: ['--stdio'],
    cwdPolicy: 'project_root',
    envAllowlist: []
  });
});

test('LanguageSupportDomain emits typed setup events during guided setup detection', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: true, command: 'python', version: '3.12.0' }),
      detectNodeRuntime: async () => ({ available: true, command: 'node', version: '22.5.0' }),
      detectPyrightServer: async () => ({ available: true, command: 'pyright-langserver', version: '1.1.390' })
    }
  });

  const progressEvents = [];
  const completedEvents = [];

  const offProgress = domain.events.onSetupProgress((event) => progressEvents.push(event));
  const offCompleted = domain.events.onSetupCompleted((event) => completedEvents.push(event));

  const response = await domain.commands.runPythonSetupDetection();
  offProgress();
  offCompleted();

  assert.equal(response.ok, true);
  assert.equal(response.result.status, 'Installed');
  assert.equal(progressEvents.length, 3);
  assert.equal(progressEvents[0].step, 'detect_prerequisites');
  assert.equal(progressEvents[1].step, 'build_setup_plan');
  assert.equal(progressEvents[2].step, 'completed');
  assert.equal(completedEvents.length, 1);
  assert.equal(completedEvents[0].packId, 'python');
});

test('LanguageSupportDomain rolls back state and emits setup failure when setup detection throws', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => {
        throw new Error('probe failed');
      }
    }
  });

  const before = domain.selectors.getPackState('python');
  const failedEvents = [];
  const offFailed = domain.events.onSetupFailed((event) => failedEvents.push(event));

  const response = await domain.commands.runPythonSetupDetection();
  offFailed();

  assert.equal(response.ok, false);
  assert.equal(response.error.code, 'python_lsp.detect.failed');
  assert.equal(failedEvents.length, 1);
  assert.equal(failedEvents[0].error.code, 'python_lsp.detect.failed');

  const after = domain.selectors.getPackState('python');
  assert.deepEqual(after, before);
});

test('LanguageSupportDomain activates Python LSP for installed pack', async () => {
  const calls = [];
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: true, command: 'python' }),
      detectNodeRuntime: async () => ({ available: true, command: 'node' }),
      detectPyrightServer: async () => ({ available: true, command: 'pyright-langserver' }),
      startPythonLsp: async (payload) => {
        calls.push(['start', payload.projectId, payload.projectRoot, payload.command, payload.args.join(' ')]);
        return {
          ok: true,
          data: {
            projectId: payload.projectId,
            sessionId: 'py-lsp-1',
            ready: true
          }
        };
      }
    }
  });

  await domain.commands.detectPythonSupport();
  const activated = await domain.commands.activatePythonForProject({
    projectId: 'project-1',
    projectRoot: 'C:/projects/demo'
  });

  assert.equal(activated, true);
  assert.deepEqual(domain.selectors.getActiveSession('python'), {
    projectId: 'project-1',
    projectRoot: 'C:/projects/demo',
    sessionId: 'py-lsp-1',
    startedAt: domain.selectors.getActiveSession('python').startedAt
  });
  assert.equal(domain.selectors.getPackStatus('python'), 'Installed');
  assert.deepEqual(calls, [
    ['start', 'project-1', 'C:/projects/demo', 'pyright-langserver', '--stdio']
  ]);
});

test('LanguageSupportDomain tears down Python session on project switch and stop failures map to shutdown code', async () => {
  const calls = [];
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: true }),
      detectNodeRuntime: async () => ({ available: true }),
      detectPyrightServer: async () => ({ available: true }),
      startPythonLsp: async ({ projectId }) => ({
        ok: true,
        data: { projectId, sessionId: `session-${projectId}`, ready: true }
      }),
      stopPythonLsp: async ({ projectId }) => {
        calls.push(['stop', projectId]);
        if (projectId === 'project-2') {
          return {
            ok: false,
            error: {
              category: 'Internal',
              code: 'python_lsp.shutdown.failed',
              message: 'stop failed'
            }
          };
        }
        return { ok: true };
      }
    }
  });

  await domain.commands.detectPythonSupport();
  assert.equal(await domain.commands.activatePythonForProject({
    projectId: 'project-1',
    projectRoot: '/tmp/project-1'
  }), true);

  assert.equal(await domain.commands.activatePythonForProject({
    projectId: 'project-2',
    projectRoot: '/tmp/project-2'
  }), true);
  assert.equal(calls[0][1], 'project-1');

  const deactivated = await domain.commands.deactivatePythonForProject('project-2');
  assert.equal(deactivated, false);
  assert.equal(domain.selectors.getPackStatus('python'), 'Error');
  assert.equal(domain.selectors.getPackState('python').error.code, 'python_lsp.shutdown.failed');
});

test('LanguageSupportDomain attach/detach Python listeners is deterministic', async () => {
  let unlistenCallCount = 0;
  const domain = createLanguageSupportDomain({
    adapters: {
      listenPythonLspEvents: async () => () => {
        unlistenCallCount += 1;
      }
    }
  });

  await domain.commands.attachPythonListeners({ onDiagnostics: () => {} });
  await domain.commands.attachPythonListeners({ onDiagnostics: () => {} });
  domain.commands.detachPythonListeners();

  assert.equal(unlistenCallCount, 2);
});

test('LanguageSupportDomain reports runtime transport errors with retry hint and exposes last failed operation', () => {
  const domain = createLanguageSupportDomain();
  const error = domain.commands.reportPythonRuntimeError({
    projectId: 'project-9',
    sessionId: 'session-9',
    error: {
      category: 'Internal',
      code: 'python_lsp.transport.failed',
      message: 'bridge dropped'
    }
  });

  assert.equal(error.code, 'python_lsp.transport.failed');
  assert.match(error.retryHint, /restart the app/i);
  const packError = domain.selectors.getPackError('python');
  assert.equal(packError.code, 'python_lsp.transport.failed');
  const lastFailed = domain.selectors.getLastFailedOperation('python');
  assert.equal(lastFailed.operation, 'activate');
  assert.equal(lastFailed.projectId, 'project-9');
});

test('LanguageSupportDomain retryLastFailedPythonOperation retries failed activation using stored project context', async () => {
  const starts = [];
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonRuntime: async () => ({ available: true, command: 'python' }),
      detectNodeRuntime: async () => ({ available: true, command: 'node' }),
      detectPyrightServer: async () => ({ available: true, command: 'pyright-langserver' }),
      startPythonLsp: async ({ projectId }) => {
        starts.push(projectId);
        if (starts.length === 1) {
          return {
            ok: false,
            error: {
              category: 'Internal',
              code: 'python_lsp.start.failed',
              message: 'spawn failed'
            }
          };
        }
        return {
          ok: true,
          data: {
            projectId,
            sessionId: 'retry-session',
            ready: true
          }
        };
      }
    }
  });

  await domain.commands.detectPythonSupport();
  const first = await domain.commands.activatePythonForProject({
    projectId: 'project-retry',
    projectRoot: '/tmp/project-retry'
  });
  assert.equal(first, false);
  assert.equal(domain.selectors.getPackError('python').code, 'python_lsp.start.failed');

  const retried = await domain.commands.retryLastFailedPythonOperation();
  assert.equal(retried, true);
  assert.equal(starts.length, 2);
  assert.equal(domain.selectors.getPackStatus('python'), 'Installed');
});

// ---------------------------------------------------------------------------
// Python interpreter probe (ADR-020 Slice 1)
// ---------------------------------------------------------------------------

test('LanguageSupportDomain stores probed interpreters and exposes them via selector', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      listPythonInterpreters: async () => ({
        interpreters: [
          {
            path: 'C:\\Py313\\python.exe',
            version: '3.13.5',
            source: 'uv',
            implementation: 'cpython',
            variant: 'default',
            arch: 'x86_64'
          },
          { path: 'C:\\Py39\\python.exe', version: '3.9.13', source: 'registry' }
        ],
        excluded: [
          {
            path: 'C:\\U\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe',
            reason: 'windows-store-stub'
          }
        ]
      })
    }
  });

  const result = await domain.commands.probePythonInterpreters();
  assert.equal(result.interpreters.length, 2);
  assert.equal(result.interpreters[0].path, 'C:\\Py313\\python.exe');
  assert.equal(result.interpreters[0].source, 'uv');
  // Missing metadata normalizes to nulls, not undefined.
  assert.equal(result.interpreters[1].implementation, null);
  assert.equal(result.excluded[0].reason, 'windows-store-stub');
  assert.equal(result.error, null);
  assert.ok(result.lastProbedAt);

  const selected = domain.selectors.getPythonInterpreters();
  assert.deepEqual(selected.interpreters, result.interpreters);
  // Selector returns clones — mutating them must not touch domain state.
  selected.interpreters[0].path = 'mutated';
  assert.equal(
    domain.selectors.getPythonInterpreters().interpreters[0].path,
    'C:\\Py313\\python.exe'
  );
});

test('LanguageSupportDomain treats an empty probe as a result, not an error', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      listPythonInterpreters: async () => ({ interpreters: [], excluded: [] })
    }
  });

  const result = await domain.commands.probePythonInterpreters();
  assert.deepEqual(result.interpreters, []);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.error, null);
});

test('LanguageSupportDomain drops malformed interpreter entries instead of failing', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      listPythonInterpreters: async () => ({
        interpreters: [
          null,
          {},
          { path: '   ' },
          { path: '/usr/bin/python3', version: '3.12.4' }
        ],
        excluded: [null, { reason: 'no-path' }]
      })
    }
  });

  const result = await domain.commands.probePythonInterpreters();
  assert.equal(result.interpreters.length, 1);
  assert.equal(result.interpreters[0].path, '/usr/bin/python3');
  assert.equal(result.interpreters[0].source, 'path');
  assert.deepEqual(result.excluded, []);
});

test('LanguageSupportDomain records probe failure without losing prior inventory', async () => {
  let fail = false;
  const domain = createLanguageSupportDomain({
    adapters: {
      listPythonInterpreters: async () => {
        if (fail) throw new Error('reg query hung');
        return {
          interpreters: [{ path: 'C:\\Py\\python.exe', version: '3.13.5', source: 'uv' }],
          excluded: []
        };
      }
    }
  });

  await domain.commands.probePythonInterpreters();
  fail = true;
  const result = await domain.commands.probePythonInterpreters();
  assert.equal(result.error.code, 'python_probe.failed');
  assert.match(result.error.message, /reg query hung/i);
  // Prior inventory survives the failed re-probe.
  assert.equal(result.interpreters.length, 1);
  assert.equal(result.interpreters[0].path, 'C:\\Py\\python.exe');
});

test('LanguageSupportDomain probe defaults to empty inventory with no adapter', async () => {
  const domain = createLanguageSupportDomain({ adapters: {} });
  const result = await domain.commands.probePythonInterpreters();
  assert.deepEqual(result.interpreters, []);
  assert.deepEqual(result.excluded, []);
  assert.equal(result.error, null);
});

// ---------------------------------------------------------------------------
// Managed-language commands (ADR-005 Slice 6) — generic by languageId, gated
// on the backend resolver's tier rather than a prerequisite list.
// ---------------------------------------------------------------------------

test('managed detect maps resolver tier to Installed and probes to hints', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async (languageId) => {
        assert.equal(languageId, 'rust');
        return {
          languageId: 'rust',
          allMet: false, // cargo missing — must NOT gate
          probes: [{ displayName: 'Rust toolchain (cargo)', command: 'cargo', available: false }],
          resolutionTier: 'managed'
        };
      }
    }
  });

  const result = await domain.commands.detectManagedSupport('rust');
  assert.equal(result.status, 'Installed');
  assert.equal(result.resolutionTier, 'managed');
  assert.equal(result.toolchainHints.length, 1);
  assert.match(result.toolchainHints[0], /cargo/i);
  assert.equal(domain.selectors.getManagedPackState('rust').status, 'Installed');
});

test('managed detect without a resolved server is Not Installed', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => ({ probes: [], resolutionTier: null })
    }
  });

  const result = await domain.commands.detectManagedSupport('cpp');
  assert.equal(result.status, 'Not Installed');
  assert.equal(result.resolutionTier, null);
  assert.equal(result.diagnostics.includes('Language server not installed.'), true);
});

test('managed detect failure lands in canonical Error state with language-scoped code', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => {
        throw new Error('ipc exploded');
      }
    }
  });

  const result = await domain.commands.detectManagedSupport('rust');
  assert.equal(result.status, 'Error');
  assert.equal(result.error.code, 'rust_lsp.detect.failed');
  assert.match(result.error.message, /ipc exploded/i);
});

test('managed activation refuses to start without a resolved tier', async () => {
  let started = false;
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => ({ probes: [], resolutionTier: null }),
      startManagedLsp: async () => {
        started = true;
        return { ok: true, data: { sessionId: 's', ready: true } };
      }
    }
  });

  await domain.commands.detectManagedSupport('rust');
  const activated = await domain.commands.activateManagedForProject('rust', {
    projectId: 'p1',
    projectRoot: 'C:/proj'
  });
  assert.equal(activated, false);
  assert.equal(started, false);
  assert.equal(domain.selectors.getActiveManagedSession('rust'), null);
});

test('ensureManagedActiveForProject runs detect → gate → activate in one call', async () => {
  const calls = [];
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => {
        calls.push('detect');
        return { probes: [], resolutionTier: 'global' };
      },
      startManagedLsp: async ({ languageId, projectId }) => {
        calls.push('start');
        return { ok: true, data: { sessionId: `${languageId}-${projectId}`, ready: true } };
      }
    }
  });

  const ok = await domain.commands.ensureManagedActiveForProject('cpp', {
    projectId: 'p1',
    projectRoot: 'C:/proj'
  });
  assert.equal(ok, true);
  assert.deepEqual(calls, ['detect', 'start']);
  const session = domain.selectors.getActiveManagedSession('cpp');
  assert.equal(session.projectId, 'p1');
  assert.equal(session.sessionId, 'cpp-p1');

  // Second call is a no-op while the session is live (StrictMode-safe).
  const again = await domain.commands.ensureManagedActiveForProject('cpp', {
    projectId: 'p1',
    projectRoot: 'C:/proj'
  });
  assert.equal(again, true);
  assert.deepEqual(calls, ['detect', 'start']);
});

test('managed activation failure surfaces language-scoped start error', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => ({ probes: [], resolutionTier: 'managed' }),
      startManagedLsp: async () => ({ ok: false, error: new Error('spawn refused') })
    }
  });

  const ok = await domain.commands.ensureManagedActiveForProject('rust', {
    projectId: 'p1',
    projectRoot: 'C:/proj'
  });
  assert.equal(ok, false);
  const pack = domain.selectors.getManagedPackState('rust');
  assert.equal(pack.status, 'Error');
  assert.equal(pack.error.code, 'rust_lsp.start.failed');
});

test('managed activation stops the previous project session before starting the next', async () => {
  const stopped = [];
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => ({ probes: [], resolutionTier: 'managed' }),
      startManagedLsp: async ({ languageId, projectId }) => (
        { ok: true, data: { sessionId: `${languageId}-${projectId}`, ready: true } }
      ),
      stopManagedLsp: async ({ projectId }) => {
        stopped.push(projectId);
        return { ok: true };
      }
    }
  });

  await domain.commands.ensureManagedActiveForProject('rust', { projectId: 'p1', projectRoot: 'C:/a' });
  await domain.commands.ensureManagedActiveForProject('rust', { projectId: 'p2', projectRoot: 'C:/b' });
  assert.deepEqual(stopped, ['p1']);
  assert.equal(domain.selectors.getActiveManagedSession('rust').projectId, 'p2');
});

test('managed deactivation returns the pack to its detected status', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => ({ probes: [], resolutionTier: 'managed' }),
      startManagedLsp: async () => ({ ok: true, data: { sessionId: 's1', ready: true } }),
      stopManagedLsp: async () => ({ ok: true })
    }
  });

  await domain.commands.ensureManagedActiveForProject('rust', { projectId: 'p1', projectRoot: 'C:/a' });
  const ok = await domain.commands.deactivateManagedForProject('rust');
  assert.equal(ok, true);
  assert.equal(domain.selectors.getActiveManagedSession('rust'), null);
  assert.equal(domain.selectors.getManagedPackState('rust').status, 'Installed');
});

test('teardownManagedLifecycle stops every managed session and detaches listeners', async () => {
  const stopped = [];
  let detached = false;
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => ({ probes: [], resolutionTier: 'managed' }),
      startManagedLsp: async ({ languageId }) => (
        { ok: true, data: { sessionId: `${languageId}-s`, ready: true } }
      ),
      stopManagedLsp: async ({ languageId }) => {
        stopped.push(languageId);
        return { ok: true };
      },
      listenManagedLspEvents: async () => () => {
        detached = true;
      }
    }
  });

  await domain.commands.attachManagedListeners({ onError: () => {} });
  await domain.commands.ensureManagedActiveForProject('rust', { projectId: 'p1', projectRoot: 'C:/a' });
  await domain.commands.ensureManagedActiveForProject('cpp', { projectId: 'p1', projectRoot: 'C:/a' });

  const ok = await domain.commands.teardownManagedLifecycle();
  assert.equal(ok, true);
  assert.equal(detached, true);
  assert.deepEqual(stopped.sort(), ['cpp', 'rust']);
  assert.equal(domain.selectors.getActiveManagedSession('rust'), null);
  assert.equal(domain.selectors.getActiveManagedSession('cpp'), null);
});

test('clearManagedSession clears externally-ended sessions (Slice 7 uninstall)', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => ({ probes: [], resolutionTier: 'managed' }),
      startManagedLsp: async () => ({ ok: true, data: { sessionId: 'rust-s1', ready: true } })
    }
  });

  await domain.commands.ensureManagedActiveForProject('rust', { projectId: 'p1', projectRoot: 'C:/a' });

  // Wrong session id → no-op (a replay of an old event must not clear a new session).
  assert.equal(domain.commands.clearManagedSession('rust', { sessionId: 'stale' }), false);
  assert.notEqual(domain.selectors.getActiveManagedSession('rust'), null);

  // Matching id → cleared; status falls back to detected reality.
  assert.equal(domain.commands.clearManagedSession('rust', { sessionId: 'rust-s1' }), true);
  assert.equal(domain.selectors.getActiveManagedSession('rust'), null);
  assert.equal(domain.selectors.getManagedPackState('rust').status, 'Installed');

  // No session / unknown language → false, no throw.
  assert.equal(domain.commands.clearManagedSession('rust'), false);
  assert.equal(domain.commands.clearManagedSession('cpp'), false);
});

test('managed runtime error report marks only the named language pack', async () => {
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => ({ probes: [], resolutionTier: 'managed' }),
      startManagedLsp: async () => ({ ok: true, data: { sessionId: 's', ready: true } })
    }
  });

  await domain.commands.ensureManagedActiveForProject('rust', { projectId: 'p1', projectRoot: 'C:/a' });
  await domain.commands.ensureManagedActiveForProject('cpp', { projectId: 'p1', projectRoot: 'C:/a' });

  const normalized = domain.commands.reportManagedRuntimeError('rust', {
    projectId: 'p1',
    error: { category: 'Transport', code: 'rust_lsp.transport.failed', message: 'pipe closed' }
  });
  assert.equal(normalized.code, 'rust_lsp.transport.failed');
  assert.equal(domain.selectors.getManagedPackState('rust').status, 'Error');
  assert.equal(domain.selectors.getManagedPackState('cpp').status, 'Installed');
});

// ---------------------------------------------------------------------------
// Activation in-flight dedup (2026-07-17 crash-loop regression)
// StrictMode double-fires the lifecycle effect; without dedup, two concurrent
// activations raced the backend session registry's check-then-insert window
// and the second insert replaced (and thereby killed) the first session.
// ---------------------------------------------------------------------------

function pythonReadySnapshot() {
  return {
    python: { available: true, command: 'python', version: '3.12.0' },
    node: { available: true, command: 'node', version: '22.5.0' },
    server: { available: true, command: 'pyright-langserver', version: '1.1.390' }
  };
}

test('concurrent python activations dedupe to a single backend start', async () => {
  let startCalls = 0;
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonSupportSnapshot: async () => pythonReadySnapshot(),
      startPythonLsp: async () => {
        startCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ok: true, data: { sessionId: 'sess-1', ready: true } };
      }
    }
  });
  await domain.commands.detectPythonSupport();

  const [first, second] = await Promise.all([
    domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '/p1' }),
    domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '/p1' })
  ]);

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(startCalls, 1);
  assert.equal(domain.selectors.getActiveSession('python')?.projectId, 'p1');
});

test('activation dedup clears on settle so a retry issues a fresh start', async () => {
  let startCalls = 0;
  const domain = createLanguageSupportDomain({
    adapters: {
      detectPythonSupportSnapshot: async () => pythonReadySnapshot(),
      startPythonLsp: async () => {
        startCalls += 1;
        if (startCalls === 1) {
          return { ok: false, error: { code: 'python_lsp.start.failed', message: 'boom' } };
        }
        return { ok: true, data: { sessionId: 'sess-2', ready: true } };
      }
    }
  });
  await domain.commands.detectPythonSupport();

  const first = await domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '/p1' });
  assert.equal(first, false);

  const second = await domain.commands.activatePythonForProject({ projectId: 'p1', projectRoot: '/p1' });
  assert.equal(second, true);
  assert.equal(startCalls, 2);
});

test('concurrent managed activations dedupe per language', async () => {
  let rustStarts = 0;
  const domain = createLanguageSupportDomain({
    adapters: {
      detectManagedSupport: async () => ({
        languageId: 'rust',
        allMet: true,
        resolutionTier: 'global',
        probes: []
      }),
      startManagedLsp: async () => {
        rustStarts += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        return { ok: true, data: { sessionId: 'rust-1', ready: true } };
      }
    }
  });
  await domain.commands.detectManagedSupport('rust');

  const [first, second] = await Promise.all([
    domain.commands.activateManagedForProject('rust', { projectId: 'p1', projectRoot: '/p1' }),
    domain.commands.activateManagedForProject('rust', { projectId: 'p1', projectRoot: '/p1' })
  ]);

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(rustStarts, 1);
});
