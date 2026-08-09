// ---------------------------------------------------------------------------
// Compatibility Matrix — single source of truth for the New Project Wizard.
//
// Copied verbatim from src/scaffold/compatibility-matrix.js so the prototype
// can be edited in isolation without touching the app.
//
// To add support for a new combination:
//   1. Add the entry here
//   2. Add scaffold handling in src-tauri/src/scaffold_runner.rs (in the app)
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
  runtimes: {
    tauri:    { frameworks: ['react', 'svelte', 'vue', 'angular', 'solid'] },
    electron: { frameworks: ['react', 'svelte', 'vue', 'solid'] },
    web:      { frameworks: ['react', 'svelte', 'vue', 'angular', 'solid'] },
  },

  // Framework -> supported languages and available addons.
  //
  // Angular is TypeScript-only (no JS option). Svelte and Angular omit router
  // (built-in routing). Solid and Angular omit shadcn (no mature CLI tooling).
  frameworks: {
    react:   { languages: ['ts', 'js'], addons: ['tailwind', 'shadcn', 'router'] },
    svelte:  { languages: ['ts', 'js'], addons: ['tailwind', 'shadcn'] },
    vue:     { languages: ['ts', 'js'], addons: ['tailwind', 'shadcn', 'router'] },
    angular: { languages: ['ts'],       addons: ['tailwind'] },
    solid:   { languages: ['ts', 'js'], addons: ['tailwind', 'router'] },
  },

  // Addon dependency rules. Selecting an addon auto-enables its dependencies
  // and prevents removing them while the dependent addon is active.
  addonDeps: {
    shadcn: ['tailwind'],
  },

  // Backend options for web-only projects. Desktop runtimes (Tauri, Electron)
  // have their own backend layer and skip this section entirely.
  backends: ['none', 'express', 'fastify'],
};

// ---------------------------------------------------------------------------
// Query helpers — used by the wizard to filter options at each cascade step
// ---------------------------------------------------------------------------

function getFrameworks(runtimeId) {
  return COMPAT.runtimes[runtimeId]?.frameworks ?? [];
}

function getLanguages(frameworkId) {
  return COMPAT.frameworks[frameworkId]?.languages ?? [];
}

function getAddons(frameworkId) {
  return COMPAT.frameworks[frameworkId]?.addons ?? [];
}

function getAddonDeps(addonId) {
  return COMPAT.addonDeps[addonId] ?? [];
}

function isLanguageLocked(frameworkId) {
  const langs = COMPAT.frameworks[frameworkId]?.languages ?? [];
  return langs.length === 1 ? langs[0] : null;
}

function getBackends() {
  return COMPAT.backends;
}

window.CompatibilityMatrix = {
  COMPAT,
  getFrameworks,
  getLanguages,
  getAddons,
  getAddonDeps,
  isLanguageLocked,
  getBackends,
};
