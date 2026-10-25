import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { Terminal as TerminalIcon, ScrollText } from 'lucide-react';
import DrawerContentTerminal from '../drawers/DrawerContentTerminal';
import DrawerContentLogs from '../drawers/DrawerContentLogs';

const subscribeNothing = () => () => {};

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
  // A session of the open project that needs the person and is out of sight
  // badges the rail (track T slice T2a-2).
  const projectId = projectInstance?.instanceId ?? null;
  const getNeedsYou = useCallback(
    () => Boolean(terminalDomain && projectId && terminalDomain.selectors.getProject(projectId).needsYouKey),
    [terminalDomain, projectId]
  );
  const terminalNeedsYou = useSyncExternalStore(terminalDomain?.subscribe ?? subscribeNothing, getNeedsYou);

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
        badge: terminalNeedsYou ? 'a session needs you' : null,
        // Opening the terminal from its rail: a project with no tab gets a
        // shell, and a session that needs the person is the one shown. The
        // domain decides; the drawer only reports the gesture.
        onOpen: () => {
          terminalDomain?.commands.ensureSession();
          terminalDomain?.commands.showSessionNeedingYou();
        },
        content: (
          <DrawerContentTerminal
            terminalDomain={terminalDomain}
            projectId={projectInstance?.instanceId ?? null}
            hasFolder={Boolean(projectInstance?.rootPath)}
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
      projectInstance?.rootPath,
      buildLogDomain,
      buildLogActions,
      logsTab,
      terminalNeedsYou
    ]
  );
}
