import {
  agentDetect,
  agentOpenInstallGuide,
  terminalBusySessions,
  terminalEndProject,
  terminalInput,
  terminalPause,
  terminalResize,
  terminalResume,
  terminalSessionEnd,
  terminalSpawn,
  terminalSpawnAgent,
  terminalTakeReloadReport,
  terminalTeardownAll
} from './terminalStorage.js';
import { createTerminalSignalScanner } from './terminalSignals.js';
import {
  PROGRAM_STATUS_REPLY,
  createProgramStatusRecords,
  displayText,
  parseProgramStatus
} from './programStatus.js';

const DEFAULT_SIZE = { cols: 80, rows: 24 };
/** A session that printed within this long counts as busy. Rust sees child
 * processes only; work inside the shell process itself (a PowerShell loop
 * or cmdlet) shows up as output instead. Silent in-process work is missed. */
const RECENT_OUTPUT_MS = 2000;
/** A command a pill starts a session with is typed after the shell's first
 * output (its prompt); this is the fallback if no output comes. */
const INITIAL_INPUT_FALLBACK_MS = 3000;
const EMPTY_PROJECT = Object.freeze({ tabs: Object.freeze([]), viewedKey: null });
/** What a session runs, and the name its tabs count under (track T plan §3:
 * "Claude Agent", never "Claude Code" as a feature name; Codex by its own
 * name). An agent is the person's own installed program (slice T2b-1). */
const KIND_LABELS = Object.freeze({ shell: 'Terminal', claude: 'Claude Agent', codex: 'Codex' });
export const AGENT_KINDS = Object.freeze(['claude', 'codex']);
const UNKNOWN_AGENTS = Object.freeze({ claude: null, codex: null });

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
 * Starts are refused unless a project is current. The switch coordinator
 * clears the current project before it ends the old project's sessions, so
 * nothing can start in a project that is closing, and sets it once the next
 * one is open; the lifecycle hook keeps it in step otherwise.
 *
 * A tab also shows what its program says it is doing (slice T2a-2). The tap
 * reads the bell and Program Status Protocol reports (OSC 7501) from every
 * chunk once; a tab "needs you" when its program is blocked on the person or
 * rang the bell while the person was not looking at it. Viewing the tab
 * (reported by the drawer, focus only) clears the bell and the finished
 * results (`done`, `error`). Litria answers the protocol's query itself, so a
 * program that asks (Claude Code does) reports its status.
 */
