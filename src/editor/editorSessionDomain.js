import { getHeaderCommentForFilename } from './editorHeaders.js';

/**
 * Editor session domain — pure reducer + selectors for the editor workspace
 * (ADR-017 split panes). Extracted from EditorSessionContext.jsx so pane
 * rules are unit-testable under node --test (test/domains/editorSessionDomain.test.mjs).
 *
 * Pane model (ADR-017):
 * - Max two panes. Pane 1 is always left, pane 2 always right — position is
 *   identity; numbers are painted by the UI only while split.
 * - The only per-tab pane state is `paneId`. "Split active" is derived
 *   (pane 2 non-empty), never stored.
 * - Single-file invariant: tabsById is keyed by piece id, so a file has at
 *   most one tab. Opening it in another pane is a MOVE (paneId re-point).
 * - Focus follows intent: opening/sending focuses that file in that pane.
 * - Collapse on empty: a pane losing its last tab collapses the split; if
 *   pane 1 empties while pane 2 has tabs, pane 2's tabs are promoted to
 *   pane 1 (the remaining pane becomes the main pane).
 */

export const MAX_OPEN_TABS = 8;
export const MAIN_PANE = 1;
export const SIDE_PANE = 2;

export function normalizeEditorText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n');
}

export function areEditorTextsEqual(left, right) {
  return normalizeEditorText(left) === normalizeEditorText(right);
}

export function normalizeTabFromPiece(piece, paneId = MAIN_PANE) {
  const filename = typeof piece?.filename === 'string' && piece.filename.trim()
    ? piece.filename.trim()
    : `piece-${piece?.id ?? 'unknown'}.txt`;
  const code = normalizeEditorText(typeof piece?.code === 'string' ? piece.code : '');
  let workingCode = normalizeEditorText(
    typeof piece?.workingCode === 'string' ? piece.workingCode : code
  );
  if (!code && piece?.workingCode == null && filename) {
    const header = getHeaderCommentForFilename(filename);
    if (header) {
      workingCode = header;
    }
  }

  return {
    id: piece.id,
    pieceId: piece.id,
    filename,
    code,
    workingCode,
    paneId: paneId === SIDE_PANE ? SIDE_PANE : MAIN_PANE
  };
}

function byFilename(a, b) {
  return a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' });
}

function dedupeTabs(tabs) {
  const seen = new Set();
  const unique = [];
  tabs.forEach((tab) => {
    if (seen.has(tab.id)) return;
    seen.add(tab.id);
    unique.push(tab);
  });
  return unique;
}

export const initialEditorSessionState = {
  isOpen: false,
  openTabIds: [],
  tabsById: {},
  activeTabIdByPane: { [MAIN_PANE]: null, [SIDE_PANE]: null },
  focusedPaneId: MAIN_PANE
};

/* ── Selectors ── */

export function getPaneTabIds(state, paneId) {
  // Tab order within a pane is the global (filename-sorted) order, filtered.
  return state.openTabIds.filter(
    (id) => (state.tabsById[id]?.paneId ?? MAIN_PANE) === paneId
  );
}

export function isSplit(state) {
  return getPaneTabIds(state, SIDE_PANE).length > 0;
}

export function getFocusedActiveTabId(state) {
  return state.activeTabIdByPane[state.focusedPaneId] ?? null;
}

export function canSplit(state) {
  return !isSplit(state) && getPaneTabIds(state, state.focusedPaneId).length >= 2;
}

/**
 * Divider bounds (ADR-017 Phase C): pane 1's fraction of the split row.
 * Clamped so neither pane can be dragged useless; anything non-numeric
 * (missing/garbage persisted value) resets to the even split.
 */
export const PANE_RATIO_MIN = 0.2;
export const PANE_RATIO_MAX = 0.8;
export const PANE_RATIO_DEFAULT = 0.5;

export function clampPaneRatio(value) {
  // null/'' coerce to 0 under Number() — treat them as the garbage they are
  // (an absent or blanked persisted value), not as a far-left divider.
  if (value == null || value === '') return PANE_RATIO_DEFAULT;
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return PANE_RATIO_DEFAULT;
  return Math.max(PANE_RATIO_MIN, Math.min(PANE_RATIO_MAX, ratio));
}

/**
 * Canvas pane-residency tags (the ADR-017 sign-off "where is it open" pill):
 * while split, pieceId → paneId for every open tab. Null while single-pane —
 * the tag only answers a question that exists when two panes are visible.
 */
export function getPaneTagsByPieceId(state) {
  if (!isSplit(state)) return null;
  const map = new Map();
  state.openTabIds.forEach((id) => {
    const tab = state.tabsById[id];
    if (tab) map.set(tab.pieceId, tab.paneId === SIDE_PANE ? SIDE_PANE : MAIN_PANE);
  });
  return map;
}

