/**
 * groupDropHandlers — pure factories for the canvas group/piece drop
 * handlers (originally extracted from App.jsx in Session 2 of the
 * app-shell refactor).
 *
 * `createHandlePieceGroupDrop` resolves a piece dropped into/out of a group
 * (edit-mode additive/subtractive — the controller gates the mode).
 * `createHandleGroupStructureDrop` resolves a group pill dropped under the
 * same mode gating: additive → nest into the hovered group, subtractive →
 * un-nest from its parent. Both delegate disk work to groupStructureOps /
 * the FilesystemWriteManager.
 *
 * Each handler has its own factory so that the React hook layer can wrap
 * each in its own `useMemo` with a per-handler dependency array —
 * preserving ref-stability granularity.
 *
 * Purity: no React imports, no module-level side effects. All collaborators
 * (db writers, fs primitives, path utilities) are injected, which makes
 * the handlers trivially testable with mocks (see
 * test/domains/groupDropHandlers.test.mjs).
 */

export function createHandlePieceGroupDrop({
  piecesById,
  groups,
  projectInstance,
  fsManager,
  pillDomain,
  groupDomain,
  normalizePath,
  getBasename,
  dbRemovePieceFromGroup,
}) {
  // Folder-less groups can still EXIST transiently (rectification skipped
  // them — name clash / reserved name), and removing a piece from one must
  // keep its group_pieces rows honest or the piece returns on reopen.
  // ADDING to one is retired (W3, brief-group-physicality): a drop into a
  // group is a file move, and there is no folder to move into.
  const persistRemove = (group, pieceId) => {
    if (group && !group.folderPath) dbRemovePieceFromGroup?.(group.id, pieceId)?.catch?.(() => {});
  };
  return async function handlePieceGroupDrop({ pieceId, fromGroupId, toGroupId }) {
    const piece = piecesById.get(pieceId);
    if (!piece?.filename) return;
    const rootPath = projectInstance?.rootPath;

    if (toGroupId) {
      const targetGroup = groups.find((g) => g.id === toGroupId);
      if (!targetGroup?.folderPath) {
        pillDomain.commands.addPill({
          projectId: projectInstance?.instanceId,
          message: `"${targetGroup?.name ?? 'That group'}" has no folder yet — rename it so one can be created, then try again`,
          severity: 'error'
        });
        return;
      }
      if (rootPath) {
        const currentPath = normalizePath(piece.filename);
        const destPath = `${normalizePath(targetGroup.folderPath)}/${getBasename(currentPath)}`;
        if (currentPath !== destPath) {
          const result = await fsManager.moveFile(currentPath, destPath);
          if (!result.success) {
            pillDomain.commands.addPill({
              projectId: projectInstance?.instanceId,
              message: `Failed to move "${getBasename(currentPath)}" into "${targetGroup.name}"`,
              severity: 'error'
            });
          }
          return;
        }
      }
      // Same path — the file already lives in the folder; sync membership.
      groupDomain.commands.addPieceToGroup(toGroupId, pieceId);
      if (fromGroupId) {
        groupDomain.commands.removePieceFromGroup(fromGroupId, pieceId);
        persistRemove(groups.find((g) => g.id === fromGroupId), pieceId);
      }
    } else if (fromGroupId) {
      const sourceGroup = groups.find((g) => g.id === fromGroupId);
      if (sourceGroup?.folderPath && rootPath) {
        const currentPath = normalizePath(piece.filename);
        const destPath = getBasename(currentPath);
        if (currentPath !== destPath) {
          const result = await fsManager.moveFile(currentPath, destPath);
          if (!result.success) {
            pillDomain.commands.addPill({
              projectId: projectInstance?.instanceId,
              message: `Failed to move "${getBasename(currentPath)}" out of "${sourceGroup.name}"`,
              severity: 'error'
            });
          }
          return;
        }
      }
      groupDomain.commands.removePieceFromGroup(fromGroupId, pieceId);
      persistRemove(sourceGroup, pieceId);
    }
  };
}

export function createHandleGroupStructureDrop({
  groups,
  projectInstance,
  groupStructureOps,
}) {
  return async function handleGroupStructureDrop({ groupId, targetGroupId, intent }) {
    if (!projectInstance?.rootPath) return;
    const sourceGroup = groups.find((g) => g.id === groupId);
    if (!sourceGroup) return;

    if (intent === 'nest') {
      if (groupId === targetGroupId) return;
      const targetGroup = groups.find((g) => g.id === targetGroupId);
      if (!targetGroup) return;
      await groupStructureOps.nestGroup(sourceGroup, targetGroup);
    } else if (intent === 'unnest') {
      await groupStructureOps.unnestGroup(sourceGroup);
    }
  };
}
