import { useCallback, useMemo } from 'react';
import { dbCreateGroup, dbDeleteGroup, dbUpdateGroup, dbUpdatePiece } from '../project/dbStorage.js';
import { findReservedDeviceSegment } from '../utils/path.js';
import { findInnermostGroupAt, hasCollapsedAncestor } from './selectors/workspaceSelectors.js';

export function useGroupMenuActions({
  selectedCount,
  projectRootPath,
  selectedIds,
  pieceDomain,
  piecesById,
  pieces,
  groups,
  normalizePath,
  connectionDomain,
  groupDomain,
  deleteProjectPath,
  scaffoldFocusPath,
  setScaffoldFocus,
  projectDomain,
  bumpScaffoldRefresh,
  targetGroupId,
  selectionDomain,
  setIsGroupMenuOpen,
  setIsRenameGroupOpen,
  setSelectedGroupId,
  nextGroupId,
  setNextGroupId,
  getBasename,
  targetGroup,
  themeOptions,
  targetGroupThemeId,
  renameGroupValue,
  getDirname,
  toFolderSegment,
  getGroupBounds,
  setHiddenScaffoldPaths,
  setRenameGroupValue,
  fsManager,
  groupStructureOps,
  singleSelectedPiece,
  saveTab,
  tabsById,
  dirtyPieceIds,
  showToast
}) {
  const handleDeleteSelected = useCallback(async () => {
    if (selectedCount > 0) {
      // Collect paths before deletion (piecesById will be stale after manager runs)
      const pathsToDelete = [...selectedIds]
        .map((id) => normalizePath(piecesById.get(id)?.filename ?? ''))
        .filter(Boolean);

      if (fsManager && pathsToDelete.length) {
        // Filesystem-first via manager: deletes files, closes tabs, removes
        // connections, unregisters syntax, removes pieces, updates SQLite
        await fsManager.batch(
          pathsToDelete.map((path) => ({ op: 'deleteFile', path }))
        );

        if (scaffoldFocusPath && pathsToDelete.includes(normalizePath(scaffoldFocusPath))) {
          setScaffoldFocus(null);
        }
      }
    } else if (targetGroupId) {
      // W5 (DP4, brief-group-physicality): a folder-backed group's Delete is
      // a DISK operation — the state-only delete became a ghost op the D2
      // reconciler resurrects. Confirm first: something real gets deleted.
      if (targetGroup?.folderPath && fsManager) {
        const hasContent = (targetGroup.pieceIds?.length ?? 0) > 0;
        const confirmed = window.confirm(
          `Delete "${targetGroup.name}" and its folder from disk?` +
          (hasContent ? ' Everything inside it will be deleted.' : ' The folder is empty.')
        );
        if (!confirmed) return;
        try {
          await fsManager.deleteFolder(normalizePath(targetGroup.folderPath));
        } catch (e) {
          showToast?.(`Could not delete "${targetGroup.name}": ${e?.message ?? e}`, { severity: 'error' });
          return;
        }
        bumpScaffoldRefresh();
      }
      groupDomain.commands.deleteGroup(targetGroupId);
      dbDeleteGroup(targetGroupId).catch(() => {});
      setSelectedGroupId(null);
    } else {
      return;
    }
    selectionDomain.commands.clear();
    setIsGroupMenuOpen(false);
    setIsRenameGroupOpen(false);
  }, [
    fsManager,
    groupDomain,
    normalizePath,
    piecesById,
    scaffoldFocusPath,
    selectedCount,
    selectedIds,
    selectionDomain,
    setIsGroupMenuOpen,
    setIsRenameGroupOpen,
    setScaffoldFocus,
    setSelectedGroupId,
    targetGroupId
  ]);

  // Merge Into… candidates for the selected group (the merge SOURCE): other
  // folder-backed groups, excluding the source's own descendants — merging a
  // group into its own subtree would try to delete a folder that still
  // contains the target's folder.
  const mergeTargets = useMemo(() => {
    if (!targetGroup?.folderPath) return [];
    const isDescendantOfSource = (group) => {
      let checkId = group.parentId;
      while (checkId) {
        if (checkId === targetGroup.id) return true;
        checkId = groups.find((g) => g.id === checkId)?.parentId ?? null;
      }
      return false;
    };
    return groups.filter((group) =>
      group.id !== targetGroup.id &&
      group.folderPath &&
      !isDescendantOfSource(group)
    );
  }, [groups, targetGroup]);

  const handleMergeInto = useCallback(async (intoGroupId) => {
    if (!targetGroup || !groupStructureOps) return;
    const intoGroup = groups.find((g) => g.id === intoGroupId);
    if (!intoGroup) return;
    setIsGroupMenuOpen(false);
    await groupStructureOps.mergeGroups(targetGroup, intoGroup);
    // The source group no longer exists — drop its selection.
    setSelectedGroupId(null);
    selectionDomain.commands.clear();
  }, [groups, groupStructureOps, selectionDomain, setIsGroupMenuOpen, setSelectedGroupId, targetGroup]);

  const handleAssignGroupTheme = useCallback((themeId) => {
    if (!targetGroupId) return;
    const normalized = typeof themeId === 'string' && themeId.trim()
      ? themeId.trim()
      : null;
    if (normalized) {
      const knownThemeIds = new Set((themeOptions ?? []).map((theme) => theme.id));
      if (!knownThemeIds.has(normalized)) return;
    }
    groupDomain.commands.setTheme(targetGroupId, normalized);
  }, [groupDomain.commands, targetGroupId, themeOptions]);

  const handleClearGroupTheme = useCallback(() => {
    if (!targetGroupId || !targetGroupThemeId) return;
    groupDomain.commands.setTheme(targetGroupId, null);
  }, [groupDomain.commands, targetGroupId, targetGroupThemeId]);

  // ── Node (single piece) actions ──────────────────────────────────────────

  // Set a piece's display label and persist it (consumer-persists model — no
  // global autosave covers label). Empty/whitespace clears back to the filename.
  const handleSetPieceLabel = useCallback((pieceId, label) => {
    if (!pieceId) return;
    pieceDomain.commands.setPieceLabel({ id: pieceId, label });
    const nextLabel = typeof label === 'string' && label.trim() ? label.trim() : null;
    dbUpdatePiece(pieceId, { label: nextLabel }).catch(() => {});
  }, [pieceDomain]);

  // Rename a piece's underlying file. Reuses the FSM move pipeline (disk rename +
  // piece filename update + LSP + SQLite). Note: moveFile resets label to the new
  // basename, so callers that also set a custom label must apply the label AFTER.
  const handleRenamePieceFile = useCallback(async (pieceId, newName) => {
    const piece = piecesById.get(pieceId);
    const trimmed = typeof newName === 'string' ? newName.trim() : '';
    if (!piece?.filename || !fsManager || !trimmed) return;
    const currentPath = normalizePath(piece.filename);
    const lastSlash = currentPath.lastIndexOf('/');
    const parentDir = lastSlash >= 0 ? currentPath.substring(0, lastSlash) : '';
    const destPath = parentDir ? `${parentDir}/${trimmed}` : trimmed;
    if (destPath === currentPath) return;
    const result = await fsManager.moveFile(currentPath, destPath);
    if (!result.success) {
      // The manager refused (reserved name, locked file, …) — a silent
      // no-op here reads as a successful rename that mysteriously reverted.
      showToast?.(result.error ?? `Cannot rename "${getBasename(currentPath)}"`, { severity: 'error' });
      return;
    }
    bumpScaffoldRefresh();
  }, [bumpScaffoldRefresh, fsManager, getBasename, normalizePath, piecesById, showToast]);

  // A piece is "dirty" when it has an open editor tab whose workingCode differs
  // from its saved code — exactly what dirtyPieceIds tracks (and what the corner
  // LED shows). Find that tab so we can save it.
  const findTabForPiece = useCallback((pieceId) => {
    if (pieceId == null || !tabsById) return null;
    return Object.values(tabsById).find((tab) => tab?.pieceId === pieceId) ?? null;
  }, [tabsById]);

  // Save (clear dirty status): write the piece's working copy to disk via the
  // editor session's saveTab — persistSavedTab writes the file and syncs the
  // piece's code/workingCode, so dirtyPieceIds (and the LED) clear.
  const handleSavePiece = useCallback((pieceId) => {
    const tab = findTabForPiece(pieceId);
    if (tab) saveTab?.(tab.id);
    setIsGroupMenuOpen(false);
  }, [findTabForPiece, saveTab, setIsGroupMenuOpen]);

  // Save All ("true save"): save every dirty file in the target group.
  const handleSaveGroup = useCallback(() => {
    const pieceIds = Array.isArray(targetGroup?.pieceIds) ? targetGroup.pieceIds : [];
    pieceIds.forEach((pieceId) => {
      if (!dirtyPieceIds?.has?.(pieceId)) return;
      const tab = findTabForPiece(pieceId);
      if (tab) saveTab?.(tab.id);
    });
    setIsGroupMenuOpen(false);
  }, [dirtyPieceIds, findTabForPiece, saveTab, setIsGroupMenuOpen, targetGroup]);

  // Enablement for the Save / Save All menu items (mirrors the dirty LED).
  const isNodeDirty = Boolean(
    singleSelectedPiece && dirtyPieceIds?.has?.(singleSelectedPiece.id)
  );
  const isGroupDirty = Array.isArray(targetGroup?.pieceIds)
    && targetGroup.pieceIds.some((pieceId) => dirtyPieceIds?.has?.(pieceId));

  /* ── Disk-first New Group (brief-group-physicality W2) ──
     Called when the HUD's name-first preview commits. DP1: the box center
     decides parentage — an open expanded folder group under it nests the
     new folder; open canvas means project root. The folder is created on
     disk BEFORE the group exists in state (Rule 7: state follows disk).
     Returns false on refusal so the naming input stays open. */
  const handleCommitGroupCreate = useCallback(async (rawName, seedBounds) => {
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || !fsManager || !seedBounds) return false;

    const groupsById = new Map(groups.map((g) => [g.id, g]));
    const centerX = seedBounds.x + seedBounds.width / 2;
    const centerY = seedBounds.y + seedBounds.height / 2;
    const parent = findInnermostGroupAt(groups, centerX, centerY, getGroupBounds, (group) => (
      // Only OPEN expanded folder groups parent (DP1's "inside an open
      // expanded group"); collapsed pills and hidden subtrees don't.
      !group.folderPath || group.isCollapsed || hasCollapsedAncestor(group, groupsById)
    ));

    const segment = toFolderSegment(name);
    if (!segment) {
      showToast?.('That name has no folder-safe characters — try another', { severity: 'error' });
      return false;
    }
    const parentFolder = parent?.folderPath ? normalizePath(parent.folderPath) : '';
    const folderPath = parentFolder ? `${parentFolder}/${segment}` : segment;
    if (findReservedDeviceSegment(folderPath)) {
      showToast?.(`"${segment}" is a reserved name on Windows — try another`, { severity: 'error' });
      return false;
    }
    const taken = groups.some((g) => g.folderPath && normalizePath(g.folderPath) === folderPath)
      || pieces.some((p) => {
        const dir = getDirname(normalizePath(p?.filename ?? ''));
        return dir === folderPath || dir.startsWith(`${folderPath}/`);
      });
    if (taken) {
      showToast?.(`"${segment}" already exists here — pick another name`, { severity: 'error' });
      return false;
    }

    try {
      await fsManager.createDirectory(folderPath);
    } catch (e) {
      showToast?.(`Could not create "${segment}": ${e?.message ?? e}`, { severity: 'error' });
      return false;
    }

    const { groupId } = groupDomain.commands.allocateGroupId();
    groupDomain.commands.createFolderGroup({
      groupId,
      name,
      pieceIds: [],
      folderPath,
      isCollapsed: false,
      seedBounds,
    });
    dbCreateGroup({
      id: groupId,
      name,
      folderPath,
      isCollapsed: false,
      parentId: parent?.id ?? null,
      seedX: seedBounds.x,
      seedY: seedBounds.y,
      seedW: seedBounds.width,
      seedH: seedBounds.height,
    }).catch(() => {});
    // Reconciler pass derives parentId in state + keeps everything honest.
    bumpScaffoldRefresh();
    return true;
  }, [bumpScaffoldRefresh, fsManager, getDirname, getGroupBounds, groupDomain, groups, normalizePath, pieces, showToast, toFolderSegment]);

  /* Empty-group drag commit (seed translation): the interaction controller
     calls this at drag end when the dragged group has no subtree pieces —
     seedBounds is the group's only geometry, so the delta lands there
     (state + SQLite) or the gesture silently reverts on the next prop sync. */
  const handleTranslateGroupSeed = useCallback((groupId, dx, dy) => {
    if (!groupId || (!dx && !dy)) return;
    const group = groups.find((g) => g.id === groupId);
    if (!group?.seedBounds) return;
    groupDomain.commands.translateGroupSeed({ groupId, dx, dy });
    dbUpdateGroup(groupId, {
      seedX: group.seedBounds.x + dx,
      seedY: group.seedBounds.y + dy
    }).catch(() => {});
  }, [groupDomain, groups]);

  const handleCreateFolderGroup = useCallback(async () => {
    if (!selectedCount) return;
    const rootPath = projectRootPath ?? null;
    const groupIndex = nextGroupId;
    const name = `Group ${groupIndex}`;
    const folderPath = `Group-${groupIndex}`;
    const pieceIds = [...selectedIds];

    groupDomain.commands.createFolderGroup({
      groupId: `group-${groupIndex}`,
      name,
      pieceIds,
      folderPath
    });
    setSelectedGroupId(`group-${groupIndex}`);
    setNextGroupId((value) => value + 1);
    setIsRenameGroupOpen(false);

    if (rootPath) {
      // Move-or-materialize via the manager (never-written pieces get their
      // in-memory code written at the destination). The pipeline owns piece
      // filename/tab/SQLite sync; membership is skipped — createFolderGroup
      // above already claimed the pieces.
      for (const pieceId of pieceIds) {
        const piece = piecesById.get(pieceId);
        if (!piece?.filename) continue;
        const nextPath = `${folderPath}/${getBasename(piece.filename)}`;
        const currentPath = normalizePath(piece.filename);
        if (currentPath === nextPath) continue;
        await fsManager.moveOrWriteFile(currentPath, nextPath, piece.code ?? '', {
          skipGroupSync: true,
          skipScaffold: true,
        });
      }
      bumpScaffoldRefresh();
    }
    setIsGroupMenuOpen(false);
  }, [
    bumpScaffoldRefresh,
    fsManager,
    getBasename,
    groupDomain,
    nextGroupId,
    normalizePath,
    piecesById,
    projectRootPath,
    selectedCount,
    selectedIds,
    setIsGroupMenuOpen,
    setIsRenameGroupOpen,
    setNextGroupId,
    setSelectedGroupId
  ]);

  /* The user-facing promote flow ("Create Folder from Group") retired with
     the physicality ruling (W3) — nothing is born folder-less anymore, and
     the survivors rectify automatically on open (useGroupPhysicalityMigration,
     which still drives groupDomain.promoteToFolderGroup). */

  const handleToggleCollapseGroup = useCallback(() => {
    if (!targetGroupId) return;
    groupDomain.commands.toggleCollapse(targetGroupId);
    setIsGroupMenuOpen(false);
  }, [groupDomain, setIsGroupMenuOpen, targetGroupId]);

  const handleExpandGroup = useCallback(() => {
    if (!targetGroupId) return;
    groupDomain.commands.expand(targetGroupId);
    setIsGroupMenuOpen(false);
  }, [groupDomain, setIsGroupMenuOpen, targetGroupId]);

  const handleOpenRenameGroup = useCallback(() => {
    if (!targetGroupId) return;
    setRenameGroupValue(targetGroup?.name ?? '');
    setIsRenameGroupOpen(true);
  }, [setIsRenameGroupOpen, setRenameGroupValue, targetGroup?.name, targetGroupId]);

  const handleCancelRenameGroup = useCallback(() => {
    setIsRenameGroupOpen(false);
    setRenameGroupValue('');
  }, [setIsRenameGroupOpen, setRenameGroupValue]);

  const handleConfirmRenameGroup = useCallback(async () => {
    if (!targetGroupId || !targetGroup) return;
    const nextName = renameGroupValue.trim();
    if (!nextName) return;
    const oldFolderPath = normalizePath(targetGroup.folderPath ?? '');
    const parentFolderPath = getDirname(oldFolderPath);
    const nextFolderName = toFolderSegment(nextName);
    const nextFolderPath = oldFolderPath
      ? (parentFolderPath ? `${parentFolderPath}/${nextFolderName}` : nextFolderName)
      : null;

    // Refuse reserved device names BEFORE the state rename below: the
    // manager would reject the folder move anyway, but by then state would
    // already point at a folder that never gets created (state/disk drift).
    if (nextFolderPath && findReservedDeviceSegment(nextFolderName)) {
      showToast?.(`"${nextFolderName}" is a reserved name on Windows — pick another group name`, { severity: 'error' });
      return;
    }

    groupDomain.commands.rename(targetGroupId, {
      name: nextName,
      ...(nextFolderPath ? { folderPath: nextFolderPath } : {})
    });

    const shouldMoveFiles = Boolean(
      oldFolderPath && nextFolderPath && nextFolderPath !== oldFolderPath
    );
    if (shouldMoveFiles) {
      const rootPath = projectRootPath ?? null;
      if (rootPath) {
        // Primary path: one folder move — the pipeline owns piece
        // filename/tab/SQLite/syntax sync and the folderPath fixup.
        const folderMove = await fsManager.moveFolder(oldFolderPath, nextFolderPath);
        if (!folderMove.success) {
          // Folder absent on disk (never-written pieces) — materialize each
          // member at its renamed location. Membership skipped: the group
          // was renamed in state above; pieces aren't changing groups.
          const pieceIds = Array.isArray(targetGroup.pieceIds) ? targetGroup.pieceIds : [];
          for (const pieceId of pieceIds) {
            const piece = piecesById.get(pieceId);
            if (!piece?.filename) continue;
            const currentPath = normalizePath(piece.filename);
            if (!currentPath) continue;
            const nextPath = currentPath === oldFolderPath
              ? nextFolderPath
              : currentPath.startsWith(`${oldFolderPath}/`)
                ? `${nextFolderPath}${currentPath.slice(oldFolderPath.length)}`
                : `${nextFolderPath}/${getBasename(currentPath)}`;
            if (currentPath === nextPath) continue;
            await fsManager.moveOrWriteFile(currentPath, nextPath, piece.code ?? '', {
              skipGroupSync: true,
              skipScaffold: true,
            });
          }
          bumpScaffoldRefresh();
        }
        setHiddenScaffoldPaths((prev) => prev.map((path) => (
          path === oldFolderPath
            ? nextFolderPath
            : path.startsWith(`${oldFolderPath}/`)
              ? `${nextFolderPath}${path.slice(oldFolderPath.length)}`
              : path
        )));
      }
    }
    // Persist group rename + folderPath change to SQLite
    dbUpdateGroup(targetGroupId, {
      name: nextName,
      ...(nextFolderPath ? { folderPath: nextFolderPath } : {})
    }).catch(() => {});
    setIsRenameGroupOpen(false);
    setRenameGroupValue('');
  }, [
    bumpScaffoldRefresh,
    getBasename,
    getDirname,
    groupDomain,
    fsManager,
    normalizePath,
    piecesById,
    projectRootPath,
    renameGroupValue,
    setHiddenScaffoldPaths,
    setIsRenameGroupOpen,
    setRenameGroupValue,
    showToast,
    targetGroup,
    targetGroupId,
    toFolderSegment
  ]);

  return {
    handleDeleteSelected,
    handleCreateFolderGroup,
    handleCommitGroupCreate,
    handleTranslateGroupSeed,
    mergeTargets,
    handleMergeInto,
    handleToggleCollapseGroup,
    handleExpandGroup,
    handleOpenRenameGroup,
    handleCancelRenameGroup,
    handleConfirmRenameGroup,
    handleAssignGroupTheme,
    handleClearGroupTheme,
    handleSetPieceLabel,
    handleRenamePieceFile,
    handleSavePiece,
    handleSaveGroup,
    isNodeDirty,
    isGroupDirty
  };
}
