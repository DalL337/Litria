// ---------------------------------------------------------------------------
// Create-CLI pins — a PROJECTION of src/scaffold/recipes.json (ADR-028 §1).
//
// Until ADR-028 this file owned the pins and the wizard sent them to the
// runner as `createCliSpec`/`addonCliSpecs`, so the webview chose which
// version executed (F34). The runner now reads the same registry and
// refuses a plan whose derivation differs; these exports exist for display
// and for the pin tests, not for execution.
//
// Bumping a pin is a reviewed change to recipes.json: verify the new version
// is at least 24 hours old (`npm view <pkg> time --json`, ADR-021 §2), refresh
// the template manifest, and re-run the recipe evidence script.
// ---------------------------------------------------------------------------

import { RECIPES } from './recipeRegistry.js';

/** Short invocation name → exact version, e.g. `vite` → `9.2.1`. */
export const CREATE_CLI_VERSIONS = Object.freeze(Object.fromEntries(
  Object.entries(RECIPES.tools)
    .filter(([, t]) => t.kind === 'initializer')
    .map(([, t]) => [t.invoke, t.version])
));

/** Addon CLI package → exact version. */
export const ADDON_CLI_VERSIONS = Object.freeze(Object.fromEntries(
  Object.entries(RECIPES.tools)
    .filter(([, t]) => t.kind === 'addon-cli')
    .map(([name, t]) => [name, t.version])
));

// The wizard's posture note (ADR-021 §5), per package manager (ADR-028 §5,
// F29). Honest by contract: it names what the gate does FOR THE SELECTED
// MANAGER and its gaps. Forbidden claims (each false, each seen in the wild
// as false comfort): "npm enforces release cooldowns", "provenance means
// safe", "pinned means safe". A test guards these, one case per manager.
export function scaffoldPostureNote(managerId = 'npm') {
  const manager = RECIPES.managers[managerId] ?? RECIPES.managers.npm;
  const scripts = {
    'env+flag': 'dependency scripts off by default',
    native: `dependency scripts off by ${manager.label}'s own default`,
    none: `dependency scripts run as ${manager.label}'s default (not disabled)`,
  }[manager.scriptsOff] ?? 'dependency scripts not controlled';
  const audit = manager.auditAtCreate ? 'npm audit at create' : 'no audit at create';
  const cooldown = managerId === 'pnpm'
    ? ', minimumReleaseAge cooldown written into the project'
    : managerId === 'yarn'
      ? ', npmMinimalAgeGate cooldown written into the project'
      : '';
  return `Supply-chain posture (${manager.label}): pinned scaffold tools, 24h release-age gate on them, `
    + `${scripts}, ${audit}${cooldown}. Release age of transitive npm dependencies is not gated.`;
}

/** The npm note — the default manager's posture, kept for callers that
 *  do not know the manager yet. */
export const SCAFFOLD_POSTURE_NOTE = scaffoldPostureNote('npm');
