/**
 * wizardNavigation.js — the New Project wizard's navigation rules, kept pure
 * so they can be tested without a DOM (brief-wizard-robustness.md, slice 2).
 *
 * The component owns the DOM and the dispatching; this module owns the
 * answers: which step is where, whether Next is allowed, whether leaving
 * would lose work, and where an arrow key lands inside a card group.
 */

export const WIZARD_STEPS = Object.freeze([
  { key: 'identity', label: 'Identity', title: "Let's start here.", sub: 'Name it. Place it. Let’s build.' },
  { key: 'stack', label: 'Stack', title: 'Pick your stack.', sub: 'Choose what powers your project.' },
  { key: 'workspace', label: 'Workspace', title: 'Shape the workspace.', sub: 'Set the visual defaults before you touch the desk.' },
  { key: 'create', label: 'Create', title: 'Ready to create.', sub: 'This is the project Litria is about to make.' }
]);

export const WIZARD_STEP_COUNT = WIZARD_STEPS.length;

/**
 * 'current' | 'done' | 'todo'. A step counts as done once it has been
 * reached, even after stepping back past it — the stepper lets the user
 * return to any reached step without losing work (NN/g wizard guidance).
 */
export function stepState(index, page, maxReached) {
  if (index === page) return 'current';
  return index <= maxReached ? 'done' : 'todo';
}

/**
 * Whether Next may leave `page`. Identity needs a name and a location.
 * Stack: Blank needs no stack (the wrapper choice alone completes it);
 * Python never blocks on interpreter state (ADR-020: creation proceeds
 * files-only when no Python exists) — archetype + auto-locked language
 * complete the page exactly like any other stack. Workspace always may.
 */
export function canAdvance(state, page) {
  if (page === 0) return state.name.trim() !== '' && state.folder.trim() !== '';
  if (page === 1) {
    if (state.wrapper === 'blank') return true;
    return state.wrapper !== null && state.framework !== null && state.lang !== null;
  }
  return page < WIZARD_STEP_COUNT - 1;
}

/**
 * Would cancelling lose something the user typed or chose? The seeded
 * folder and theme do not count — they came from Preferences, not from
 * this session.
 */
export function isWizardDirty(state, page) {
  return state.name.trim() !== '' || state.wrapper !== null || page > 0;
}

// Arrow keys → direction inside a card group (Right/Down forward, Left/Up back).
export const ROVING_KEYS = Object.freeze({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 });

/**
 * The option index an arrow press lands on, wrapping at both ends like a
 * native radio group. null when there is nothing to move to.
 */
export function rovingTarget(index, count, delta) {
  if (index < 0 || count < 2 || !delta) return null;
  return (index + delta + count) % count;
}

// ---------------------------------------------------------------------------
// Advanced folds (slice 3). A fold header counts its non-default choices so a
// collapsed fold can never hide a surprise. Only what the fold actually
// holds for this stack is counted.
// ---------------------------------------------------------------------------

/** Stack step fold: package manager, backend (web), Python environment engine. */
export function countAdvancedChanges(state) {
  if (!state.wrapper || state.wrapper === 'blank') return 0;
  if (state.wrapper === 'python') {
    let n = state.pyEnvEngine !== 'auto' ? 1 : 0;
    if (state.pyEnvMode === 'existing' && (state.pyExistingEnv ?? '').trim() !== '') n += 1;
    return n;
  }
  let n = state.manager !== 'npm' ? 1 : 0;
  if (state.wrapper === 'web' && state.backend !== 'none') n += 1;
  return n;
}

/** Workspace step fold: folder-group and single-piece colour modes. */
export function countColorChanges(state) {
  return (state.groupColorMode !== 'auto' ? 1 : 0) + (state.nodeColorMode !== 'inherit' ? 1 : 0);
}

// Review rows whose value lives inside the Stack step's Advanced fold: the
// Edit jump opens the fold so the control is on screen, not behind a click.
const ADVANCED_ROW_KEYS = new Set(['Backend', 'Package Manager', 'Environment']);

/**
 * Where a review-row Edit control jumps: the owning step, and which fold to
 * open there (or null). Keys are the review-card labels.
 */
export function reviewRowTarget(key) {
  if (key === 'Project' || key === 'Location') return { step: 0, fold: null };
  if (key === 'Workspace') return { step: 2, fold: null };
  return { step: 1, fold: ADVANCED_ROW_KEYS.has(key) ? 'advanced' : null };
}
