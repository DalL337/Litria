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

/** Subprocess limits per step kind (ADR-028 §8) — the plan carries them and
 *  the runner refuses a payload whose limits differ from the registry. */
export function getLimits() {
  const { primary, command, env } = recipes.limits;
  return { primary: { ...primary }, command: { ...command }, env: { ...env } };
}

export function listManagers() {
  return Object.keys(recipes.managers);
}

export function getManager(managerId) {
  return recipes.managers[managerId] ?? null;
}

/** Environment the runner sets on every command of this manager (Yarn's
 *  linker choice must reach the create CLI's own install). */
export function managerEnv(managerId) {
  return { ...(recipes.managers[managerId]?.env ?? {}) };
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
 * assembles it. `npm create --yes vite@9.2.1 <name> -- --template react-ts`.
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
  if (!entry) return { wrapper, framework, language, manager, platform, status: 'unverified' };
  // Revalidation trigger (ADR-028 §10, dependency policy Rule 5): evidence
  // recorded against other pins does not carry over to the current ones.
  const stale = SELECTABLE_STATUSES.has(entry.status) ? pinsOutOfDate(entry.evidence) : null;
  return stale ? { ...entry, status: 'unverified', reason: stale } : entry;
}

/** The current registry pin for a tool or generated-project package. */
function currentPin(name) {
  return recipes.tools[name]?.version ?? recipes.packages[name]?.version ?? null;
}

/**
 * Why a coverage entry's evidence no longer applies, or null. Evidence must
 * carry the pins it was recorded against (`evidence.pins`); one that
 * predates pin tracking is stale by definition, and any pin that has moved
 * since names itself.
 */
export function pinsOutOfDate(evidence) {
  const pins = evidence?.pins;
  if (!pins || typeof pins !== 'object' || Object.keys(pins).length === 0) {
    return 'evidence predates pin tracking — re-run scripts/scaffold-recipe-evidence.mjs';
  }
  for (const [name, version] of Object.entries(pins)) {
    const current = currentPin(name);
    if (current && current !== version) {
      return `evidence recorded against ${name}@${version}; the registry now pins ${name}@${current} — re-run scripts/scaffold-recipe-evidence.mjs`;
    }
  }
  return null;
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
  let coverage = getCoverage({ wrapper, framework, language, manager, platform });
  if (SELECTABLE_STATUSES.has(coverage.status)) {
    return { selectable: true, status: coverage.status, reason: null, coverage };
  }
  // No primary entry, but a failing add-on run of the same combination
  // exists: its cause is the honest answer (Yarn + Angular read "not
  // verified" while the registry knew why — owner live pass 2026-09-17).
  if (coverage.status === 'unverified' && !coverage.reason) {
    const failed = (recipes.addonCoverage?.entries ?? []).find((e) =>
      e.wrapper === wrapper && e.framework === framework && e.language === language
      && e.manager === manager && e.platform === platform && e.status === 'failing' && e.reason);
    if (failed) coverage = { ...coverage, status: 'failing', reason: failed.reason };
  }
  const label = `${framework} (${language}) with ${manager} on ${platform}`;
  const reason = coverage.status === 'failing'
    ? `${label} failed verification${coverage.reason ? `: ${coverage.reason}` : ''}.`
    : coverage.reason
      ? `${label}: ${coverage.reason}.`
      : `${label} has not been verified yet (ADR-028 §10) — not offered until it has.`;
  return { selectable: false, status: coverage.status, reason, coverage };
}

/** Languages of `framework` that are selectable for this wrapper/manager/platform. */
export function selectableLanguages({ wrapper, framework, manager, platform }) {
  return getLanguages(framework).filter((language) =>
    availability({ wrapper, framework, language, manager, platform }).selectable);
}

// ---- add-on / backend / framework steps (ADR-028 §4) ----------------------

/** Order selected add-ons so every prerequisite precedes its dependent (F6),
 *  pulling in prerequisites that were not selected. Stable: registry order. */
export function orderAddons(selected) {
  const wanted = new Set();
  const visit = (id) => {
    if (!recipes.addons[id] || wanted.has(id)) return;
    for (const dep of getAddonDeps(id)) visit(dep);
    wanted.add(id);
  };
  for (const id of selected) visit(id);
  // Explicit registry order (`addonOrder`), never object-key order: the Rust
  // side has no ordered map and must produce the identical sequence.
  return recipes.addonOrder.filter((id) => wanted.has(id));
}

function selectorMatches(when, ctx) {
  for (const [key, allowed] of Object.entries(when ?? {})) {
    if (!Array.isArray(allowed) || !allowed.includes(ctx[key])) return false;
  }
  return true;
}

function fill(value, ctx) {
  if (typeof value === 'string') {
    return value
      .replaceAll('{entry}', ctx.entry ?? '{entry}')
      .replaceAll('{ext}', ctx.ext)
      .replaceAll('{jsx}', ctx.jsx)
      .replaceAll('{name}', ctx.name);
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, ctx));
  return value;
}

/**
 * One executable step, with placeholders filled and — for steps that run a
 * process — the exact argv after the manager executable, so the preview
 * shows what runs and the runner can compare (ADR-028 §2).
 */
