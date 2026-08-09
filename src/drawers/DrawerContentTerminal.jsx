import { useCallback, useEffect, useRef, useState } from 'react';
import TerminalRenderer from '../components/TerminalRenderer';
import { prefsLoadGlobal } from '../preferences/preferencesStore.js';
import { resolveTerminalCloseBehavior } from '../terminal/terminalClosePreference.js';

function DrawerContentTerminal({ terminalDomain, pillDomain, projectId, projectRoot, isVisible = false }) {
  const [channel, setChannel] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [spawnError, setSpawnError] = useState(null);
  const spawnAttemptedRef = useRef(false);

  // Spawn PTY session when drawer opens with an active project
  useEffect(() => {
    if (!isVisible || !projectId || !projectRoot || !terminalDomain) return;
    if (spawnAttemptedRef.current) return;

    let cancelled = false;
    setSpawnError(null);

    const spawn = async () => {
      const ch = await terminalDomain.commands.spawnWithChannel({
        projectId,
        projectRoot,
        cols: 80,
        rows: 24
      });
      if (cancelled) return;
      if (ch) {
        spawnAttemptedRef.current = true;
        setChannel(ch);
        const session = terminalDomain.selectors.getActiveSession();
        setSessionId(session?.sessionId ?? null);
      } else {
        const lastErr = terminalDomain.selectors.getLastError();
        setSpawnError(lastErr?.message || 'PTY spawn returned no channel');
      }
    };
    spawn();

    return () => { cancelled = true; };
  }, [isVisible, projectId, projectRoot, terminalDomain]);

  // Reset spawn state when project changes. With the per-project keying in
  // TopDrawerShell (Phase 1 of the fix plan), this normally fires only on
  // mount because each instance is bound to a single projectId via the
  // wrapper key. Kept as defense in depth in case the keying is bypassed.
  useEffect(() => {
    spawnAttemptedRef.current = false;
    setChannel(null);
    setSessionId(null);
  }, [projectId]);

  // End the Rust PTY session on unmount (project switch via wrapper key
  // remount, or app close). NO isVisible in deps — this effect must not
  // fire on drawer toggle, only on actual unmount or projectId change.
  // Z.5 v1 (commits 00f64e9 / ee58825) used isVisible in deps and broke
  // the spawn path; this version cannot recreate that bug.
  // See docs/plans/persistence/project-switch-crash-investigation.md.
  useEffect(() => {
    if (!projectId || !terminalDomain) return;
    return () => {
      if (spawnAttemptedRef.current) {
        terminalDomain.commands.endForProject(projectId);
      }
    };
  }, [projectId, terminalDomain]);

  // Phase 4: End the Rust PTY session when the drawer collapses (isVisible
  // goes true → false) within the same project. Without this, a user who
  // opens the terminal, closes the drawer, and keeps using the same project
  // leaks one PTY session until the next project switch or app close.
  //
  // Uses a transition-detecting ref pattern (NOT a useEffect cleanup).
  // Z.5 v1 used a cleanup-based approach keyed on isVisible and broke
  // the spawn path. This version only acts when wasVisibleRef.current is
  // true AND isVisible is now false — i.e., specifically the close transition.
  // On the open transition (false → true), the condition is false && true
  // which is false, so no action is taken. Safe.
  //
  // ADR-019 `terminalDrawerClose` steers the close: 'end' (default) kills
  // the session as above; 'hide' keeps it alive behind the collapsed drawer
  // — the renderer stays mounted (Rule 4 CSS toggling), output keeps
  // flowing into the buffer under the flow-control watermarks, and reopen
  // finds the live session (spawnAttemptedRef stays true so the spawn
  // effect no-ops). The pref is resolved at close-time so changes need no
  // listener; a load failure falls back to 'end'. Project switch and app
  // exit still hard-kill regardless (unmount effect above +
  // useTerminalLifecycle) — clean shutdown is not steerable.
  const wasVisibleRef = useRef(false);
  useEffect(() => {
    if (wasVisibleRef.current && !isVisible) {
      if (spawnAttemptedRef.current && projectId && terminalDomain) {
        (async () => {
          let behavior = 'end';
          try {
            behavior = resolveTerminalCloseBehavior(await prefsLoadGlobal());
          } catch {
            behavior = 'end';
          }
          if (behavior === 'hide') return;
          // Reopened while the pref was loading — killing now would break
          // the visible terminal. Skip; a close that stays closed ends it.
          if (wasVisibleRef.current) return;
          if (spawnAttemptedRef.current && terminalDomain) {
            terminalDomain.commands.endForProject(projectId);
            spawnAttemptedRef.current = false;
            setChannel(null);
            setSessionId(null);
          }
        })();
      }
    }
    wasVisibleRef.current = isVisible;
  }, [isVisible, projectId, terminalDomain]);

  const handleInput = useCallback(
    (data) => {
      if (projectId && terminalDomain) {
        terminalDomain.commands.sendInput({ projectId, input: data });
      }
    },
    [projectId, terminalDomain]
  );

  const handleResize = useCallback(
    (cols, rows) => {
      if (projectId && terminalDomain) {
        terminalDomain.commands.resize({ projectId, cols, rows });
      }
    },
    [projectId, terminalDomain]
  );

  const handlePause = useCallback(() => {
    if (projectId && terminalDomain) {
      terminalDomain.commands.pauseOutput({ projectId });
    }
  }, [projectId, terminalDomain]);

  const handleResume = useCallback(() => {
    if (projectId && terminalDomain) {
      terminalDomain.commands.resumeOutput({ projectId });
    }
  }, [projectId, terminalDomain]);

  const handleProcessComplete = useCallback(
    (exitCode) => {
      if (!pillDomain || !projectId) return;
      const isSuccess = exitCode === 0 || exitCode === null;
      pillDomain.commands.addPill({
        projectId,
        message: isSuccess ? 'Process completed' : `Process exited (${exitCode})`,
        severity: isSuccess ? 'success' : 'error',
        exitCode
      });
    },
    [pillDomain, projectId]
  );

  if (!projectId) {
    return (
      <div className="top-drawer-empty">
        Open a project to start a terminal session.
      </div>
    );
  }

  if (spawnError) {
    return (
      <div className="top-drawer-empty" style={{ color: '#f87171' }}>
        Terminal failed: {spawnError}
      </div>
    );
  }

  return (
    <TerminalRenderer
      channel={channel}
      projectId={projectId}
      sessionId={sessionId}
      onInput={handleInput}
      onResize={handleResize}
      onPause={handlePause}
      onResume={handleResume}
      onProcessComplete={handleProcessComplete}
      isVisible={isVisible}
    />
  );
}

export default DrawerContentTerminal;
