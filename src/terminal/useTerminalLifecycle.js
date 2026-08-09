import { useEffect, useRef } from 'react';

export function shouldTeardownOnProjectTransition(previousProjectId, nextProjectId) {
  return Boolean(previousProjectId && nextProjectId && previousProjectId !== nextProjectId);
}

export function useTerminalLifecycle({ projectInstance, terminalDomain }) {
  const previousProjectRef = useRef(null);

  useEffect(() => {
    if (!terminalDomain) return;
    const previousProject = previousProjectRef.current;
    const currentProject = projectInstance?.instanceId ?? null;
    previousProjectRef.current = currentProject;

    // Project switch: teardown all active terminal sessions for deterministic cleanup.
    if (shouldTeardownOnProjectTransition(previousProject, currentProject)) {
      terminalDomain.commands.teardownAll();
    }
  }, [projectInstance?.instanceId, terminalDomain]);

  useEffect(() => {
    if (!terminalDomain) return undefined;

    return () => {
      // App/session unmount: force terminal teardown.
      terminalDomain.commands.teardownAll();
    };
  }, [terminalDomain]);
}
