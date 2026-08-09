// ---------------------------------------------------------------------------
// Create-CLI pin registry — single source of truth for every third-party CLI
// the scaffold runner executes (ADR-021 §1: pin what we execute).
//
// Keys are the short names as invoked (`npm create <key>` resolves package
// `create-<key>`; addon CLIs run via `<pm> dlx <key> init`). Values are exact
// versions — never ranges, tags, or `latest`. scaffold_runner.rs enforces the
// exact-spec form as the floor and refuses anything else.
//
// Bumping a pin is a reviewed change: verify the new version is at least 24
// hours old on the registry (`npm view <pkg> time --json`) before landing —
// the age gate (ADR-021 §2, slice 2) enforces this at scaffold time too.
// Pins recorded 2026-07-13 with publish dates verified against the registry.
// ---------------------------------------------------------------------------

export const CREATE_CLI_VERSIONS = {
  'tauri-app': '4.6.2', // create-tauri-app, published 2025-08-05
  'vite': '9.1.1', // create-vite, published 2026-06-30
  'electron-app': '7.11.2', // create-electron-app, published 2026-05-20
};

export const ADDON_CLI_VERSIONS = {
  'shadcn': '4.13.0', // published 2026-07-03
  'shadcn-svelte': '1.4.1', // published 2026-07-09
  'shadcn-vue': '2.7.4', // published 2026-06-03
};

const WRAPPER_TO_CREATE_CLI = {
  tauri: 'tauri-app',
  web: 'vite',
  electron: 'electron-app',
};

// Exact spec (`name@X.Y.Z`) for the wrapper's create CLI. Throws on unknown
// wrappers so a new runtime card cannot silently scaffold unpinned.
export function pinnedCreateSpec(wrapper) {
  const name = WRAPPER_TO_CREATE_CLI[wrapper];
  const version = name && CREATE_CLI_VERSIONS[name];
  if (!version) {
    throw new Error(`No pinned create CLI for wrapper "${wrapper}" — add it to create-cli-versions.js`);
  }
  return `${name}@${version}`;
}

// Full addon map as exact specs, sent with every scaffold config; the runner
// looks up only the entries the selected addons require.
export function pinnedAddonSpecs() {
  return Object.fromEntries(
    Object.entries(ADDON_CLI_VERSIONS).map(([name, version]) => [name, `${name}@${version}`])
  );
}

// The wizard's posture note (ADR-021 §5). Honest by contract: names what the
// gate does and its one gap. Forbidden claims (each false, each seen in the
// wild as false comfort): "npm enforces release cooldowns", "provenance
// means safe", "pinned means safe". A test guards these.
export const SCAFFOLD_POSTURE_NOTE =
  'Supply-chain posture: pinned scaffold tools, 24h release-age gate on them, '
  + 'dependency scripts off by default, npm audit at create. Release age of '
  + 'transitive npm dependencies is not gated.';

// Display form for the wizard's command preview: the long package name with
// the pinned version (`create-vite@9.1.1`), keeping "what you see is what
// runs" literal now that versions are part of what runs.
export function previewCreateLabel(wrapper) {
  const name = WRAPPER_TO_CREATE_CLI[wrapper];
  const version = name && CREATE_CLI_VERSIONS[name];
  if (!version) return null;
  return `create-${name}@${version}`;
}
