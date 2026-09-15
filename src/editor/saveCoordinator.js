const savedCodeFor = (tab) => (typeof tab?.workingCode === 'string' ? tab.workingCode : '');

/**
 * Persist one tab and dispatch its saved baseline only after explicit success.
 */
export async function saveOneTab({ tab, persist, dispatch }) {
  if (!tab || typeof persist !== 'function') return null;
  const savedCode = savedCodeFor(tab);
  const saved = await persist(tab);
  if (saved === true) {
    dispatch({ type: 'SAVE_TAB', tabId: tab.id, savedCode });
    return true;
  }
  return false;
}

/**
 * Untitled Save As must stay sequential because the first success establishes
 * the root used by later tabs.
 */
export async function saveTabsSequentially({ tabs, persist, dispatch }) {
  if (typeof persist !== 'function') return null;
  let allSaved = true;
  for (const tab of tabs ?? []) {
    const saved = await saveOneTab({ tab, persist, dispatch });
    if (saved !== true) allSaved = false;
  }
  return allSaved;
}

/**
 * Apply per-tab outcomes from the normal save-all persistence callback.
 * Earlier successes advance independently; failed/missing results stay dirty.
 */
export async function saveTabsFromBatch({ tabs, persistAll, dispatch }) {
  if (typeof persistAll !== 'function') return null;
  const requested = tabs ?? [];
  const results = await persistAll(requested);
  const byTabId = new Map(
    Array.isArray(results) ? results.map((result) => [result.tabId, result]) : []
  );
  let allSaved = true;

  for (const tab of requested) {
    const result = byTabId.get(tab.id);
    if (result?.saved === true && typeof result.savedCode === 'string') {
      dispatch({ type: 'SAVE_TAB', tabId: tab.id, savedCode: result.savedCode });
    } else {
      allSaved = false;
    }
  }
  return allSaved;
}

/** A failed save is a veto on the pending destructive transition. */
export async function canProceedAfterSave(saveAllTabs) {
  return (await saveAllTabs()) !== false;
}
