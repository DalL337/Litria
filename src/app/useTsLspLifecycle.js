import { useEffect, useRef } from 'react';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function normalizeFilename(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isTsFilename(filename) {
  const normalized = normalizeFilename(filename);
  const dot = normalized.lastIndexOf('.');
  return dot >= 0 && TS_EXTENSIONS.has(normalized.slice(dot));
}

export function shouldTeardownTsOnProjectTransition(previousProjectId, nextProjectId) {
  return Boolean(previousProjectId && previousProjectId !== nextProjectId);
}

// lsp:error fires for EVERY language's session (the ts listener is a plain
// alias of the global listenLspEvents) — filter to the typescript pack (the
// session-level id for all TS/JS variants) so a rust/cpp/python crash never
// lands on ts runtime-error state. Mirrors useManagedLspLifecycle's
// MANAGED_LANGUAGE_IDS filter.
export function isTsLspEvent(payload) {
  return payload?.languageId === 'typescript';
}

export function useTsLspLifecycle({
  projectInstance,
  activeFilenames = [],
  languageSupportDomain
}) {
  const previousProjectRef = useRef(null);

  // Tear down when the user switches to a different project.
  useEffect(() => {
    if (!languageSupportDomain) return;
    const previousProjectId = previousProjectRef.current;
    const currentProjectId = projectInstance?.instanceId ?? null;
    previousProjectRef.current = currentProjectId;

    if (shouldTeardownTsOnProjectTransition(previousProjectId, currentProjectId)) {
      languageSupportDomain.commands.teardownTsLifecycle();
    }
  }, [projectInstance?.instanceId, languageSupportDomain]);

  // Attach / detach Tauri event listeners (session started/ended, errors).
  useEffect(() => {
    if (!languageSupportDomain) return undefined;
    languageSupportDomain.commands.attachTsListeners({
      onError: (payload) => {
        if (!isTsLspEvent(payload)) return;
        // Crash payloads carry the server's last stderr lines — diagnostic
        // only, so it lands in the devtools console, never in UI copy.
        if (payload?.stderrTail?.length) {
          console.warn(`[lsp] typescript server stderr tail:\n${payload.stderrTail.join('\n')}`);
        }
        languageSupportDomain.commands.reportTsRuntimeError({
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
      languageSupportDomain.commands.detachTsListeners();
    };
  }, [languageSupportDomain]);

  // Activate / deactivate the tsserver session whenever the active file changes.
  useEffect(() => {
    if (!languageSupportDomain) return undefined;

    let canceled = false;
    const projectId = projectInstance?.instanceId ?? null;
    const projectRoot = projectInstance?.rootPath ?? null;
    const activeSession = languageSupportDomain.selectors.getActiveSession('typescript');

    const run = async () => {
      // ADR-017: with split panes there can be two active files; keep the
      // server alive when ANY pane's active file is TS/JS.
      if (!projectId || !projectRoot || !activeFilenames.some(isTsFilename)) {
        await languageSupportDomain.commands.deactivateTsForProject();
        return;
      }
      if (activeSession?.projectId === projectId) {
        return;
      }

      const setupResult = await languageSupportDomain.commands.runTsSetupDetection();
      if (canceled || !setupResult?.ok || setupResult?.result?.status !== 'Installed') return;

      await languageSupportDomain.commands.activateTsForProject({
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

  // Tear down on unmount (component removed or domain replaced).
  useEffect(() => {
    if (!languageSupportDomain) return undefined;
    return () => {
      languageSupportDomain.commands.teardownTsLifecycle();
    };
  }, [languageSupportDomain]);
}