/**
 * Serialize per-tab pane residency for persistence (ADR-017 Phase B).
 * Keys follow openTabIds order, so the string is value-stable across
 * keystrokes (workingCode churn) and only changes when membership or
 * placement changes — the debounced editor-state save keys off it.
 */
export function serializeTabPaneAssignments(state) {
  const entries = state.openTabIds.map((id) => [
    String(id),
    (state.tabsById[id]?.paneId ?? MAIN_PANE) === SIDE_PANE ? SIDE_PANE : MAIN_PANE
  ]);
  return JSON.stringify(Object.fromEntries(entries));
}

/**
 * Apply persisted pane residency to snapshot tabs before OPEN_FROM_SNAPSHOT.
 * Tolerant by design: with no usable assignments (pre-Phase-B saves,
 * malformed JSON) tabs keep whatever paneId they already carry (normalized);
 * with a map, listed ids follow it and unknown ids fall back to the main
 * pane. A bad save can never brick session restore.
 */
export function applyPaneAssignments(tabs, rawAssignments) {
  let map = null;
  if (typeof rawAssignments === 'string' && rawAssignments) {
    try {
      map = JSON.parse(rawAssignments);
    } catch {
      map = null;
    }
  }
  if (map == null || typeof map !== 'object') {
    return tabs.map((tab) => ({
      ...tab,
      paneId: tab.paneId === SIDE_PANE ? SIDE_PANE : MAIN_PANE
    }));
  }
  return tabs.map((tab) => ({
    ...tab,
    paneId: map[String(tab.id)] === SIDE_PANE ? SIDE_PANE : MAIN_PANE
  }));
}

/* ── Invariant normalization ──
   Applied after any structural change (open/move/close/restore). Re-derives
   per-pane actives, promotes pane 2 when pane 1 empties, and clears side
   focus when the side pane is gone. */
function withPaneInvariants(state) {
  let next = state;

  let mainIds = getPaneTabIds(next, MAIN_PANE);
  let sideIds = getPaneTabIds(next, SIDE_PANE);

  // Pane 1 empty while pane 2 holds tabs -> the remaining pane becomes the
  // main pane (position is identity; there is no floating "pane 2 only").
  if (mainIds.length === 0 && sideIds.length > 0) {
    const promoted = { ...next.tabsById };
    sideIds.forEach((id) => {
      promoted[id] = { ...promoted[id], paneId: MAIN_PANE };
    });
    next = {
      ...next,
      tabsById: promoted,
      activeTabIdByPane: {
        [MAIN_PANE]: next.activeTabIdByPane[SIDE_PANE],
        [SIDE_PANE]: null
      },
      focusedPaneId: MAIN_PANE
    };
    mainIds = getPaneTabIds(next, MAIN_PANE);
    sideIds = [];
  }

  // Per-pane active must exist inside its pane; fall back to the pane's
  // first tab (or null when the pane is empty).
  const resolveActive = (ids, current) => (
    current != null && ids.includes(current) ? current : (ids[0] ?? null)
  );
  const nextActive = {
    [MAIN_PANE]: resolveActive(mainIds, next.activeTabIdByPane[MAIN_PANE]),
    [SIDE_PANE]: resolveActive(sideIds, next.activeTabIdByPane[SIDE_PANE])
  };
  const focusedPaneId = sideIds.length === 0 ? MAIN_PANE : next.focusedPaneId;

  if (
    nextActive[MAIN_PANE] !== next.activeTabIdByPane[MAIN_PANE]
    || nextActive[SIDE_PANE] !== next.activeTabIdByPane[SIDE_PANE]
    || focusedPaneId !== next.focusedPaneId
  ) {
    next = { ...next, activeTabIdByPane: nextActive, focusedPaneId };
  }

  return next;
}

/* ── Reducer ── */

