import { useEffect, useRef } from 'react';
import { reconcileGroupsWithFolders } from './reconcileGroupsWithFolders.js';
import { COLLAPSED_STUB_HEIGHT } from './selectors/workspaceSelectors.js';
import { dbCreateGroup, dbAddPieceToGroup, dbDeleteGroup, dbUpdateGroup } from '../project/dbStorage.js';

/**
 * useGroupFolderReconciliation — Option A safety net (backstop since the
 * FSM's in-pipeline reconciliation, PRD-FSM-001 §3.3).
 *
 * Ensures the folder = group invariant holds. Since the group-physicality
 * ruling (brief-group-physicality, owner 2026-08-01) the invariant is D2
 * parity: EVERY folder on disk has a group — empty folders included — and a
 * group is removed only when its folder is gone from disk, never for being
 * empty (D1). The disk folder list comes from `listTree` at reconcile time;
 * when the tree is unavailable the pass falls back to the legacy
 * piece-derived behavior rather than guessing.
 *
 * Empty-folder creations carry seedBounds (their only geometry until members
 * arrive): under an existing parent group they sit just below the parent's
 * content (the parent's descendant-union box absorbs them); top-level ones
 * stagger from the spawn position.
 *
 * Triggers (owner live-verify D, 2026-07-18 — the old version skipped its
 * initial run and only fired on scaffold refreshes, so a project whose
 * groups weren't in the DB launched with NO groups drawn until some
 * scaffold operation happened to bump the token):
 *  1. Once per PROJECT LOAD, after pieces hydrate (loadToken + non-empty
 *     pieces — same per-load pattern discovery uses).
 *  2. Every scaffold refresh (token change), as before.
 *
 * The whole delta (creations, removals, parent links) is applied through
 * ONE applyFsSyncPlan command: sequential per-group commands in the same
 * tick each rebuild from the same stale base and clobber one another
 * (groupsRef syncs in an effect). withHistory:false — background healing
 * never lands in the undo stack. All deltas are persisted (group rows are
 * what make groups exist on the next launch; membership rows are a
 * fallback cache — hydration derives membership from folderPath). The tree
 * fetch makes the pass async; upserts union-by-id, so a replay against an
 * already-applied base stays correct.
 *
 * @param {object} params
 * @param {Array}    params.pieces          - All pieces
 * @param {Array}    params.groups          - All groups
 * @param {object}   params.groupDomain     - Group domain with commands
 * @param {number}   params.scaffoldRefreshToken - Increments on scaffold refresh
 * @param {any}      params.loadToken       - Per-open identity (projectInstance._dbState)
 * @param {function} params.normalizePath   - Path normalizer
 * @param {function} params.getBasename     - Basename extractor
 * @param {function} [params.listTree]      - async (rootPath) => tree entries
 * @param {string}   [params.projectRootPath]
 * @param {function} [params.getSpawnPosition] - () => {x, y} for top-level seeds
 * @param {function} [params.getGroupBounds]   - (group) => bounds|null
 * @param {number}   [params.pieceWidth]
 */
