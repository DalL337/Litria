// undoManager.js
// Generic undo/redo manager for command-pattern actions.

export function createUndoManager({ maxHistory = 200 } = {}) {
  let past = [];
  let future = [];
  let group = null;
  // Reentrancy depth for nested begin/endGroup. Composed flows (e.g. the
  // wire-birth nudge: piece move + connection create as ONE undo step) open
  // an outer group while inner helpers open/close their own — only the
  // outermost endGroup closes the composite.
  let groupDepth = 0;
  const listeners = new Set();

  const notify = () => {
    listeners.forEach(listener => listener());
  };

  const trimHistory = () => {
    if (past.length > maxHistory) {
      past = past.slice(past.length - maxHistory);
    }
  };

  const tryMerge = (action) => {
    if (!past.length) return false;
    const previous = past[past.length - 1];
    if (typeof action.merge !== 'function') return false;
    const merged = action.merge(previous);
    if (!merged) return false;
    past[past.length - 1] = merged;
    return true;
  };

  const pushHistory = (action) => {
    if (group) {
      group.actions.push(action);
      return;
    }

    if (!tryMerge(action)) {
      past = [...past, action];
      trimHistory();
    }

    future = [];
    notify();
  };

  const execute = (action, options = {}) => {
    const { skipDo = false } = options;
    if (!skipDo && typeof action.do === 'function') {
      action.do();
    }
    pushHistory(action);
  };

  const undo = () => {
    if (!past.length) return;
    const action = past[past.length - 1];
    past = past.slice(0, -1);
    if (typeof action.undo === 'function') {
      action.undo();
    }
    future = [action, ...future];
    notify();
  };

  const redo = () => {
    if (!future.length) return;
    const action = future[0];
    future = future.slice(1);
    if (typeof action.do === 'function') {
      action.do();
    }
    past = [...past, action];
    trimHistory();
    notify();
  };

  // Begin a grouped history entry (all actions until endGroup become one
  // undo step). Reentrant: nested beginGroup joins the open group.
  const beginGroup = (label = 'Group') => {
    if (group) {
      groupDepth += 1;
      return;
    }
    group = { label, actions: [] };
    groupDepth = 1;
  };

  // End the current group and push a composite action onto history. Nested
  // ends only unwind their own depth; the outermost end closes the group.
  const endGroup = () => {
    if (!group) return;
    if (groupDepth > 1) {
      groupDepth -= 1;
      return;
    }
    groupDepth = 0;
    const actions = group.actions;
    const label = group.label;
    group = null;

    if (!actions.length) return;

    const groupedAction = {
      label,
      do: () => {
        actions.forEach(action => action.do?.());
      },
      undo: () => {
        [...actions].reverse().forEach(action => action.undo?.());
      }
    };

    pushHistory(groupedAction);
  };

  const clear = () => {
    past = [];
    future = [];
    group = null;
    groupDepth = 0;
    notify();
  };

  const canUndo = () => past.length > 0;
  const canRedo = () => future.length > 0;

  // Subscribe to history changes for UI state (canUndo/canRedo).
  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return {
    execute,
    pushAction: execute,
    undo,
    redo,
    canUndo,
    canRedo,
    beginGroup,
    endGroup,
    clear,
    subscribe
  };
}
