// useManagedLspLifecycle (ADR-005 Slice 6) — one lifecycle hook for ALL
// managed registry languages (rust, cpp), where usePythonLspLifecycle /
// useTsLspLifecycle each own a single bespoke pack. Opening a file a
// registry language claims starts its session when the resolver can supply
// the server (global PATH or managed install); closing the last such file
// stops it; project switch and unmount tear everything down.
//
// The registry-language extensions mirror
// src-tauri/resources/language-server-registry.json (the source of truth) —
// the contract test in test/domains/useManagedLspLifecycle.test.mjs fails
// the build if they drift.
//
// "Managed" here names the generic lifecycle MACHINERY, not the install
// tier: go (ADR-005 Slice 6.5) is toolchain-tier — no registry entry, no
// verified installer — but once gopls exists (PATH or `go env GOPATH`/bin)
// its sessions ride the same detect → gate → activate path.

import { useEffect, useRef } from 'react';

export const MANAGED_LANGUAGE_EXTENSIONS = Object.freeze({
  rust: Object.freeze(['.rs']),
  cpp: Object.freeze(['.c', '.h', '.cpp', '.hpp', '.cc', '.cxx']),
  go: Object.freeze(['.go'])
});

export const MANAGED_LANGUAGE_IDS = Object.freeze(Object.keys(MANAGED_LANGUAGE_EXTENSIONS));

function extensionOf(filename) {
  if (typeof filename !== 'string') return null;
  const normalized = filename.trim().toLowerCase();
  const dot = normalized.lastIndexOf('.');
  if (dot <= 0) return null;
  return normalized.slice(dot);
}

/** Registry language id a filename belongs to, or null. */
export function managedLanguageForFilename(filename) {
  const ext = extensionOf(filename);
  if (!ext) return null;
  for (const [languageId, extensions] of Object.entries(MANAGED_LANGUAGE_EXTENSIONS)) {
    if (extensions.includes(ext)) return languageId;
  }
  return null;
}

/** Set of managed language ids desired by the active files (both panes, ADR-017). */
export function desiredManagedLanguages(activeFilenames = []) {
  const desired = new Set();
  for (const filename of activeFilenames) {
    const languageId = managedLanguageForFilename(filename);
    if (languageId) desired.add(languageId);
  }
  return desired;
}

export function shouldTeardownManagedOnProjectTransition(previousProjectId, nextProjectId) {
  return Boolean(previousProjectId && previousProjectId !== nextProjectId);
}

export function useManagedLspLifecycle({
  projectInstance,
  activeFilenames = [],
  languageSupportDomain
}) {
  const previousProjectRef = useRef(null);

  // Tear down all managed sessions when the user switches projects.
  useEffect(() => {
    if (!languageSupportDomain) return;
    const previousProjectId = previousProjectRef.current;
    const currentProjectId = projectInstance?.instanceId ?? null;
    previousProjectRef.current = currentProjectId;

    if (shouldTeardownManagedOnProjectTransition(previousProjectId, currentProjectId)) {
      languageSupportDomain.commands.teardownManagedLifecycle();
    }
  }, [projectInstance?.instanceId, languageSupportDomain]);

  // Attach / detach Tauri event listeners. lsp:error and lsp:session-ended
  // fire for EVERY language's session — filter to managed ids so a
  // python/ts event never touches a managed pack.
  useEffect(() => {
    if (!languageSupportDomain) return undefined;
    languageSupportDomain.commands.attachManagedListeners({
      onError: (payload) => {
        const languageId = payload?.languageId;
        if (!MANAGED_LANGUAGE_IDS.includes(languageId)) return;
        // Crash payloads carry the server's last stderr lines — diagnostic
        // only, so it lands in the devtools console, never in UI copy.
        if (payload?.stderrTail?.length) {
          console.warn(`[lsp] ${languageId} server stderr tail:\n${payload.stderrTail.join('\n')}`);
        }
        languageSupportDomain.commands.reportManagedRuntimeError(languageId, {
          projectId: payload?.projectId ?? null,
          sessionId: payload?.sessionId ?? null,
          error: {
            category: payload?.category,
            code: payload?.code,
            message: payload?.message
          }
        });
      },
      // A session can end outside this hook's own deactivate path —
      // settings uninstall (Slice 7) stops it backend-side. Clear the
      // stale record so the next decision starts from reality.
      onSessionEnded: (payload) => {
        const languageId = payload?.languageId;
        if (!MANAGED_LANGUAGE_IDS.includes(languageId)) return;
        languageSupportDomain.commands.clearManagedSession(languageId, {
          sessionId: payload?.sessionId ?? null
        });
      }
    });

    return () => {
      languageSupportDomain.commands.detachManagedListeners();
    };
  }, [languageSupportDomain]);

  // Activate / deactivate per language whenever the active files change.
  useEffect(() => {
    if (!languageSupportDomain) return undefined;

    let canceled = false;
    const projectId = projectInstance?.instanceId ?? null;
    const projectRoot = projectInstance?.rootPath ?? null;
    const desired = desiredManagedLanguages(activeFilenames);

    const run = async () => {
      for (const languageId of MANAGED_LANGUAGE_IDS) {
        if (canceled) return;
        const activeSession = languageSupportDomain.selectors.getActiveManagedSession(languageId);
        if (!projectId || !projectRoot || !desired.has(languageId)) {
          if (activeSession) {
            await languageSupportDomain.commands.deactivateManagedForProject(languageId);
          }
          continue;
        }
        if (activeSession?.projectId === projectId) continue;
        await languageSupportDomain.commands.ensureManagedActiveForProject(languageId, {
          projectId,
          projectRoot
        });
      }
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
      languageSupportDomain.commands.teardownManagedLifecycle();
    };
  }, [languageSupportDomain]);
}
