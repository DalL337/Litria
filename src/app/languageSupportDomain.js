const CANONICAL_STATUSES = new Set([
  'Not Installed',
  'Installing',
  'Installed',
  'Update Available',
  'Error'
]);

const PYTHON_PACK_ID = 'python';
const PYRIGHT_LAUNCH_COMMAND = 'pyright-langserver';
const PYRIGHT_LAUNCH_ARGS = ['--stdio'];

const TS_PACK_ID = 'typescript';
const TSSERVER_LAUNCH_COMMAND = 'typescript-language-server';
const TSSERVER_LAUNCH_ARGS = ['--stdio'];

const PROGRESS_STEPS = Object.freeze({
  detect: 'detect_prerequisites',
  plan: 'build_setup_plan',
  complete: 'completed'
});
const ACTIVATION_STEPS = Object.freeze({
  start: 'start_lsp',
  stop: 'stop_lsp'
});

function toBoolean(value) {
  return value === true;
}

function normalizeRuntimeResult(result) {
  if (!result || typeof result !== 'object') {
    return { available: false, command: null, version: null };
  }
  const command = typeof result.command === 'string' && result.command.trim()
    ? result.command.trim()
    : null;
  const version = typeof result.version === 'string' && result.version.trim()
    ? result.version.trim()
    : null;
  return {
    available: toBoolean(result.available),
    command,
    version
  };
}

/**
 * Normalize one interpreter entry from the python probe (ADR-020 Slice 1).
 * Backend shape: { path, version, source, implementation, variant, arch }.
 * Path is required; everything else is best-effort metadata.
 */
function normalizeInterpreterResult(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const path = typeof entry.path === 'string' && entry.path.trim() ? entry.path.trim() : null;
  if (!path) return null;
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    path,
    version: str(entry.version),
    source: str(entry.source) ?? 'path',
    implementation: str(entry.implementation),
    variant: str(entry.variant),
    arch: str(entry.arch)
  };
}

function cloneInterpreterState(interpreterState) {
  return {
    interpreters: interpreterState.interpreters.map((i) => ({ ...i })),
    excluded: interpreterState.excluded.map((e) => ({ ...e })),
    uvAvailable: interpreterState.uvAvailable === true,
    lastProbedAt: interpreterState.lastProbedAt,
    error: interpreterState.error ? { ...interpreterState.error } : null
  };
}

function normalizeError(error, fallbackCode, fallbackMessage) {
  if (error && typeof error === 'object') {
    const category = typeof error.category === 'string' && error.category.trim()
      ? error.category.trim()
      : 'Internal';
    const code = typeof error.code === 'string' && error.code.trim()
      ? error.code.trim()
      : fallbackCode;
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : fallbackMessage;
    const retryHint = typeof error.retryHint === 'string' && error.retryHint.trim()
      ? error.retryHint.trim()
      : null;
    return { category, code, message, retryHint };
  }

  if (error instanceof Error) {
    return {
      category: 'Internal',
      code: fallbackCode,
      message: error.message || fallbackMessage,
      retryHint: null
    };
  }

  return {
    category: 'Internal',
    code: fallbackCode,
    message: fallbackMessage,
    retryHint: null
  };
}

function withRetryHint(error, retryHint) {
  if (!error) return null;
  if (error.retryHint) return error;
  return {
    ...error,
    retryHint
  };
}

function clonePackState(packState) {
  return {
    ...packState,
    prerequisites: Object.fromEntries(
      Object.entries(packState.prerequisites).map(([k, v]) => [k, { ...v }])
    ),
    launch: {
      command: packState.launch.command,
      args: [...packState.launch.args],
      cwdPolicy: packState.launch.cwdPolicy,
      envAllowlist: [...packState.launch.envAllowlist]
    },
    setupPlan: {
      required: packState.setupPlan.required,
      commands: [...packState.setupPlan.commands]
    },
    session: packState.session ? { ...packState.session } : null,
    diagnostics: [...packState.diagnostics],
    error: packState.error ? { ...packState.error } : null
  };
}

function buildDiagnostics(packState) {
  const diagnostics = [];
  if (!packState.prerequisites.python.available) {
    diagnostics.push('Python runtime not detected.');
  }
  if (!packState.prerequisites.node.available) {
    diagnostics.push('Node runtime not detected.');
  }
  if (!packState.prerequisites.server.available) {
    diagnostics.push('pyright-langserver is not installed.');
  }
  return diagnostics;
}

function buildSetupCommands({ platform, missingPython, missingNode, missingServer }) {
  const commands = [];
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';

  if (missingPython) {
    if (isWindows) {
      commands.push('winget install Python.Python.3.12');
    } else if (isMac) {
      commands.push('brew install python');
    } else {
      commands.push('sudo apt-get install -y python3 python3-pip');
    }
  }

  if (missingNode) {
    if (isWindows) {
      commands.push('winget install OpenJS.NodeJS.LTS');
    } else if (isMac) {
      commands.push('brew install node');
    } else {
      commands.push('sudo apt-get install -y nodejs npm');
    }
  }

  if (missingServer) {
    commands.push('npm install -g pyright');
  }

  return commands;
}

function getRetryHintForCode(code) {
  switch (code) {
    case 'python_lsp.runtime.python_missing':
      return 'Install Python 3 and retry detection.';
    case 'python_lsp.runtime.node_missing':
      return 'Install Node.js LTS and retry detection.';
    case 'python_lsp.server.missing':
      return 'Run `npm install -g pyright` and retry.';
    case 'python_lsp.start.failed':
      return 'Verify pyright is installed and project path is valid, then retry.';
    case 'python_lsp.start.timeout':
      return 'Retry start. If it repeats, restart the app and verify pyright installation.';
    case 'python_lsp.shutdown.failed':
      return 'Retry stop. If the process is stuck, restart the app.';
    case 'python_lsp.transport.failed':
      return 'Restart the app and retry Python LSP activation.';
    default:
      return 'Retry the operation after verifying Python prerequisites.';
  }
}

// ---------------------------------------------------------------------------
// Managed-language helpers (ADR-005 Slice 6)
//
// Registry languages (rust, cpp) share ONE generic command set keyed by
// languageId instead of the per-language command pairs above. The gate is
// the backend resolver's answer (`resolutionTier`: global/managed/bundled or
// null), not a prerequisite list — pack prerequisites for these languages
// are toolchain HINTS (detect + hint, never install, never gate; ADR-005
// Scope Notes). Python/TS keep their bespoke paths: their multi-probe setup
// guidance predates this and migrating them is not Slice 6's job.
// ---------------------------------------------------------------------------

