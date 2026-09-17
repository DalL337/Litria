// ---------------------------------------------------------------------------
// Scaffold plan (ADR-028 §2) — ONE derivation for preview, validation and
// execution. The wizard renders `plan.preview`, gates Create on
// `plan.availability`, and sends `plan.payload` to the runner; the runner
// re-derives the same primary argv from the same registry and refuses a
// payload that differs (scaffold.plan_mismatch). Pure: no React, no IPC.
// ---------------------------------------------------------------------------

import {
  RECIPES,
  wrapperKind,
  resolveRoute,
  assemblePrimaryArgv,
  availability,
  getBackendOptions,
  deriveScaffoldSteps,
  getLimits,
  describeStep,
  addonAvailability,
  backendAvailability,
} from './recipeRegistry.js';
import {
  isPythonWrapper,
  derivePythonNames,
  pythonPlanProblem,
  resolvePythonEngine,
  buildPythonPlanPreview,
} from './pythonWizardModel.js';

/** Substrate files the Blank template writes, in the Rust command's creation
 *  order (blank_project.rs SUBSTRATE_FILES). Shown in the review card and the
 *  plan preview. */
export const BLANK_FILES = Object.freeze(['README.md', '.gitignore', '.editorconfig']);

/** Platform ids the registry's coverage table understands. */
export function normalizePlatform(os) {
  if (os === 'windows' || os === 'macos' || os === 'linux') return os;
  return 'unknown';
}

function displayName(state) {
  return (state.name ?? '').trim() || 'my-app';
}

// ---- preview part builders -------------------------------------------------

function blankPreview(state) {
  return [
    { type: 'key', text: 'blank' },
    { type: 'val', text: ` ${displayName(state)}` },
    { type: 'comment', text: ` # ${BLANK_FILES.join(' + ')} — no scaffold, no npm` },
  ];
}

/**
 * The npm route's preview IS the argv: the manager, then every token the
 * runner passes, flags styled as keys and values as values. Nothing appears
 * here that does not run, and nothing runs that does not appear here (F14).
 */
function npmPreview({ managerId, argv, steps }) {
  const parts = [{ type: 'key', text: managerId }];
  for (const token of argv) {
    parts.push({ type: token.startsWith('-') ? 'key' : 'val', text: ` ${token}` });
  }
  // Every post-scaffold step, one line each (ADR-028 §4): what installs,
  // what is written, what is patched — nothing runs that is not listed.
  for (const step of steps) {
    parts.push({ type: 'comment', text: `\n# ${describeStep(step, managerId)}` });
  }
  return parts;
}

// ---- plan ------------------------------------------------------------------

/**
 * @param {object} state  wizard reducer state
 * @param {object} probe  python probe snapshot ({ interpreters, uvAvailable })
 * @param {{ platform?: string }} env  the running platform ('windows' | 'macos' | 'linux')
 */
export function buildScaffoldPlan(state, probe, env = {}) {
  const platform = normalizePlatform(env.platform);
  const wrapper = state.wrapper;

  if (wrapper === 'blank') {
    return {
      kind: 'blank',
      preview: blankPreview(state),
      availability: { selectable: true, status: 'verified', reason: null },
      files: [...BLANK_FILES],
      payload: {
        projectName: state.name.trim(),
        projectLocation: state.folder.trim(),
      },
    };
  }

  if (isPythonWrapper(wrapper)) {
    const { distName, moduleName } = derivePythonNames(state.name);
    const preview = buildPythonPlanPreview(state, probe);
    // Every refusal the runner would make is a reason here first (ADR-028 §9).
    const reason = pythonPlanProblem(state);
    return {
      kind: 'python',
      preview,
      availability: { selectable: reason === null, status: 'verified', reason },
      payload: {
        projectName: state.name.trim(),
        projectLocation: state.folder.trim(),
        archetype: state.framework,
        distName,
        moduleName,
        addons: state.addons,
        requiresFloor: state.pyRequiresFloor?.trim() || null,
        envMode: state.pyEnvMode,
        // Resolve 'auto' here so the preview and the executed command share
        // one resolution (the preview used the same probe snapshot).
        envEngine: resolvePythonEngine(state.pyEnvEngine, probe?.uvAvailable === true),
        interpreterPath: state.pyInterpreter,
        existingEnv: state.pyEnvMode === 'existing' ? (state.pyExistingEnv.trim() || null) : null,
      },
    };
  }

  if (wrapperKind(wrapper) !== 'npm' || !state.framework || !state.lang) {
    return { kind: 'npm', preview: null, availability: { selectable: false, status: 'unverified', reason: null }, route: null, argv: null, payload: null };
  }

  const managerId = state.manager || 'npm';
  const route = resolveRoute(wrapper, state.framework, state.lang);
  const avail = availability({ wrapper, framework: state.framework, language: state.lang, manager: managerId, platform });

  if (!route || route.unsupported) {
    return {
      kind: 'npm',
      preview: [{ type: 'comment', text: `# ${avail.reason}` }],
      availability: avail,
      route: null,
      argv: null,
      payload: null,
    };
  }

  const argv = assemblePrimaryArgv({ route, managerId, projectName: displayName(state) });
  const backend = getBackendOptions(wrapper).length > 0 ? (state.backend || 'none') : 'none';
  const stepArgs = { wrapper, framework: state.framework, language: state.lang, manager: managerId, addons: state.addons, backend, projectName: state.name.trim() };
  const steps = deriveScaffoldSteps(stepArgs);
  const preview = npmPreview({ managerId, argv, steps });
  // Add-ons and the backend need their own evidence for this combination
  // (ADR-028 §10); the first one without it names the reason.
  let combined = avail;
  if (combined.selectable) {
    const key = { wrapper, framework: state.framework, language: state.lang, manager: managerId, platform };
    for (const addon of state.addons) {
      const a = addonAvailability({ ...key, addon });
      if (!a.selectable) { combined = { selectable: false, status: 'unverified', reason: a.reason }; break; }
    }
    if (combined.selectable) {
      const b = backendAvailability({ ...key, backend });
      if (!b.selectable) combined = { selectable: false, status: 'unverified', reason: b.reason };
    }
  }
  if (!combined.selectable) {
    preview.push({ type: 'comment', text: `\n# not offered: ${combined.reason}` });
  }

  return {
    kind: 'npm',
    preview,
    availability: combined,
    route,
    argv,
    steps,
    payload: {
      projectName: state.name.trim(),
      projectLocation: state.folder.trim(),
      wrapper,
      framework: state.framework,
      language: state.lang,
      backend: backend === 'none' ? null : backend,
      addons: state.addons,
      manager: managerId,
      theme: state.theme,
      // ADR-028 §2: the derivation the runner must reproduce byte for byte.
      // The runner reads the same registry; a differing argv, package,
      // version or template is refused (scaffold.plan_mismatch).
      plan: {
        schemaVersion: RECIPES.schemaVersion,
        routeKind: route.kind,
        package: route.package,
        version: route.version,
        template: route.template,
        // The real project name, not the display fallback: the runner
        // derives with the validated name and compares.
        argv: assemblePrimaryArgv({ route, managerId, projectName: state.name.trim() }),
        platform,
        // Post-scaffold steps, verbatim (ADR-028 §4): the runner derives the
        // same list from the registry and refuses a payload that differs.
        steps,
        // Subprocess limits per step kind (ADR-028 §8): part of the plan
        // record, compared by the runner like every other field.
        limits: getLimits(),
      },
    },
  };
}
