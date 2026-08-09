/**
 * reconcileGroupsWithFolders.js — Ensures folder = group invariant.
 *
 * Every folder that contains pieces should have a matching group.
 * Every group should have pieces in its folder.
 * This function computes the delta needed to restore the invariant.
 *
 * Pure function — no side effects. Returns a list of actions to apply.
 */

import { buildPiecesByFolder } from '../utils/groupFolders.js';

/**
 * @param {object} params
 * @param {Array} params.pieces       - All pieces in the project
 * @param {Array} params.groups       - All groups in the project
 * @param {function} params.normalizePath - Path normalizer (forward slashes, no leading slash)
 * @param {function} params.getBasename  - Extracts filename/dirname from path
 * @param {Array<string>|null} [params.folders] - Every folder path on disk
 *   (from the project tree). When provided, D2 parity applies: EVERY folder
 *   gets a group (empty included, pieceIds []), and a group is removed only
 *   when its folder is GONE from disk — never for being empty (D1,
 *   brief-group-physicality). When absent (legacy callers/tests), the old
 *   piece-derived behavior stands.
 * @returns {{
 *   createGroups: Array<{folderPath: string, name: string, pieceIds: Array, parentFolderPath: string|null}>,
 *   removeGroups: Array<string>,
 *   parentUpdates: Array<{groupId: string, parentFolderPath: string|null}>
 * }}
 */
export function reconcileGroupsWithFolders({ pieces, groups, normalizePath, getBasename, folders = null }) {
  if (!Array.isArray(pieces) || !Array.isArray(groups)) {
    return { createGroups: [], removeGroups: [], parentUpdates: [] };
  }

  const norm = typeof normalizePath === 'function'
    ? normalizePath
    : (p) => (typeof p === 'string' ? p.replace(/\\/g, '/').replace(/^\/+/, '') : '');

  const basename = typeof getBasename === 'function'
    ? getBasename
    : (p) => {
      const n = norm(p);
      const idx = n.lastIndexOf('/');
      return idx >= 0 ? n.substring(idx + 1) : n;
    };

  // Build a map of folder → group for existing groups. FIRST one wins as the
  // canonical group; later rows with the same folder are duplicates — the
  // pre-#241 drop path minted a new group on every drop of the same folder,
  // and the twins rendered pixel-identically stacked (invisible) until
  // independent collapse states made them diverge (owner live repro
  // 2026-08-01: "main parented to main"). Dupes are removed below; children
  // pointing at a removed twin re-derive onto the survivor via parentUpdates.
  const groupByFolder = new Map();
  const duplicateGroups = [];
  for (const group of groups) {
    if (!group.folderPath) continue;
    const folder = norm(group.folderPath);
    if (groupByFolder.has(folder)) {
      duplicateGroups.push(group.id);
    } else {
      groupByFolder.set(folder, group);
    }
  }

  // Build a map of folder → pieceIds from actual piece locations (shared with
  // hydration via buildPiecesByFolder so runtime and load agree exactly).
  const piecesByFolder = buildPiecesByFolder(pieces, norm);

  const createGroups = [];
  const removeGroups = [];
  const diskFolders = Array.isArray(folders)
    ? new Set(folders.map((f) => norm(f)).filter(Boolean))
    : null;

  // Folders needing group creation. With the disk list (D2): every folder,
  // empty included. Without it (legacy): folders that hold pieces. The two
  // sources are unioned so a piece whose folder somehow missed the listing
  // still gets its group.
  const candidateFolders = new Map(piecesByFolder);
  if (diskFolders) {
    for (const folderPath of diskFolders) {
      if (!candidateFolders.has(folderPath)) candidateFolders.set(folderPath, []);
    }
  }
  for (const [folderPath, pieceIds] of candidateFolders) {
    if (!groupByFolder.has(folderPath)) {
      createGroups.push({
        folderPath,
        name: basename(folderPath),
        pieceIds,
      });
    }
  }

  // Removal. Duplicates go regardless of mode (invariant healing: one group
  // per folder). With the disk list: a group additionally dies only when its
  // FOLDER is gone (D1 — emptiness never kills a group). Without it: legacy
  // piece-derived removal stands.
  const removedIds = new Set();
  for (const dupId of duplicateGroups) {
    removeGroups.push(dupId);
    removedIds.add(dupId);
  }
  for (const group of groups) {
    if (!group.folderPath) continue;
    if (removedIds.has(group.id)) continue;
    const normalizedFolder = norm(group.folderPath);
    if (diskFolders) {
      if (!diskFolders.has(normalizedFolder)) {
        removeGroups.push(group.id);
        removedIds.add(group.id);
      }
      continue;
    }
    const piecesInFolder = piecesByFolder.get(normalizedFolder);
    if (!piecesInFolder || piecesInFolder.length === 0) {
      removeGroups.push(group.id);
      removedIds.add(group.id);
    }
  }

  // Parent derivation (2026-07-26): a folder group's parent is the group
  // owning its NEAREST ancestor folder. parentId otherwise only gets set by
  // the canvas nest action, so disk-nested folders (scaffold drags, external
  // edits, auto-created groups) never received the renderer's nested
  // affordances. folderPath is the source of truth; parentId is derived
  // state. Results are folder-path HINTS — the caller resolves them to group
  // ids after allocating ids for createGroups (a parent may itself be
  // getting created in this pass).
  const groupedFolders = new Set([
    ...[...groupByFolder.keys()].filter((folder) => {
      const group = groupByFolder.get(folder);
      return group && !removedIds.has(group.id);
    }),
    ...createGroups.map((entry) => entry.folderPath),
  ]);
  const nearestAncestorFolder = (folderPath) => {
    let current = folderPath;
    let lastSlash = current.lastIndexOf('/');
    while (lastSlash > 0) {
      current = current.substring(0, lastSlash);
      if (groupedFolders.has(current)) return current;
      lastSlash = current.lastIndexOf('/');
    }
    return null;
  };

  for (const entry of createGroups) {
    entry.parentFolderPath = nearestAncestorFolder(entry.folderPath);
  }

  const parentUpdates = [];
  for (const group of groups) {
    if (!group.folderPath || removedIds.has(group.id)) continue;
    const derivedFolder = nearestAncestorFolder(norm(group.folderPath));
    const currentParent = group.parentId
      ? groups.find((g) => g.id === group.parentId) ?? null
      : null;
    // Compare at the folder level: the current link is correct only when it
    // points at a surviving group owning exactly the derived ancestor folder.
    const currentFolder = currentParent && currentParent.folderPath && !removedIds.has(currentParent.id)
      ? norm(currentParent.folderPath)
      : null;
    if (currentFolder !== derivedFolder) {
      parentUpdates.push({ groupId: group.id, parentFolderPath: derivedFolder });
    }
  }

  return { createGroups, removeGroups, parentUpdates };
}