function createManagedPackState(languageId) {
  return {
    packId: languageId,
    status: 'Not Installed',
    resolutionTier: null,
    toolchainHints: [],
    session: null,
    diagnostics: [],
    lastCheckedAt: null,
    error: null
  };
}

function cloneManagedPackState(pack) {
  return {
    ...pack,
    toolchainHints: [...pack.toolchainHints],
    diagnostics: [...pack.diagnostics],
    session: pack.session ? { ...pack.session } : null,
    error: pack.error ? { ...pack.error } : null
  };
}

function getManagedRetryHintForCode(languageId, code) {
  if (code === `${languageId}_lsp.start.failed`) {
    return 'Verify the language server is installed and the project path is valid, then retry.';
  }
  if (code === `${languageId}_lsp.start.timeout`) {
    return 'Retry start. If it repeats, restart the app and verify the server installation.';
  }
  if (code === `${languageId}_lsp.shutdown.failed`) {
    return 'Retry stop. If the process is stuck, restart the app.';
  }
  if (code === `${languageId}_lsp.transport.failed`) {
    return 'Restart the app and retry language server activation.';
  }
  return 'Retry the operation after verifying the language server is installed.';
}

// ---------------------------------------------------------------------------
// TypeScript-specific helpers
// ---------------------------------------------------------------------------

function buildTsDiagnostics(packState) {
  const diagnostics = [];
  if (!packState.prerequisites.node.available) {
    diagnostics.push('Node runtime not detected.');
  }
  if (!packState.prerequisites.server.available) {
    diagnostics.push('typescript-language-server is not installed.');
  }
  if (!packState.prerequisites.tsc.available) {
    diagnostics.push('TypeScript compiler (tsc) is not installed.');
  }
  return diagnostics;
}

function buildTsSetupCommands({ platform, missingNode, missingServer, missingTsc }) {
  const commands = [];
  const isWindows = platform === 'win32';
  const isMac = platform === 'darwin';

  if (missingNode) {
    if (isWindows) {
      commands.push('winget install OpenJS.NodeJS.LTS');
    } else if (isMac) {
      commands.push('brew install node');
    } else {
      commands.push('sudo apt-get install -y nodejs npm');
    }
  }

  if (missingServer || missingTsc) {
    commands.push('npm install -g typescript typescript-language-server');
  }

  return commands;
}

function getTsRetryHintForCode(code) {
  switch (code) {
    case 'typescript_lsp.runtime.node_missing':
      return 'Install Node.js LTS and retry detection.';
    case 'typescript_lsp.server.missing':
      return 'Run `npm install -g typescript typescript-language-server` and retry.';
    case 'typescript_lsp.start.failed':
      return 'Verify typescript-language-server is installed and project path is valid, then retry.';
    case 'typescript_lsp.start.timeout':
      return 'Retry start. If it repeats, restart the app and verify TypeScript installation.';
    case 'typescript_lsp.shutdown.failed':
      return 'Retry stop. If the process is stuck, restart the app.';
    case 'typescript_lsp.transport.failed':
      return 'Restart the app and retry TypeScript LSP activation.';
    default:
      return 'Retry the operation after verifying TypeScript prerequisites.';
  }
}

