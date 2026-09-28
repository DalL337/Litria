import { useEffect, useRef } from 'react';
import { reconcileGroupsWithFolders } from './reconcileGroupsWithFolders.js';
import { COLLAPSED_STUB_HEIGHT, GROUP_OUTLINE_PAD, GROUP_NEST_PAD } from './selectors/workspaceSelectors.js';
import { GROUP_TAB_HEIGHT, layoutEmptyGroupSeeds } from './emptyGroupSeeds.js';
import { pieceRect } from '../utils/spatialGeometry2d.js';
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
 * arrive), laid out by layoutEmptyGroupSeeds: each empty subtree is a
 * column; under a parent that already has a box it sits just below the
 * parent's content (the parent's descendant-union box absorbs it); any
 * other column takes a free major intersection near the spawn position.
 *
 * Triggers (owner live-verify D, 2026-07-18 — the old version skipped its
 * initial run and only fired on scaffold refreshes, so a project whose
 * groups weren't in the DB launched with NO groups drawn until some
 * scaffold operation happened to bump the token):
 *  1. Once per PROJECT LOAD, after pieces hydrate (loadToken + non-empty
 *     pieces — same per-load pattern discovery uses). The token and root
 *     must come from the hydrated load, so they change in the same render
 *     as the pieces and groups they describe. A launch pass cancelled
 *     before it applied (pieces or groups changed while the tree loaded) is
 *     released and rerun on the newer state, not dropped for the load.
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
 * @param {any}      params.loadToken       - Per-open identity of the HYDRATED load
 * @param {function} params.normalizePath   - Path normalizer
 * @param {function} params.getBasename     - Basename extractor
 * @param {function} [params.listTree]      - async (rootPath) => tree entries
 * @param {string}   [params.projectRootPath]
 * @param {function} [params.getSpawnPosition] - () => {x, y} for top-level seeds
 * @param {function} [params.getGroupBounds]   - (group) => bounds|null
 * @param {number}   [params.pieceWidth]
 * @param {number}   [params.pieceHeight]
 * @param {function} [params.getGridPlacement] - () => { steps } | null
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
  pieceHeight = 110,
  getGridPlacement = null,
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
    let applied = false;
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
      applied = true;

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
      const boundsOf = (group) => (typeof getGroupBounds === 'function' ? getGroupBounds(group) : null);
      const creationByFolder = new Map(creations.map((entry) => [entry.folderPath, entry]));
      const anchorBoundsFor = (folder) => {
        const existing = groupByFolder.get(folder);
        if (existing) return boundsOf(existing);
        const created = creationByFolder.get(folder);
        return created?.pieceIds.length
          ? boundsOf({ id: created.groupId, pieceIds: created.pieceIds, parentId: null, isCollapsed: false, seedBounds: null })
          : null;
      };
      // Keep clear of every node and every drawn group box (tab included).
      const obstacles = [];
      for (const piece of pieces) {
        if (Number.isFinite(piece?.x) && Number.isFinite(piece?.y)) obstacles.push(pieceRect(piece, pieceWidth, pieceHeight));
      }
      for (const group of groups) {
        if (removedIds.has(group.id)) continue;
        const b = boundsOf(group);
        if (!b) continue;
        const pad = group.parentId ? GROUP_OUTLINE_PAD + GROUP_NEST_PAD : GROUP_OUTLINE_PAD;
        obstacles.push({
          x: b.minX - pad,
          y: b.minY - pad - GROUP_TAB_HEIGHT,
          width: b.maxX - b.minX + 2 * pad,
          height: b.maxY - b.minY + 2 * pad + GROUP_TAB_HEIGHT,
        });
      }
      const seedByGroupId = layoutEmptyGroupSeeds({
        creations,
        anchorBoundsFor,
        origin: typeof getSpawnPosition === 'function' ? getSpawnPosition() : { x: 0, y: 0 },
        obstacles,
        steps: typeof getGridPlacement === 'function' ? getGridPlacement()?.steps ?? null : null,
        seedWidth: pieceWidth,
        seedHeight: COLLAPSED_STUB_HEIGHT,
      });

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

    return () => {
      cancelled = true;
      if (launchDue && !applied && ranForTokenRef.current === loadToken) {
        ranForTokenRef.current = null;
      }
    };
  }, [scaffoldRefreshToken, loadToken, pieces, groups, groupDomain, normalizePath, getBasename, listTree, projectRootPath, getSpawnPosition, getGroupBounds, pieceWidth, pieceHeight, getGridPlacement]);
}
