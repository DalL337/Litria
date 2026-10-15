/**
 * The notice before a project closes while terminals are busy (track T slice
 * T2a). Closing a project ends every terminal session it holds (owner ruling,
 * 2026-10-14). A shell at its prompt ends without a word; a session running a
 * program (a dev server, a build) gets an inline pill first. Never a modal.
 *
 * The pill's button confirms; dismissing the pill means stay. A newer request
 * (the person picked another project meanwhile) cancels the one waiting, so a
 * forgotten pill never holds the next switch.
 *
 * Pure over an injected pill domain so it stays node-testable.
 */
export function createTerminalEndGate({ pillDomain }) {
  let waiting = null;

  const settle = (answer) => {
    if (!waiting) return;
    const { resolve, unsubscribe, pillId } = waiting;
    waiting = null;
    unsubscribe();
    if (pillDomain.selectors.getPills().some((pill) => pill.id === pillId)) {
      pillDomain.commands.dismissPill(pillId);
    }
    resolve(answer);
  };

  return {
    /**
     * Resolves true to go ahead, false to stay.
     * @param {object} request
     * @param {string} request.projectId
     * @param {number} request.busyCount  sessions running a program
     * @param {string} request.action     the button, e.g. 'Switch'
     * @param {string} request.subject    the sentence's subject, e.g. 'Switching'
     */
    confirm({ projectId, busyCount, action, subject }) {
      settle(false);
      if (!pillDomain || !(busyCount > 0)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const message = busyCount === 1
          ? `A terminal is still running a command. ${subject} ends it.`
          : `${busyCount} terminals are still running commands. ${subject} ends them.`;
        const entry = { resolve, unsubscribe: () => {}, pillId: null };
        waiting = entry;
        entry.pillId = pillDomain.commands.addPill({
          projectId,
          message,
          severity: 'warning',
          secondary: { label: action, run: () => settle(true) }
        });
        // Dismissing the pill (its ×) means stay.
        entry.unsubscribe = pillDomain.subscribe((pills) => {
          if (waiting === entry && !pills.some((pill) => pill.id === entry.pillId)) settle(false);
        });
      });
    },
    cancel() {
      settle(false);
    }
  };
}
