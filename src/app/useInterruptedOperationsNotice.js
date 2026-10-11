// useInterruptedOperationsNotice (Project API build plan W4b; owner ruling
// 2026-10-11): when a project opens, Rust settles every agent change an
// earlier run of Litria left half-applied, and reports each one once. This
// hook asks once per project load (the `_dbState` token idiom, as the
// first-open hooks do) and shows a pill per interrupted change. Nothing is
// replayed and no agent is asked to do anything.

import { useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { describeInterruptedOperation } from './interruptedOperations.js';

export function useInterruptedOperationsNotice({ projectInstance, pillDomain }) {
  const ranForTokenRef = useRef(null);

  useEffect(() => {
    const token = projectInstance?._dbState;
    const epoch = token?.workspaceEpoch;
    if (!token || typeof epoch !== 'string' || !epoch || !pillDomain) return;
    if (ranForTokenRef.current === token) return;
    ranForTokenRef.current = token;
    const projectId = projectInstance.instanceId;
    // Rust marks each change reported as it answers, so its pill is shown for
    // the project instance that asked even if the user has moved on.
    invoke('project_api_interrupted_operations', { epoch })
      .then((reports) => {
        for (const report of Array.isArray(reports) ? reports : []) {
          const message = describeInterruptedOperation(report);
          if (message) pillDomain.commands.addPill({ projectId, message, severity: 'info' });
        }
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.warn('[project-api] interrupted operations unavailable:', error);
      });
  }, [projectInstance, pillDomain]);
}
