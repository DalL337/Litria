/**
 * gridPreferences.js — the structural grid's personal settings, resolved
 * from the stored global preferences against the registry (ADR-019).
 *
 * The registry declares every key, default and legal value once; this module
 * only turns the stored values into the typed object the grid consumers read,
 * and folds in the OS reduce-motion setting. Pure: no React, no I/O.
 */

import { createPreferencesDomain } from '../preferences/preferencesDomain.js';
import { PREF_KEYS } from '../preferences/registry.js';
import { gridPaintOverrideKey } from '../theme/gridPaint.js';

// The capture tolerance a smart guide pulls from, in screen pixels
// (owner-accepted playground value; the caption in the registry says 6).
export const GRID_GUIDE_CAPTURE_PX = 6;

/** Resolve stored global values to the grid's typed settings. */
export function resolveGridPreferences(stored, { systemReducedMotion = false } = {}) {
  const prefs = createPreferencesDomain({ values: stored ?? {} }).selectors;
  const get = (key) => prefs.getEffective(key);
  const reduceMotionSetting = get(PREF_KEYS.gridReduceMotion);
  return {
    snapMode: get(PREF_KEYS.gridSnapMode),
    smartGuides: get(PREF_KEYS.gridSmartGuides),
    settleMs: get(PREF_KEYS.gridSettleMs),
    settleEasing: get(PREF_KEYS.gridSettleEasing),
    reduceMotionSetting,
    reduceMotion: reduceMotionSetting === 'always'
      || (reduceMotionSetting === 'system' && Boolean(systemReducedMotion)),
    ink: get(PREF_KEYS.gridInk),
    showMajor: get(PREF_KEYS.gridShowMajor),
    showMinor: get(PREF_KEYS.gridShowMinor),
    showSub: get(PREF_KEYS.gridShowSub),
    showOrigin: get(PREF_KEYS.gridShowOrigin),
    paintOverrides: get(PREF_KEYS.gridPaintOverrides),
  };
}

/**
 * The next paint-override map with one theme/energy/ink entry set, or
 * removed when `levels` is null (Reset to theme).
 */
export function withPaintOverride(overrides, { themeId, energyLevel, ink }, levels) {
  const next = { ...(overrides ?? {}) };
  const key = gridPaintOverrideKey(themeId, energyLevel, ink);
  if (levels) {
    next[key] = { major: levels.major, minor: levels.minor, sub: levels.sub };
  } else {
    delete next[key];
  }
  return next;
}
