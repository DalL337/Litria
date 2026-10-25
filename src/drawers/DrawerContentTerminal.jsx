import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Plus, Square, X } from 'lucide-react';
import TerminalRenderer from '../components/TerminalRenderer';

const NO_TABS = { tabs: [], viewedKey: null };
const subscribeNothing = () => () => {};
const getNoTabs = () => NO_TABS;
const getNoProject = () => null;

/**
 * The terminal drawer: a view of the open project's terminal sessions.
 *
 * It owns no session (track T slice T2a; docs/Orchestration.md §1.2). It never
 * starts or ends one because it became visible or hidden: closing the drawer,
 * switching drawers or clicking outside only hides it, and every session keeps
 * running. Sessions start from the person's gestures (the terminal rail, New
 * terminal, a command pill) through TerminalDomain, and end through End, their
 * own exit, or their project closing.
 *
 * Every session's screen stays mounted. Inactive ones are hidden and moved
 * out of the clipped stack, so xterm also stops rendering them while their
 * boxes keep their size.
 */
function DrawerContentTerminal({ terminalDomain, projectId, hasFolder = true, isVisible = false }) {
  const subscribe = terminalDomain?.subscribe ?? subscribeNothing;
  const getSnapshot = useCallback(
    () => (terminalDomain && projectId ? terminalDomain.selectors.getProject(projectId) : NO_TABS),
    [terminalDomain, projectId]
  );
  const getCurrentProjectId = useCallback(
    () => terminalDomain.selectors.getCurrentProjectId(),
    [terminalDomain]
  );
  const { tabs, viewedKey } = useSyncExternalStore(subscribe, terminalDomain ? getSnapshot : getNoTabs);
  const currentProjectId = useSyncExternalStore(subscribe, terminalDomain ? getCurrentProjectId : getNoProject);

  // Reports the tab on screen (the drawer is visible and shows it). Focus
  // only: being seen clears what a tab's program was waiting to show.
  const inViewKey = isVisible && hasFolder ? viewedKey : null;
  useEffect(() => {
    if (!terminalDomain || !projectId) return undefined;
    terminalDomain.commands.setSessionInView(projectId, inViewKey);
    return () => terminalDomain.commands.setSessionInView(projectId, null);
  }, [terminalDomain, projectId, inViewKey]);

  if (!projectId || !terminalDomain) {
    return (
      <div className="top-drawer-empty">
        Open a project to use the terminal
      </div>
    );
  }
  if (!hasFolder) {
    // An untitled file has no folder for a shell to run in.
    return (
      <div className="top-drawer-empty">
        Save this file to a folder to use the terminal
      </div>
    );
  }

  // Only the current project can start a session: never one that is closing.
  const canStart = currentProjectId === projectId;
  const startNew = () => {
    terminalDomain.commands.startSession();
  };

  return (
    <div className="terminal-drawer">
      <div className="terminal-tabs" role="tablist" aria-label="Terminal sessions">
        {tabs.map((tab) => (
          <TerminalTab
            key={tab.key}
            tab={tab}
            isViewed={tab.key === viewedKey}
            terminalDomain={terminalDomain}
            projectId={projectId}
          />
        ))}
        {canStart && (
          <button
            type="button"
            className="terminal-tab-new"
            onClick={startNew}
            title="New terminal"
            aria-label="New terminal"
          >
            <Plus size={13} />
          </button>
        )}
      </div>
      <div className="terminal-stack">
        {tabs.length === 0 ? (
          <div className="top-drawer-empty terminal-empty">
            <span>No terminal is open in this project.</span>
            {canStart && (
              <button type="button" className="terminal-empty-new" onClick={startNew}>
                <Plus size={13} /> New terminal
              </button>
            )}
          </div>
        ) : (
          tabs.map((tab) => (
            <TerminalSessionView
              key={tab.key}
              tab={tab}
              isActive={tab.key === viewedKey}
              drawerVisible={isVisible}
              terminalDomain={terminalDomain}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TerminalSessionView({ tab, isActive, drawerVisible, terminalDomain }) {
  const { key } = tab;
  const onInput = useCallback((data) => terminalDomain.commands.sendInput(key, data), [terminalDomain, key]);
  const onResize = useCallback((cols, rows) => terminalDomain.commands.resize(key, cols, rows), [terminalDomain, key]);
  const onPause = useCallback(() => terminalDomain.commands.pauseOutput(key), [terminalDomain, key]);
  const onResume = useCallback(() => terminalDomain.commands.resumeOutput(key), [terminalDomain, key]);

  return (
    <div
      className={`terminal-session${isActive ? ' is-active' : ''}`}
      role="tabpanel"
      aria-hidden={!isActive}
    >
      {tab.stream ? (
        <TerminalRenderer
          stream={tab.stream}
          onInput={onInput}
          onResize={onResize}
          onPause={onPause}
          onResume={onResume}
          isVisible={drawerVisible && isActive}
        />
      ) : (
        <div className="top-drawer-empty">
          {tab.error ? `Terminal failed to start: ${tab.error.message}` : 'Starting…'}
        </div>
      )}
    </div>
  );
}

const KIND_TEXT = {
  permission: 'asks for permission',
  question: 'has a question',
  auth: 'needs you to sign in'
};

/** What the tab's program says (slice T2a-2), for the tab's dot. */
function programState(tab) {
  if (tab.needsYou) return 'needs-you';
  return ['working', 'done', 'error'].includes(tab.activity) ? tab.activity : null;
}

/** The same, in words, for the tab's tooltip. A program's own text arrives
 * already stripped of invisible formatting (programStatus.displayText). */
function programTitle(tab) {
  const who = tab.statusApp ?? 'The program';
  const detail = tab.statusText ? `: ${tab.statusText}` : '';
  if (tab.activity === 'blocked') {
    return `Needs you: ${who} ${KIND_TEXT[tab.statusKind] ?? 'is waiting for you'}${detail}`;
  }
  if (tab.needsYou) return 'Needs you: the program rang the bell';
  if (tab.activity === 'working') return `${who} is working${detail}`;
  if (tab.activity === 'done') return `${who} finished${detail}`;
  if (tab.activity === 'error') return `${who} stopped with an error${detail}`;
  return null;
}

function TerminalTab({ tab, isViewed, terminalDomain, projectId }) {
  const [renaming, setRenaming] = useState(false);
  const [confirmingEnd, setConfirmingEnd] = useState(false);
  const inputRef = useRef(null);
  // Escape cancels: the blur that can follow when the box goes away must not
  // commit what was typed.
  const renameCancelledRef = useRef(false);
  const ended = tab.status === 'ended';

  useEffect(() => {
    if (!renaming) return;
    renameCancelledRef.current = false;
    inputRef.current?.select();
  }, [renaming]);

  const select = () => terminalDomain.commands.setViewedSession(projectId, tab.key);

  const commitRename = (value) => {
    terminalDomain.commands.renameSession(tab.key, value);
    setRenaming(false);
  };

  // A session running a program asks first; a shell at its prompt ends at once.
  const requestEnd = async (event) => {
    event.stopPropagation();
    if (await terminalDomain.commands.isBusy(tab.key)) {
      setConfirmingEnd(true);
      return;
    }
    terminalDomain.commands.endSession(tab.key);
  };

  const title = ended
    ? (tab.error ? 'Failed to start' : `Ended${tab.exitCode == null ? '' : ` (exit ${tab.exitCode})`}`)
    : tab.status === 'starting' ? 'Starting' : 'Running';
  const program = programState(tab);
  const programText = programTitle(tab);

  return (
    <div
      className={`terminal-tab${isViewed ? ' is-active' : ''}${ended ? ' is-ended' : ''}${tab.needsYou ? ' needs-you' : ''}`}
      role="tab"
      aria-selected={isViewed}
      tabIndex={0}
      title={`${tab.label} — ${title}${programText ? `\n${programText}` : ''}`}
      onClick={select}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !renaming) select();
      }}
    >
      <span className={`terminal-tab-dot is-${tab.status}${program ? ` is-${program}` : ''}`} aria-hidden="true" />
      {tab.needsYou && <span className="sr-only">Needs you.</span>}
      {renaming ? (
        <input
          ref={inputRef}
          className="terminal-tab-rename"
          defaultValue={tab.label}
          aria-label="Terminal name"
          onClick={(event) => event.stopPropagation()}
          onBlur={(event) => {
            if (!renameCancelledRef.current) commitRename(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            // Escape cancels the rename only; it must not close the drawer.
            event.stopPropagation();
            if (event.key === 'Enter') commitRename(event.currentTarget.value);
            if (event.key === 'Escape') {
              renameCancelledRef.current = true;
              setRenaming(false);
            }
          }}
        />
      ) : (
        <span
          className="terminal-tab-label"
          onDoubleClick={(event) => {
            event.stopPropagation();
            setRenaming(true);
          }}
        >
          {tab.label}
        </span>
      )}
      {confirmingEnd && !ended ? (
        <span className="terminal-tab-confirm" onClick={(event) => event.stopPropagation()}>
          <span>End it?</span>
          <button
            type="button"
            onClick={() => {
              setConfirmingEnd(false);
              terminalDomain.commands.endSession(tab.key);
            }}
            onKeyDown={(event) => event.stopPropagation()}
          >
            End
          </button>
          <button
            type="button"
            onClick={() => setConfirmingEnd(false)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Escape') setConfirmingEnd(false);
            }}
          >
            Keep
          </button>
        </span>
      ) : ended ? (
        <button
          type="button"
          className="terminal-tab-action"
          onClick={(event) => {
            event.stopPropagation();
            terminalDomain.commands.removeSession(tab.key);
          }}
          title="Remove this tab"
          aria-label={`Remove ${tab.label}`}
        >
          <X size={11} />
        </button>
      ) : (
        <button
          type="button"
          className="terminal-tab-action"
          onClick={requestEnd}
          title="End this session"
          aria-label={`End ${tab.label}`}
        >
          <Square size={9} />
        </button>
      )}
    </div>
  );
}

export default DrawerContentTerminal;
