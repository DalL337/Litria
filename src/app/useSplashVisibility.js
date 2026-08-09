/**
 * useSplashVisibility — gates the launch splash on the ADR-019 `splashScreen`
 * preference (ADR-024).
 *
 * The overlay must never flash-then-vanish for users who disabled it, so the
 * splash mounts only after the global preferences resolve: `showSplash`
 * starts false and flips true only when the stored value (or the registry
 * default) says the splash is on. The launcher renders beneath the overlay
 * from the first frame either way, so the few-ms mount delay when enabled is
 * imperceptible. A pref-load failure falls back to the registry default — an
 * error must not change launch feel.
 */

import { useCallback, useEffect, useState } from 'react';
import { prefsLoadGlobal } from '../preferences/preferencesStore.js';
import { findEntry, PREF_KEYS } from '../preferences/registry.js';

/** Pure: resolve stored global prefs to the splash on/off decision. */
export function resolveSplashEnabled(prefs) {
  const stored = prefs?.[PREF_KEYS.splashScreen];
  if (typeof stored === 'boolean') return stored;
  return findEntry(PREF_KEYS.splashScreen).defaultValue;
}

export function useSplashVisibility() {
  const [showSplash, setShowSplash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const prefs = await prefsLoadGlobal().catch(() => null);
      if (!cancelled && resolveSplashEnabled(prefs)) setShowSplash(true);
    })();
    return () => { cancelled = true; };
  }, []);

  const dismissSplash = useCallback(() => setShowSplash(false), []);

  return { showSplash, dismissSplash };
}
