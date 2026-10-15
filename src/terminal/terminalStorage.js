const ERROR_CATEGORIES = new Set(['AccessDenied', 'InvalidPath', 'Conflict', 'NotFound', 'Internal']);

const TAURI_UNAVAILABLE = {
  category: 'Internal',
  code: 'terminal.tauri_unavailable',
  message: 'Tauri invoke bridge is unavailable.'
};

/** How much recent output each session keeps for a view that (re)attaches,
 * in UTF-16 code units: the unit xterm counts and the flow control uses. */
export const REPLAY_LIMIT = 1024 * 1024;

/** Written first when older output fell out of the replay: a full reset, so
 * the replay never starts inside an escape sequence's leftovers, then a note. */
const TRUNCATED_PREAMBLE = '\x1bc\x1b[90m[earlier output not kept]\x1b[0m\r\n';

async function getTauriCore() {
  try {
    return await import('@tauri-apps/api/core');
  } catch {
    return null;
  }
}

/**
 * The event stream of one terminal session.
 *
 * Buffering starts the moment the channel exists. Tauri's Channel constructor
 * installs a NO-OP handler — in-order messages that arrive before a consumer
 * assigns `onmessage` are consumed and silently dropped (its pending queue only
 * covers out-of-order arrivals). The shell's first burst (banner + prompt)
 * lands in exactly that gap: the PTY spawns during `invoke`. The old Win10
 * conhost masked this by stalling its first paint on an unanswered cursor
 * query; the sideloaded ConPTY host (PR #106) paints immediately and exposed
 * it as a blank terminal.
 *
 * Two kinds of listener (track T slice T2a):
 * - `onEvent`, the domain's tap, sees every event as it arrives, whether or
 *   not a view is attached. The domain learns a session ended even while no
 *   view shows it.
 * - One view at a time subscribes. It first gets a replay, then live events.
 *   The replay does not drain: a view that mounts twice (StrictMode in
 *   development) or remounts gets the same screen again. Recent output is kept
 *   as whole chunks up to `limit`; once older chunks fall out, the replay
 *   starts with a reset and a note. Exited is kept apart and replays last.
 *
 * Pure over an injected channel-like object so it stays node-testable.
 */
export function createTerminalEventStream(channel, { onEvent = null, limit = REPLAY_LIMIT } = {}) {
  const ring = [];
  let size = 0;
  let truncated = false;
  let exited = null;
  let view = null;

  const keep = (event) => {
    if (event?.event === 'Output' && typeof event.data?.chunk === 'string') {
      ring.push(event);
      size += event.data.chunk.length;
      while (size > limit && ring.length > 1) {
        size -= ring.shift().data.chunk.length;
        truncated = true;
      }
    } else if (event?.event === 'Exited') {
      exited = event;
    }
  };

  channel.onmessage = (event) => {
    keep(event);
    if (typeof onEvent === 'function') {
      try {
        onEvent(event);
      } catch {
        // A failing tap must never stop delivery to the view.
      }
    }
    if (view) view(event);
  };

  return {
    channel,
    /** Replays, then attaches. Returns an unsubscribe that only detaches this
     * handler, so a late cleanup never detaches a newer view. */
    subscribe(handler) {
      if (truncated) handler({ event: 'Output', data: { chunk: TRUNCATED_PREAMBLE } });
      for (const event of ring) handler(event);
      if (exited) handler(exited);
      view = handler;
      return () => {
        if (view === handler) view = null;
      };
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
  return {
    category: 'Internal',
    code: fallbackCode,
    message: typeof error === 'string' && error.trim() ? error.trim() : fallbackMessage
  };
}

async function invokeTerminal(command, payload, fallbackCode, fallbackMessage) {
  const core = await getTauriCore();
  if (!core) return { ok: false, error: TAURI_UNAVAILABLE };
  try {
    const data = await core.invoke(command, payload);
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: normalizeCommandError(error, fallbackCode, fallbackMessage) };
  }
}

/** Starts a shell session. The stream exists before `invoke`, so the shell's
 * first output is never lost; `onEvent` is the domain's tap. */
export async function terminalSpawn({ projectId, projectRoot, cols, rows, executable = null, onEvent = null }) {
  const core = await getTauriCore();
  if (!core) return { ok: false, error: TAURI_UNAVAILABLE };
  try {
    const stream = createTerminalEventStream(new core.Channel(), { onEvent });
    const data = await core.invoke('terminal_spawn', {
      projectId,
      projectRoot,
      executable,
      cols,
      rows,
      onEvent: stream.channel
    });
    return { ok: true, data, stream };
  } catch (error) {
    return {
      ok: false,
      error: normalizeCommandError(error, 'terminal.spawn.failed', 'Failed to start a terminal.')
    };
  }
}

export async function terminalSessionEnd(projectId, sessionId) {
  return invokeTerminal(
    'terminal_session_end',
    { projectId, sessionId },
    'terminal.session_end.failed',
    'Failed to end the terminal session.'
  );
}

export async function terminalEndProject(projectId) {
  return invokeTerminal(
    'terminal_end_project',
    { projectId },
    'terminal.end_project.failed',
    "Failed to end the project's terminal sessions."
  );
}

export async function terminalTeardownAll() {
  return invokeTerminal(
    'terminal_teardown_all',
    {},
    'terminal.teardown_all.failed',
    'Failed to end the terminal sessions.'
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
    'Failed to resize the terminal.'
  );
}

export async function terminalPause(projectId, sessionId) {
  return invokeTerminal(
    'terminal_pause',
    { projectId, sessionId },
    'terminal.pause.failed',
    'Failed to pause terminal output.'
  );
}

export async function terminalResume(projectId, sessionId) {
  return invokeTerminal(
    'terminal_resume',
    { projectId, sessionId },
    'terminal.resume.failed',
    'Failed to resume terminal output.'
  );
}

export async function terminalBusySessions(projectId) {
  return invokeTerminal(
    'terminal_busy_sessions',
    { projectId },
    'terminal.busy.failed',
    'Failed to check the terminal sessions.'
  );
}

export async function terminalTakeReloadReport() {
  return invokeTerminal(
    'terminal_take_reload_report',
    {},
    'terminal.reload_report.failed',
    'Failed to read the reload report.'
  );
}
