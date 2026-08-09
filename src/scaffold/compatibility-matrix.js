// ---------------------------------------------------------------------------
// Compatibility Matrix — single source of truth for the New Project Wizard.
//
// The wizard reads this to populate each selection step dynamically. Invalid
// combinations are never rendered — no greyed-out cards, no disabled states.
//
// To add support for a new combination:
//   1. Add the entry here
//   2. Add scaffold handling in src-tauri/src/scaffold_runner.rs
//   3. Test the full scaffold flow
//
// To document an excluded combination (e.g. Angular + Electron):
//   - Add a note in docs/capabilities.md with community alternatives
// ---------------------------------------------------------------------------

const COMPAT = {
  // Runtime -> which frameworks have first-party or production-quality support.
  //
  // Angular + Electron: excluded. No official electron-forge or electron-vite
  // support exists — community maintains maximegris/angular-electron.
  // See docs/capabilities.md for details and community links.
  runtimes: {
    tauri:    { frameworks: ['react', 'svelte', 'vue', 'angular', 'solid'] },
    electron: { frameworks: ['react', 'svelte', 'vue', 'solid'] },
    web:      { frameworks: ['react', 'svelte', 'vue', 'angular', 'solid'] },
    // Python (ADR-020): the "framework" tier is the project *archetype* —
    // the wizard relabels the section "Project Type" for this runtime.
    // Scaffold handling lives in python_scaffold.rs (offline blueprints),
    // not scaffold_runner.rs (npm CLI translation).
    python:   { frameworks: ['py-script', 'py-cli', 'py-lib', 'py-fastapi'] },
  },

  // Framework -> supported languages and available addons.
  //
  // Only addons with working scaffold support in scaffold_runner.rs are listed.
  // Angular is TypeScript-only (no JS option). Svelte and Angular omit router
  // (built-in routing). Solid and Angular omit shadcn (no mature CLI tooling).
  frameworks: {
    react:   { languages: ['ts', 'js'], addons: ['tailwind', 'shadcn', 'router'] },
    svelte:  { languages: ['ts', 'js'], addons: ['tailwind', 'shadcn'] },
    vue:     { languages: ['ts', 'js'], addons: ['tailwind', 'shadcn', 'router'] },
    angular: { languages: ['ts'],       addons: ['tailwind'] },
    solid:   { languages: ['ts', 'js'], addons: ['tailwind', 'router'] },
    // Python archetypes (ADR-020). Single-language → the existing
    // isLanguageLocked mechanism auto-locks the Language card to Python.
    // pytest/ruff are declaration-only add-ons (files + pyproject entries;
    // nothing installs at creation). py-lib omits the pytest add-on because
    // the Library archetype is pytest-ready by definition.
    'py-script':  { languages: ['py'], addons: ['pytest', 'ruff'] },
    'py-cli':     { languages: ['py'], addons: ['pytest', 'ruff'] },
    'py-lib':     { languages: ['py'], addons: ['ruff'] },
    'py-fastapi': { languages: ['py'], addons: ['pytest', 'ruff'] },
  },

  // Addon dependency rules. Selecting an addon auto-enables its dependencies
  // and prevents removing them while the dependent addon is active.
  addonDeps: {
    shadcn: ['tailwind'],
  },

  // Backend options for web-only projects. Desktop runtimes (Tauri, Electron)
  // have their own backend layer and skip this section entirely.
  // Axum excluded: Rust backend doesn't fit the JS/TS scaffold pipeline.
  backends: ['none', 'express', 'fastify'],
};

// ---------------------------------------------------------------------------
// Query helpers — used by the wizard to filter options at each cascade step
// ---------------------------------------------------------------------------

/** Frameworks available for a given runtime. */
export function getFrameworks(runtimeId) {
  return COMPAT.runtimes[runtimeId]?.frameworks ?? [];
}

/** Languages available for a given framework. */
export function getLanguages(frameworkId) {
  return COMPAT.frameworks[frameworkId]?.languages ?? [];
}

/** Addons available for a given framework. */
export function getAddons(frameworkId) {
  return COMPAT.frameworks[frameworkId]?.addons ?? [];
}

/** Addon IDs that must be enabled when `addonId` is selected. */
export function getAddonDeps(addonId) {
  return COMPAT.addonDeps[addonId] ?? [];
}

/**
 * If a framework only supports one language, returns that language ID.
 * Returns null if the user has a choice.
 */
export function isLanguageLocked(frameworkId) {
  const langs = COMPAT.frameworks[frameworkId]?.languages ?? [];
  return langs.length === 1 ? langs[0] : null;
}

export { COMPAT };