export function createLanguageSupportDomain({ adapters = {} } = {}) {
  const setupProgressListeners = new Set();
  const setupCompletedListeners = new Set();
  const setupFailedListeners = new Set();
  const activationProgressListeners = new Set();
  const activationCompletedListeners = new Set();
  const activationFailedListeners = new Set();

  const io = {
    // Python adapters
    detectPythonSupportSnapshot: adapters.detectPythonSupportSnapshot ?? null,
    detectPythonRuntime: adapters.detectPythonRuntime ?? (async () => ({ available: false })),
    detectNodeRuntime: adapters.detectNodeRuntime ?? (async () => ({ available: false })),
    detectPyrightServer: adapters.detectPyrightServer ?? (async () => ({ available: false })),
    listPythonInterpreters: adapters.listPythonInterpreters
      ?? (async () => ({ interpreters: [], excluded: [] })),
    detectPlatform: adapters.detectPlatform ?? (() => 'unknown'),
    startPythonLsp: adapters.startPythonLsp ?? (async ({ projectId }) => ({
      ok: true,
      data: {
        projectId,
        sessionId: `python-lsp-${projectId}`,
        ready: true
      }
    })),
    stopPythonLsp: adapters.stopPythonLsp ?? (async () => ({ ok: true })),
    listenPythonLspEvents: adapters.listenPythonLspEvents ?? (async () => (() => {})),
    // TypeScript adapters
    detectTsSupportSnapshot: adapters.detectTsSupportSnapshot ?? null,
    startTsLsp: adapters.startTsLsp ?? (async ({ projectId }) => ({
      ok: true,
      data: {
        projectId,
        sessionId: `typescript-lsp-${projectId}`,
        ready: true
      }
    })),
    stopTsLsp: adapters.stopTsLsp ?? (async () => ({ ok: true })),
    listenTsLspEvents: adapters.listenTsLspEvents ?? (async () => (() => {})),
    // Managed-language adapters (ADR-005 Slice 6) — generic by languageId
    detectManagedSupport: adapters.detectManagedSupport
      ?? (async () => ({ allMet: false, probes: [], resolutionTier: null })),
    startManagedLsp: adapters.startManagedLsp ?? (async ({ languageId, projectId }) => ({
      ok: true,
      data: {
        projectId,
        sessionId: `${languageId}-lsp-${projectId}`,
        ready: true
      }
    })),
    stopManagedLsp: adapters.stopManagedLsp ?? (async () => ({ ok: true })),
    listenManagedLspEvents: adapters.listenManagedLspEvents ?? (async () => (() => {}))
  };

  function emit(listeners, payload) {
    listeners.forEach((listener) => {
      try {
        listener(payload);
      } catch {
        // Ignore listener failures so core flow remains deterministic.
      }
    });
  }

  function subscribe(listeners, handler) {
    if (typeof handler !== 'function') return () => {};
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }

  // One activation per pack at a time: a second concurrent call awaits the
  // first instead of issuing another backend start. The entry is cleared on
  // settle so retries after a failure start fresh.
  function dedupeActivation(key, run) {
    const existing = state.activationsInFlight.get(key);
    if (existing) return existing;
    const promise = Promise.resolve()
      .then(run)
      .finally(() => {
        state.activationsInFlight.delete(key);
      });
    state.activationsInFlight.set(key, promise);
    return promise;
  }

  const state = {
    pythonLspUnlisten: null,
    tsLspUnlisten: null,
    managedLspUnlisten: null,
    lastFailedOperation: null,
    tsLastFailedOperation: null,
    // In-flight activation promises, keyed by pack/language id. Dedup for
    // concurrent activate calls (2026-07-17 crash-loop: StrictMode
    // double-fires the lifecycle effect; two concurrent backend starts race
    // the session registry's check-then-insert window).
    activationsInFlight: new Map(),
    // Managed registry languages (ADR-005 Slice 6): languageId → pack state,
    // created lazily so the domain stays agnostic of the registry's contents.
    managedPacks: {},
    // Machine-wide interpreter inventory (ADR-020 Slice 1) — deliberately
    // separate from pack prerequisite state: prerequisites answer "can the
    // LSP run", this answers "which Pythons exist" (wizard + diagnostics).
    pythonInterpreters: {
      interpreters: [],
      excluded: [],
      uvAvailable: false,
      lastProbedAt: null,
      error: null
    },
    packs: {
      [PYTHON_PACK_ID]: {
        packId: PYTHON_PACK_ID,
        status: 'Not Installed',
        prerequisites: {
          python: { available: false, command: null, version: null },
          node: { available: false, command: null, version: null },
          server: { available: false, command: null, version: null }
        },
        launch: {
          command: PYRIGHT_LAUNCH_COMMAND,
          args: [...PYRIGHT_LAUNCH_ARGS],
          cwdPolicy: 'project_root',
          envAllowlist: []
        },
        setupPlan: {
          required: true,
          commands: []
        },
        session: null,
        diagnostics: [],
        lastCheckedAt: null,
        error: null
      },
      [TS_PACK_ID]: {
        packId: TS_PACK_ID,
        status: 'Not Installed',
        prerequisites: {
          node: { available: false, command: null, version: null },
          server: { available: false, command: null, version: null },
          tsc: { available: false, command: null, version: null }
        },
        launch: {
          command: TSSERVER_LAUNCH_COMMAND,
          args: [...TSSERVER_LAUNCH_ARGS],
          cwdPolicy: 'project_root',
          envAllowlist: []
        },
        setupPlan: {
          required: true,
          commands: []
        },
        session: null,
        diagnostics: [],
        lastCheckedAt: null,
        error: null
      }
    }
  };

  function getManagedPack(languageId) {
    if (!state.managedPacks[languageId]) {
      state.managedPacks[languageId] = createManagedPackState(languageId);
    }
    return state.managedPacks[languageId];
  }

  return {
    commands: {
      /**
       * Enumerate every Python interpreter on this machine via the backend
       * probe (uv JSON, PEP 514 registry, py launcher, PATH — merged and
       * sorted best-first; first entry = recommended default). "None found"
       * is a valid result; the Windows Store stub arrives under `excluded`.
       */
      async probePythonInterpreters() {
        try {
          const report = await io.listPythonInterpreters();
          const interpreters = (Array.isArray(report?.interpreters) ? report.interpreters : [])
            .map(normalizeInterpreterResult)
            .filter(Boolean);
          const excluded = (Array.isArray(report?.excluded) ? report.excluded : [])
            .map((entry) => {
              const path = typeof entry?.path === 'string' && entry.path.trim()
                ? entry.path.trim()
                : null;
              if (!path) return null;
              const reason = typeof entry?.reason === 'string' && entry.reason.trim()
                ? entry.reason.trim()
                : 'unknown';
              return { path, reason };
            })
            .filter(Boolean);
          state.pythonInterpreters = {
            interpreters,
            excluded,
            uvAvailable: report?.uvAvailable === true,
            lastProbedAt: new Date().toISOString(),
            error: null
          };
        } catch (error) {
          state.pythonInterpreters = {
            ...state.pythonInterpreters,
            lastProbedAt: new Date().toISOString(),
            error: normalizeError(
              error,
              'python_probe.failed',
              'Failed to enumerate Python interpreters.'
            )
          };
        }
        return cloneInterpreterState(state.pythonInterpreters);
      },
      async detectPythonSupport() {
        const pack = state.packs[PYTHON_PACK_ID];
        try {
          let python;
          let node;
          let server;

          if (typeof io.detectPythonSupportSnapshot === 'function') {
            const snapshot = await io.detectPythonSupportSnapshot();
            python = snapshot?.python ?? { available: false };
            node = snapshot?.node ?? { available: false };
            server = snapshot?.server ?? { available: false };
          } else {
            [python, node, server] = await Promise.all([
              io.detectPythonRuntime(),
              io.detectNodeRuntime(),
              io.detectPyrightServer()
            ]);
          }
          pack.prerequisites.python = normalizeRuntimeResult(python);
          pack.prerequisites.node = normalizeRuntimeResult(node);
          pack.prerequisites.server = normalizeRuntimeResult(server);
          pack.lastCheckedAt = new Date().toISOString();
          pack.error = null;
          pack.diagnostics = buildDiagnostics(pack);
          pack.setupPlan.required = pack.diagnostics.length > 0;
          if (pack.setupPlan.required) {
            const platform = io.detectPlatform();
            pack.setupPlan.commands = buildSetupCommands({
              platform,
              missingPython: !pack.prerequisites.python.available,
              missingNode: !pack.prerequisites.node.available,
              missingServer: !pack.prerequisites.server.available
            });
          } else {
            pack.setupPlan.commands = [];
          }
          pack.status = pack.diagnostics.length ? 'Not Installed' : 'Installed';
          if (pack.status === 'Installed') {
            state.lastFailedOperation = null;
          }
          return clonePackState(pack);
        } catch (error) {
          pack.lastCheckedAt = new Date().toISOString();
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            error,
            'python_lsp.detect.failed',
            'Failed to detect Python language support prerequisites.'
          ), getRetryHintForCode('python_lsp.detect.failed'));
          pack.diagnostics = [pack.error.message];
          pack.setupPlan.required = true;
          pack.setupPlan.commands = [];
          state.lastFailedOperation = {
            operation: 'detect',
            packId: PYTHON_PACK_ID
          };
          return clonePackState(pack);
        }
      },
      async runPythonSetupDetection() {
        const pack = state.packs[PYTHON_PACK_ID];
        const previous = clonePackState(pack);
        const startedAt = new Date().toISOString();

        pack.status = 'Installing';
        pack.error = null;
        emit(setupProgressListeners, {
          packId: PYTHON_PACK_ID,
          step: PROGRESS_STEPS.detect,
          status: 'in_progress',
          at: startedAt
        });

        try {
          const result = await this.detectPythonSupport();
          if (result.status === 'Error') {
            state.packs[PYTHON_PACK_ID] = previous;
            const normalized = withRetryHint(normalizeError(
              result.error,
              'python_lsp.setup.failed',
              'Python setup guidance detection failed.'
            ), getRetryHintForCode(result?.error?.code ?? 'python_lsp.setup.failed'));
            emit(setupFailedListeners, {
              packId: PYTHON_PACK_ID,
              error: normalized,
              at: new Date().toISOString()
            });
            state.lastFailedOperation = {
              operation: 'setup',
              packId: PYTHON_PACK_ID
            };
            return {
              ok: false,
              error: normalized
            };
          }
          emit(setupProgressListeners, {
            packId: PYTHON_PACK_ID,
            step: PROGRESS_STEPS.plan,
            status: 'completed',
            at: new Date().toISOString(),
            setupRequired: result.setupPlan.required
          });
          emit(setupProgressListeners, {
            packId: PYTHON_PACK_ID,
            step: PROGRESS_STEPS.complete,
            status: 'completed',
            at: new Date().toISOString(),
            finalStatus: result.status
          });
          emit(setupCompletedListeners, { packId: PYTHON_PACK_ID, result });
          state.lastFailedOperation = null;
          return {
            ok: true,
            result
          };
        } catch (error) {
          state.packs[PYTHON_PACK_ID] = previous;
          const normalized = withRetryHint(normalizeError(
            error,
            'python_lsp.setup.failed',
            'Python setup guidance detection failed.'
          ), getRetryHintForCode('python_lsp.setup.failed'));
          emit(setupFailedListeners, {
            packId: PYTHON_PACK_ID,
            error: normalized,
            at: new Date().toISOString()
          });
          state.lastFailedOperation = {
            operation: 'setup',
            packId: PYTHON_PACK_ID
          };
          return {
            ok: false,
            error: normalized
          };
        }
      },
      activatePythonForProject(params) {
        return dedupeActivation(PYTHON_PACK_ID, () => this._activatePythonForProject(params));
      },
      async _activatePythonForProject({ projectId, projectRoot } = {}) {
        const pack = state.packs[PYTHON_PACK_ID];
        if (!projectId || !projectRoot) return false;
        const prerequisitesReady = Boolean(
          pack.prerequisites.python.available
          && pack.prerequisites.node.available
          && pack.prerequisites.server.available
        );
        if (!prerequisitesReady) return false;
        if (pack.session?.projectId === projectId) return true;

        emit(activationProgressListeners, {
          packId: PYTHON_PACK_ID,
          step: ACTIVATION_STEPS.start,
          status: 'in_progress',
          at: new Date().toISOString(),
          projectId
        });

        if (pack.session?.projectId && pack.session.projectId !== projectId) {
          const stopPrevious = await io.stopPythonLsp({
            projectId: pack.session.projectId,
            sessionId: pack.session.sessionId
          });
          if (!stopPrevious?.ok) {
            pack.status = 'Error';
            pack.error = withRetryHint(normalizeError(
              stopPrevious?.error,
              'python_lsp.shutdown.failed',
              'Failed to stop previous Python LSP session.'
            ), getRetryHintForCode('python_lsp.shutdown.failed'));
            pack.diagnostics = [pack.error.message];
            emit(activationFailedListeners, {
              packId: PYTHON_PACK_ID,
              error: pack.error,
              at: new Date().toISOString(),
              projectId: pack.session.projectId
            });
            state.lastFailedOperation = {
              operation: 'deactivate',
              packId: PYTHON_PACK_ID,
              projectId: pack.session.projectId
            };
            return false;
          }
          pack.session = null;
        }

        const launch = pack.launch;
        const response = await io.startPythonLsp({
          projectId,
          projectRoot,
          command: launch.command,
          args: [...launch.args],
          cwd: projectRoot,
          envAllowlist: [...launch.envAllowlist]
        });
        if (!response?.ok) {
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            response?.error,
            'python_lsp.start.failed',
            'Failed to start Python LSP server.'
          ), getRetryHintForCode('python_lsp.start.failed'));
          pack.diagnostics = [pack.error.message];
          emit(activationFailedListeners, {
            packId: PYTHON_PACK_ID,
            error: pack.error,
            at: new Date().toISOString(),
            projectId
          });
          state.lastFailedOperation = {
            operation: 'activate',
            packId: PYTHON_PACK_ID,
            projectId,
            projectRoot
          };
          return false;
        }

        const ready = response?.data?.ready !== false;
        if (!ready) {
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            response?.error,
            'python_lsp.start.timeout',
            'Python LSP startup timed out.'
          ), getRetryHintForCode('python_lsp.start.timeout'));
          pack.diagnostics = [pack.error.message];
          emit(activationFailedListeners, {
            packId: PYTHON_PACK_ID,
            error: pack.error,
            at: new Date().toISOString(),
            projectId
          });
          state.lastFailedOperation = {
            operation: 'activate',
            packId: PYTHON_PACK_ID,
            projectId,
            projectRoot
          };
          return false;
        }

        pack.session = {
          projectId,
          projectRoot,
          sessionId: typeof response?.data?.sessionId === 'string' && response.data.sessionId.trim()
            ? response.data.sessionId.trim()
            : `python-lsp-${projectId}`,
          startedAt: new Date().toISOString()
        };
        pack.status = 'Installed';
        pack.error = null;
        pack.diagnostics = [];
        emit(activationCompletedListeners, {
          packId: PYTHON_PACK_ID,
          projectId,
          session: { ...pack.session },
          at: new Date().toISOString()
        });
        state.lastFailedOperation = null;
        return true;
      },
      async deactivatePythonForProject(projectId = null) {
        const pack = state.packs[PYTHON_PACK_ID];
        if (!pack.session) return true;
        if (projectId && pack.session.projectId !== projectId) return true;

        emit(activationProgressListeners, {
          packId: PYTHON_PACK_ID,
          step: ACTIVATION_STEPS.stop,
          status: 'in_progress',
          at: new Date().toISOString(),
          projectId: pack.session.projectId
        });

        const response = await io.stopPythonLsp({
          projectId: pack.session.projectId,
          sessionId: pack.session.sessionId
        });
        if (!response?.ok) {
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            response?.error,
            'python_lsp.shutdown.failed',
            'Failed to stop Python LSP session.'
          ), getRetryHintForCode('python_lsp.shutdown.failed'));
          pack.diagnostics = [pack.error.message];
          emit(activationFailedListeners, {
            packId: PYTHON_PACK_ID,
            error: pack.error,
            at: new Date().toISOString(),
            projectId: pack.session.projectId
          });
          state.lastFailedOperation = {
            operation: 'deactivate',
            packId: PYTHON_PACK_ID,
            projectId: pack.session.projectId
          };
          return false;
        }

        pack.session = null;
        if (pack.prerequisites.python.available && pack.prerequisites.node.available && pack.prerequisites.server.available) {
          pack.status = 'Installed';
          pack.error = null;
          pack.diagnostics = [];
        } else {
          pack.status = 'Not Installed';
        }
        state.lastFailedOperation = null;
        return true;
      },
      reportPythonRuntimeError({ projectId = null, sessionId = null, error = null } = {}) {
        const pack = state.packs[PYTHON_PACK_ID];
        const normalized = withRetryHint(normalizeError(
          error,
          'python_lsp.transport.failed',
          'Python LSP transport failed.'
        ), getRetryHintForCode(error?.code ?? 'python_lsp.transport.failed'));
        pack.status = 'Error';
        pack.error = normalized;
        pack.diagnostics = [normalized.message];
        state.lastFailedOperation = {
          operation: 'activate',
          packId: PYTHON_PACK_ID,
          projectId: projectId ?? pack.session?.projectId ?? null,
          projectRoot: pack.session?.projectRoot ?? null,
          sessionId: sessionId ?? pack.session?.sessionId ?? null
        };
        emit(activationFailedListeners, {
          packId: PYTHON_PACK_ID,
          error: normalized,
          at: new Date().toISOString(),
          projectId: projectId ?? pack.session?.projectId ?? null
        });
        return normalized;
      },
      async retryLastFailedPythonOperation() {
        const last = state.lastFailedOperation;
        if (!last || last.packId !== PYTHON_PACK_ID) return false;
        if (last.operation === 'detect') {
          const result = await this.detectPythonSupport();
          return result.status !== 'Error';
        }
        if (last.operation === 'setup') {
          const result = await this.runPythonSetupDetection();
          return result.ok;
        }
        if (last.operation === 'activate') {
          if (!last.projectId || !last.projectRoot) return false;
          return this.activatePythonForProject({
            projectId: last.projectId,
            projectRoot: last.projectRoot
          });
        }
        if (last.operation === 'deactivate') {
          return this.deactivatePythonForProject(last.projectId ?? null);
        }
        return false;
      },
      async attachPythonListeners(handlers = {}) {
        if (typeof state.pythonLspUnlisten === 'function') {
          state.pythonLspUnlisten();
          state.pythonLspUnlisten = null;
        }
        state.pythonLspUnlisten = await io.listenPythonLspEvents(handlers);
        return true;
      },
      detachPythonListeners() {
        if (typeof state.pythonLspUnlisten === 'function') {
          state.pythonLspUnlisten();
        }
        state.pythonLspUnlisten = null;
      },
      async teardownPythonLifecycle() {
        this.detachPythonListeners();
        return this.deactivatePythonForProject();
      },
      // -----------------------------------------------------------------------
      // TypeScript / JavaScript commands (mirror of Python commands above)
      // -----------------------------------------------------------------------

      async detectTsSupport() {
        const pack = state.packs[TS_PACK_ID];
        try {
          let node;
          let server;
          let tsc;

          if (typeof io.detectTsSupportSnapshot === 'function') {
            const snapshot = await io.detectTsSupportSnapshot();
            node = snapshot?.node ?? { available: false };
            server = snapshot?.server ?? { available: false };
            tsc = snapshot?.tsc ?? { available: false };
          } else {
            node = { available: false };
            server = { available: false };
            tsc = { available: false };
          }
          pack.prerequisites.node = normalizeRuntimeResult(node);
          pack.prerequisites.server = normalizeRuntimeResult(server);
          pack.prerequisites.tsc = normalizeRuntimeResult(tsc);
          pack.lastCheckedAt = new Date().toISOString();
          pack.error = null;
          pack.diagnostics = buildTsDiagnostics(pack);
          pack.setupPlan.required = pack.diagnostics.length > 0;
          if (pack.setupPlan.required) {
            const platform = io.detectPlatform();
            pack.setupPlan.commands = buildTsSetupCommands({
              platform,
              missingNode: !pack.prerequisites.node.available,
              missingServer: !pack.prerequisites.server.available,
              missingTsc: !pack.prerequisites.tsc.available
            });
          } else {
            pack.setupPlan.commands = [];
          }
          pack.status = pack.diagnostics.length ? 'Not Installed' : 'Installed';
          if (pack.status === 'Installed') {
            state.tsLastFailedOperation = null;
          }
          return clonePackState(pack);
        } catch (error) {
          pack.lastCheckedAt = new Date().toISOString();
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            error,
            'typescript_lsp.detect.failed',
            'Failed to detect TypeScript language support prerequisites.'
          ), getTsRetryHintForCode('typescript_lsp.detect.failed'));
          pack.diagnostics = [pack.error.message];
          pack.setupPlan.required = true;
          pack.setupPlan.commands = [];
          state.tsLastFailedOperation = {
            operation: 'detect',
            packId: TS_PACK_ID
          };
          return clonePackState(pack);
        }
      },
      async runTsSetupDetection() {
        const pack = state.packs[TS_PACK_ID];
        const previous = clonePackState(pack);
        const startedAt = new Date().toISOString();

        pack.status = 'Installing';
        pack.error = null;
        emit(setupProgressListeners, {
          packId: TS_PACK_ID,
          step: PROGRESS_STEPS.detect,
          status: 'in_progress',
          at: startedAt
        });

        try {
          const result = await this.detectTsSupport();
          if (result.status === 'Error') {
            state.packs[TS_PACK_ID] = previous;
            const normalized = withRetryHint(normalizeError(
              result.error,
              'typescript_lsp.setup.failed',
              'TypeScript setup guidance detection failed.'
            ), getTsRetryHintForCode(result?.error?.code ?? 'typescript_lsp.setup.failed'));
            emit(setupFailedListeners, {
              packId: TS_PACK_ID,
              error: normalized,
              at: new Date().toISOString()
            });
            state.tsLastFailedOperation = {
              operation: 'setup',
              packId: TS_PACK_ID
            };
            return {
              ok: false,
              error: normalized
            };
          }
          emit(setupProgressListeners, {
            packId: TS_PACK_ID,
            step: PROGRESS_STEPS.plan,
            status: 'completed',
            at: new Date().toISOString(),
            setupRequired: result.setupPlan.required
          });
          emit(setupProgressListeners, {
            packId: TS_PACK_ID,
            step: PROGRESS_STEPS.complete,
            status: 'completed',
            at: new Date().toISOString(),
            finalStatus: result.status
          });
          emit(setupCompletedListeners, { packId: TS_PACK_ID, result });
          state.tsLastFailedOperation = null;
          return {
            ok: true,
            result
          };
        } catch (error) {
          state.packs[TS_PACK_ID] = previous;
          const normalized = withRetryHint(normalizeError(
            error,
            'typescript_lsp.setup.failed',
            'TypeScript setup guidance detection failed.'
          ), getTsRetryHintForCode('typescript_lsp.setup.failed'));
          emit(setupFailedListeners, {
            packId: TS_PACK_ID,
            error: normalized,
            at: new Date().toISOString()
          });
          state.tsLastFailedOperation = {
            operation: 'setup',
            packId: TS_PACK_ID
          };
          return {
            ok: false,
            error: normalized
          };
        }
      },
      activateTsForProject(params) {
        return dedupeActivation(TS_PACK_ID, () => this._activateTsForProject(params));
      },
      async _activateTsForProject({ projectId, projectRoot } = {}) {
        const pack = state.packs[TS_PACK_ID];
        if (!projectId || !projectRoot) return false;
        const prerequisitesReady = Boolean(
          pack.prerequisites.node.available
          && pack.prerequisites.server.available
          && pack.prerequisites.tsc.available
        );
        if (!prerequisitesReady) return false;
        if (pack.session?.projectId === projectId) return true;

        emit(activationProgressListeners, {
          packId: TS_PACK_ID,
          step: ACTIVATION_STEPS.start,
          status: 'in_progress',
          at: new Date().toISOString(),
          projectId
        });

        if (pack.session?.projectId && pack.session.projectId !== projectId) {
          const stopPrevious = await io.stopTsLsp({
            projectId: pack.session.projectId,
            sessionId: pack.session.sessionId
          });
          if (!stopPrevious?.ok) {
            pack.status = 'Error';
            pack.error = withRetryHint(normalizeError(
              stopPrevious?.error,
              'typescript_lsp.shutdown.failed',
              'Failed to stop previous TypeScript LSP session.'
            ), getTsRetryHintForCode('typescript_lsp.shutdown.failed'));
            pack.diagnostics = [pack.error.message];
            emit(activationFailedListeners, {
              packId: TS_PACK_ID,
              error: pack.error,
              at: new Date().toISOString(),
              projectId: pack.session.projectId
            });
            state.tsLastFailedOperation = {
              operation: 'deactivate',
              packId: TS_PACK_ID,
              projectId: pack.session.projectId
            };
            return false;
          }
          pack.session = null;
        }

        const launch = pack.launch;
        const response = await io.startTsLsp({
          projectId,
          projectRoot,
          command: launch.command,
          args: [...launch.args],
          cwd: projectRoot,
          envAllowlist: [...launch.envAllowlist]
        });
        if (!response?.ok) {
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            response?.error,
            'typescript_lsp.start.failed',
            'Failed to start TypeScript LSP server.'
          ), getTsRetryHintForCode('typescript_lsp.start.failed'));
          pack.diagnostics = [pack.error.message];
          emit(activationFailedListeners, {
            packId: TS_PACK_ID,
            error: pack.error,
            at: new Date().toISOString(),
            projectId
          });
          state.tsLastFailedOperation = {
            operation: 'activate',
            packId: TS_PACK_ID,
            projectId,
            projectRoot
          };
          return false;
        }

        const ready = response?.data?.ready !== false;
        if (!ready) {
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            response?.error,
            'typescript_lsp.start.timeout',
            'TypeScript LSP startup timed out.'
          ), getTsRetryHintForCode('typescript_lsp.start.timeout'));
          pack.diagnostics = [pack.error.message];
          emit(activationFailedListeners, {
            packId: TS_PACK_ID,
            error: pack.error,
            at: new Date().toISOString(),
            projectId
          });
          state.tsLastFailedOperation = {
            operation: 'activate',
            packId: TS_PACK_ID,
            projectId,
            projectRoot
          };
          return false;
        }

        pack.session = {
          projectId,
          projectRoot,
          sessionId: typeof response?.data?.sessionId === 'string' && response.data.sessionId.trim()
            ? response.data.sessionId.trim()
            : `typescript-lsp-${projectId}`,
          startedAt: new Date().toISOString()
        };
        pack.status = 'Installed';
        pack.error = null;
        pack.diagnostics = [];
        emit(activationCompletedListeners, {
          packId: TS_PACK_ID,
          projectId,
          session: { ...pack.session },
          at: new Date().toISOString()
        });
        state.tsLastFailedOperation = null;
        return true;
      },
      async deactivateTsForProject(projectId = null) {
        const pack = state.packs[TS_PACK_ID];
        if (!pack.session) return true;
        if (projectId && pack.session.projectId !== projectId) return true;

        emit(activationProgressListeners, {
          packId: TS_PACK_ID,
          step: ACTIVATION_STEPS.stop,
          status: 'in_progress',
          at: new Date().toISOString(),
          projectId: pack.session.projectId
        });

        const response = await io.stopTsLsp({
          projectId: pack.session.projectId,
          sessionId: pack.session.sessionId
        });
        if (!response?.ok) {
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            response?.error,
            'typescript_lsp.shutdown.failed',
            'Failed to stop TypeScript LSP session.'
          ), getTsRetryHintForCode('typescript_lsp.shutdown.failed'));
          pack.diagnostics = [pack.error.message];
          emit(activationFailedListeners, {
            packId: TS_PACK_ID,
            error: pack.error,
            at: new Date().toISOString(),
            projectId: pack.session.projectId
          });
          state.tsLastFailedOperation = {
            operation: 'deactivate',
            packId: TS_PACK_ID,
            projectId: pack.session.projectId
          };
          return false;
        }

        pack.session = null;
        if (pack.prerequisites.node.available && pack.prerequisites.server.available && pack.prerequisites.tsc.available) {
          pack.status = 'Installed';
          pack.error = null;
          pack.diagnostics = [];
        } else {
          pack.status = 'Not Installed';
        }
        state.tsLastFailedOperation = null;
        return true;
      },
      reportTsRuntimeError({ projectId = null, sessionId = null, error = null } = {}) {
        const pack = state.packs[TS_PACK_ID];
        const normalized = withRetryHint(normalizeError(
          error,
          'typescript_lsp.transport.failed',
          'TypeScript LSP transport failed.'
        ), getTsRetryHintForCode(error?.code ?? 'typescript_lsp.transport.failed'));
        pack.status = 'Error';
        pack.error = normalized;
        pack.diagnostics = [normalized.message];
        state.tsLastFailedOperation = {
          operation: 'activate',
          packId: TS_PACK_ID,
          projectId: projectId ?? pack.session?.projectId ?? null,
          projectRoot: pack.session?.projectRoot ?? null,
          sessionId: sessionId ?? pack.session?.sessionId ?? null
        };
        emit(activationFailedListeners, {
          packId: TS_PACK_ID,
          error: normalized,
          at: new Date().toISOString(),
          projectId: projectId ?? pack.session?.projectId ?? null
        });
        return normalized;
      },
      async retryLastFailedTsOperation() {
        const last = state.tsLastFailedOperation;
        if (!last || last.packId !== TS_PACK_ID) return false;
        if (last.operation === 'detect') {
          const result = await this.detectTsSupport();
          return result.status !== 'Error';
        }
        if (last.operation === 'setup') {
          const result = await this.runTsSetupDetection();
          return result.ok;
        }
        if (last.operation === 'activate') {
          if (!last.projectId || !last.projectRoot) return false;
          return this.activateTsForProject({
            projectId: last.projectId,
            projectRoot: last.projectRoot
          });
        }
        if (last.operation === 'deactivate') {
          return this.deactivateTsForProject(last.projectId ?? null);
        }
        return false;
      },
      async attachTsListeners(handlers = {}) {
        if (typeof state.tsLspUnlisten === 'function') {
          state.tsLspUnlisten();
          state.tsLspUnlisten = null;
        }
        state.tsLspUnlisten = await io.listenTsLspEvents(handlers);
        return true;
      },
      detachTsListeners() {
        if (typeof state.tsLspUnlisten === 'function') {
          state.tsLspUnlisten();
        }
        state.tsLspUnlisten = null;
      },
      async teardownTsLifecycle() {
        this.detachTsListeners();
        return this.deactivateTsForProject();
      },

      // -----------------------------------------------------------------------
      // Managed-language commands (ADR-005 Slice 6) — generic by languageId.
      // Availability gate = the resolver's tier (probes are toolchain hints).
      // -----------------------------------------------------------------------

      async detectManagedSupport(languageId) {
        const pack = getManagedPack(languageId);
        try {
          const payload = await io.detectManagedSupport(languageId);
          const tier = typeof payload?.resolutionTier === 'string' && payload.resolutionTier.trim()
            ? payload.resolutionTier.trim()
            : null;
          const probes = Array.isArray(payload?.probes) ? payload.probes : [];
          pack.resolutionTier = tier;
          pack.toolchainHints = probes
            .filter((probe) => probe && probe.available !== true)
            .map((probe) => {
              const name = probe.displayName ?? probe.command ?? 'toolchain';
              return `${name} not detected — language intelligence works, builds may not.`;
            });
          pack.lastCheckedAt = new Date().toISOString();
          pack.error = null;
          pack.status = tier ? 'Installed' : 'Not Installed';
          pack.diagnostics = tier
            ? [...pack.toolchainHints]
            : ['Language server not installed.', ...pack.toolchainHints];
          return cloneManagedPackState(pack);
        } catch (error) {
          pack.lastCheckedAt = new Date().toISOString();
          pack.status = 'Error';
          pack.resolutionTier = null;
          pack.error = withRetryHint(normalizeError(
            error,
            `${languageId}_lsp.detect.failed`,
            'Failed to detect language server availability.'
          ), getManagedRetryHintForCode(languageId, `${languageId}_lsp.detect.failed`));
          pack.diagnostics = [pack.error.message];
          return cloneManagedPackState(pack);
        }
      },
      activateManagedForProject(languageId, params) {
        return dedupeActivation(languageId, () => this._activateManagedForProject(languageId, params));
      },
      async _activateManagedForProject(languageId, { projectId, projectRoot } = {}) {
        const pack = getManagedPack(languageId);
        if (!projectId || !projectRoot) return false;
        if (!pack.resolutionTier) return false;
        if (pack.session?.projectId === projectId) return true;

        emit(activationProgressListeners, {
          packId: languageId,
          step: ACTIVATION_STEPS.start,
          status: 'in_progress',
          at: new Date().toISOString(),
          projectId
        });

        if (pack.session?.projectId && pack.session.projectId !== projectId) {
          const stopPrevious = await io.stopManagedLsp({
            languageId,
            projectId: pack.session.projectId,
            sessionId: pack.session.sessionId
          });
          if (!stopPrevious?.ok) {
            pack.status = 'Error';
            pack.error = withRetryHint(normalizeError(
              stopPrevious?.error,
              `${languageId}_lsp.shutdown.failed`,
              'Failed to stop previous language server session.'
            ), getManagedRetryHintForCode(languageId, `${languageId}_lsp.shutdown.failed`));
            pack.diagnostics = [pack.error.message];
            emit(activationFailedListeners, {
              packId: languageId,
              error: pack.error,
              at: new Date().toISOString(),
              projectId: pack.session.projectId
            });
            return false;
          }
          pack.session = null;
        }

        const response = await io.startManagedLsp({ languageId, projectId, projectRoot });
        if (!response?.ok) {
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            response?.error,
            `${languageId}_lsp.start.failed`,
            'Failed to start language server.'
          ), getManagedRetryHintForCode(languageId, `${languageId}_lsp.start.failed`));
          pack.diagnostics = [pack.error.message];
          emit(activationFailedListeners, {
            packId: languageId,
            error: pack.error,
            at: new Date().toISOString(),
            projectId
          });
          return false;
        }

        const ready = response?.data?.ready !== false;
        if (!ready) {
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            response?.error,
            `${languageId}_lsp.start.timeout`,
            'Language server startup timed out.'
          ), getManagedRetryHintForCode(languageId, `${languageId}_lsp.start.timeout`));
          pack.diagnostics = [pack.error.message];
          emit(activationFailedListeners, {
            packId: languageId,
            error: pack.error,
            at: new Date().toISOString(),
            projectId
          });
          return false;
        }

        pack.session = {
          projectId,
          projectRoot,
          sessionId: typeof response?.data?.sessionId === 'string' && response.data.sessionId.trim()
            ? response.data.sessionId.trim()
            : `${languageId}-lsp-${projectId}`,
          startedAt: new Date().toISOString()
        };
        pack.status = 'Installed';
        pack.error = null;
        pack.diagnostics = [...pack.toolchainHints];
        emit(activationCompletedListeners, {
          packId: languageId,
          projectId,
          session: { ...pack.session },
          at: new Date().toISOString()
        });
        return true;
      },
      async deactivateManagedForProject(languageId, projectId = null) {
        const pack = getManagedPack(languageId);
        if (!pack.session) return true;
        if (projectId && pack.session.projectId !== projectId) return true;

        emit(activationProgressListeners, {
          packId: languageId,
          step: ACTIVATION_STEPS.stop,
          status: 'in_progress',
          at: new Date().toISOString(),
          projectId: pack.session.projectId
        });

        const response = await io.stopManagedLsp({
          languageId,
          projectId: pack.session.projectId,
          sessionId: pack.session.sessionId
        });
        if (!response?.ok) {
          pack.status = 'Error';
          pack.error = withRetryHint(normalizeError(
            response?.error,
            `${languageId}_lsp.shutdown.failed`,
            'Failed to stop language server session.'
          ), getManagedRetryHintForCode(languageId, `${languageId}_lsp.shutdown.failed`));
          pack.diagnostics = [pack.error.message];
          emit(activationFailedListeners, {
            packId: languageId,
            error: pack.error,
            at: new Date().toISOString(),
            projectId: pack.session.projectId
          });
          return false;
        }

        pack.session = null;
        pack.status = pack.resolutionTier ? 'Installed' : 'Not Installed';
        pack.error = null;
        pack.diagnostics = [...pack.toolchainHints];
        return true;
      },
      /**
       * Detect → gate → activate in one command. Both managed triggers use
       * it: the file-open lifecycle hook and the post-install offer path —
       * so an install completing turns straight into a running session.
       */
      async ensureManagedActiveForProject(languageId, { projectId, projectRoot }) {
        if (!projectId || !projectRoot) return false;
        const pack = getManagedPack(languageId);
        if (pack.session?.projectId === projectId) return true;
        const detected = await this.detectManagedSupport(languageId);
        if (detected.status !== 'Installed') return false;
        return this.activateManagedForProject(languageId, { projectId, projectRoot });
      },
      /**
       * A managed session ended outside this domain's own stop path —
       * uninstall (Slice 7) stops sessions backend-side, and crashes end
       * them too. Clearing the stale record keeps activate/deactivate
       * decisions honest; status falls back to what detection last said.
       */
      clearManagedSession(languageId, { sessionId = null } = {}) {
        const pack = state.managedPacks[languageId];
        if (!pack?.session) return false;
        if (sessionId && pack.session.sessionId !== sessionId) return false;
        pack.session = null;
        if (pack.status !== 'Error') {
          pack.status = pack.resolutionTier ? 'Installed' : 'Not Installed';
        }
        return true;
      },
      reportManagedRuntimeError(languageId, { projectId = null, sessionId = null, error = null } = {}) {
        const pack = getManagedPack(languageId);
        const normalized = withRetryHint(normalizeError(
          error,
          `${languageId}_lsp.transport.failed`,
          'Language server transport failed.'
        ), getManagedRetryHintForCode(languageId, error?.code ?? `${languageId}_lsp.transport.failed`));
        pack.status = 'Error';
        pack.error = normalized;
        pack.diagnostics = [normalized.message];
        emit(activationFailedListeners, {
          packId: languageId,
          error: normalized,
          at: new Date().toISOString(),
          projectId: projectId ?? pack.session?.projectId ?? null
        });
        return normalized;
      },
      async attachManagedListeners(handlers = {}) {
        if (typeof state.managedLspUnlisten === 'function') {
          state.managedLspUnlisten();
          state.managedLspUnlisten = null;
        }
        state.managedLspUnlisten = await io.listenManagedLspEvents(handlers);
        return true;
      },
      detachManagedListeners() {
        if (typeof state.managedLspUnlisten === 'function') {
          state.managedLspUnlisten();
        }
        state.managedLspUnlisten = null;
      },
      async teardownManagedLifecycle() {
        this.detachManagedListeners();
        let allStopped = true;
        for (const languageId of Object.keys(state.managedPacks)) {
          const stopped = await this.deactivateManagedForProject(languageId);
          if (!stopped) allStopped = false;
        }
        return allStopped;
      },

      // -----------------------------------------------------------------------
      // Generic commands
      // -----------------------------------------------------------------------

      setPackStatus(packId, status) {
        if (!state.packs[packId]) return false;
        if (!CANONICAL_STATUSES.has(status)) return false;
        state.packs[packId].status = status;
        return true;
      }
    },
    selectors: {
      getSupportedPackIds() {
        return Object.keys(state.packs);
      },
      getPythonInterpreters() {
        return cloneInterpreterState(state.pythonInterpreters);
      },
      getPackState(packId) {
        const pack = state.packs[packId];
        return pack ? clonePackState(pack) : null;
      },
      getPackStatus(packId) {
        return state.packs[packId]?.status ?? null;
      },
      getPackDiagnostics(packId) {
        const pack = state.packs[packId];
        return pack ? [...pack.diagnostics] : [];
      },
      getPackLaunch(packId) {
        const pack = state.packs[packId];
        if (!pack) return null;
        return {
          command: pack.launch.command,
          args: [...pack.launch.args],
          cwdPolicy: pack.launch.cwdPolicy,
          envAllowlist: [...pack.launch.envAllowlist]
        };
      },
      getPackSetupCommands(packId) {
        const pack = state.packs[packId];
        return pack ? [...pack.setupPlan.commands] : [];
      },
      getActiveSession(packId) {
        const pack = state.packs[packId];
        return pack?.session ? { ...pack.session } : null;
      },
      getPackError(packId) {
        const pack = state.packs[packId];
        return pack?.error ? { ...pack.error } : null;
      },
      getLastFailedOperation(packId) {
        if (packId === TS_PACK_ID) {
          return state.tsLastFailedOperation ? { ...state.tsLastFailedOperation } : null;
        }
        if (packId === PYTHON_PACK_ID) {
          return state.lastFailedOperation ? { ...state.lastFailedOperation } : null;
        }
        return null;
      },
      getManagedLanguageIds() {
        return Object.keys(state.managedPacks);
      },
      getManagedPackState(languageId) {
        const pack = state.managedPacks[languageId];
        return pack ? cloneManagedPackState(pack) : null;
      },
      getActiveManagedSession(languageId) {
        const pack = state.managedPacks[languageId];
        return pack?.session ? { ...pack.session } : null;
      }
    },
    events: {
      onSetupProgress(handler) {
        return subscribe(setupProgressListeners, handler);
      },
      onSetupCompleted(handler) {
        return subscribe(setupCompletedListeners, handler);
      },
      onSetupFailed(handler) {
        return subscribe(setupFailedListeners, handler);
      },
      onActivationProgress(handler) {
        return subscribe(activationProgressListeners, handler);
      },
      onActivationCompleted(handler) {
        return subscribe(activationCompletedListeners, handler);
      },
      onActivationFailed(handler) {
        return subscribe(activationFailedListeners, handler);
      }
    }
  };
}
