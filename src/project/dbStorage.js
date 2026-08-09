/**
 * dbStorage.js — Tauri invoke wrappers for the SQLite persistence layer.
 *
 * Each function maps to a Rust #[tauri::command] in src-tauri/src/db/commands.rs.
 * Returns typed results; callers handle errors.
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

// Lifecycle-grade DB commands worth a breadcrumb. Everything else here
// (viewport saves, editor-state saves, batch moves) is debounced chatter
// that would evict real user actions from the crash ring.
const CRUMB_KEEP = new Set([
  'db_bootstrap_project',
  'db_open_project',
  'db_close_project',
  'db_create_piece',
  'db_create_pieces_batch',
  'db_delete_piece',
  'db_create_group',
  'db_delete_group',
]);

async function invokeDb(command, payload = {}) {
  const invoke = await getInvoke();
  if (!invoke) throw new Error('Tauri invoke bridge is unavailable.');
  try {
    const result = await invoke(command, payload);
    if (CRUMB_KEEP.has(command)) crumb('command', `${command}:ok`);
    return result;
  } catch (error) {
    if (CRUMB_KEEP.has(command)) crumb('command', `${command}:err`);
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Project lifecycle
// ═══════════════════════════════════════════════════════════════════════════

/** Open a project (handles returning, migration, and bootstrap). Returns ProjectState. */
export async function dbOpenProject(path) {
  return invokeDb('db_open_project', { path });
}

/** Bootstrap a new project. Returns ProjectState.
 *  environmentPython: requires-python floor (e.g. "3.13") → written into
 *  litria.toml's `[environment]` block (ADR-020). */
export async function dbBootstrapProject(path, name, language = null, framework = null, environmentPython = null) {
  return invokeDb('db_bootstrap_project', { path, name, language, framework, environmentPython });
}

/** Close the currently open project. */
export async function dbCloseProject() {
  return invokeDb('db_close_project');
}

// ═══════════════════════════════════════════════════════════════════════════
// Piece operations
// ═══════════════════════════════════════════════════════════════════════════

/** Create a single piece. Returns the new piece ID (i64). */
export async function dbCreatePiece({ filePath, label, x, y, color, scale, isHidden }) {
  return invokeDb('db_create_piece', { filePath, label, x, y, color, scale, isHidden });
}

/** Batch-create pieces. Returns array of new IDs. */
export async function dbCreatePiecesBatch(pieces) {
  return invokeDb('db_create_pieces_batch', { pieces });
}

/** Batch move pieces (update x, y). */
export async function dbBatchMovePieces(moves) {
  return invokeDb('db_batch_move_pieces', { moves });
}

/** Update specific fields of a piece. */
export async function dbUpdatePiece(id, fields) {
  return invokeDb('db_update_piece', { id, fields });
}

/** Delete a piece (cascades to group_pieces and connections). */
export async function dbDeletePiece(id) {
  return invokeDb('db_delete_piece', { id });
}

// ═══════════════════════════════════════════════════════════════════════════
// Group operations
// ═══════════════════════════════════════════════════════════════════════════

/** Create a group. */
export async function dbCreateGroup(group) {
  return invokeDb('db_create_group', { group });
}

/** Update specific fields of a group. */
export async function dbUpdateGroup(id, fields) {
  return invokeDb('db_update_group', { id, fields });
}

/** Delete a group (cascades to group_pieces). */
export async function dbDeleteGroup(id) {
  return invokeDb('db_delete_group', { id });
}

/** Add a piece to a group (UNIQUE constraint prevents duplicates). */
export async function dbAddPieceToGroup(groupId, pieceId) {
  return invokeDb('db_add_piece_to_group', { groupId, pieceId });
}

/** Remove a piece from a group. */
export async function dbRemovePieceFromGroup(groupId, pieceId) {
  return invokeDb('db_remove_piece_from_group', { groupId, pieceId });
}

// ═══════════════════════════════════════════════════════════════════════════
// Connection operations
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a connection between two pieces, persisting its anchor sides + type.
 * Returns the new connection row id. `sourceSide`/`targetSide`/`type` may be
 * null (legacy rows / geometry-derived) — they hydrate back with a geometry
 * fallback. See project_discovery_canvas_sync (Phase 1B).
 */
export async function dbCreateConnection(
  fromPieceId,
  toPieceId,
  sourceSide = null,
  targetSide = null,
  type = null,
) {
  return invokeDb('db_create_connection', {
    fromPieceId,
    toPieceId,
    sourceSide,
    targetSide,
    type,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// State operations (editor, viewport, hidden paths)
// ═══════════════════════════════════════════════════════════════════════════

/** Save a single editor state key-value pair. */
export async function dbSaveEditorState(key, value) {
  return invokeDb('db_save_editor_state', { key, value });
}

/** Load all editor state key-value pairs. */
export async function dbLoadEditorState() {
  return invokeDb('db_load_editor_state');
}

/** Save viewport position and scale. */
export async function dbSaveViewport(x, y, scale) {
  return invokeDb('db_save_viewport', { x, y, scale });
}

/** Add a path to the hidden scaffold paths list. */
export async function dbAddHiddenPath(path) {
  return invokeDb('db_add_hidden_path', { path });
}

/** Remove a path from the hidden scaffold paths list. */
export async function dbRemoveHiddenPath(path) {
  return invokeDb('db_remove_hidden_path', { path });
}

// ═══════════════════════════════════════════════════════════════════════════
// App-level operations (recent projects, preferences)
// ═══════════════════════════════════════════════════════════════════════════

/** List recent projects (sorted by pinned + last_opened_at). */
export async function dbListRecentProjects() {
  return invokeDb('db_list_recent_projects');
}

/** Register a project in the app-level database. */
export async function dbRegisterProject(path, name, framework = null) {
  return invokeDb('db_register_project', { path, name, framework });
}

/** Remove a project from the recent list. */
export async function dbRemoveProject(path) {
  return invokeDb('db_remove_project', { path });
}

/** Pin/unpin a project. */
export async function dbPinProject(path, pinned) {
  return invokeDb('db_pin_project', { path, pinned });
}

/** Save a global preference. */
export async function dbSavePreference(key, value) {
  return invokeDb('db_save_preference', { key, value });
}

/** Load all global preferences. */
export async function dbLoadPreferences() {
  return invokeDb('db_load_preferences');
}