export function editorSessionReducer(state, action) {
  switch (action.type) {
    case 'OPEN_FROM_SELECTION': {
      const rawTabs = action.pieces.map((piece) => {
        const nextTab = normalizeTabFromPiece(piece);
        const existing = state.tabsById[nextTab.id];
        if (existing) {
          // Preserve buffer state AND pane placement for tabs that survive
          // the replace — re-opening a selection must not tear down a split.
          return {
            ...nextTab,
            code: existing.code,
            workingCode: existing.workingCode,
            paneId: existing.paneId ?? MAIN_PANE
          };
        }
        return nextTab;
      }).sort(byFilename);
      const tabs = dedupeTabs(rawTabs).slice(0, MAX_OPEN_TABS);
      const tabsById = {};
      tabs.forEach((tab) => {
        tabsById[tab.id] = tab;
      });

      const next = {
        ...state,
        isOpen: tabs.length > 0,
        openTabIds: tabs.map((tab) => tab.id),
        tabsById: {
          ...state.tabsById,
          ...tabsById
        }
      };
      return withPaneInvariants(next);
    }
    case 'OPEN_FOR_PIECE': {
      // Focus-follows-intent primitive. Targets action.paneId when given,
      // else the focused pane. An already-open tab is MOVED (paneId
      // re-point), never duplicated (single-file invariant).
      const targetPane = action.paneId === SIDE_PANE ? SIDE_PANE : (
        action.paneId === MAIN_PANE ? MAIN_PANE : state.focusedPaneId
      );
      const nextTab = normalizeTabFromPiece(action.piece, targetPane);
      const existing = state.tabsById[nextTab.id];
      const tab = existing
        ? {
          ...nextTab,
          code: existing.code,
          workingCode: existing.workingCode,
          paneId: targetPane
        }
        : nextTab;
      const nextIds = dedupeTabs([
        ...state.openTabIds.map((id) => state.tabsById[id]).filter(Boolean),
        tab
      ].sort(byFilename)).slice(0, MAX_OPEN_TABS).map((entry) => entry.id);

      const next = {
        ...state,
        isOpen: true,
        openTabIds: nextIds,
        tabsById: {
          ...state.tabsById,
          [tab.id]: tab
        },
        activeTabIdByPane: {
          ...state.activeTabIdByPane,
          [targetPane]: tab.id
        },
        focusedPaneId: targetPane
      };
      return withPaneInvariants(next);
    }
    case 'OPEN_IN_OTHER_PANE': {
      // ADR-017 Phase B entry point (shift+double-click on a canvas node):
      // open the piece in the pane the user is NOT focused on — splits when
      // single-pane, sends across when already split. Degenerate case (only
      // tab moves out of pane 1) self-heals via withPaneInvariants.
      const other = state.focusedPaneId === SIDE_PANE ? MAIN_PANE : SIDE_PANE;
      return editorSessionReducer(state, {
        type: 'OPEN_FOR_PIECE',
        piece: action.piece,
        paneId: other
      });
    }
    case 'SEND_TO_PANE': {
      // Move an EXISTING tab to a pane (or focus it if already there).
      // "Open in new pane" is SEND_TO_PANE(tabId, SIDE_PANE) with no split
      // active — the UI's degenerate guard keeps it off a pane's only tab.
      const tab = state.tabsById[action.tabId];
      if (!tab || !state.openTabIds.includes(action.tabId)) return state;
      const targetPane = action.paneId === SIDE_PANE ? SIDE_PANE : MAIN_PANE;

      const next = {
        ...state,
        isOpen: true,
        tabsById: {
          ...state.tabsById,
          [tab.id]: { ...tab, paneId: targetPane }
        },
        activeTabIdByPane: {
          ...state.activeTabIdByPane,
          [targetPane]: tab.id
        },
        focusedPaneId: targetPane
      };
      return withPaneInvariants(next);
    }
    case 'SPLIT_NEXT': {
      // Generic View > Split Editor verb (Ctrl+\): move the tab after the
      // focused pane's active into a new side pane. No-op while split or
      // with fewer than two tabs (menu disables; reducer stays safe).
      if (isSplit(state)) return state;
      const ids = getPaneTabIds(state, state.focusedPaneId);
      if (ids.length < 2) return state;
      const active = state.activeTabIdByPane[state.focusedPaneId] ?? ids[0];
      const idx = Math.max(0, ids.indexOf(active));
      const moveId = ids[idx + 1] ?? ids[idx - 1];
      return editorSessionReducer(state, { type: 'SEND_TO_PANE', tabId: moveId, paneId: SIDE_PANE });
    }
    case 'OPEN_FROM_SNAPSHOT': {
      const rawTabs = Array.isArray(action.tabs) ? action.tabs : [];
      const tabs = dedupeTabs(rawTabs).slice(0, MAX_OPEN_TABS).map((tab) => ({
        ...tab,
        paneId: tab.paneId === SIDE_PANE ? SIDE_PANE : MAIN_PANE
      }));
      const tabsById = {};
      tabs.forEach((tab) => {
        tabsById[tab.id] = tab;
      });
      const nextOpenIds = tabs.map((tab) => tab.id);
      const restoredActive = nextOpenIds.includes(action.activeTabId)
        ? action.activeTabId
        : (nextOpenIds[0] ?? null);
      const restoredPane = restoredActive != null
        ? (tabsById[restoredActive]?.paneId ?? MAIN_PANE)
        : MAIN_PANE;

      const next = {
        ...state,
        isOpen: state.isOpen,
        openTabIds: nextOpenIds,
        tabsById: {
          ...state.tabsById,
          ...tabsById
        },
        activeTabIdByPane: {
          [MAIN_PANE]: restoredPane === MAIN_PANE ? restoredActive : null,
          [SIDE_PANE]: restoredPane === SIDE_PANE ? restoredActive : null
        },
        focusedPaneId: restoredPane
      };
      return withPaneInvariants(next);
    }
    case 'SET_ACTIVE_TAB': {
      const tab = state.tabsById[action.tabId];
      if (!tab || !state.openTabIds.includes(action.tabId)) return state;
      const pane = tab.paneId ?? MAIN_PANE;
      return {
        ...state,
        isOpen: true,
        activeTabIdByPane: {
          ...state.activeTabIdByPane,
          [pane]: action.tabId
        },
        focusedPaneId: pane
      };
    }
    case 'SET_FOCUSED_PANE': {
      const pane = action.paneId === SIDE_PANE ? SIDE_PANE : MAIN_PANE;
      if (pane === SIDE_PANE && getPaneTabIds(state, SIDE_PANE).length === 0) return state;
      if (pane === state.focusedPaneId) return state;
      return { ...state, focusedPaneId: pane };
    }
    case 'UPDATE_WORKING_CODE': {
      const current = state.tabsById[action.tabId];
      if (!current) return state;
      return {
        ...state,
        tabsById: {
          ...state.tabsById,
          [action.tabId]: {
            ...current,
            workingCode: normalizeEditorText(action.workingCode)
          }
        }
      };
    }
    case 'SAVE_TAB': {
      const current = state.tabsById[action.tabId];
      if (!current) return state;
      // savedCode: what actually reached disk. Async save paths (untitled
      // Save As) pass the snapshot they wrote, so keystrokes typed during the
      // dialog/write stay dirty; sync paths omit it and baseline to live
      // workingCode as before.
      const savedCode = typeof action.savedCode === 'string'
        ? action.savedCode
        : current.workingCode;
      return {
        ...state,
        tabsById: {
          ...state.tabsById,
          [action.tabId]: {
            ...current,
            code: savedCode
          }
        }
      };
    }
    case 'DISCARD_TAB': {
      const current = state.tabsById[action.tabId];
      if (!current) return state;
      return {
        ...state,
        tabsById: {
          ...state.tabsById,
          [action.tabId]: {
            ...current,
            workingCode: current.code
          }
        }
      };
    }
    case 'SAVE_ALL': {
      const nextTabsById = { ...state.tabsById };
      Object.keys(nextTabsById).forEach((tabId) => {
        const tab = nextTabsById[tabId];
        nextTabsById[tabId] = { ...tab, code: tab.workingCode };
      });
      return {
        ...state,
        tabsById: nextTabsById
      };
    }
    case 'UPDATE_TAB_FILENAME': {
      const current = state.tabsById[action.tabId];
      if (!current) return state;
      return {
        ...state,
        tabsById: {
          ...state.tabsById,
          [action.tabId]: {
            ...current,
            filename: action.filename
          }
        }
      };
    }
    case 'DISCARD_ALL': {
      const nextTabsById = { ...state.tabsById };
      Object.keys(nextTabsById).forEach((tabId) => {
        const tab = nextTabsById[tabId];
        nextTabsById[tabId] = { ...tab, workingCode: tab.code };
      });
      return {
        ...state,
        tabsById: nextTabsById
      };
    }
    case 'CLOSE_TAB': {
      const closing = state.tabsById[action.tabId];
      if (!closing || !state.openTabIds.includes(action.tabId)) return state;
      const pane = closing.paneId ?? MAIN_PANE;
      const nextOpenIds = state.openTabIds.filter((id) => id !== action.tabId);
      const paneRemainder = nextOpenIds.filter(
        (id) => (state.tabsById[id]?.paneId ?? MAIN_PANE) === pane
      );
      const paneActive = state.activeTabIdByPane[pane] === action.tabId
        ? (paneRemainder[0] ?? null)
        : state.activeTabIdByPane[pane];

      const next = {
        ...state,
        openTabIds: nextOpenIds,
        activeTabIdByPane: {
          ...state.activeTabIdByPane,
          [pane]: paneActive
        },
        isOpen: nextOpenIds.length ? state.isOpen : false
      };
      return withPaneInvariants(next);
    }
    case 'HIDE_DRAWER':
      return {
        ...state,
        isOpen: false
      };
    case 'SHOW_DRAWER':
      return {
        ...state,
        isOpen: state.openTabIds.length > 0
      };
    case 'RESET_SESSION':
      return {
        ...initialEditorSessionState
      };
    default:
      return state;
  }
}
