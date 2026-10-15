import { useEffect, useRef } from 'react';

export function shouldTeardownOnProjectTransition(previousProjectId, nextProjectId) {
  return Boolean(previousProjectId && nextProjectId && previousProjectId !== nextProjectId);
}

export function reloadReportMessage(count) {
  if (!Number.isInteger(count) || count <= 0) return null;
  return count === 1
    ? 'The window reloaded, so its terminal session ended.'
    : `The window reloaded, so its ${count} terminal sessions ended.`;
}

/**
 * Keeps TerminalDomain's current project in step with the open project.
 *
 * Ending sessions is not this hook's job on a switch: the switch coordinator
 * (useProjectLaunch) ends them, awaited, before the next project opens. This
 * stays as a backstop, scoped to the PREVIOUS project, so it can never touch
 * a session the new project has already started. App never unmounts, and
 * quitting is handled in Rust, so there is no unmount teardown here.
 */
export function useTerminalLifecycle({ projectInstance, terminalDomain, showToast = null }) {
  const previousProjectRef = useRef(null);
  const instanceId = projectInstance?.instanceId ?? null;
  const rootPath = projectInstance?.rootPath ?? null;

  useEffect(() => {
    if (!terminalDomain) return;
    const previousProject = previousProjectRef.current;
    previousProjectRef.current = instanceId;
    terminalDomain.commands.setCurrentProject(
      instanceId && rootPath ? { id: instanceId, root: rootPath } : null
    );
    if (shouldTeardownOnProjectTransition(previousProject, instanceId)) {
      terminalDomain.commands.endProject(previousProject);
    }
  }, [instanceId, rootPath, terminalDomain]);

  // A page reload ends every session (Rust does it as the page starts to
  // load). Say so once; the ref survives StrictMode's double effect.
  const reportedRef = useRef(false);
  useEffect(() => {
    if (!terminalDomain || reportedRef.current) return;
    reportedRef.current = true;
    terminalDomain.commands.takeReloadReport().then((count) => {
      const message = reloadReportMessage(count);
      if (message) showToast?.(message, { severity: 'info' });
    });
  }, [terminalDomain, showToast]);
}