export function createTerminalDomain({ adapters = {}, setTimer = setTimeout, now = () => Date.now() } = {}) {
  const io = {
    spawn: adapters.spawn ?? terminalSpawn,
    spawnAgent: adapters.spawnAgent ?? terminalSpawnAgent,
    detectAgents: adapters.detectAgents ?? agentDetect,
    installGuide: adapters.installGuide ?? agentOpenInstallGuide,
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
    keyCount: 0,
    /** The tab the person is looking at: the drawer is visible and shows it. */
    inView: null,
    attentionCount: 0,
    /** Which agents are installed (null: not looked yet). */
    agents: UNKNOWN_AGENTS,
    detecting: null
  };
  let listeners = [];
  let snapshot = null;

  const notify = () => {
    snapshot = null;
    for (const listener of listeners) listener();
  };

  const needsYou = (tab) => tab.bell || tab.records.summary()?.state === 'blocked';
  /** What a tab shows of its program's records: a report that leaves this
   * alone (a `working` report with new progress) changes nothing on screen. */
  const shownStatus = (tab) => {
    const record = tab.records.summary();
    return record ? [record.state, record.kind, record.app, record.msg].join('\u0000') : '';
  };

  const buildSnapshot = () => {
    const byProject = {};
    for (const [projectId, keys] of state.order) {
      const live = keys.map((key) => state.tabs.get(key)).filter(Boolean);
      const tabs = live.map((tab) => {
        const record = tab.records.summary();
        return Object.freeze({
          key: tab.key,
          sessionId: tab.sessionId,
          kind: tab.kind,
          label: tab.label,
          status: tab.status,
          exitCode: tab.exitCode,
          error: tab.error,
          stream: tab.stream,
          needsYou: needsYou(tab),
          activity: record?.state ?? null,
          statusKind: record?.kind ?? null,
          statusText: displayText(record?.msg),
          statusApp: displayText(record?.app, 32)
        });
      });
      // The session to take the person to: the latest to need them, of those
      // they are not looking at.
      const waiting = live
        .filter((tab) => tab.key !== state.inView && needsYou(tab))
        .sort((a, b) => b.attentionSeq - a.attentionSeq);
      byProject[projectId] = Object.freeze({
        tabs: Object.freeze(tabs),
        viewedKey: state.viewed.get(projectId) ?? tabs[0]?.key ?? null,
        needsYouKey: waiting[0]?.key ?? null
      });
    }
    return Object.freeze({ byProject: Object.freeze(byProject) });
  };

  /** Labels count per project and per kind: Terminal 1, Claude Agent 1. */
  const labelKey = (projectId, kind) => `${kind}:${projectId}`;
  const nextLabel = (projectId, kind = 'shell') => {
    const key = labelKey(projectId, kind);
    const count = (state.labelCount.get(key) ?? 0) + 1;
    state.labelCount.set(key, count);
    return `${KIND_LABELS[kind]} ${count}`;
  };
  const forgetLabels = (projectId) => {
    for (const kind of Object.keys(KIND_LABELS)) state.labelCount.delete(labelKey(projectId, kind));
  };

  /** Removes tabs from the view state; returns the removed tab records. */
  const dropTabs = (keys) => {
    const removed = [];
    for (const key of keys) {
      const tab = state.tabs.get(key);
      if (!tab) continue;
      state.tabs.delete(key);
      if (state.inView === key) state.inView = null;
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

  const answerQuery = (tab) => {
    if (tab.sessionId && tab.status === 'running') {
      io.input(tab.projectId, tab.sessionId, PROGRAM_STATUS_REPLY);
    } else {
      // Asked before the start resolved (a program started as the session's
      // own process): answered the moment the session id arrives, still ahead
      // of the screen's answer to the DA1 query that follows the question.
      tab.replyOwed = true;
    }
  };

  /** What the tap does with the signals in a session's output. A handler that
   * changes what the tab shows marks it `signalled`; the tap notifies once per
   * chunk. */
  const signalHandlers = (tab) => ({
    onBell: () => {
      if (tab.status === 'ended' || tab.bell || state.inView === tab.key) return;
      tab.bell = true;
      tab.attentionSeq = ++state.attentionCount;
      tab.signalled = true;
    },
    onStatus: (body) => {
      const report = parseProgramStatus(body);
      if (!report) return;
      const before = shownStatus(tab);
      const wasBlocked = tab.records.summary()?.state === 'blocked';
      tab.records.apply(report);
      // Finished while the person was looking: they have seen it.
      if (state.inView === tab.key) tab.records.acknowledge();
      if (!wasBlocked && tab.records.summary()?.state === 'blocked') {
        tab.attentionSeq = ++state.attentionCount;
      }
      if (shownStatus(tab) !== before) tab.signalled = true;
    },
    onQuery: () => answerQuery(tab),
    onPrompt: () => {
      if (tab.records.endActivity()) tab.signalled = true;
    },
    onReset: () => {
      if (tab.records.reset()) tab.signalled = true;
    }
  });

  /** The tap: every event of a session, whether or not a view shows it. */
  const onStreamEvent = (tab, event) => {
    if (event?.event === 'Output') {
      tab.sawOutput = true;
      tab.lastOutputAt = now();
      writeInitialInput(tab);
      if (!state.tabs.has(tab.key)) return;
      tab.scanner.push(event.data?.chunk);
      if (tab.signalled) {
        tab.signalled = false;
        notify();
      }
    } else if (event?.event === 'Exited') {
      if (!state.tabs.has(tab.key) || tab.status === 'ended') return;
      tab.status = 'ended';
      tab.exitCode = event.data?.exitCode ?? null;
      tab.pendingInput = null;
      tab.replyOwed = false;
      // The program's activity ends with it; a bell from a program that is
      // gone asks nothing. `done` and `error` stay until seen.
      tab.bell = false;
      tab.records.endActivity();
      notify();
    }
  };

  const startSession = async ({ label = null, initialInput = null, executable = null, agent = null } = {}) => {
    const project = state.current;
    if (!project) {
      return { ok: false, error: { code: 'terminal.no_project', message: 'No project is open.' } };
    }
    if (agent !== null && !AGENT_KINDS.includes(agent)) {
      return { ok: false, error: { code: 'agent.unknown', message: 'Litria cannot start that agent.' } };
    }
    const kind = agent ?? 'shell';
    const key = `t${++state.keyCount}`;
    const tab = {
      key,
      sessionId: null,
      projectId: project.id,
      kind,
      label: label || nextLabel(project.id, kind),
      status: 'starting',
      exitCode: null,
      error: null,
      stream: null,
      // Nothing is ever typed into an agent for Litria (a pill's command
      // runs in a shell tab of its own).
      pendingInput: agent ? null : initialInput,
      sawOutput: false,
      lastOutputAt: 0,
      bell: false,
      records: createProgramStatusRecords(),
      replyOwed: false,
      signalled: false,
      attentionSeq: 0,
      scanner: null
    };
    tab.scanner = createTerminalSignalScanner(signalHandlers(tab));
    state.tabs.set(key, tab);
    state.order.set(project.id, [...(state.order.get(project.id) ?? []), key]);
    state.viewed.set(project.id, key);
    notify();

    const onEvent = (event) => onStreamEvent(tab, event);
    const response = agent
      ? await io.spawnAgent({
        projectId: project.id,
        projectRoot: project.root,
        agent,
        cols: state.lastSize.cols,
        rows: state.lastSize.rows,
        onEvent
      })
      : await io.spawn({
        projectId: project.id,
        projectRoot: project.root,
        cols: state.lastSize.cols,
        rows: state.lastSize.rows,
        executable,
        onEvent
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
    // Before the notify: the view that mounts on it replays the output and
    // answers the DA1 query that followed the question.
    if (tab.replyOwed) {
      tab.replyOwed = false;
      if (tab.status === 'running') io.input(tab.projectId, tab.sessionId, PROGRAM_STATUS_REPLY);
    }
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
    const tabs = (state.order.get(projectId) ?? [])
      .map((key) => state.tabs.get(key))
      .filter((tab) => tab?.sessionId && tab.status === 'running');
    // When the answer is unknown, every running tab counts as busy: one extra
    // question before a switch, rather than ending a running program unasked.
    const busyIds = response.ok && Array.isArray(response.data)
      ? new Set(response.data)
      : new Set(tabs.map((tab) => tab.sessionId));
    const recent = now() - RECENT_OUTPUT_MS;
    return tabs
      .filter((tab) => busyIds.has(tab.sessionId) || tab.lastOutputAt > recent)
      .map((tab) => ({ key: tab.key, label: tab.label }));
  };

  const tabFor = (key) => state.tabs.get(key) ?? null;
  const runningTab = (key) => {
    const tab = tabFor(key);
    return tab && tab.status === 'running' && tab.sessionId ? tab : null;
  };

  return {
    commands: {
      /** The open project, or null (no folder: an untitled file). Starts are
       * refused without one. */
      setCurrentProject(project) {
        const next = project?.id && project?.root ? { id: project.id, root: project.root } : null;
        if (next?.id === state.current?.id && next?.root === state.current?.root) return;
        state.current = next;
        notify();
      },
      clearCurrentProject() {
        if (!state.current) return;
        state.current = null;
        notify();
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
      /** The drawer reports the tab on screen: it is visible and shows `key`,
       * or (null) shows none of the project's tabs. Focus only. Seeing a tab
       * clears its bell and its finished results. */
      setSessionInView(projectId, key) {
        const tab = key ? tabFor(key) : null;
        if (key && (!tab || tab.projectId !== projectId)) return;
        if (!key) {
          const current = state.inView ? tabFor(state.inView) : null;
          if (current && current.projectId !== projectId) return;
        }
        const next = tab ? key : null;
        if (state.inView === next) return;
        state.inView = next;
        if (tab) {
          tab.bell = false;
          tab.records.acknowledge();
        }
        notify();
      },
      /** The person opened the terminal from its rail while a session needs
       * them: show that one. */
      showSessionNeedingYou() {
        const projectId = state.current?.id;
        if (!projectId) return false;
        if (!snapshot) snapshot = buildSnapshot();
        const key = snapshot.byProject[projectId]?.needsYouKey;
        if (!key || state.viewed.get(projectId) === key) return Boolean(key);
        state.viewed.set(projectId, key);
        notify();
        return true;
      },
      /** Ends every session of a project. Only the tabs that exist now are
       * dropped, so a late reply never touches tabs created after the call. */
      async endProject(projectId) {
        if (!projectId) return false;
        const keys = [...(state.order.get(projectId) ?? [])];
        forgetLabels(projectId);
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
      /** Looks for the person's agents (one look in flight at a time). The
       * start menu asks when it opens, so an install made since shows. */
      detectAgents() {
        if (state.detecting) return state.detecting;
        state.detecting = io.detectAgents().then((response) => {
          state.detecting = null;
          const found = response.ok && response.data ? response.data : {};
          const next = Object.freeze({ claude: found.claude === true, codex: found.codex === true });
          if (next.claude !== state.agents.claude || next.codex !== state.agents.codex) {
            state.agents = next;
            notify();
          }
          return next;
        });
        return state.detecting;
      },
      /** Opens an agent's official installation page. Litria never installs
       * one. */
      openInstallGuide(agent) {
        if (!AGENT_KINDS.includes(agent)) return Promise.resolve(false);
        return io.installGuide(agent).then((r) => r.ok);
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
      },
      /** `{ claude, codex }`: true installed, false not, null not looked yet. */
      getAgents() {
        return state.agents;
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