export function useGroupFolderReconciliation({
  pieces,
  groups,
  groupDomain,
  scaffoldRefreshToken,
  loadToken = null,
  normalizePath,
  getBasename,
  listTree = null,
  projectRootPath = null,
  getSpawnPosition = null,
  getGroupBounds = null,
  pieceWidth = 160,
}) {
  const ranForTokenRef = useRef(null);
  const prevScaffoldTokenRef = useRef(scaffoldRefreshToken);

  useEffect(() => {
    if (!groupDomain || !Array.isArray(pieces) || !Array.isArray(groups)) return;

    const scaffoldChanged = prevScaffoldTokenRef.current !== scaffoldRefreshToken;
    prevScaffoldTokenRef.current = scaffoldRefreshToken;

    const launchDue = loadToken != null
      && ranForTokenRef.current !== loadToken
      && pieces.length > 0;
    if (!scaffoldChanged && !launchDue) return;
    if (launchDue) ranForTokenRef.current = loadToken;

    let cancelled = false;
    (async () => {
      let folders = null;
      if (typeof listTree === 'function' && projectRootPath) {
        try {
          const entries = await listTree(projectRootPath);
          if (Array.isArray(entries)) {
            folders = entries
              .filter((entry) => entry?.entryType === 'dir')
              .map((entry) => normalizePath(entry.path))
              .filter(Boolean);
          }
        } catch {
          folders = null; // tree unavailable → legacy piece-derived pass
        }
      }
      if (cancelled) return;

      const { createGroups, removeGroups, parentUpdates } = reconcileGroupsWithFolders({
        pieces,
        groups,
        normalizePath,
        getBasename,
        folders,
      });

      if (!createGroups.length && !removeGroups.length && !parentUpdates.length) return;

      // Allocate ids for creations first, then resolve parent-folder HINTS to
      // group ids against surviving existing groups ∪ this pass's creations
      // (a parent may itself be getting created right now).
      const removedIds = new Set(removeGroups);
      const groupIdByFolder = new Map();
      const groupByFolder = new Map();
      for (const group of groups) {
        if (group.folderPath && !removedIds.has(group.id)) {
          const folder = normalizePath(group.folderPath);
          groupIdByFolder.set(folder, group.id);
          groupByFolder.set(folder, group);
        }
      }
      const creations = createGroups.map((entry) => ({
        ...entry,
        groupId: groupDomain.commands.allocateGroupId().groupId,
      }));
      for (const entry of creations) {
        groupIdByFolder.set(entry.folderPath, entry.groupId);
      }
      const resolveParentId = (parentFolderPath) => (
        parentFolderPath ? groupIdByFolder.get(parentFolderPath) ?? null : null
      );

      // Seed geometry for EMPTY creations (their only geometry). Non-empty
      // creations derive bounds from members as always.
      const seedByGroupId = new Map();
      let topLevelSeeds = 0;
      const spawnOrigin = typeof getSpawnPosition === 'function'
        ? getSpawnPosition()
        : { x: 0, y: 0 };
      for (const entry of creations) {
        if (entry.pieceIds.length > 0) continue;
        let x = spawnOrigin.x + topLevelSeeds * 24;
        let y = spawnOrigin.y + topLevelSeeds * 24;
        const parentGroup = entry.parentFolderPath
          ? groupByFolder.get(entry.parentFolderPath) ?? null
          : null;
        const parentBounds = parentGroup && typeof getGroupBounds === 'function'
          ? getGroupBounds(parentGroup)
          : null;
        if (parentBounds) {
          x = parentBounds.minX + 16;
          y = parentBounds.maxY + 16;
        } else if (entry.parentFolderPath && seedByGroupId.has(groupIdByFolder.get(entry.parentFolderPath))) {
          const parentSeed = seedByGroupId.get(groupIdByFolder.get(entry.parentFolderPath));
          x = parentSeed.x + 24;
          y = parentSeed.y + parentSeed.height + 24;
        } else {
          topLevelSeeds += 1;
        }
        seedByGroupId.set(entry.groupId, { x, y, width: pieceWidth, height: COLLAPSED_STUB_HEIGHT });
      }

      groupDomain.commands.applyFsSyncPlan({
        upserts: creations.map((entry) => ({
          groupId: entry.groupId,
          name: entry.name,
          folderPath: entry.folderPath,
          pieceIds: entry.pieceIds,
          parentId: resolveParentId(entry.parentFolderPath),
          seedBounds: seedByGroupId.get(entry.groupId) ?? null,
        })),
        parentUpdates: parentUpdates.map(({ groupId, parentFolderPath }) => ({
          groupId,
          parentId: resolveParentId(parentFolderPath),
        })),
        groupDeletes: removeGroups,
      }, { withHistory: false });

      for (const entry of creations) {
        const seed = seedByGroupId.get(entry.groupId) ?? null;
        dbCreateGroup({
          id: entry.groupId,
          name: entry.name,
          folderPath: entry.folderPath,
          isCollapsed: false,
          parentId: resolveParentId(entry.parentFolderPath),
          color: null,
          seedX: seed?.x ?? null,
          seedY: seed?.y ?? null,
          seedW: seed?.width ?? null,
          seedH: seed?.height ?? null,
        }).then(() => {
          for (const pieceId of entry.pieceIds) {
            dbAddPieceToGroup(entry.groupId, pieceId).catch(() => {});
          }
        }).catch((e) => {
          console.warn('[groups] reconciliation group persistence failed:', e);
        });
      }
      for (const { groupId, parentFolderPath } of parentUpdates) {
        dbUpdateGroup(groupId, { parentId: resolveParentId(parentFolderPath) }).catch(() => {});
      }
      for (const groupId of removeGroups) {
        dbDeleteGroup(groupId).catch(() => {});
      }
    })();

    return () => { cancelled = true; };
  }, [scaffoldRefreshToken, loadToken, pieces, groups, groupDomain, normalizePath, getBasename, listTree, projectRootPath, getSpawnPosition, getGroupBounds, pieceWidth]);
}
