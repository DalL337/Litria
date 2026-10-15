import {
  terminalBusySessions,
  terminalEndProject,
  terminalInput,
  terminalPause,
  terminalResize,
  terminalResume,
  terminalSessionEnd,
  terminalSpawn,
  terminalTakeReloadReport,
  terminalTeardownAll
} from './terminalStorage.js';

const DEFAULT_SIZE = { cols: 80, rows: 24 };
/** A command a pill starts a session with is typed after the shell's first
 * output (its prompt); this is the fallback if no output comes. */
const INITIAL_INPUT_FALLBACK_MS = 3000;
const EMPTY_PROJECT = Object.freeze({ tabs: Object.freeze([]), viewedKey: null });

/**
 * TerminalDomain — owns terminal sessions (track T slice T2a).
 *
 * A session lives until the person ends it, its shell exits, its project
 * closes, the window reloads, or Litria quits. No view owns one: the drawer
 * only shows sessions and reports which one the person is looking at
 * (docs/Orchestration.md §1.2). A project can hold several sessions.
 *
 * Each session is a tab, keyed by a local key that exists from the moment
 * the person asks for it; the Rust session id arrives when the start
 * resolves. A tab is `starting`, `running` or `ended`. An ended tab stays
 * until the person removes it, so they can read what the program printed.
 *
 * Starts are refused unless a project is current. The lifecycle hook sets
 * the current project; the switch coordinator clears it before it ends the
 * old project's sessions, so nothing can start in a project that is closing.
 */
