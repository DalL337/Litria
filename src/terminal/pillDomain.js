export function createPillDomain() {
  let pills = [];
  let nextId = 1;
  let listeners = [];

  function notify() {
    const snapshot = pills;
    for (const fn of listeners) {
      fn(snapshot);
    }
  }

  return {
    commands: {
      // command/onActivated (ADR-020 Slice 4): action pills. `command` is
      // shell input PillNotification types into the visible terminal when
      // the pill body is clicked; `onActivated` fires after injection (flag
      // persistence). Plain notification pills leave both unset and keep
      // the original click-opens-terminal behavior.
      // `action` (ADR-005 A3, Slice 5): a callback pill for class-1 consent
      // (verified managed installs) — the click runs the callback instead of
      // the terminal; class-3 offers keep using `command` (the terminal IS
      // their consent surface).
      // `secondary` ({ label, run }): a small button beside the message that
      // runs without dismissing the pill — an install's Cancel.
      addPill({ projectId, message, severity = 'info', exitCode = null, command = null, onActivated = null, action = null, secondary = null }) {
        const pill = {
          id: nextId++,
          projectId,
          message,
          severity,
          exitCode,
          command,
          onActivated,
          action,
          secondary,
          timestamp: Date.now()
        };
        pills = [...pills, pill];
        notify();
        return pill.id;
      },
      // Live pills change in place (an install's progress, then "Cancelling…").
      // Only the visible parts can change; a pill that is gone stays gone.
      updatePill(id, { message, severity, secondary } = {}) {
        let changed = false;
        pills = pills.map((p) => {
          if (p.id !== id) return p;
          changed = true;
          return {
            ...p,
            ...(message !== undefined && { message }),
            ...(severity !== undefined && { severity }),
            ...(secondary !== undefined && { secondary }),
          };
        });
        if (changed) notify();
      },
      dismissPill(id) {
        pills = pills.filter((p) => p.id !== id);
        notify();
      },
      clearForProject(projectId) {
        pills = pills.filter((p) => p.projectId !== projectId);
        notify();
      }
    },
    selectors: {
      getPills() {
        return pills;
      }
    },
    subscribe(fn) {
      listeners.push(fn);
      return () => {
        listeners = listeners.filter((l) => l !== fn);
      };
    }
  };
}
