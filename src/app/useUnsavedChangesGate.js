import { useCallback, useEffect, useRef, useState } from 'react';

// Per-flow prompt copy, keyed by the `kind` passed to guardUnsavedChanges.
export const UNSAVED_CHANGES_PROMPT_COPY = {
  'switch-project': {
    title: 'Unsaved Changes Before Switching Projects',
    message: 'You have unsaved editor changes. Save before switching projects?'
  },
  'exit-to-launcher': {
    title: 'Unsaved Changes Before Exit to Launcher',
    message: 'You have unsaved editor changes. Save before exiting to the launcher?'
  }
};

/**
 * useUnsavedChangesGate — shared dirty-tab gate for project-lifecycle
 * transitions (live project switch, Exit to Launcher).
 *
 * Load-bearing, not polish: unsaved workingCode is memory-only (disk on
 * save, layout-only debounced DB writes), so any flow that tears down the
 * workspace without this gate silently discards edits.
 *
 * `guardUnsavedChanges(kind)` resolves `true` when the transition may
 * proceed: immediately if no tabs are dirty, otherwise after the user picks
 * Save (false if an untitled Save As dialog was canceled — same abort
 * contract as the window-close exit prompt) or Discard. Cancel resolves
 * `false`. Callers gate at their choke point, AFTER any picker/selection UI,
 * so Discard only ever fires for a transition that is definitely proceeding.
 *
 * No beginShutdown / clean-shutdown ritual here — the app keeps running.
 * See docs/plans/ideas/brief-exit-to-launcher.md.
 */
export function useUnsavedChangesGate({ hasDirtyTabs, discardAllTabs, saveAllTabs }) {
  const [promptKind, setPromptKind] = useState(null);
  const resolverRef = useRef(null);
  // Ref mirror so guardUnsavedChanges stays stable — it's a dependency of
  // useProjectLaunch's memoized handlers and must not rebuild per keystroke.
  const hasDirtyTabsRef = useRef(hasDirtyTabs);
  useEffect(() => {
    hasDirtyTabsRef.current = hasDirtyTabs;
  }, [hasDirtyTabs]);

  // Take ownership of the pending resolver and close the prompt. Returns
  // null if another handler already claimed it. Claiming must be SYNCHRONOUS
  // in each button's onClick prefix: the prompt's Save/Discard buttons are
  // Radix AlertDialog.Action buttons, which auto-close the dialog in the
  // same click dispatch — the close fires onCancel via onOpenChange, and an
  // unclaimed resolver would be settled false there while an async Save is
  // still in flight (tab saved, transition silently dropped).
  const claimResolver = useCallback(() => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPromptKind(null);
    return resolve;
  }, []);

  const guardUnsavedChanges = useCallback((kind) => {
    if (!hasDirtyTabsRef.current) return Promise.resolve(true);
    // The prompt is modal so two pending confirms shouldn't be reachable —
    // if one ever is, settle the stray as canceled instead of leaking it.
    resolverRef.current?.(false);
    setPromptKind(kind);
    return new Promise((resolve) => {
      resolverRef.current = resolve;
    });
  }, []);

  const handlePromptCancel = useCallback(() => {
    claimResolver()?.(false);
  }, [claimResolver]);

  const handlePromptDiscard = useCallback(() => {
    const resolve = claimResolver();
    if (!resolve) return;
    discardAllTabs();
    resolve(true);
  }, [claimResolver, discardAllTabs]);

  const handlePromptSave = useCallback(async () => {
    // Claim BEFORE the await — see claimResolver. Without this, the Radix
    // auto-close cancel wins the race and the transition never runs.
    const resolve = claimResolver();
    if (!resolve) return;
    // saveAllTabs resolves false when an untitled session's Save As dialog
    // was canceled — the user backed out of the save, so abort the transition.
    const result = await saveAllTabs();
    resolve(result !== false);
  }, [claimResolver, saveAllTabs]);

  return {
    promptKind,
    guardUnsavedChanges,
    handlePromptCancel,
    handlePromptDiscard,
    handlePromptSave
  };
}