export function createTerminalDomain({ adapters = {}, setTimer = setTimeout } = {}) {
  const io = {
    spawn: adapters.spawn ?? terminalSpawn,
    end: adapters.end ?? terminalSessionEnd,
    endProject: adapters.endProject ?? terminalEndProject,
    teardownAll: adapters.teardownAll ?? terminalTeardownAll,
    input: adapters.input ?? terminalInput,
    resize: adapters.resize ?? terminalResize,
    pause: adapters.pause ?? terminalPause,
    resume: adapters.resume ?? terminalResume,
    busy: adapters.busy ?? terminalBusySessions,
    takeReloadReport: adapters.takeReloadReport ?? terminalTakeReloadReport
  };

  const state = {
    current: null,
    tabs: new Map(),
    order: new Map(),
    viewed: new Map(),
    ensuring: new Map(),
    labelCount: new Map(),
    lastSize: { ...DEFAULT_SIZE },
    keyCount: 0
  };
  let listeners = [];
  let snapshot = null;

  const notify = () => {
    snapshot = null;
    for (const listener of listeners) listener();
  };

  const buildSnapshot = () => {
    const byProject = {};
    for (const [projectId, keys] of state.order) {
      const tabs = keys
        .map((key) => state.tabs.get(key))
        .filter(Boolean)
        .map((tab) => Object.freeze({
          key: tab.key,
          sessionId: tab.sessionId,
          label: tab.label,
          status: tab.status,
          exitCode: tab.exitCode,
          error: tab.error,
          stream: tab.stream
        }));
      byProject[projectId] = Object.freeze({
        tabs: Object.freeze(tabs),
        viewedKey: state.viewed.get(projectId) ?? tabs[0]?.key ?? null
      });
    }
    return Object.freeze({ byProject: Object.freeze(byProject) });
  };

  const nextLabel = (projectId) => {
    const count = (state.labelCount.get(projectId) ?? 0) + 1;
    state.labelCount.set(projectId, count);
    return `Terminal ${count}`;
  };

  /** Removes tabs from the view state; returns the removed tab records. */
  const dropTabs = (keys) => {
    const removed = [];
    for (const key of keys) {
      const tab = state.tabs.get(key);
      if (!tab) continue;
      state.tabs.delete(key);
      removed.push(tab);
      const order = (state.order.get(tab.projectId) ?? []).filter((k) => k !== key);
      if (order.length) state.order.set(tab.projectId, order);
      else state.order.delete(tab.projectId);
      if (state.viewed.get(tab.projectId) === key) {
        if (order.length) state.viewed.set(tab.projectId, order[order.length - 1]);
        else state.viewed.delete(tab.projectId);
      }
    }
    return removed;
  };

  const writeInitialInput = (tab) => {
    if (!tab.pendingInput || !tab.sessionId || tab.status !== 'running') return;
    const input = tab.pendingInput;
    tab.pendingInput = null;
    io.input(tab.projectId, tab.sessionId, input);
  };

  /** The tap: every event of a session, whether or not a view shows it. */
  const onStreamEvent = (tab, event) => {
    if (event?.event === 'Output') {
      tab.sawOutput = true;
      writeInitialInput(tab);
    } else if (event?.event === 'Exited') {
      if (!state.tabs.has(tab.key) || tab.status === 'ended') return;
      tab.status = 'ended';
      tab.exitCode = event.data?.exitCode ?? null;
      tab.pendingInput = null;
      notify();
    }
  };

  const startSession = async ({ label = null, initialInput = null, executable = null } = {}) => {
    const project = state.current;
    if (!project) {
      return { ok: false, error: { code: 'terminal.no_project', message: 'No project is open.' } };
    }
    const key = `t${++state.keyCount}`;
    const tab = {
      key,
      sessionId: null,
      projectId: project.id,
      label: label || nextLabel(project.id),
      status: 'starting',
      exitCode: null,
      error: null,
      stream: null,
      pendingInput: initialInput,
      sawOutput: false
    };
    state.tabs.set(key, tab);
    state.order.set(project.id, [...(state.order.get(project.id) ?? []), key]);
    state.viewed.set(project.id, key);
    notify();

    const response = await io.spawn({
      projectId: project.id,
      projectRoot: project.root,
      cols: state.lastSize.cols,
      rows: state.lastSize.rows,
      executable,
      onEvent: (event) => onStreamEvent(tab, event)
    });

    if (!state.tabs.has(key)) {
      // The tab went away while the shell was starting (the person ended it,
      // or the project closed): end the session that just started.
      if (response.ok) io.end(project.id, response.data.sessionId);
      return { ok: false, error: { code: 'terminal.ended', message: 'The terminal was closed.' } };
    }
    if (!response.ok) {
      tab.status = 'ended';
      tab.error = response.error;
      tab.pendingInput = null;
      notify();
      return { ok: false, key, error: response.error };
    }

    tab.sessionId = response.data.sessionId;
    tab.stream = response.stream;
    // An Exited the tap already saw (a shell that died at once) wins.
    if (tab.status === 'starting') tab.status = 'running';
    notify();
    if (tab.pendingInput) {
      if (tab.sawOutput) writeInitialInput(tab);
      else setTimer(() => writeInitialInput(tab), INITIAL_INPUT_FALLBACK_MS);
    }
    return { ok: true, key, sessionId: tab.sessionId };
  };

  const busySessions = async (projectId) => {
    if (!projectId) return [];
    const response = await io.busy(projectId);
    if (!response.ok || !Array.isArray(response.data)) return [];
    const busyIds = new Set(response.data);
    return (state.order.get(projectId) ?? [])
      .map((key) => state.tabs.get(key))
      .filter((tab) => tab?.sessionId && busyIds.has(tab.sessionId))
      .map((tab) => ({ key: tab.key, label: tab.label }));
  };

  const tabFor = (key) => state.tabs.get(key) ?? null;
  const runningTab = (key) => {
    const tab = tabFor(key);
    return tab && tab.status === 'running' && tab.sessionId ? tab : null;
  };

  return {
    commands: {
      /** The open project, or null. Starts are refused without one. */
      setCurrentProject(project) {
        state.current = project?.id && project?.root ? { id: project.id, root: project.root } : null;
      },
      clearCurrentProject() {
        state.current = null;
      },
      startSession,
      /** The person's open gesture (the terminal rail): a project with no tabs
       * gets one shell. Never from a view effect: a drawer that merely becomes
       * visible decides nothing. One start in flight per project. */
      async ensureSession() {
        const project = state.current;
        if (!project) return null;
        if (state.order.get(project.id)?.length) return null;
        const inFlight = state.ensuring.get(project.id);
        if (inFlight) return inFlight;
        const started = startSession().finally(() => state.ensuring.delete(project.id));
        state.ensuring.set(project.id, started);
        return started;
      },
      /** The person ended a running (or starting) session: its tab goes away
       * at once and its whole process tree stops. */
      async endSession(key) {
        const tab = tabFor(key);
        if (!tab || tab.status === 'ended') return false;
        dropTabs([key]);
        notify();
        if (!tab.sessionId) return true; // startSession ends it when the start resolves
        const response = await io.end(tab.projectId, tab.sessionId);
        return response.ok;
      },
      /** Removes an ended tab. */
      removeSession(key) {
        const tab = tabFor(key);
        if (!tab || tab.status !== 'ended') return false;
        dropTabs([key]);
        notify();
        return true;
      },
      renameSession(key, label) {
        const tab = tabFor(key);
        const trimmed = typeof label === 'string' ? label.trim() : '';
        if (!tab || !trimmed || trimmed === tab.label) return false;
        tab.label = trimmed;
        notify();
        return true;
      },
      /** What the person is looking at. Focus only: it never starts or ends. */
      setViewedSession(projectId, key) {
        const tab = tabFor(key);
        if (!tab || tab.projectId !== projectId || state.viewed.get(projectId) === key) return;
        state.viewed.set(projectId, key);
        notify();
      },
      /** Ends every session of a project. Only the tabs that exist now are
       * dropped, so a late reply never touches tabs created after the call. */
      async endProject(projectId) {
        if (!projectId) return false;
        const keys = [...(state.order.get(projectId) ?? [])];
        state.labelCount.delete(projectId);
        if (dropTabs(keys).length) notify();
        const response = await io.endProject(projectId);
        return response.ok;
      },
      /** Ends every session of every project (a window holds one project, so
       * the switch coordinator uses this: it also sweeps anything left). */
      async teardownAll() {
        const keys = [...state.tabs.keys()];
        state.labelCount.clear();
        if (dropTabs(keys).length) notify();
        const response = await io.teardownAll();
        return response.ok;
      },
      sendInput(key, input) {
        const tab = runningTab(key);
        if (!tab) return Promise.resolve(false);
        return io.input(tab.projectId, tab.sessionId, input ?? '').then((r) => r.ok);
      },
      resize(key, cols, rows) {
        if (cols > 0 && rows > 0) state.lastSize = { cols, rows };
        const tab = runningTab(key);
        if (!tab) return Promise.resolve(false);
        return io.resize(tab.projectId, tab.sessionId, cols, rows).then((r) => r.ok);
      },
      pauseOutput(key) {
        const tab = runningTab(key);
        if (!tab) return Promise.resolve(false);
        return io.pause(tab.projectId, tab.sessionId).then((r) => r.ok);
      },
      resumeOutput(key) {
        const tab = runningTab(key);
        if (!tab) return Promise.resolve(false);
        return io.resume(tab.projectId, tab.sessionId).then((r) => r.ok);
      },
      /** The project's tabs whose shell is running a program. */
      busySessions,
      async isBusy(key) {
        const tab = runningTab(key);
        if (!tab) return false;
        const busy = await busySessions(tab.projectId);
        return busy.some((entry) => entry.key === key);
      },
      /** How many sessions the last page reload ended, reported once. */
      async takeReloadReport() {
        const response = await io.takeReloadReport();
        return response.ok && Number.isInteger(response.data) ? response.data : 0;
      }
    },
    selectors: {
      /** An immutable snapshot that only changes when tabs change, for
       * useSyncExternalStore. */
      getSnapshot() {
        if (!snapshot) snapshot = buildSnapshot();
        return snapshot;
      },
      getProject(projectId) {
        if (!snapshot) snapshot = buildSnapshot();
        return snapshot.byProject[projectId] ?? EMPTY_PROJECT;
      },
      getCurrentProjectId() {
        return state.current?.id ?? null;
      }
    },
    subscribe(listener) {
      listeners.push(listener);
      return () => {
        listeners = listeners.filter((l) => l !== listener);
      };
    }
  };
}
