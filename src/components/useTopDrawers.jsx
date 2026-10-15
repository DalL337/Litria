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
 * @param {object|null} opts.projectInstance
 * @returns {Array<object>} memoized drawer descriptors
 */
export function useTopDrawers({
  terminalDomain,
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
        // contentKey remounts the view when the project changes, so the new
        // project starts with fresh screens. It ends nothing: the switch
        // coordinator ends the old project's sessions (track T slice T2a).
        contentKey: projectInstance?.instanceId ?? 'no-project',
        // Opening the terminal from its rail: a project with no tab gets a
        // shell. The domain decides; the drawer only reports the gesture.
        onOpen: () => {
          terminalDomain?.commands.ensureSession();
        },
        content: (
          <DrawerContentTerminal
            terminalDomain={terminalDomain}
            projectId={projectInstance?.instanceId ?? null}
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
      projectInstance?.instanceId,
      buildLogDomain,
      buildLogActions,
      logsTab
    ]
  );
}
