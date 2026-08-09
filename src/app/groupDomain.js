import { replaceGroupsAction } from '../history/actions.js';
import { executeInteractionHistoryAction } from './interactionHelpers.js';

const areGroupsEqual = (left, right) => JSON.stringify(left) === JSON.stringify(right);

// D1 (brief-group-physicality, owner-ruled): NO group is culled for being
// empty. A folder-backed group lives exactly as long as its folder does —
// however it got empty — and dies only by explicit deleteGroup or the
// reconciler's folder-gone removal. Manual (folder-less) groups were always
// cull-exempt. The filter sites below are kept as the documented seam where
// emptiness-culling used to live (and would be re-scoped if a cull ever
// returns).
const keepGroup = () => true;

const normalizeSeedBounds = (seedBounds) => {
  if (!seedBounds) return null;
  const { x, y, width, height } = seedBounds;
  if (![x, y, width, height].every(Number.isFinite)) return null;
  return { x, y, width, height };
};

export function createGroupDomain({ setGroups, history, getGroups, getNextGroupId, setNextGroupId }) {
  const applyGroupsUpdate = ({ label, update, withHistory = true }) => {
    if (typeof update !== 'function') return false;
    const before = typeof getGroups === 'function' ? getGroups() : null;
    if (!Array.isArray(before)) {
      setGroups((prev) => update(prev));
      return true;
    }
    const after = update(before);
    if (!Array.isArray(after) || areGroupsEqual(before, after)) return false;
    if (withHistory && history) {
      executeInteractionHistoryAction(history, {
        label,
        action: replaceGroupsAction({
          beforeGroups: before,
          afterGroups: after,
          setGroups,
          label
        })
      });
      return true;
    }
    setGroups(after);
    return true;
  };

  return {
    commands: {
      // Mint the next `group-<n>` id and advance the counter. The counter cell
      // lives with the app's persistence state (hydrated per project); the
      // allocation semantics live here. Not undoable — id allocation is
      // bookkeeping, not a user action.
      allocateGroupId() {
        const idx = getNextGroupId();
        setNextGroupId((prev) => prev + 1);
        return { groupId: `group-${idx}`, groupIndex: idx };
      },
      // pieceIds may be empty (D2: empty folders are first-class — the group
      // then positions by seedBounds until members provide geometry).
      createFolderGroup({ groupId, name, pieceIds, folderPath, isCollapsed = false, color = null, seedBounds = null }) {
        if (!groupId || !Array.isArray(pieceIds)) return;
        applyGroupsUpdate({
          label: 'Create folder group',
          withHistory: false,
          update: (prev) => {
          const withoutPieces = prev
            .map((group) => ({
              ...group,
              pieceIds: group.pieceIds.filter((id) => !pieceIds.includes(id))
            }))
            .filter(keepGroup);
          return [
            ...withoutPieces,
            {
              id: groupId,
              name,
              pieceIds,
              isCollapsed: Boolean(isCollapsed),
              folderPath,
              themeId: null,
              color: color ?? null,
              seedBounds: normalizeSeedBounds(seedBounds),
              gridTier: 0
            }
          ];
        }
        });
      },
      removePieces(pieceIds) {
        if (!Array.isArray(pieceIds) || pieceIds.length === 0) return;
        applyGroupsUpdate({
          label: 'Remove pieces from groups',
          withHistory: false,
          update: (prev) => prev
            .map((group) => ({
              ...group,
              pieceIds: group.pieceIds.filter((pieceId) => !pieceIds.includes(pieceId))
            }))
            .filter(keepGroup)
        });
      },
      /* createManualGroup retired (W3, brief-group-physicality): nothing is
         born folder-less anymore — canvas creation is disk-first
         (handleCommitGroupCreate) and legacy ghosts rectify on open
         (useGroupPhysicalityMigration → promoteToFolderGroup below). */
      /** Promote a manual group to folder-backed (plan-only staircase step 1).
       *  Sets folderPath and claims the members exclusively — a piece's file is
       *  about to move into the folder, so folder derivation would strip it
       *  from any other group anyway; doing it here keeps memory consistent
       *  before the reconciler runs. seedBounds is dropped: folder groups
       *  derive geometry from members (and a memberless folder group gets
       *  garbage-collected by the reconciler regardless). */
      // Empty groups promote too (W4, brief-group-physicality): since D1 the
      // reconciler no longer GCs empty folder groups, so the old ≥1-member
      // gate is obsolete. An empty promotion keeps its seedBounds — the only
      // geometry until members arrive; member-holding promotions drop it
      // (members provide geometry).
      promoteToFolderGroup({ groupId, folderPath }) {
        const nextFolderPath = typeof folderPath === 'string' ? folderPath.trim() : '';
        if (!groupId || !nextFolderPath) return;
        applyGroupsUpdate({
          label: 'Create folder from group',
          withHistory: false,
          update: (prev) => {
            const target = prev.find((group) => group.id === groupId);
            if (!target || target.folderPath) return prev;
            const memberIds = new Set(target.pieceIds);
            return prev
              .map((group) => (
                group.id === groupId
                  ? {
                    ...group,
                    folderPath: nextFolderPath,
                    seedBounds: target.pieceIds.length > 0 ? null : group.seedBounds ?? null
                  }
                  : { ...group, pieceIds: group.pieceIds.filter((id) => !memberIds.has(id)) }
              ))
              .filter(keepGroup);
          }
        });
      },
      /** Move a seed-positioned group by a drag delta. Pieces move through
       *  movePiecesAction; a group with no subtree pieces has only its
       *  seedBounds to move — without this, the Konva node follows the
       *  pointer but state never commits, and everything state-anchored (the
       *  action pill, reopen position) stays at the seed (owner live repro
       *  2026-08-01: newfolder's action pill "not moving with it").
       *  History participates: one gesture, one undo. */
      translateGroupSeed({ groupId, dx, dy }) {
        if (!groupId || !Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return;
        applyGroupsUpdate({
          label: 'Move group',
          update: (prev) => prev.map((group) => (
            group.id === groupId && group.seedBounds
              ? {
                ...group,
                seedBounds: {
                  ...group.seedBounds,
                  x: group.seedBounds.x + dx,
                  y: group.seedBounds.y + dy
                }
              }
              : group
          ))
        });
      },
      addPieceToGroup(groupId, pieceId) {
        if (!groupId || pieceId == null) return;
        applyGroupsUpdate({
          label: 'Add piece to group',
          update: (prev) => prev.map((group) => {
            if (group.id !== groupId) return group;
            if (group.pieceIds.includes(pieceId)) return group;
            return { ...group, pieceIds: [...group.pieceIds, pieceId] };
          })
        });
      },
      removePieceFromGroup(groupId, pieceId) {
        if (!groupId || pieceId == null) return;
        applyGroupsUpdate({
          label: 'Remove piece from group',
          update: (prev) => prev
            .map((group) => {
              if (group.id !== groupId) return group;
              return { ...group, pieceIds: group.pieceIds.filter((id) => id !== pieceId) };
            })
            .filter(keepGroup)
        });
      },
      /**
       * Apply the filesystem write manager's post-move group sync as ONE
       * state update. Per-item commands issued in the same tick each rebuild
       * from the same stale base and clobber one another (groupsRef syncs in
       * an effect, not during render) — a whole-plan command is the only
       * tick-safe shape.
       *
       * Order inside the update: folderPath updates → removals → additions →
       * upserts → empty-group culling, so upserts can refill a group before
       * the cull and additions target post-rename folder state.
       *
       * upserts create a folder group when the id is absent and union the
       * pieceIds into it when present — replaying a plan against a base that
       * already contains the group (pending-map reuse across pipeline calls)
       * stays correct instead of minting a duplicate.
       *
       * parentUpdates set/clear parent links (folder-containment derivation);
       * groupDeletes remove groups outright (reconciler GC). Background
       * healing passes opt withHistory:false so reconciliation never lands
       * in the undo stack.
       */
      applyFsSyncPlan(
        { folderPathUpdates = [], parentUpdates = [], removals = [], additions = [], upserts = [], groupDeletes = [] } = {},
        { withHistory = true } = {}
      ) {
        if (!folderPathUpdates.length && !parentUpdates.length && !removals.length
          && !additions.length && !upserts.length && !groupDeletes.length) return;
        applyGroupsUpdate({
          label: 'Sync groups with filesystem move',
          withHistory,
          update: (prev) => {
            let next = prev;
            if (folderPathUpdates.length) {
              const pathsByGroup = new Map(folderPathUpdates.map(({ groupId, folderPath }) => [groupId, folderPath]));
              next = next.map((group) => {
                const folderPath = pathsByGroup.get(group.id);
                return folderPath ? { ...group, folderPath } : group;
              });
            }
            if (parentUpdates.length) {
              const parentsByGroup = new Map(parentUpdates.map(({ groupId, parentId }) => [groupId, parentId ?? null]));
              next = next.map((group) => (
                parentsByGroup.has(group.id)
                  ? { ...group, parentId: parentsByGroup.get(group.id) }
                  : group
              ));
            }
            if (removals.length) {
              const dropsByGroup = new Map();
              for (const { groupId, pieceId } of removals) {
                if (!dropsByGroup.has(groupId)) dropsByGroup.set(groupId, new Set());
                dropsByGroup.get(groupId).add(pieceId);
              }
              next = next.map((group) => {
                const drop = dropsByGroup.get(group.id);
                if (!drop) return group;
                return { ...group, pieceIds: group.pieceIds.filter((id) => !drop.has(id)) };
              });
            }
            if (additions.length) {
              const addsByGroup = new Map();
              for (const { groupId, pieceId } of additions) {
                if (!addsByGroup.has(groupId)) addsByGroup.set(groupId, []);
                addsByGroup.get(groupId).push(pieceId);
              }
              next = next.map((group) => {
                const add = addsByGroup.get(group.id);
                if (!add) return group;
                const merged = [...new Set([...group.pieceIds, ...add])];
                return merged.length === group.pieceIds.length ? group : { ...group, pieceIds: merged };
              });
            }
            for (const { groupId, name, folderPath, pieceIds, parentId, seedBounds } of upserts) {
              // Empty pieceIds is legal (D2: empty folders materialize as
              // groups, positioned by seedBounds).
              if (!groupId || !folderPath || !Array.isArray(pieceIds)) continue;
              const existing = next.find((group) => group.id === groupId);
              if (existing) {
                next = next.map((group) => (
                  group.id === groupId
                    ? { ...group, pieceIds: [...new Set([...group.pieceIds, ...pieceIds])] }
                    : group
                ));
              } else {
                next = [...next, {
                  id: groupId,
                  name,
                  pieceIds: [...pieceIds],
                  isCollapsed: false,
                  folderPath,
                  parentId: parentId ?? null,
                  themeId: null,
                  color: null,
                  seedBounds: normalizeSeedBounds(seedBounds),
                  gridTier: 0
                }];
              }
            }
            if (groupDeletes.length) {
              const doomed = new Set(groupDeletes);
              next = next
                .filter((group) => !doomed.has(group.id))
                // Mirror deleteGroup's FK semantics (ON DELETE SET NULL):
                // children of a deleted parent become top-level.
                .map((group) => (
                  group.parentId && doomed.has(group.parentId)
                    ? { ...group, parentId: null }
                    : group
                ));
            }
            return next.filter(keepGroup);
          }
        });
      },
      replaceAll(groups) {
        if (!Array.isArray(groups)) return;
        setGroups(groups);
      },
      deleteGroup(groupId) {
        if (!groupId) return;
        applyGroupsUpdate({
          label: 'Delete group',
          update: (prev) => prev.filter((group) => group.id !== groupId)
        });
      },
      toggleCollapse(groupId) {
        if (!groupId) return;
        applyGroupsUpdate({
          label: 'Toggle group collapse',
          update: (prev) => prev.map((group) => (
            group.id === groupId ? { ...group, isCollapsed: !group.isCollapsed } : group
          ))
        });
      },
      setGridTier(groupId, tier) {
        if (!groupId || typeof tier !== 'number') return;
        applyGroupsUpdate({
          label: 'Set grid tier',
          update: (prev) => prev.map((group) => (
            group.id === groupId ? { ...group, gridTier: tier } : group
          ))
        });
      },
      expand(groupId) {
        if (!groupId) return;
        applyGroupsUpdate({
          label: 'Expand group',
          update: (prev) => prev.map((group) => (
            group.id === groupId ? { ...group, isCollapsed: false } : group
          ))
        });
      },
      rename(groupId, input) {
        const nextName = typeof input === 'string'
          ? input.trim()
          : (typeof input?.name === 'string' ? input.name.trim() : '');
        const nextFolderPath = typeof input === 'object' && typeof input?.folderPath === 'string'
          ? input.folderPath.trim()
          : null;
        if (!groupId || !nextName) return;
        applyGroupsUpdate({
          label: 'Rename group',
          update: (prev) => prev.map((group) => (
            group.id === groupId
              ? {
                ...group,
                name: nextName,
                ...(nextFolderPath ? { folderPath: nextFolderPath } : {})
              }
              : group
          ))
        });
      },
      setTheme(groupId, themeId) {
        if (!groupId) return;
        const normalizedThemeId = typeof themeId === 'string' && themeId.trim()
          ? themeId.trim()
          : null;
        applyGroupsUpdate({
          label: 'Set group theme',
          update: (prev) => prev.map((group) => (
            group.id === groupId
              ? { ...group, themeId: normalizedThemeId }
              : group
          ))
        });
      },
      setGroupColor(groupId, color) {
        if (!groupId) return;
        const normalizedColor = typeof color === 'string' && color.trim()
          ? color.trim()
          : null;
        applyGroupsUpdate({
          label: 'Set group color',
          update: (prev) => prev.map((group) => (
            group.id === groupId
              ? { ...group, color: normalizedColor }
              : group
          ))
        });
      },
      setParentGroup(groupId, parentId) {
        if (!groupId) return;
        applyGroupsUpdate({
          label: 'Set group parent',
          update: (prev) => prev.map((group) => (
            group.id === groupId
              ? { ...group, parentId: parentId ?? null }
              : group
          ))
        });
      },
      setFolderPath(groupId, folderPath) {
        if (!groupId || typeof folderPath !== 'string') return;
        applyGroupsUpdate({
          label: 'Set group folder path',
          update: (prev) => prev.map((group) => (
            group.id === groupId
              ? { ...group, folderPath: folderPath.trim() || null }
              : group
          ))
        });
      },
      mergeIntoGroup(fromGroupId, intoGroupId) {
        if (!fromGroupId || !intoGroupId || fromGroupId === intoGroupId) return;
        applyGroupsUpdate({
          label: 'Merge folder groups',
          update: (prev) => {
            const source = prev.find((g) => g.id === fromGroupId);
            const target = prev.find((g) => g.id === intoGroupId);
            if (!source || !target) return prev;
            const mergedIds = [...new Set([...target.pieceIds, ...source.pieceIds])];
            return prev
              .filter((g) => g.id !== fromGroupId)
              .map((g) => {
                if (g.id === intoGroupId) return { ...g, pieceIds: mergedIds };
                if (g.parentId === fromGroupId) return { ...g, parentId: intoGroupId };
                return g;
              });
          }
        });
      }
    },
    selectors: {
      getGroupById(groups, groupId) {
        if (!Array.isArray(groups) || !groupId) return null;
        return groups.find((group) => group.id === groupId) ?? null;
      }
    }
  };
}
