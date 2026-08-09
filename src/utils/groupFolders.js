// groupFolders.js — folder-derived group membership (single source of truth).
//
// A folder-backed group's members are exactly the pieces whose files live
// directly in that group's folder. This derivation is used in two places that
// MUST agree, or they'd fight each other:
//   - runtime: reconcileGroupsWithFolders (keeps the folder = group invariant)
//   - load:    useProjectPersistence hydration (rebuilds membership on reopen)
// Keeping the logic here, shared, guarantees identical semantics.

import { normalizePath as defaultNormalize } from './path.js';

/**
 * Map each folder to the ids of pieces whose file sits directly in it. Pieces
 * at the project root (no parent folder) belong to no folder and are skipped.
 *
 * @param {Array<{id:*, filename?:string}>} pieces
 * @param {(p:string)=>string} [normalizePath]
 * @returns {Map<string, Array>} normalized folder path → piece ids
 */
export function buildPiecesByFolder(pieces, normalizePath = defaultNormalize) {
  const map = new Map();
  if (!Array.isArray(pieces)) return map;
  const norm = typeof normalizePath === 'function' ? normalizePath : defaultNormalize;

  for (const piece of pieces) {
    if (!piece?.filename) continue;
    const normalized = norm(piece.filename);
    const lastSlash = normalized.lastIndexOf('/');
    // lastSlash > 0 (not >= 0): a leading-slash-stripped path with the slash at
    // index 0 has no real parent folder. Matches reconcileGroupsWithFolders.
    const parentDir = lastSlash > 0 ? normalized.substring(0, lastSlash) : null;
    if (!parentDir) continue;
    if (!map.has(parentDir)) map.set(parentDir, []);
    map.get(parentDir).push(piece.id);
  }
  return map;
}

/**
 * Member piece ids for a folder-backed group, derived from folder structure.
 * Returns null for a group with no folderPath — the caller decides the fallback
 * (e.g. a persisted membership cache) for non-folder ("manual") groups.
 *
 * @param {{folderPath?:string|null}} group
 * @param {Map<string, Array>} piecesByFolder  from buildPiecesByFolder
 * @param {(p:string)=>string} [normalizePath]
 * @returns {Array|null}
 */
export function deriveGroupPieceIds(group, piecesByFolder, normalizePath = defaultNormalize) {
  if (!group?.folderPath) return null;
  const norm = typeof normalizePath === 'function' ? normalizePath : defaultNormalize;
  return piecesByFolder.get(norm(group.folderPath)) ?? [];
}
