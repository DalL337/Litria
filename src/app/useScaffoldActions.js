import { useCallback } from 'react';
import {
  dbCreatePiece,
  dbCreatePiecesBatch,
  dbCreateGroup,
  dbAddPieceToGroup,
  dbAddHiddenPath,
  dbRemoveHiddenPath
} from '../project/dbStorage.js';
import { computeSpawnGridPositions } from '../utils/gridLayout.js';

let folderSpawnCounter = 0;

export function useScaffoldActions({
  projectRootPath,
  defaultFolderGroupColor = null,
  normalizePath,
  piecesByFilename,
  readProjectFile,
  getBasename,
  addPiece,
  openForPiece,
  selectionDomain,
  setScaffoldFocus,
  setSelectedGroupId,
  hiddenScaffoldPaths,
  setHiddenScaffoldPaths,
  selectedCount,
  selectedIds,
  piecesById,
  openFromSelection,
  scaffoldFocusPath,
  setScaffoldRefreshToken,
  setIsGroupMenuOpen,
  setIsRenameGroupOpen,
  groupDomain,
  pieceDomain,
  listTree,
  getSpawnPosition,
  groups = [],
  pieceWidth = 160
}) {
  const createPieceFromFile = useCallback(async (relativePath) => {
    if (!projectRootPath) return null;
    const normalized = normalizePath(relativePath);
    const existing = piecesByFilename.get(normalized);
    if (existing) return existing;
    const diskCode = await readProjectFile(projectRootPath, normalized);
    const code = typeof diskCode === 'string' ? diskCode : '';
    const label = getBasename(normalized);
    // Create the SQLite row first to get the authoritative piece id, mirroring
    // usePieceUiActions.handleCreatePiece. A client-only id (the old behavior)
    // collides with the next AUTOINCREMENT value SQLite hands out — in a
    // fresh/low project both land on id 1, producing two canvas pieces with the
    // same id (duplicate-React-key flood + Map-collapsed "orphan" rendering).
    let dbId = null;
    try {
      dbId = await dbCreatePiece({ filePath: normalized, label, x: 0, y: 0, color: null });
    } catch (e) {
      console.warn('[scaffold] dbCreatePiece failed:', e);
    }
    if (dbId == null) return null; // never fabricate a colliding client id
    return addPiece({
      id: dbId,
      filename: normalized,
      label,
      code,
      workingCode: code
    });
  }, [addPiece, getBasename, normalizePath, piecesByFilename, projectRootPath, readProjectFile]);

  const handleScaffoldOpenFolder = useCallback(async (folderPath) => {
    if (!projectRootPath || !folderPath || !listTree) return;

    // Get all entries under this project to find files in the target folder.
    const allEntries = await listTree(projectRootPath);
    if (!Array.isArray(allEntries)) return;

    const normalizedFolder = normalizePath(folderPath);

    // Collect all files recursively under this folder.
    const filesInFolder = allEntries.filter((entry) => {
      if (entry.entryType !== 'file') return false;
      const normalized = normalizePath(entry.path);
      return normalized.startsWith(normalizedFolder + '/');
    });

    // The folder may already have a group — since D2 parity the reconciler
    // materializes EVERY folder, so this is the common case, and creating a
    // second group for the same folderPath would be a duplicate.
    const existingGroup = groups.find(
      (g) => g.folderPath && normalizePath(g.folderPath) === normalizedFolder
    );

    if (filesInFolder.length === 0) {
      // Empty folder (D2: first-class citizen). If its group already exists
      // the reconciler owns it — nothing to spawn. Otherwise (e.g. a folder
      // created outside the app with no scaffold refresh yet) create the
      // group here, collapsed, seeded at the drop/spawn position.
      if (existingGroup) return;
      const emptySpawn = typeof getSpawnPosition === 'function'
        ? getSpawnPosition()
        : { x: 0, y: 0 };
      const folderName = normalizedFolder.split('/').pop() || normalizedFolder;
      folderSpawnCounter += 1;
      const groupId = `scaffold-folder-${Date.now()}-${folderSpawnCounter}`;
      const seedBounds = { x: emptySpawn.x, y: emptySpawn.y, width: pieceWidth, height: 80 };
      groupDomain.commands.createFolderGroup({
        groupId,
        name: folderName,
        pieceIds: [],
        folderPath: normalizedFolder,
        isCollapsed: true,
        color: defaultFolderGroupColor,
        seedBounds
      });
      try {
        await dbCreateGroup({
          id: groupId,
          name: folderName,
          folderPath: normalizedFolder,
          isCollapsed: true,
          color: defaultFolderGroupColor,
          seedX: seedBounds.x,
          seedY: seedBounds.y,
          seedW: seedBounds.width,
          seedH: seedBounds.height
        });
      } catch (e) {
        console.warn('[scaffold] empty folder group persistence failed:', e);
      }
      return;
    }

    // Hard cap to prevent canvas from becoming unresponsive.
    const MAX_SPAWN = 100;
    if (filesInFolder.length > MAX_SPAWN) {
      const confirmed = window.confirm(
        `"${normalizedFolder.split('/').pop()}" contains ${filesInFolder.length} files.\n\n` +
        `Only the first ${MAX_SPAWN} will be spawned to keep the canvas responsive.\n\nContinue?`
      );
      if (!confirmed) return;
      filesInFolder.length = MAX_SPAWN;
    } else if (filesInFolder.length > 20) {
      const confirmed = window.confirm(
        `"${normalizedFolder.split('/').pop()}" contains ${filesInFolder.length} files. Spawn all to canvas?`
      );
      if (!confirmed) return;
    }

    // Read all files in parallel, then batch-create pieces in a single state update.
    const filesToCreate = [];
    for (const fileEntry of filesInFolder) {
      const normalized = normalizePath(fileEntry.path);
      const existing = piecesByFilename.get(normalized);
      if (existing) {
        // Already on canvas — include in group but don't re-create.
        filesToCreate.push({ existing, normalized });
      } else {
        const diskCode = await readProjectFile(projectRootPath, normalized);
        const code = typeof diskCode === 'string' ? diskCode : '';
        const label = getBasename(normalized);
        filesToCreate.push({ normalized, label, code, existing: null });
      }
    }

    // Split into existing pieces and new pieces to create.
    const existingIds = filesToCreate.filter((f) => f.existing).map((f) => f.existing.id);
    const newItems = filesToCreate.filter((f) => !f.existing);

    // Sort alphabetically so creation order matches the sort order group expand
    // uses — that way the spawn grid positions line up with the tier layout.
    newItems.sort((a, b) =>
      a.normalized.localeCompare(b.normalized, undefined, { sensitivity: 'base' })
    );

    // Pre-compute grid positions so pieces spawn laid out instead of stacked.
    // 3 columns, unlimited rows — every file gets a unique position, and the
    // first-piece origin becomes the anchor that group expand uses later.
    const spawnOrigin = typeof getSpawnPosition === 'function'
      ? getSpawnPosition()
      : { x: 0, y: 0 };
    const gridPositions = computeSpawnGridPositions(
      newItems.length,
      spawnOrigin.x,
      spawnOrigin.y
    );

    let newIds = [];
    if (newItems.length > 0) {
      try {
        newIds = await dbCreatePiecesBatch(newItems.map((item, i) => ({
          filePath: item.normalized,
          label: item.label,
          x: gridPositions[i].x,
          y: gridPositions[i].y,
          color: null
        })));
      } catch (e) {
        console.warn('[scaffold] dbCreatePiecesBatch failed:', e);
        return;
      }

      pieceDomain.commands.createPiecesBatch(newItems.map((item, i) => ({
        id: newIds[i],
        filename: item.normalized,
        label: item.label,
        code: item.code,
        workingCode: item.code,
        x: gridPositions[i].x,
        y: gridPositions[i].y
      })));
    }

    const createdPieceIds = [...existingIds, ...newIds];
    if (createdPieceIds.length === 0) return;

    if (existingGroup) {
      // The folder's group already exists (reconciler-owned since D2
      // parity) — union the spawned pieces in instead of minting a
      // duplicate group for the same folderPath.
      groupDomain.commands.applyFsSyncPlan({
        additions: createdPieceIds.map((pieceId) => ({ groupId: existingGroup.id, pieceId }))
      }, { withHistory: false });
      for (const pid of createdPieceIds) {
        dbAddPieceToGroup(existingGroup.id, pid).catch(() => {});
      }
      return;
    }

    // Create a collapsed folder group containing all spawned pieces.
    const folderName = normalizedFolder.split('/').pop() || normalizedFolder;
    folderSpawnCounter += 1;
    const groupId = `scaffold-folder-${Date.now()}-${folderSpawnCounter}`;

    groupDomain.commands.createFolderGroup({
      groupId,
      name: folderName,
      pieceIds: createdPieceIds,
      folderPath: normalizedFolder,
      isCollapsed: true,
      // Project's default folder-group color (wizard "custom" mode; null in auto).
      color: defaultFolderGroupColor
    });

    // Persist group and membership to SQLite
    try {
      await dbCreateGroup({
        id: groupId,
        name: folderName,
        folderPath: normalizedFolder,
        isCollapsed: true,
        color: defaultFolderGroupColor
      });
      for (const pid of createdPieceIds) {
        dbAddPieceToGroup(groupId, pid).catch(() => {});
      }
    } catch (e) {
      console.warn('[scaffold] folder group persistence failed:', e);
    }
  }, [defaultFolderGroupColor, getBasename, getSpawnPosition, groupDomain, groups, listTree, normalizePath, pieceDomain, pieceWidth, piecesByFilename, projectRootPath, readProjectFile]);

  const handleScaffoldSelectEntry = useCallback((entry) => {
    if (!entry) return;
    if (entry.entryType === 'file') {
      setScaffoldFocus({ path: normalizePath(entry.path) });
    } else {
      setScaffoldFocus(null);
    }
    setSelectedGroupId(null);
  }, [normalizePath, setScaffoldFocus, setSelectedGroupId]);

  const handleToggleScaffoldVisibility = useCallback((entry) => {
    if (!entry) return;
    const target = normalizePath(entry.path);
    if (!target) return;
    // Decide + persist OUTSIDE the updater: React state updaters must be
    // pure (StrictMode invokes them twice — the DB add/remove used to
    // double-fire from inside; canvas-internals note 4 / feedback #23).
    const isHidden = (hiddenScaffoldPaths ?? []).includes(target);
    if (isHidden) {
      dbRemoveHiddenPath(target).catch(() => {});
    } else {
      dbAddHiddenPath(target).catch(() => {});
    }
    setHiddenScaffoldPaths((prev) => (
      prev.includes(target)
        ? prev.filter((path) => path !== target)
        : [...prev, target]
    ));
  }, [hiddenScaffoldPaths, normalizePath, setHiddenScaffoldPaths]);

  const handleScaffoldOpenEntry = useCallback(async (entry) => {
    if (!entry) return;
    if (entry.entryType === 'dir') {
      await handleScaffoldOpenFolder(entry.path);
      return;
    }
    if (entry.entryType !== 'file') return;
    const normalized = normalizePath(entry.path);
    const existing = piecesByFilename.get(normalized);
    const targetPiece = existing ?? await createPieceFromFile(normalized);
    if (targetPiece) {
      openForPiece(targetPiece);
      selectionDomain.commands.select(targetPiece.id);
      setScaffoldFocus({ path: normalized });
    }
  }, [createPieceFromFile, handleScaffoldOpenFolder, normalizePath, openForPiece, piecesByFilename, selectionDomain, setScaffoldFocus]);

  const bumpScaffoldRefresh = useCallback(() => {
    setScaffoldRefreshToken((value) => value + 1);
  }, [setScaffoldRefreshToken]);

  const handleOpenEditorFromSelection = useCallback(() => {
    if (!selectedCount) return;
    const selectedPieces = selectedIds
      .map((id) => piecesById.get(id))
      .filter(Boolean);
    openFromSelection(selectedPieces);
    setScaffoldFocus(null);
  }, [openFromSelection, piecesById, selectedCount, selectedIds, setScaffoldFocus]);

  const handleEditorLauncherOpen = useCallback(() => {
    if (selectedCount > 0) {
      handleOpenEditorFromSelection();
      return;
    }
    if (scaffoldFocusPath) {
      handleScaffoldOpenEntry({ path: scaffoldFocusPath, entryType: 'file' });
    }
  }, [handleOpenEditorFromSelection, handleScaffoldOpenEntry, scaffoldFocusPath, selectedCount]);

  const handleDeselectAll = useCallback(() => {
    selectionDomain.commands.clear();
    setSelectedGroupId(null);
    setScaffoldFocus(null);
    setIsGroupMenuOpen(false);
    setIsRenameGroupOpen(false);
  }, [
    selectionDomain,
    setIsGroupMenuOpen,
    setIsRenameGroupOpen,
    setScaffoldFocus,
    setSelectedGroupId
  ]);

  return {
    createPieceFromFile,
    handleScaffoldSelectEntry,
    handleToggleScaffoldVisibility,
    handleScaffoldOpenEntry,
    handleScaffoldOpenFolder,
    bumpScaffoldRefresh,
    handleOpenEditorFromSelection,
    handleEditorLauncherOpen,
    handleDeselectAll
  };
}
