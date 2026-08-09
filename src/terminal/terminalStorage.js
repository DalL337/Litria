let lastTerminalStorageError = null;

const ERROR_CATEGORIES = new Set(['AccessDenied', 'InvalidPath', 'Conflict', 'NotFound', 'Internal']);
const TERMINAL_EVENT_NAMES = {
  sessionStarted: 'terminal:session-started',
  output: 'terminal:output',
  sessionEnded: 'terminal:session-ended',
  processComplete: 'terminal:process-complete',
  error: 'terminal:error'
};

async function getInvoke() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke;
  } catch {
    return null;
  }
}

/**
 * Buffer PTY events from the moment the channel exists. Tauri's Channel
 * constructor installs a NO-OP handler — in-order messages that arrive
 * before a consumer assigns `onmessage` are consumed and silently dropped
 * (its pending queue only covers out-of-order arrivals). The shell's first
 * burst (banner + prompt) lands in exactly that gap: the PTY spawns during
 * `invoke` but TerminalRenderer only attaches after React state propagates.
 * The old Win10 conhost masked this by stalling its first paint on an
 * unanswered cursor query; the sideloaded ConPTY host (PR #106) paints
 * immediately and exposed it as a blank terminal.
 *
 * Pure over an injected channel-like object so it stays node-testable.
 */
export function createTerminalEventStream(channel) {
  const backlog = [];
  const buffer = (event) => { backlog.push(event); };
  channel.onmessage = buffer;
  return {
    channel,
    subscribe(handler) {
      // Drain-then-attach: everything that arrived early replays in order.
      backlog.splice(0).forEach((event) => handler(event));
      channel.onmessage = handler;
    },
    unsubscribe() {
      // Re-buffer instead of nulling — a null handler throws on the next
      // message, and buffering lets a remounting consumer catch up.
      channel.onmessage = buffer;
    }
  };
}

function normalizeCommandError(error, fallbackCode, fallbackMessage) {
  if (error && typeof error === 'object') {
    const category = typeof error.category === 'string' && ERROR_CATEGORIES.has(error.category)
      ? error.category
      : 'Internal';
    const code = typeof error.code === 'string' && error.code.trim()
      ? error.code.trim()
      : fallbackCode;
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : fallbackMessage;
    return { category, code, message };
  }
  if (error instanceof Error) {
    return {
      category: 'Internal',
      code: fallbackCode,
      message: error.message || fallbackMessage
    };
  }
  return {
    category: 'Internal',
    code: fallbackCode,
    message: fallbackMessage
  };
}

async function invokeTerminal(command, payload, fallbackCode, fallbackMessage) {
  const invoke = await getInvoke();
  if (!invoke) {
    const error = {
      category: 'Internal',
      code: 'terminal.tauri_unavailable',
      message: 'Tauri invoke bridge is unavailable.'
    };
    lastTerminalStorageError = error;
    return { ok: false, error };
  }

  try {
    const data = await invoke(command, payload);
    lastTerminalStorageError = null;
    return { ok: true, data };
  } catch (error) {
    const normalized = normalizeCommandError(error, fallbackCode, fallbackMessage);
    lastTerminalStorageError = normalized;
    return { ok: false, error: normalized };
  }
}

export async function terminalSessionStart(projectId, projectRoot, executable = null) {
  return invokeTerminal(
    'terminal_session_start',
    { projectId, projectRoot, executable },
    'terminal.session_start.failed',
    'Failed to start terminal session.'
  );
}

export async function terminalSpawn(projectId, projectRoot, cols, rows, executable = null) {
  try {
    const { invoke, Channel } = await import('@tauri-apps/api/core');
    // Wrap BEFORE invoke — the PTY starts writing during the spawn call.
    const stream = createTerminalEventStream(new Channel());
    const data = await invoke('terminal_spawn', {
      projectId,
      projectRoot,
      executable,
      cols,
      rows,
      onEvent: stream.channel
    });
    lastTerminalStorageError = null;
    return { ok: true, data, channel: stream };
  } catch (error) {
    const normalized = normalizeCommandError(
      error,
      'terminal.spawn.failed',
      'Failed to spawn terminal PTY session.'
    );
    lastTerminalStorageError = normalized;
    return { ok: false, error: normalized };
  }
}

export async function terminalSessionEnd(projectId) {
  return invokeTerminal(
    'terminal_session_end',
    { projectId },
    'terminal.session_end.failed',
    'Failed to end terminal session.'
  );
}

export async function terminalTeardownAll() {
  return invokeTerminal(
    'terminal_teardown_all',
    {},
    'terminal.teardown_all.failed',
    'Failed to teardown terminal sessions.'
  );
}

export async function terminalInput(projectId, sessionId, input) {
  return invokeTerminal(
    'terminal_input',
    { projectId, sessionId, input },
    'terminal.input.failed',
    'Failed to send terminal input.'
  );
}

export async function terminalResize(projectId, sessionId, cols, rows) {
  return invokeTerminal(
    'terminal_resize',
    { projectId, sessionId, cols, rows },
    'terminal.resize.failed',
    'Failed to resize terminal session.'
  );
}

export async function terminalPause(projectId) {
  return invokeTerminal(
    'terminal_pause',
    { projectId },
    'terminal.pause.failed',
    'Failed to pause terminal output.'
  );
}

export async function terminalResume(projectId) {
  return invokeTerminal(
    'terminal_resume',
    { projectId },
    'terminal.resume.failed',
    'Failed to resume terminal output.'
  );
}

export function getLastTerminalStorageError() {
  return lastTerminalStorageError;
}

export async function listenTerminalEvents({
  onSessionStarted,
  onOutput,
  onSessionEnded,
  onProcessComplete,
  onError
} = {}) {
  try {
    const { listen } = await import('@tauri-apps/api/event');
    const unlistenCallbacks = [];

    if (typeof onSessionStarted === 'function') {
      unlistenCallbacks.push(await listen(TERMINAL_EVENT_NAMES.sessionStarted, (event) => {
        onSessionStarted(event.payload);
      }));
    }
    if (typeof onOutput === 'function') {
      unlistenCallbacks.push(await listen(TERMINAL_EVENT_NAMES.output, (event) => {
        onOutput(event.payload);
      }));
    }
    if (typeof onSessionEnded === 'function') {
      unlistenCallbacks.push(await listen(TERMINAL_EVENT_NAMES.sessionEnded, (event) => {
        onSessionEnded(event.payload);
      }));
    }
    if (typeof onProcessComplete === 'function') {
      unlistenCallbacks.push(await listen(TERMINAL_EVENT_NAMES.processComplete, (event) => {
        onProcessComplete(event.payload);
      }));
    }
    if (typeof onError === 'function') {
      unlistenCallbacks.push(await listen(TERMINAL_EVENT_NAMES.error, (event) => {
        onError(event.payload);
      }));
    }

    return () => {
      unlistenCallbacks.forEach((unlisten) => {
        if (typeof unlisten === 'function') {
          unlisten();
        }
      });
    };
  } catch {
    return () => {};
  }
}
