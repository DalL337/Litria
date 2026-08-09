import {
  getLastTerminalStorageError,
  listenTerminalEvents,
  terminalInput,
  terminalPause,
  terminalResize,
  terminalResume,
  terminalSessionEnd,
  terminalSessionStart,
  terminalSpawn,
  terminalTeardownAll
} from './terminalStorage.js';

export function createTerminalDomain({ adapters = {} } = {}) {
  const io = {
    start: adapters.start ?? terminalSessionStart,
    spawn: adapters.spawn ?? terminalSpawn,
    end: adapters.end ?? terminalSessionEnd,
    teardownAll: adapters.teardownAll ?? terminalTeardownAll,
    input: adapters.input ?? terminalInput,
    resize: adapters.resize ?? terminalResize,
    pause: adapters.pause ?? terminalPause,
    resume: adapters.resume ?? terminalResume,
    getLastError: adapters.getLastError ?? getLastTerminalStorageError
  };

  const state = {
    active: null,
    channel: null,
    unlisten: null,
    spawnPromise: null
  };

  const clearActive = () => {
    state.active = null;
    state.channel = null;
  };

  return {
    commands: {
      async startForProject({ projectId, projectRoot, executable = null }) {
        if (!projectId || !projectRoot) return false;
        if (state.active?.projectId === projectId) return true;
        const response = await io.start(projectId, projectRoot, executable);
        if (!response.ok) return false;
        state.active = {
          projectId: response.data.projectId,
          sessionId: response.data.sessionId
        };
        return true;
      },
      async spawnWithChannel({ projectId, projectRoot, cols, rows, executable = null }) {
        if (!projectId || !projectRoot) return null;
        if (state.active?.projectId === projectId) {
          return state.channel;
        }
        if (state.spawnPromise) return state.spawnPromise;
        state.spawnPromise = (async () => {
          try {
            const response = await io.spawn(projectId, projectRoot, cols, rows, executable);
            if (!response.ok) return null;
            state.active = {
              projectId: response.data.projectId,
              sessionId: response.data.sessionId
            };
            state.channel = response.channel;
            return state.channel;
          } finally {
            state.spawnPromise = null;
          }
        })();
        return state.spawnPromise;
      },
      async endForProject(projectId) {
        if (!projectId) return false;
        const response = await io.end(projectId);
        if (!response.ok) return false;
        if (state.active?.projectId === projectId) {
          clearActive();
        }
        return true;
      },
      async teardownAll() {
        const response = await io.teardownAll();
        if (!response.ok) return false;
        if (typeof state.unlisten === 'function') {
          state.unlisten();
          state.unlisten = null;
        }
        clearActive();
        return true;
      },
      async attachListeners(handlers = {}) {
        if (typeof state.unlisten === 'function') {
          state.unlisten();
          state.unlisten = null;
        }
        state.unlisten = await listenTerminalEvents(handlers);
        return true;
      },
      detachListeners() {
        if (typeof state.unlisten === 'function') {
          state.unlisten();
        }
        state.unlisten = null;
      },
      async sendInput({ projectId, input }) {
        if (!state.active?.sessionId || !projectId) return false;
        const response = await io.input(projectId, state.active.sessionId, input ?? '');
        return response.ok;
      },
      async resize({ projectId, cols, rows }) {
        if (!state.active?.sessionId || !projectId) return false;
        const response = await io.resize(projectId, state.active.sessionId, cols, rows);
        return response.ok;
      },
      async pauseOutput({ projectId }) {
        if (!state.active?.sessionId || !projectId) return false;
        const response = await io.pause(projectId);
        return response.ok;
      },
      async resumeOutput({ projectId }) {
        if (!state.active?.sessionId || !projectId) return false;
        const response = await io.resume(projectId);
        return response.ok;
      }
    },
    selectors: {
      getActiveSession() {
        return state.active ? { ...state.active } : null;
      },
      getActiveChannel() {
        return state.channel;
      },
      getLastError() {
        return io.getLastError();
      }
    }
  };
}
