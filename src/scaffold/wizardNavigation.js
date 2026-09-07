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
