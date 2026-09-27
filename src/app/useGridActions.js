/**
 * useGridActions — orchestration for the structural grid (ADR-030).
 *
 * Holds GridDomain's state in React, hydrates it from the open workspace's
 * record, applies spacing as one undoable step, and saves the record through
 * `invokeDb` with the epoch captured when the save was queued (ADR-032 D1).
 * Also resolves the grid's personal settings from the global preferences
 * (ADR-019) and keeps them live when either the Grid widget or the
 * Preferences panel saves one.
 *
 * Nothing here moves a node: spacing, mode, paint and visibility change how
 * nodes will land and how the grid looks, never where nodes are.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createGridDomain } from './gridDomain.js';
import { GRID_GUIDE_CAPTURE_PX, resolveGridPreferences, withPaintOverride } from './gridPreferences.js';
import { dbSaveWorkspaceGrid, getWorkspaceEpoch, isWorkspaceChanged } from '../project/dbStorage.js';
import { canPersist } from '../project/persistenceNotices.js';
import {
  onGlobalPreferenceSaved,
  prefsLoadGlobal,
  prefsSaveGlobal,
} from '../preferences/preferencesStore.js';
import { PREFERENCE_REGISTRY, PREF_KEYS } from '../preferences/registry.js';

const GRID_PREF_KEYS = new Set(
  PREFERENCE_REGISTRY.filter((entry) => entry.place.includes('hud.grid')).map((entry) => entry.key),
);

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

function systemPrefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION_QUERY).matches
    : false;
}

export function useGridActions({ projectInstance, history }) {
  const domain = useMemo(() => createGridDomain(), []);
  const [gridState, setGridState] = useState(() => domain.selectors.getState());

  // ── Hydration: one record per workspace, never written back on open ──
  const dbState = projectInstance?._dbState ?? null;
  const instanceId = projectInstance?.instanceId ?? null;
  const hasWorkspace = Boolean(instanceId) && projectInstance?.manifestPath !== null && Boolean(dbState);
  const readOnly = projectInstance?.readOnly === true;
  useEffect(() => {
    if (!instanceId) {
      setGridState(domain.commands.reset());
      return;
    }
    // A single-file session has no workspace to hold a grid: it reads the
    // compatibility lattice and cannot change it.
    setGridState(domain.commands.hydrate(hasWorkspace
      ? { record: dbState.grid ?? null, unreadable: dbState.gridUnreadable === true, readOnly }
      : { record: null, readOnly: true }));
  }, [domain, instanceId, dbState, hasWorkspace, readOnly]);

  // ── Saves: serialized and coalesced, so an older save can never land last ──
  const saveQueueRef = useRef({ running: null, next: null });
  const projectRef = useRef(projectInstance);
  projectRef.current = projectInstance;
  const queueSave = useCallback((definition) => {
    if (!canPersist(projectRef.current)) return Promise.resolve();
    const queue = saveQueueRef.current;
    queue.next = { definition, epoch: getWorkspaceEpoch() };
    if (queue.running) return queue.running;
    queue.running = (async () => {
      while (queue.next) {
        const job = queue.next;
        queue.next = null;
        try {
          await dbSaveWorkspaceGrid(job.definition, { epoch: job.epoch });
        } catch (error) {
          // A fenced write addressed a workspace that is no longer open:
          // correct and silent (ADR-032 D3). Anything else already reached
          // the persistence notice through invokeDb.
          if (!isWorkspaceChanged(error)) {
            console.warn('[grid] saving the workspace grid failed:', error);
          }
        }
      }
      queue.running = null;
    })();
    return queue.running;
  }, []);

  const commitDefinition = useCallback((definition) => {
    const result = domain.commands.applyDefinition(definition);
    if (result.ok && result.changed) {
      setGridState(result.state);
      void queueSave(result.state.definition);
    }
    return result;
  }, [domain, queueSave]);

  /**
   * Apply spacing to this workspace: one undoable step, saved at once. Nodes
   * stay where they are. Returns the domain's result ({ ok, changed, errors }).
   */
  const applyGridDefinition = useCallback((definition) => {
    const result = domain.commands.applyDefinition(definition);
    if (!result.ok || !result.changed) return result;
    const next = result.state.definition;
    const previous = result.previous;
    setGridState(result.state);
    void queueSave(next);
    history?.execute?.({
      label: 'Change grid spacing',
      do: () => { commitDefinition(next); },
      undo: () => { commitDefinition(previous); },
    }, { skipDo: true });
    return result;
  }, [commitDefinition, domain, history, queueSave]);

  // ── Personal settings (global preferences) ──
  const [storedPrefs, setStoredPrefs] = useState({});
  const [systemReducedMotion, setSystemReducedMotion] = useState(systemPrefersReducedMotion);
  useEffect(() => {
    let canceled = false;
    prefsLoadGlobal()
      .then((prefs) => {
        if (canceled || !prefs) return;
        setStoredPrefs(Object.fromEntries(
          Object.entries(prefs).filter(([key]) => GRID_PREF_KEYS.has(key)),
        ));
      })
      .catch(() => {});
    const unsubscribe = onGlobalPreferenceSaved((key, value) => {
      if (GRID_PREF_KEYS.has(key)) setStoredPrefs((prev) => ({ ...prev, [key]: value }));
    });
    return () => {
      canceled = true;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(REDUCED_MOTION_QUERY);
    const update = () => setSystemReducedMotion(media.matches);
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  const gridPreferences = useMemo(
    () => resolveGridPreferences(storedPrefs, { systemReducedMotion }),
    [storedPrefs, systemReducedMotion],
  );

  /** Save one grid setting; the value shows at once and the save follows. */
  const setGridPreference = useCallback((key, value) => {
    if (!GRID_PREF_KEYS.has(key)) return;
    setStoredPrefs((prev) => ({ ...prev, [key]: value }));
    prefsSaveGlobal(key, value).catch((error) => {
      console.warn(`[grid] saving the ${key} setting failed:`, error);
    });
  }, []);

  // What placement reads at drag start (brief §5: captured once per gesture).
  // A stable getter over a ref, so the interaction controller's callbacks do
  // not rebuild on every grid or preference change.
  const placementRef = useRef(null);
  placementRef.current = {
    mode: gridPreferences.snapMode,
    steps: gridState.steps,
    revision: gridState.revision,
    guides: gridPreferences.smartGuides,
    guideTolerancePx: GRID_GUIDE_CAPTURE_PX,
  };
  const getGridPlacement = useCallback(() => placementRef.current, []);

  /** Set this theme/energy/ink's line opacities, or clear them with null. */
  const setGridPaintOverride = useCallback((context, levels) => {
    const next = withPaintOverride(gridPreferences.paintOverrides, context, levels);
    setGridPreference(PREF_KEYS.gridPaintOverrides, next);
  }, [gridPreferences.paintOverrides, setGridPreference]);

  return {
    gridState,
    gridSteps: gridState.steps,
    gridRevision: gridState.revision,
    canEditGrid: gridState.hydrated && !gridState.locked,
    applyGridDefinition,
    gridPreferences,
    setGridPreference,
    setGridPaintOverride,
    getGridPlacement,
  };
}
