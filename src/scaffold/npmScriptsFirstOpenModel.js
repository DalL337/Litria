// ---------------------------------------------------------------------------
// npm scripts first-open model (ADR-021 §3) — pure decision logic for the
// scripts-off consent pill. Scaffolded npm projects install with dependency
// lifecycle scripts disabled; projects that need them (Electron's binary
// download is the canonical case) get a one-click, terminal-visible
// re-enable. No React, no IPC — mirrors pythonFirstOpenModel.
//
// The offer command is SHELL INPUT typed into the project's visible terminal
// session — never a spawned executable (ADR-005 class-3 boundary; same as
// the Python deps pill). `npm rebuild` runs the lifecycle scripts of the
// already-installed tree, which is exactly the deferred half of the
// scripts-off install.
// ---------------------------------------------------------------------------

/** editor_state marker set at project creation when installs skipped scripts. */
export const NPM_SCRIPTS_PENDING_KEY = 'npm.scriptsPending';

/** editor_state keys gating the offer (persisted when actioned). */
export const NPM_SCRIPTS_FLAGS = {
  'enable-scripts': 'hint.npm.scriptsOffered',
};

/**
 * Which offer (if any) this open deserves. Same dismissal contract as the
 * Python pills: actioned persists forever, a dismissed-but-unactioned pill
 * returns on the next open.
 */
export function decideNpmScriptsFirstOpen({ scriptsPending, flags = {} }) {
  if (!scriptsPending) return null;
  if (flags['enable-scripts']) return null;
  return 'enable-scripts';
}

/** The exact shell input for the offer — the pill must name what it runs. */
export function buildNpmScriptsOffer() {
  return { command: 'npm rebuild', display: 'npm rebuild' };
}

/** Pill copy — honest about why scripts are off and what the click does. */
export function buildNpmScriptsOfferMessage(display) {
  return `Dependency scripts were skipped for supply-chain safety — runs ${display} in the terminal if this project needs them`;
}
