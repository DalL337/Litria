import { findEntry, PREF_KEYS } from '../preferences/registry.js';

/**
 * Pure: resolve stored global prefs to the drawer-close behavior.
 * Values and the default come from the registry entry — no local copy to
 * drift. Anything unrecognized (missing prefs, load failure upstream,
 * stale value) resolves to the registry default ('end'): the fail-safe is
 * never a leaked session.
 *
 * @param {object|null} prefs  result of prefsLoadGlobal()
 * @returns {'end'|'hide'}
 */
export function resolveTerminalCloseBehavior(prefs) {
  const entry = findEntry(PREF_KEYS.terminalDrawerClose);
  const stored = prefs?.[PREF_KEYS.terminalDrawerClose];
  return entry.values.includes(stored) ? stored : entry.defaultValue;
}
