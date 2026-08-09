/**
 * groupStructureOps — group-level structural operations (nest, merge) built
 * on the FilesystemWriteManager.
 *
 * These are the disk-touching group ops: nesting moves the source group's
 * folder inside the target's, merging moves every source piece file into the
 * target folder and deletes the emptied source folder. All filesystem work
 * routes through fsManager (Orchestration.md §2.2 — no independent fs
 * mutation), which owns the post-op sync: piece filenames, tabs, group
 * membership, syntax-domain unregistration, SQLite piece rows, scaffold
 * refresh. What remains here is the group-semantic half: parentId /
 * mergeIntoGroup state commands and their group-row persistence.
 *
 * Pure factory, no React, all collaborators injected (same testability
 * contract as groupDropHandlers).
 */

export function createGroupStructureOps({
  piecesById,
  fsManager,
  groupDomain,
  pillDomain,
  projectInstance,
  normalizePath,
  getBasename,
  dbUpdateGroup,
  dbDeleteGroup,
  dbAddPieceToGroup,
}) {
  const notifyError = (message) => {
    pillDomain?.commands?.addPill({
      projectId: projectInstance?.instanceId,
      message,
      severity: 'error',
    });
  };

  /**
   * Nest sourceGroup inside targetGroup: the source folder moves into the
   * target folder and the source group becomes a child of the target.
   * Both groups must be folder-backed.
   */
  async function nestGroup(sourceGroup, targetGroup) {
    if (!sourceGroup?.folderPath || !targetGroup?.folderPath) {
      return { success: false, error: 'Both groups must be folder-backed', code: 'group.not_folder_backed' };
    }
    const sourcePath = normalizePath(sourceGroup.folderPath);
    const destPath = `${normalizePath(targetGroup.folderPath)}/${getBasename(sourcePath)}`;
    if (destPath === sourcePath) {
      // Already nested in this target (e.g. a child pill dropped inside its
      // own parent under innermost-wins hit testing) — no folder move; just
      // make sure the parent link holds.
      groupDomain.commands.setParentGroup(sourceGroup.id, targetGroup.id);
      dbUpdateGroup(sourceGroup.id, { parentId: targetGroup.id }).catch(() => {});
      return { success: true };
    }

    const result = await fsManager.moveFolder(sourcePath, destPath);
    if (!result.success) {
      notifyError(`Failed to move "${getBasename(sourcePath)}" into "${getBasename(targetGroup.folderPath)}"`);
      return result;
    }

    // The move pipeline already updated the source group's folderPath (state
    // + SQLite) and re-synced membership; only the parent link is ours.
    groupDomain.commands.setParentGroup(sourceGroup.id, targetGroup.id);
    dbUpdateGroup(sourceGroup.id, { parentId: targetGroup.id }).catch(() => {});
    return { success: true };
  }

  /**
   * Un-nest sourceGroup from its parent: the group's folder moves to the
   * project root (mirroring node-extract, which moves the file to root) and
   * the parent link is cleared. A folder-less (manual) child unlinks
   * state-only. No-op when the group has no parent.
   */
  async function unnestGroup(sourceGroup) {
    if (!sourceGroup?.parentId) {
      return { success: false, error: 'Group has no parent', code: 'group.not_nested' };
    }
    if (sourceGroup.folderPath) {
      const sourcePath = normalizePath(sourceGroup.folderPath);
      const destPath = getBasename(sourcePath);
      if (destPath !== sourcePath) {
        const result = await fsManager.moveFolder(sourcePath, destPath);
        if (!result.success) {
          notifyError(`Failed to move "${getBasename(sourcePath)}" out of its parent folder`);
          return result;
        }
      }
    }
    groupDomain.commands.setParentGroup(sourceGroup.id, null);
    dbUpdateGroup(sourceGroup.id, { parentId: null }).catch(() => {});
    return { success: true };
  }

  /**
   * Merge sourceGroup into targetGroup: every source piece file moves into
   * the target folder, the emptied source folder is deleted, the source
   * group's members (and child groups) transfer to the target, and the
   * source group is deleted. Both groups must be folder-backed.
   *
   * Partial failures do not abort the batch (FSM batch semantics); pieces
   * whose file move failed keep their old path on disk and get no target
   * membership row, and a pill reports the count.
   */
  async function mergeGroups(sourceGroup, targetGroup) {
    if (!sourceGroup?.folderPath || !targetGroup?.folderPath) {
      return { success: false, error: 'Both groups must be folder-backed', code: 'group.not_folder_backed' };
    }
    const targetPath = normalizePath(targetGroup.folderPath);
    const sourcePath = normalizePath(sourceGroup.folderPath);

    const operations = [];
    const opPieceIds = [];
    const samePathPieceIds = [];
    for (const pieceId of sourceGroup.pieceIds) {
      const piece = piecesById.get(pieceId);
      if (!piece?.filename) continue;
      const currentPath = normalizePath(piece.filename);
      const nextPath = `${targetPath}/${getBasename(currentPath)}`;
      if (currentPath === nextPath) {
        samePathPieceIds.push(pieceId);
        continue;
      }
      operations.push({ op: 'moveFile', from: currentPath, to: nextPath });
      opPieceIds.push(pieceId);
    }
    operations.push({ op: 'deleteEmptyFolder', path: sourcePath });

    const { results, failureCount } = await fsManager.batch(operations);

    const movedPieceIds = opPieceIds.filter((_, index) => results[index]?.success);

    groupDomain.commands.mergeIntoGroup(sourceGroup.id, targetGroup.id);
    for (const pieceId of [...movedPieceIds, ...samePathPieceIds]) {
      dbAddPieceToGroup(targetGroup.id, pieceId).catch(() => {});
    }
    dbDeleteGroup(sourceGroup.id).catch(() => {});

    if (failureCount > 0) {
      notifyError(`Merge into "${targetGroup.name}": ${failureCount} file operation(s) failed`);
    }
    return { success: failureCount === 0, failureCount };
  }

  return { nestGroup, unnestGroup, mergeGroups };
}
