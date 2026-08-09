import { useCallback, useEffect, useRef, useState } from 'react';

import { performCleanShutdown } from '../crash/shutdown';

export function useWindowCloseGuard({ hasDirtyTabs }) {
  const [isExitPromptOpen, setIsExitPromptOpen] = useState(false);
  const tauriWindowRef = useRef(null);
  const allowCloseRef = useRef(false);
  const isShuttingDownRef = useRef(false);
  const hasDirtyTabsRef = useRef(false);
  // True while the clean-close ritual is in flight: repeat close requests
  // (double-clicked X) are swallowed instead of racing past the ritual.
  const ritualPendingRef = useRef(false);
  // Mirrors isExitPromptOpen so the close listener can subscribe ONCE —
  // re-subscribing on state change opens a gap where a close request has
  // no listener at all (and leaks duplicate listeners under StrictMode).
  const isExitPromptOpenRef = useRef(false);

  useEffect(() => {
    hasDirtyTabsRef.current = hasDirtyTabs;
  }, [hasDirtyTabs]);

  useEffect(() => {
    isExitPromptOpenRef.current = isExitPromptOpen;
  }, [isExitPromptOpen]);

  useEffect(() => {
    const handleBeforeUnload = (event) => {
      if (isShuttingDownRef.current || allowCloseRef.current) return;
      if (!hasDirtyTabsRef.current) return;
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten = null;

    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const tauriWindow = getCurrentWindow();
        tauriWindowRef.current = tauriWindow;
        const un = await tauriWindow.onCloseRequested((event) => {
          if (allowCloseRef.current || isShuttingDownRef.current) return;
          if (ritualPendingRef.current) {
            // Ritual already in flight (double-clicked X) — swallow the
            // repeat; the ritual's own close() finishes the job.
            event.preventDefault();
            return;
          }
          if (hasDirtyTabsRef.current) {
            event.preventDefault();
            if (isExitPromptOpenRef.current) return;
            setIsExitPromptOpen(true);
            return;
          }
          // Clean close (no dirty tabs): block THIS close, run the
          // clean-shutdown ritual (crash marker), then close for real.
          // allowCloseRef flips only AFTER the ritual so a second OS close
          // can't slip past it mid-ritual.
          event.preventDefault();
          ritualPendingRef.current = true;
          performCleanShutdown().finally(() => {
            allowCloseRef.current = true;
            tauriWindow.close().catch(async () => {
              try {
                if (typeof tauriWindow.destroy === 'function') {
                  await tauriWindow.destroy();
                }
              } catch {
                // The window survived a failed close — re-arm every guard so
                // the session keeps its dirty-tab protection.
                allowCloseRef.current = false;
                ritualPendingRef.current = false;
              }
            });
          });
        });
        // StrictMode/unmount race: if cleanup ran while registration was
        // pending, release the listener immediately instead of leaking it.
        if (cancelled) {
          un();
        } else {
          unlisten = un;
        }
      } catch (error) {
        console.warn('Window close listener not available:', error);
      }
    })();

    return () => {
      cancelled = true;
      if (typeof unlisten === 'function') {
        unlisten();
      }
    };
  }, []);

  // File → Exit: request a window close so the flow enters onCloseRequested
  // above — the menu item and the title-bar X are the same code path by
  // construction (dirty-tab prompt, clean-shutdown ritual, close). Never
  // bypasses the guard: allowCloseRef stays false until the guard flips it.
  const requestAppClose = useCallback(async () => {
    const tauriWindow = tauriWindowRef.current;
    if (tauriWindow) {
      try {
        await tauriWindow.close();
        return;
      } catch {
        // Fall through to the browser/dev fallback.
      }
    }
    window.close();
  }, []);

  const beginShutdown = useCallback(() => {
    isShuttingDownRef.current = true;
    allowCloseRef.current = true;
  }, []);

  const closeTauriWindow = useCallback(async () => {
    // All deliberate exits (exit prompt Save/Discard, launcher Exit) are
    // clean shutdowns: complete the ritual before the window goes away.
    await performCleanShutdown();
    allowCloseRef.current = true;
    if (!tauriWindowRef.current) {
      window.close();
      return;
    }
    const tauriWindow = tauriWindowRef.current;

    // Fallback in case close gets blocked by OS/window lifecycle.
    window.setTimeout(async () => {
      if (!isShuttingDownRef.current) return;
      if (typeof tauriWindow.destroy === 'function') {
        try {
          await tauriWindow.destroy();
        } catch {
          // Ignore fallback errors.
        }
      }
    }, 1200);

    try {
      await tauriWindow.close();
    } catch {
      // Browser/dev fallback.
      if (typeof tauriWindow.destroy === 'function') {
        try {
          await tauriWindow.destroy();
          return;
        } catch {
          // Ignore and fall back to window.close below.
        }
      }
      window.close();
    }
  }, []);

  return {
    isExitPromptOpen,
    setIsExitPromptOpen,
    beginShutdown,
    closeTauriWindow,
    requestAppClose
  };
}