function materialize(step, ctx, source) {
  const manager = recipes.managers[ctx.manager];
  const out = { source, op: step.op };
  switch (step.op) {
    case 'install': {
      out.dev = Boolean(step.dev);
      out.packages = [...step.packages];
      out.argv = [...manager.install, ...(step.dev ? [manager.devFlag] : []), ...step.packages];
      break;
    }
    case 'exec': {
      const spec = pinnedSpec(step.cli);
      out.cli = step.cli;
      out.spec = spec;
      out.args = fill(step.args, ctx);
      out.argv = spec ? [...manager.exec, spec, ...out.args] : null;
      break;
    }
    case 'write':
      out.path = fill(step.path, ctx); out.mode = step.mode ?? 'create'; out.content = fill(step.content, ctx);
      break;
    case 'prepend':
    case 'append':
      out.path = fill(step.path, ctx); out.text = fill(step.text, ctx);
      break;
    case 'replace':
      out.path = fill(step.path, ctx); out.find = fill(step.find, ctx); out.with = fill(step.with, ctx);
      break;
    case 'insertBefore':
      out.path = fill(step.path, ctx); out.marker = fill(step.marker, ctx); out.text = fill(step.text, ctx);
      break;
    case 'mergeJson':
      out.path = fill(step.path, ctx); out.value = step.value; out.optional = Boolean(step.optional); out.create = Boolean(step.create);
      break;
    case 'delete':
      out.path = fill(step.path, ctx);
      break;
    default:
      throw new Error(`recipes.json: unknown step op "${step.op}"`);
  }
  return out;
}

/**
 * Every post-scaffold step for a selection, in execution order: Electron
 * framework wiring → add-ons (prerequisites first) → backend. Pure data;
 * src-tauri/src/scaffold_recipes.rs derives the same list and the runner
 * refuses a payload whose steps differ.
 */
export function deriveScaffoldSteps({ wrapper, framework, language, manager, addons = [], backend = null, projectName = 'my-app' }) {
  if (wrapperKind(wrapper) !== 'npm' || !recipes.managers[manager]) return [];
  const entry = recipes.wrappers[wrapper]?.entries?.[framework]?.[language] ?? null;
  const ctx = { wrapper, framework, language, manager, entry, ext: language, jsx: language === 'ts' ? 'tsx' : 'jsx', name: projectName };
  const out = [];
  const apply = (entries, source) => {
    for (const recipe of entries ?? []) {
      if (!selectorMatches(recipe.when, ctx)) continue;
      for (const step of recipe.steps) out.push(materialize(step, ctx, source));
    }
  };
  // Manager-specific post-create steps come first (Yarn Berry's project marker).
  if (recipes.managers[manager]?.postCreate?.length) {
    apply([{ when: {}, steps: recipes.managers[manager].postCreate }], `manager:${manager}`);
  }
  apply(recipes.wrappers[wrapper]?.frameworkRecipes?.[framework], `framework:${framework}`);
  for (const addon of orderAddons(addons)) apply(recipes.addons[addon]?.recipes, `addon:${addon}`);
  if (backend && backend !== 'none' && getBackendOptions(wrapper).includes(backend)) {
    apply(recipes.backends.recipes?.[backend], `backend:${backend}`);
  }
  return out;
}

/** Human line for one step, for the wizard's plan preview. */
export function describeStep(step, managerId) {
  const who = step.source;
  switch (step.op) {
    case 'install': return `${who}: ${managerId} ${step.argv.join(' ')}`;
    case 'exec': return `${who}: ${managerId} ${(step.argv ?? [step.cli, ...step.args]).join(' ')}`;
    case 'write': return `${who}: write ${step.path}${step.mode === 'replace' ? ' (replace)' : ''}`;
    case 'prepend': return `${who}: prepend to ${step.path}`;
    case 'append': return `${who}: append to ${step.path}`;
    case 'replace': return `${who}: patch ${step.path}`;
    case 'insertBefore': return `${who}: patch ${step.path}`;
    case 'mergeJson': return `${who}: merge into ${step.path}`;
    case 'delete': return `${who}: remove ${step.path}`;
    default: return `${who}: ${step.op}`;
  }
}

// ---- add-on / backend coverage (ADR-028 §10) --------------------------------

function addonEntriesFor({ wrapper, framework, language, manager, platform }) {
  return (recipes.addonCoverage?.entries ?? []).filter((e) =>
    e.wrapper === wrapper && e.framework === framework && e.language === language
    && e.manager === manager && e.platform === platform && SELECTABLE_STATUSES.has(e.status)
    // A bumped pin invalidates add-on evidence too (ADR-028 §10).
    && pinsOutOfDate(e.evidence) === null);
}

/** May `addon` be offered for this primary combination? Evidence = a verified
 *  run of the same combination whose recipe steps included the add-on. */
export function addonAvailability({ wrapper, framework, language, manager, platform, addon }) {
  if (wrapperKind(wrapper) !== 'npm') return { selectable: true, reason: null };
  const ok = addonEntriesFor({ wrapper, framework, language, manager, platform })
    .some((e) => (e.addons ?? []).includes(addon));
  return ok
    ? { selectable: true, reason: null }
    : { selectable: false, reason: `${addon} on ${framework} (${language}) with ${manager} on ${platform} has no execution evidence yet (ADR-028 §10) — not offered until it has.` };
}

export function backendAvailability({ wrapper, framework, language, manager, platform, backend }) {
  if (!backend || backend === 'none') return { selectable: true, reason: null };
  const ok = addonEntriesFor({ wrapper, framework, language, manager, platform })
    .some((e) => e.backend === backend);
  return ok
    ? { selectable: true, reason: null }
    : { selectable: false, reason: `${backend} with ${framework} (${language}) with ${manager} on ${platform} has no execution evidence yet (ADR-028 §10) — not offered until it has.` };
}
