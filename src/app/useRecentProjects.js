import { useCallback, useEffect, useState } from 'react';
import {
  dbListRecentProjects,
  dbRegisterProject,
  dbPinProject,
  dbRemoveProject,
} from '../project/dbStorage.js';

// Recents are stored in the app-level SQLite DB (durable, cross-window) via the
// db_* commands. This replaces the old localStorage store; any entries left in
// that store are migrated once on first load (see drainLegacyRecents).
const LEGACY_STORAGE_KEY = 'cm:recent_projects';

/** Map a Rust `RecentProject` row to the shape UI consumers expect. */
function toEntry(row) {
  return {
    rootPath: row.path,
    name: row.name || row.path,
    framework: row.framework ?? null,
    lastOpenedAt: row.lastOpenedAt ?? null,
    pinned: Boolean(row.pinned),
  };
}

/** Read and clear the legacy localStorage recents (best-effort, one-time). */
function drainLegacyRecents() {
  try {
    const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [];
    localStorage.removeItem(LEGACY_STORAGE_KEY);
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * useRecentProjects — SQLite-backed recent projects list with pin/forget.
 *
 * Backed by the app-level DB (`db_list_recent_projects` / `db_register_project`
 * / `db_pin_project` / `db_remove_project`). Every command failure is swallowed
 * so the launcher still works when the app DB is unavailable (e.g. browser dev
 * without a Tauri backend) — recents just come back empty in that case.
 */
export function useRecentProjects() {
  const [recents, setRecents] = useState([]);

  const refresh = useCallback(async () => {
    try {
      const rows = await dbListRecentProjects();
      setRecents(Array.isArray(rows) ? rows.map(toEntry) : []);
    } catch {
      // App DB unavailable — surface an empty list rather than throwing.
      setRecents([]);
    }
  }, []);

  // Initial load, preceded by a one-time migration of any legacy localStorage
  // recents into the app DB. Registering oldest-first preserves ordering, since
  // register_project stamps last_opened_at = now and the list sorts by it.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const legacy = drainLegacyRecents();
      for (const entry of legacy.reverse()) {
        if (!entry?.rootPath) continue;
        try {
          await dbRegisterProject(entry.rootPath, entry.name || entry.rootPath, null);
        } catch { /* best-effort migration */ }
      }
      if (!cancelled) await refresh();
    })();
    return () => { cancelled = true; };
  }, [refresh]);

  const pinProject = useCallback(async (rootPath, pinned) => {
    if (!rootPath) return;
    try {
      await dbPinProject(rootPath, pinned);
      await refresh();
    } catch { /* app DB unavailable — skip */ }
  }, [refresh]);

  const removeProject = useCallback(async (rootPath) => {
    if (!rootPath) return;
    try {
      await dbRemoveProject(rootPath);
      await refresh();
    } catch { /* app DB unavailable — skip */ }
  }, [refresh]);

  return { recents, refresh, pinProject, removeProject };
}
