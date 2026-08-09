import { useCallback, useState } from 'react';

/**
 * usePreferencesSurface — open-state for the in-app Preferences panel
 * (ADR-019 Slice 2). The panel itself is a dumb renderer of registry
 * queries; this hook only owns whether it is showing.
 */
export function usePreferencesSurface() {
  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false);
  const openPreferences = useCallback(() => setIsPreferencesOpen(true), []);
  const closePreferences = useCallback(() => setIsPreferencesOpen(false), []);
  return { isPreferencesOpen, openPreferences, closePreferences };
}
