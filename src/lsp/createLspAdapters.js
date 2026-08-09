/**
 * createLspAdapters.js — Tauri IPC adapter factory for LanguageSupportDomain.
 *
 * Bridges lspClient invoke wrappers to the adapter interface expected by
 * createLanguageSupportDomain(). Lives in src/lsp/ alongside lspClient.js
 * so all Tauri IPC coupling is co-located in one module boundary.
 */

import {
  lspDetectPrerequisites,
  lspStartSession,
  lspStopSession,
  listenLspEvents,
  detectPythonInterpreters
} from './lspClient';
import { sanitizeLspError } from './lspErrorSanitize';

export function createLspAdapters() {
  return {
    // -------------------------------------------------------------------------
    // Python adapters
    // -------------------------------------------------------------------------

    detectPythonSupportSnapshot: async () => {
      try {
        const result = await lspDetectPrerequisites('python');
        const probes = result?.probes ?? [];
        const findProbe = (cmd) => probes.find((p) => p.command === cmd);
        return {
          python: findProbe('python') ?? { available: false },
          node:   findProbe('node')   ?? { available: false },
          server: findProbe('pyright') ?? findProbe('pyright-langserver') ?? { available: false },
        };
      } catch {
        return null;
      }
    },

    detectPlatform: () => {
      const platform = window.navigator?.platform?.toLowerCase() ?? '';
      if (platform.includes('mac')) return 'darwin';
      if (platform.includes('win')) return 'win32';
      return 'linux';
    },

    listPythonInterpreters: async () => {
      // Throws propagate: the domain records the failure on its interpreter
      // state (unlike snapshot detection, "probe failed" is worth surfacing).
      return detectPythonInterpreters();
    },

    startPythonLsp: async ({ projectId, projectRoot }) => {
      try {
        const data = await lspStartSession('python', projectId, projectRoot);
        return { ok: true, data: { sessionId: data.sessionId, ready: true } };
      } catch (e) {
        return { ok: false, error: sanitizeLspError(e) };
      }
    },

    stopPythonLsp: async ({ projectId }) => {
      try {
        await lspStopSession('python', projectId);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: sanitizeLspError(e) };
      }
    },

    listenPythonLspEvents: (handlers) => listenLspEvents(handlers),

    // -------------------------------------------------------------------------
    // TypeScript adapters
    // -------------------------------------------------------------------------

    detectTsSupportSnapshot: async () => {
      try {
        const result = await lspDetectPrerequisites('typescript');
        const probes = result?.probes ?? [];
        const findProbe = (cmd) => probes.find((p) => p.command === cmd);
        return {
          node:   findProbe('node')   ?? { available: false },
          server: findProbe('typescript-language-server') ?? { available: false },
          tsc:    findProbe('tsc')    ?? { available: false },
        };
      } catch {
        return null;
      }
    },

    startTsLsp: async ({ projectId, projectRoot }) => {
      try {
        const data = await lspStartSession('typescript', projectId, projectRoot);
        return { ok: true, data: { sessionId: data.sessionId, ready: true } };
      } catch (e) {
        return { ok: false, error: sanitizeLspError(e) };
      }
    },

    stopTsLsp: async ({ projectId }) => {
      try {
        await lspStopSession('typescript', projectId);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: sanitizeLspError(e) };
      }
    },

    listenTsLspEvents: (handlers) => listenLspEvents(handlers),

    // -------------------------------------------------------------------------
    // Managed-language adapters (ADR-005 Slice 6) — generic by languageId.
    // The prerequisites payload's resolutionTier is the availability gate;
    // throws propagate so the domain records the failure on the pack state.
    // -------------------------------------------------------------------------

    detectManagedSupport: async (languageId) => lspDetectPrerequisites(languageId),

    startManagedLsp: async ({ languageId, projectId, projectRoot }) => {
      try {
        const data = await lspStartSession(languageId, projectId, projectRoot);
        return { ok: true, data: { sessionId: data.sessionId, ready: true } };
      } catch (e) {
        return { ok: false, error: sanitizeLspError(e) };
      }
    },

    stopManagedLsp: async ({ languageId, projectId }) => {
      try {
        await lspStopSession(languageId, projectId);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: sanitizeLspError(e) };
      }
    },

    listenManagedLspEvents: (handlers) => listenLspEvents(handlers),
  };
}
