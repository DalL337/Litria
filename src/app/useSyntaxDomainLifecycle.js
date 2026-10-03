/**
 * useSyntaxDomainLifecycle.js — React hook for syntaxDomain + syntaxAdapter setup.
 *
 * Creates and memoizes both objects for the lifetime of the project session.
 * Follows the pattern of usePythonLspLifecycle.js / useTsLspLifecycle.js.
 *
 * Usage:
 *   const { syntaxDomain, syntaxAdapter, syntaxConnStatuses } = useSyntaxDomainLifecycle({ projectRoot });
 *
 *   // Pass syntaxDomain.selectors to canvas for port/connection queries.
 *   // Pass syntaxAdapter to EditorMonaco for file lifecycle + connection handlers.
 *   // syntaxConnStatuses (Map<connectionId, 'pending'|'resolved'|'broken'>)
 *   // drives ConnectionLine visual state — the domain-state mirror lived
 *   // inline in App.jsx before the Tier 1 debt cleanup.
 */

import { useMemo, useEffect, useRef, useState } from 'react';
import { createSyntaxDomain } from './syntaxDomain.js';
import { createSyntaxAdapter } from '../lsp/syntaxAdapter.js';

/**
 * @param {{
 *   projectRoot: string,
 *   loadToken?: any,  identity of the current project load (projectInstance._dbState);
 *                     a new one empties the index (see the reset effect)
 *   readProjectFile?: function,
 *   writeProjectFile?: function,
 * }} params
 * @returns {{ syntaxDomain: object, syntaxAdapter: object }}
 */
export function useSyntaxDomainLifecycle({ projectRoot, loadToken = null, readProjectFile, readProjectFileWithRevision, writeProjectFile }) {
  // Domain and adapter are singletons for the component lifetime.
  // They are recreated only if projectRoot changes (effectively on project switch).
  const syntaxDomain = useMemo(() => createSyntaxDomain(), []);

  const syntaxAdapter = useMemo(
    () => createSyntaxAdapter({ syntaxDomain, projectRoot, readProjectFile, readProjectFileWithRevision, writeProjectFile }),
    // projectRoot change intentionally re-creates the adapter (relative paths depend on it).
    // Domain state is preserved — file registration is per-session.
    [syntaxDomain, projectRoot, readProjectFile, readProjectFileWithRevision, writeProjectFile],
  );

  // Mirror the domain's per-connection status into React state so the canvas
  // re-renders when a connection resolves or breaks.
  const [syntaxConnStatuses, setSyntaxConnStatuses] = useState(() => new Map());
  useEffect(() => {
    return syntaxDomain.onStateChange(({ connectionsChanged }) => {
      if (!connectionsChanged?.length) return;
      setSyntaxConnStatuses((prev) => {
        const next = new Map(prev);
        for (const connId of connectionsChanged) {
          const conn = syntaxDomain.selectors.getSyntaxConnection(connId);
          if (conn) {
            next.set(connId, conn.status);
          } else {
            next.delete(connId);
          }
        }
        return next;
      });
    });
  }, [syntaxDomain]);

  // A new project load starts from an empty index. The domain outlives
  // projects, and every load restarts canvas connection ids at conn_1, so
  // the next project's wires were linked to the previous project's edges and
  // its files stayed indexed (P4, 2026-10-01). Reopening the same project is
  // a new load too: its wires are re-created with fresh ids.
  const loadRef = useRef(loadToken);
  useEffect(() => {
    if (loadRef.current === loadToken) return;
    loadRef.current = loadToken;
    syntaxDomain.commands.reset();
    setSyntaxConnStatuses(new Map());
  }, [loadToken, syntaxDomain]);

  // Cleanup: unregister all files when the hook unmounts (project closed / app exits).
  // Currently a no-op at the JS level — GC handles closure memory.
  // If domain grows cleanup needs (e.g., timers), add them here.
  useEffect(() => {
    return () => {
      // Future: syntaxDomain.commands.teardown();
    };
  }, [syntaxDomain]);

  return { syntaxDomain, syntaxAdapter, syntaxConnStatuses };
}
