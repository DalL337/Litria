// ---------------------------------------------------------------------------
// Recipe registry (ADR-028 §1) — the frontend's read side of recipes.json.
//
// Pure: no React, no IPC. Every question the wizard asks about what can be
// built ("which frameworks for this wrapper?", "what is the pinned version
// of create-vite?", "is web + react + ts + npm verified on Windows?") is
// answered here from the one registry the Rust runner also reads
// (src-tauri/src/scaffold_recipes.rs). Nothing in this module carries data
// of its own — it is a projection, and so are compatibility-matrix.js and
// create-cli-versions.js on top of it.
// ---------------------------------------------------------------------------

import recipes from './recipes.json' with { type: 'json' };

export const RECIPES = recipes;

export const COVERAGE_STATUSES = Object.freeze(['verified', 'covered-by-equivalence', 'unverified', 'failing']);

/** Statuses under which a combination may be offered (brief §6). */
export const SELECTABLE_STATUSES = Object.freeze(new Set(['verified', 'covered-by-equivalence']));

export const PLATFORMS = Object.freeze(['windows', 'macos', 'linux']);

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

export function isExactVersion(version) {
  return typeof version === 'string' && EXACT_VERSION.test(version);
}

// ---- wrappers / frameworks / languages / addons -------------------------

export function listWrappers() {
  return Object.keys(recipes.wrappers);
}

export function getWrapper(wrapperId) {
  return recipes.wrappers[wrapperId] ?? null;
}

/** Wrapper kinds: 'npm' (create-CLI route), 'blueprint' (Python, offline), 'blank'. */
export function wrapperKind(wrapperId) {
  return recipes.wrappers[wrapperId]?.kind ?? null;
}

export function getFrameworks(wrapperId) {
  return recipes.wrappers[wrapperId]?.frameworks ?? [];
}

export function getLanguages(frameworkId) {
  return recipes.frameworks[frameworkId]?.languages ?? [];
}

export function getAddons(frameworkId) {
  return recipes.frameworks[frameworkId]?.addons ?? [];
}

export function getAddonDeps(addonId) {
  return recipes.addons[addonId]?.requires ?? [];
}

export function isLanguageLocked(frameworkId) {
  const langs = getLanguages(frameworkId);
  return langs.length === 1 ? langs[0] : null;
}

export function listManagers() {
  return Object.keys(recipes.managers);
}

export function getManager(managerId) {
  return recipes.managers[managerId] ?? null;
}

export function getBackendOptions(wrapperId) {
  return recipes.backends.wrappers.includes(wrapperId) ? recipes.backends.options : [];
}

// ---- tools / pins ----------------------------------------------------------

export function getTool(toolName) {
  return recipes.tools[toolName] ?? null;
}

/** `name@X.Y.Z` for any registry tool, or null when the tool is unknown. */
export function pinnedSpec(toolName) {
  const tool = recipes.tools[toolName];
  if (!tool) return null;
  return `${toolName}@${tool.version}`;
}

/** Addon CLI package name for (addon, framework), e.g. shadcn → 'shadcn-vue' on vue. */
export function addonCli(addonId, frameworkId) {
  return recipes.addons[addonId]?.cli?.[frameworkId] ?? null;
}

// ---- routes ----------------------------------------------------------------

/**
 * The primary route for an npm-kind wrapper + framework + language, or an
 * object with `unsupported` set when the registry has no template for the
 * combination (web + angular until S2 — F1).
 */
export function resolveRoute(wrapperId, frameworkId, languageId) {
  const wrapper = recipes.wrappers[wrapperId];
  if (!wrapper || wrapper.kind !== 'npm') return null;
  if (!getLanguages(frameworkId).includes(languageId)) {
    return { unsupported: `${frameworkId} has no ${languageId} variant.` };
  }
  // A per-framework route override (ADR-028 §3: web + angular runs the
  // Angular CLI through an `exec` route) wins over the wrapper's route.
  const override = wrapper.routes?.[frameworkId] ?? null;
  const route = override ?? wrapper.route;
  const template = override
    ? (override.template ?? frameworkId)
    : (wrapper.templates?.[frameworkId]?.[languageId] ?? null);
  if (!template) {
    const reason = wrapper.unsupported?.[frameworkId]
      ?? `${frameworkId} (${languageId}) has no template on the ${wrapperId} wrapper.`;
    return { unsupported: reason };
  }
  const tool = recipes.tools[route.tool];
  return {
    kind: route.kind,
    tool: route.tool,
    invoke: tool.invoke ?? route.tool,
    package: route.tool,
    version: tool.version,
    template,
    args: route.args,
  };
}

/**
 * The exact argument vector the runner executes after the manager
 * executable, assembled the same way src-tauri/src/scaffold_recipes.rs
 * assembles it. `npm create --yes vite@9.1.1 <name> -- --template react-ts`.
 */
export function assemblePrimaryArgv({ route, managerId, projectName }) {
  const manager = recipes.managers[managerId];
  if (!manager || !route || route.unsupported) return null;
  const substitute = (arg) => arg
    .replaceAll('{template}', route.template)
    .replaceAll('{manager}', managerId)
    .replaceAll('{name}', projectName);
  const spec = `${route.invoke}@${route.version}`;
  if (route.kind === 'initializer') {
    const argv = [...manager.create, spec, projectName];
    if (manager.forwardSeparator) argv.push(manager.forwardSeparator);
    argv.push(...route.args.map(substitute));
    return argv;
  }
  if (route.kind === 'exec') {
    return [...manager.exec, spec, ...route.args.map(substitute)];
  }
  return null;
}

// ---- coverage --------------------------------------------------------------

/**
 * Coverage record for one full combination on one platform. Missing entry
 * ⇒ `{ status: 'unverified' }` (brief §6: naming a gap is not permission).
 */
export function getCoverage({ wrapper, framework, language, manager, platform }) {
  const entry = recipes.coverage.entries.find((e) =>
    e.wrapper === wrapper && e.framework === framework && e.language === language
    && e.manager === manager && e.platform === platform);
  return entry ?? { wrapper, framework, language, manager, platform, status: 'unverified' };
}

/**
 * Whether a combination may be offered on this platform with this manager,
 * with a human reason when it may not. Offline wrappers (python, blank) are
 * always selectable — their evidence is the Rust suite, not a manager run.
 */
export function availability({ wrapper, framework, language, manager, platform }) {
  const kind = wrapperKind(wrapper);
  if (kind !== 'npm') return { selectable: true, status: 'verified', reason: null };
  const route = resolveRoute(wrapper, framework, language);
  if (!route) return { selectable: false, status: 'unverified', reason: 'No recipe for this selection.' };
  if (route.unsupported) return { selectable: false, status: 'unverified', reason: route.unsupported };
  const coverage = getCoverage({ wrapper, framework, language, manager, platform });
  if (SELECTABLE_STATUSES.has(coverage.status)) {
    return { selectable: true, status: coverage.status, reason: null, coverage };
  }
  const label = `${framework} (${language}) with ${manager} on ${platform}`;
  const reason = coverage.status === 'failing'
    ? `${label} failed verification${coverage.reason ? `: ${coverage.reason}` : ''}.`
    : `${label} has not been verified yet (ADR-028 §10) — not offered until it has.`;
  return { selectable: false, status: coverage.status, reason, coverage };
}

/** Languages of `framework` that are selectable for this wrapper/manager/platform. */
export function selectableLanguages({ wrapper, framework, manager, platform }) {
  return getLanguages(framework).filter((language) =>
    availability({ wrapper, framework, language, manager, platform }).selectable);
}
