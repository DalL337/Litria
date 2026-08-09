import { useEffect, useRef } from 'react';

function normalizeFilename(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isPythonFilename(filename) {
  const normalized = normalizeFilename(filename);
  return normalized.endsWith('.py') || normalized.endsWith('.pyi');
}

export function shouldTeardownPythonOnProjectTransition(previousProjectId, nextProjectId) {
  return Boolean(previousProjectId && previousProjectId !== nextProjectId);
}

// lsp:error fires for EVERY language's session (the python listener is a
// plain alias of the global listenLspEvents) — filter to the python pack so
// a rust/cpp/ts crash never lands on python runtime-error state. Mirrors
// useManagedLspLifecycle's MANAGED_LANGUAGE_IDS filter.
export function isPythonLspEvent(payload) {
  return payload?.languageId === 'python';
}

export function usePythonLspLifecycle({
  projectInstance,
  activeFilenames = [],
  languageSupportDomain
}) {
  const previousProjectRef = useRef(null);

  useEffect(() => {
    if (!languageSupportDomain) return;
    const previousProjectId = previousProjectRef.current;
    const currentProjectId = projectInstance?.instanceId ?? null;
    previousProjectRef.current = currentProjectId;

    if (shouldTeardownPythonOnProjectTransition(previousProjectId, currentProjectId)) {
      languageSupportDomain.commands.teardownPythonLifecycle();
    }
  }, [projectInstance?.instanceId, languageSupportDomain]);

  useEffect(() => {
    if (!languageSupportDomain) return undefined;
    languageSupportDomain.commands.attachPythonListeners({
      onError: (payload) => {
        if (!isPythonLspEvent(payload)) return;
        // Crash payloads carry the server's last stderr lines — diagnostic
        // only, so it lands in the devtools console, never in UI copy.
        if (payload?.stderrTail?.length) {
          console.warn(`[lsp] python server stderr tail:\n${payload.stderrTail.join('\n')}`);
        }
        languageSupportDomain.commands.reportPythonRuntimeError({
          projectId: payload?.projectId ?? null,
          sessionId: payload?.sessionId ?? null,
          error: {
            category: payload?.category,
            code: payload?.code,
            message: payload?.message
          }
        });
      }
    });

    return () => {
      languageSupportDomain.commands.detachPythonListeners();
    };
  }, [languageSupportDomain]);

  useEffect(() => {
    if (!languageSupportDomain) return undefined;

    let canceled = false;
    const projectId = projectInstance?.instanceId ?? null;
    const projectRoot = projectInstance?.rootPath ?? null;
    const activeSession = languageSupportDomain.selectors.getActiveSession('python');

    const run = async () => {
      // ADR-017: with split panes there can be two active files; keep the
      // server alive when ANY pane's active file is Python.
      if (!projectId || !projectRoot || !activeFilenames.some(isPythonFilename)) {
        await languageSupportDomain.commands.deactivatePythonForProject();
        return;
      }
      if (activeSession?.projectId === projectId) {
        return;
      }

      const setupResult = await languageSupportDomain.commands.runPythonSetupDetection();
      if (canceled || !setupResult?.ok || setupResult?.result?.status !== 'Installed') return;

      await languageSupportDomain.commands.activatePythonForProject({
        projectId,
        projectRoot
      });
    };

    run();

    return () => {
      canceled = true;
    };
  }, [
    activeFilenames,
    languageSupportDomain,
    projectInstance?.instanceId,
    projectInstance?.rootPath
  ]);

  useEffect(() => {
    if (!languageSupportDomain) return undefined;
    return () => {
      languageSupportDomain.commands.teardownPythonLifecycle();
    };
  }, [languageSupportDomain]);
}
