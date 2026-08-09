import { useEffect, useRef, useState } from 'react';

import { setCrashAppInfo } from './errorCapture.js';

/**
 * useCrashBoot — the B5 startup sequence, extracted from App.jsx in the
 * Tier 2 debt cleanup so the crash system is fully self-contained in
 * src/crash/. Runs once per app launch:
 *
 * 1. Advance the Rust-side marker's phase checkpoint (webview reached React).
 * 2. Capture app version + OS for crash-record context.
 * 3. Scan for records left by a previous run that died dirty; any found
 *    surface as launch-screen notices.
 *
 * All of it is best-effort by contract — a dev shell without Tauri still
 * gets working capture, just no marker/scan plumbing.
 */
export function useCrashBoot() {
  const [crashNotices, setCrashNotices] = useState([]);
  const bootRanRef = useRef(false);

  useEffect(() => {
    if (bootRanRef.current) return; // StrictMode double-run guard
    bootRanRef.current = true;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        // The webview reached React — advance the marker's phase checkpoint.
        invoke('crash_mark_phase', { phase: 'webview-ready' }).catch(() => {});
        try {
          const { getVersion } = await import('@tauri-apps/api/app');
          setCrashAppInfo({
            version: await getVersion(),
            os: navigator.userAgentData?.platform || navigator.platform || 'unknown'
          });
        } catch { /* dev shell without Tauri — capture still works */ }
        const notices = await invoke('crash_startup_scan');
        if (Array.isArray(notices) && notices.length) setCrashNotices(notices);
      } catch { /* crash plumbing is best-effort by contract */ }
    })();
  }, []);

  const dismissCrashNotices = () => setCrashNotices([]);

  return { crashNotices, dismissCrashNotices };
}
