import { useMemo } from 'react';
import { Terminal as TerminalIcon, ScrollText } from 'lucide-react';
import DrawerContentTerminal from '../drawers/DrawerContentTerminal';
import DrawerContentLogs from '../drawers/DrawerContentLogs';

/**
 * useTopDrawers — builds the configuration array for the top drawer rail.
 *
 * Extracted from App.jsx (Session 1, Group H) to keep the app shell
 * composition-only. Returns the memoized list of drawer descriptors
 * consumed by TopDrawerProvider.
 *
 * Lives in src/components/ rather than src/app/ because it imports
 * UI components (DrawerContentTerminal). The architecture guard
 * forbids domain-layer files (src/app/) from depending on the UI layer.
 *
 * @param {object} opts
 * @param {object} opts.terminalDomain
 * @param {object} opts.pillDomain
 * @param {object|null} opts.projectInstance
 * @returns {Array<object>} memoized drawer descriptors
 */
export function useTopDrawers({
  terminalDomain,
  pillDomain,
  projectInstance,
  buildLogDomain = null,
  buildLogActions = null,
  logsTab = 'build',
}) {
  return useMemo(
    () => [
      {
        id: 'terminal',
        label: 'Terminal',
        icon: TerminalIcon,
        // contentKey forces TopDrawerShell to remount the wrapper subtree
        // when the project changes, so DrawerContentTerminal unmounts cleanly
        // for the OLD project (running its endForProject cleanup) and a fresh
        // instance mounts for the NEW project. See
        // docs/plans/persistence/project-switch-crash-investigation.md Phase 3.
        contentKey: projectInstance?.instanceId ?? 'no-project',
        content: (
          <DrawerContentTerminal
            terminalDomain={terminalDomain}
            pillDomain={pillDomain}
            projectId={projectInstance?.instanceId ?? null}
            projectRoot={projectInstance?.rootPath ?? null}
          />
        )
      },
      {
        id: 'logs',
        label: 'Logs',
        icon: ScrollText,
        // Remount when the requested tab changes so opening via
        // "View Crash Logs" lands on Crash rather than the last-used tab.
        contentKey: logsTab,
        content: (
          <DrawerContentLogs
            buildLogDomain={buildLogDomain}
            buildLogActions={buildLogActions}
            initialTab={logsTab}
          />
        )
      }
    ],
    [
      terminalDomain,
      pillDomain,
      projectInstance?.instanceId,
      projectInstance?.rootPath,
      buildLogDomain,
      buildLogActions,
      logsTab
    ]
  );
}
