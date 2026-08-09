/**
 * preferencesStore.js — Tauri invoke wrappers for the preferences store
 * (ADR-019 Slice 1: `preferences/global.litria.toml` in the app data dir).
 *
 * Values cross the bridge as JSON; the Rust side owns the toml file, the
 * one-time SQLite migration, and the never-clobber-a-corrupt-file rule.
 * Persisted UI state (HUD layout) does NOT belong here — that stays on
 * dbSavePreference by design (physical state/preference boundary).
 */

import { crumb } from '../crash/breadcrumbs.js';

async function getInvoke() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke;
  } catch {
    return null;
  }
}

async function invokePrefs(command, payload = {}) {
  const invoke = await getInvoke();
  if (!invoke) throw new Error('Tauri invoke bridge is unavailable.');
  try {
    return await invoke(command, payload);
  } catch (error) {
    crumb('command', `${command}:err`);
    throw error;
  }
}

/** Load all global preferences as a plain object (creates the file on first call). */
export async function prefsLoadGlobal() {
  return invokePrefs('prefs_load_global');
}

/** Persist one global preference. Preference writes are rare, real user actions. */
export async function prefsSaveGlobal(key, value) {
  const result = await invokePrefs('prefs_save_global', { key, value });
  crumb('command', `prefs_save_global:${key}`);
  return result;
}

/**
 * Load the project-layer preferences for a project (creates the per-project
 * file on first contact — pre-ADR projects included).
 */
export async function prefsLoadProject(projectPath) {
  return invokePrefs('prefs_load_project', { projectPath });
}

/** Persist one project-layer override. */
export async function prefsSaveProject(projectPath, key, value) {
  const result = await invokePrefs('prefs_save_project', { projectPath, key, value });
  crumb('command', `prefs_save_project:${key}`);
  return result;
}

/** Remove one project-layer override (reset to global). */
export async function prefsClearProject(projectPath, key) {
  const result = await invokePrefs('prefs_clear_project', { projectPath, key });
  crumb('command', `prefs_clear_project:${key}`);
  return result;
}
