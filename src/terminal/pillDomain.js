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
      addPill({ projectId, message, severity = 'info', exitCode = null, command = null, onActivated = null, action = null }) {
        const pill = {
          id: nextId++,
          projectId,
          message,
          severity,
          exitCode,
          command,
          onActivated,
          action,
          timestamp: Date.now()
        };
        pills = [...pills, pill];
        notify();
        return pill.id;
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
