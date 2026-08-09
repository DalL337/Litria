import { useCallback } from 'react';

export function useExitPromptActions({
  setIsExitPromptOpen,
  beginShutdown,
  discardAllTabs,
  closeTauriWindow,
  saveAllTabs
}) {
  const handleCancelExitPrompt = useCallback(() => {
    setIsExitPromptOpen(false);
  }, [setIsExitPromptOpen]);

  const handleDiscardAndExit = useCallback(async () => {
    beginShutdown();
    discardAllTabs();
    setIsExitPromptOpen(false);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await closeTauriWindow();
  }, [beginShutdown, closeTauriWindow, discardAllTabs, setIsExitPromptOpen]);

  const handleSaveAndExit = useCallback(async () => {
    // Save FIRST, shut down after: in an untitled session saveAllTabs blocks
    // on a native Save As dialog for an unbounded time, and beginShutdown
    // disarms the window-close guard — disarming before the save would let a
    // second close request during the dialog kill the window with the file
    // never written.
    const result = await saveAllTabs();
    // Untitled session: saveAllTabs resolves false when a Save As dialog was
    // canceled — the user backed out of the save, so abort the exit and keep
    // the session open. Normal project saves never resolve false.
    if (result === false) {
      setIsExitPromptOpen(false);
      return;
    }
    beginShutdown();
    setIsExitPromptOpen(false);
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    await closeTauriWindow();
  }, [beginShutdown, closeTauriWindow, saveAllTabs, setIsExitPromptOpen]);

  return {
    handleCancelExitPrompt,
    handleDiscardAndExit,
    handleSaveAndExit
  };
}
