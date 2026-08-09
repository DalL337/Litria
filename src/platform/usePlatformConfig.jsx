import { createContext, useContext, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import PLATFORM_DEFAULTS from './platformDefaults';

const FALLBACK = PLATFORM_DEFAULTS.windows;

// Synchronous best-guess from the webview UA so the FIRST paint already uses the
// right platform's labels/paths instead of flashing Windows defaults on Mac/Linux.
// The async get_platform_config (std::env::consts::OS) is still authoritative and
// confirms/corrects this — but in the common case it matches, so there's no flash.
function guessInitialConfig() {
  try {
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/Mac/i.test(ua)) return PLATFORM_DEFAULTS.macos;
    if (/(Linux|X11)/i.test(ua)) return PLATFORM_DEFAULTS.linux;
    if (/Win/i.test(ua)) return PLATFORM_DEFAULTS.windows;
  } catch {
    // ignore — fall through to Windows fallback
  }
  return FALLBACK;
}

export const PlatformContext = createContext(FALLBACK);

export function PlatformProvider({ children }) {
  const [config, setConfig] = useState(guessInitialConfig);

  useEffect(() => {
    invoke('get_platform_config')
      .then((result) => {
        const defaults = PLATFORM_DEFAULTS[result.os] || FALLBACK;
        setConfig(defaults);
      })
      .catch(() => {
        // Graceful fallback — keep the synchronous guess
      });
  }, []);

  return (
    <PlatformContext.Provider value={config}>
      {children}
    </PlatformContext.Provider>
  );
}

export function usePlatformConfig() {
  return useContext(PlatformContext);
}
