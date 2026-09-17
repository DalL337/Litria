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

// ---------------------------------------------------------------------------
// Run lifecycle (ADR-028 §6). One state replaces the scaffolding / held /
// error flags; every permission below is a pure function of it, so the
// stepper, Back, Alt+arrows, review-row edits, Cancel and Create cannot
// disagree about what a running or created project allows.
// ---------------------------------------------------------------------------

export const RUN_STATES = Object.freeze(['idle', 'running', 'held', 'opening', 'failed']);

/** Moving between steps or editing choices: only while nothing has been
 *  created and nothing is executing. A held (created) project must not have
 *  its review rows drift from what exists on disk (F18, F20). */
export function canNavigate(runState, hasCreatedProject = false) {
  if (runState === 'idle') return true;
  // A failed OPEN leaves the project on disk: the review must keep matching it.
  return runState === 'failed' && !hasCreatedProject;
}

/**
 * What the Cancel control does:
 *  - 'discard'  — nothing created; a dirty wizard confirms first, a clean one closes.
 *  - 'close'    — a project exists on disk (held, or open failed): close the
 *                 wizard without opening it; never worded as "discard".
 *  - 'abort'    — a run is executing (cancel IPC lands in S7; until then the
 *                 control is disabled).
 *  - null       — the workspace is opening; nothing to cancel.
 */
export function cancelMode(runState, hasCreatedProject) {
  if (runState === 'running') return 'abort';
  if (runState === 'opening') return null;
  if (runState === 'held' || (runState === 'failed' && hasCreatedProject)) return 'close';
  return 'discard';
}

/** The first page whose prerequisites are not met, or null when every
 *  page before Create is complete (F19). */
export function firstInvalidPage(state) {
  for (let page = 0; page < WIZARD_STEP_COUNT - 1; page += 1) {
    if (!canAdvance(state, page)) return page;
  }
  return null;
}

/** Where a jump to `target` actually lands: never past an earlier page that
 *  is no longer valid (changing the runtime after reaching Create resets the
 *  framework; Create must not stay reachable). */
export function resolveJump(state, target) {
  const invalid = firstInvalidPage(state);
  return invalid === null ? target : Math.min(target, invalid);
}

/** Create is allowed only when nothing is running or created, every earlier
 *  page is complete, and the plan is selectable for this platform/manager. */
export function canSubmit(state, runState, planSelectable, hasCreatedProject = false) {
  if (!canNavigate(runState, hasCreatedProject)) return false;
  if (firstInvalidPage(state) !== null) return false;
  return Boolean(planSelectable);
}

/** The Create button's caption per state. */
export function submitLabel(runState, { isBlank = false, isPython = false } = {}) {
  if (runState === 'running') return isBlank || isPython ? 'Creating...' : 'Scaffolding...';
  if (runState === 'opening') return 'Opening...';
  if (runState === 'held') return 'Created';
  return 'Create Project';
}
