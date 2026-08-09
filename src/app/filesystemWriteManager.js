/**
 * filesystemWriteManager.js — Centralized filesystem mutation service.
 *
 * Owns all filesystem mutations (move, rename, create, delete) within a Litria
 * project. Every surface that modifies files on disk routes through this
 * manager rather than independently calling Tauri invoke wrappers.
 *
 * Compliance register (2026-07-28 write-pipeline pass): the only writers
 * allowed OUTSIDE the manager are storage.js (the invoke wrappers
 * themselves), projectDomain's IO adapter (which supplies the manager's own
 * deps), and useUntitledSaveAs — a ratified exception: it bootstraps the
 * project root itself, so there is no project scope for the manager to
 * operate in yet (see that hook's header). Everything else goes through
 * moveFile / moveOrWriteFile / writeFile / deleteFile / batch here.
 *
 * Two distinct post-op pipelines:
 *   Move:   fs op → piece filenames → tabs → groups → syntax → SQLite → scaffold
 *   Delete: fs op → identify pieces → close tabs → connections → syntax → pieces → groups → SQLite → scaffold
 *
 * Group sync is applied as ONE atomic domain command per pipeline run
 * (applyFsSyncPlan) built from a pure membership plan — see
 * buildMembershipPlan for why per-piece commands and state re-reads are
 * unsafe mid-tick. Moves into a folder no group owns auto-create the group
 * (PRD-FSM-001 §3.3); the launch/refresh reconciler is the backstop.
 *
 * See: docs/prds/filesystem-write-manager-prd.md
 *      docs/rfcs/filesystem-write-manager.md
 */
import { dbUpdatePiece, dbDeletePiece, dbUpdateGroup, dbCreateGroup, dbAddPieceToGroup, dbDeleteGroup } from '../project/dbStorage.js';
import { findReservedDeviceSegment } from '../utils/path.js';

/**
 * Reject creation targets that collide with reserved Windows device names
 * (owner ruling 2026-07-28 — the verbatim-path backend would happily create
 * `con.py`, minting files other Windows tools choke on). Guarded here, at
 * the manager, so every surface is covered regardless of its own input
 * validation. Only CREATION targets are checked — existing reserved-name
 * files (e.g. in a cloned project) can still be renamed away or deleted.
 */
function reservedNameFailure(targetPath) {
  const reserved = findReservedDeviceSegment(targetPath);
  if (!reserved) return null;
  return {
    success: false,
    error: `"${reserved}" is a reserved name on Windows`,
    code: 'fs.reserved_name',
  };
}

// ---------------------------------------------------------------------------
// Path utilities (extracted from useScaffoldOperations.js)
// ---------------------------------------------------------------------------

function getParentDir(filePath) {
  const lastSlash = filePath.lastIndexOf('/');
  return lastSlash >= 0 ? filePath.substring(0, lastSlash) : '';
}

function collectAffectedPieces(piecesByFilename, normalizePath, sourcePath, isDir) {
  const normalizedSource = normalizePath(sourcePath);
  const affected = [];
  piecesByFilename.forEach((piece) => {
    const pf = normalizePath(piece.filename);
    if (isDir) {
      if (pf === normalizedSource || pf.startsWith(normalizedSource + '/')) {
        affected.push(piece);
      }
    } else if (pf === normalizedSource) {
      affected.push(piece);
    }
  });
  return affected;
}

function buildFilenameUpdates(affected, normalizePath, sourcePath, destPath) {
  const normalizedSource = normalizePath(sourcePath);
  const normalizedDest = normalizePath(destPath);
  return affected.map((piece) => {
    const pf = normalizePath(piece.filename);
    const newPath = pf === normalizedSource
      ? normalizedDest
      : normalizedDest + pf.substring(normalizedSource.length);
    return { pieceId: piece.id, path: newPath };
  });
}

/**
 * Build the post-move group-membership plan (pure — applied atomically via
 * groupDomain.commands.applyFsSyncPlan). For each affected piece: remove it
 * from a folder group whose folder it left, add it to the group owning the
 * destination folder, or — when NO group owns that folder — create one
 * (PRD-FSM-001 §3.3 reconciliation: the launch/refresh reconciler becomes a
 * backstop instead of the primary mechanism).
 *
 * `folderPathOverrides` carries folder renames computed in the same pipeline
 * run: state re-reads within a tick are stale (groupsRef syncs in an
 * effect), so a moved group's corrected folder must come from here, never
 * from a re-read — otherwise a folder move looks like every member leaving
 * its group.
 *
 * `pendingFolderGroups` (manager-scoped) remembers folders whose group was
 * created by an earlier pipeline call this tick; upsert semantics make
 * replays against an already-updated base a union, not a duplicate.
 */
function buildMembershipPlan({
  affected,
  normalizePath,
  getBasename,
  sourcePath,
  destPath,
  groups,
  groupByPieceId,
  folderPathOverrides,
  pendingFolderGroups,
  allocateGroupId,
}) {
  const plan = { removals: [], additions: [], upserts: [], creations: [] };
  if (!groups || !groupByPieceId) return plan;

  const effectiveFolderPath = (group) =>
    folderPathOverrides?.get(group.id) ?? group.folderPath;

  const normalizedSource = normalizePath(sourcePath);
  const normalizedDest = normalizePath(destPath);
  const runUpserts = new Map(); // normalizedParent -> upsert entry (shared within this run)

  // Parent link for a created group: the group owning the nearest ancestor
  // folder (folder containment is the source of truth for nesting — same
  // derivation the reconciler backstop applies).
  const nearestAncestorGroupId = (folderPath) => {
    let current = folderPath;
    let lastSlash = current.lastIndexOf('/');
    while (lastSlash > 0) {
      current = current.substring(0, lastSlash);
      const normalizedCurrent = normalizePath(current);
      const owner = groups.find((g) => {
        const folder = effectiveFolderPath(g);
        return folder && normalizePath(folder) === normalizedCurrent;
      });
      if (owner) return owner.id;
      const created = runUpserts.get(normalizedCurrent);
      if (created) return created.groupId;
      lastSlash = current.lastIndexOf('/');
    }
    return null;
  };

  for (const piece of affected) {
    const pieceId = piece.id;
    const currentGroupId = groupByPieceId.get(pieceId) ?? null;
    const pf = normalizePath(piece.filename);
    const newPath = pf === normalizedSource
      ? normalizedDest
      : normalizedDest + pf.substring(normalizedSource.length);
    const newParentDir = getParentDir(newPath);
    const normalizedParent = newParentDir ? normalizePath(newParentDir) : '';

    const currentGroup = currentGroupId ? groups.find((g) => g.id === currentGroupId) : null;
    const currentFolder = currentGroup ? effectiveFolderPath(currentGroup) : null;
    const stayed = Boolean(currentFolder && normalizePath(currentFolder) === normalizedParent);

    // Manual groups (folderPath null) are canvas-only — file moves never
    // touch their membership.
    if (currentGroup && currentFolder && !stayed) {
      plan.removals.push({ groupId: currentGroupId, pieceId });
    }
    if (!normalizedParent || stayed) continue;

    const targetGroup = groups.find((g) => {
      if (g.id === currentGroupId) return false;
      const folder = effectiveFolderPath(g);
      return folder && normalizePath(folder) === normalizedParent;
    });
    if (targetGroup) {
      pendingFolderGroups?.delete(normalizedParent);
      if (!targetGroup.pieceIds.includes(pieceId)) {
        plan.additions.push({ groupId: targetGroup.id, pieceId });
      }
      continue;
    }

    const run = runUpserts.get(normalizedParent);
    if (run) {
      run.pieceIds.push(pieceId);
      continue;
    }
    const pendingId = pendingFolderGroups?.get(normalizedParent);
    if (pendingId) {
      const entry = {
        groupId: pendingId,
        name: getBasename(normalizedParent),
        folderPath: normalizedParent,
        pieceIds: [pieceId],
        parentId: nearestAncestorGroupId(normalizedParent),
      };
      runUpserts.set(normalizedParent, entry);
      plan.upserts.push(entry);
      continue;
    }
    if (!allocateGroupId) continue;
    const { groupId } = allocateGroupId();
    const entry = {
      groupId,
      name: getBasename(normalizedParent),
      folderPath: normalizedParent,
      pieceIds: [pieceId],
      parentId: nearestAncestorGroupId(normalizedParent),
    };
    runUpserts.set(normalizedParent, entry);
    plan.upserts.push(entry);
    plan.creations.push(entry);
    pendingFolderGroups?.set(normalizedParent, groupId);
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Folder-backed groups whose ENTIRE membership is being removed by a sync
 * plan (or a delete) get culled from state by applyFsSyncPlan's keepGroup
 * filter — but that cull is state-only, and the next reconciler pass can't
 * see a group that's already gone, so the SQLite row ghosted until the next
 * launch (found 2026-07-26: pytest2's emptied heisenburg row survived its
 * dissolution). The pipeline computes the emptied set from its own snapshot
 * so the row deletion persists in the same operation.
 *
 * @param {Array} groups - groups snapshot the plan was built against
 * @param {Array<{groupId, pieceId}>} removals - plan removals (or synthesized
 *   {groupId, pieceId} pairs for delete flows)
 * @returns {Array<string>} ids of folder-backed groups left with no members
 */
export function collectEmptiedFolderGroups(groups, removals) {
  if (!groups || !removals.length) return [];
  const removedByGroup = new Map();
  for (const { groupId, pieceId } of removals) {
    if (!removedByGroup.has(groupId)) removedByGroup.set(groupId, new Set());
    removedByGroup.get(groupId).add(pieceId);
  }
  const emptied = [];
  for (const group of groups) {
    if (!group.folderPath) continue; // manual groups survive empty by design
    const removed = removedByGroup.get(group.id);
    if (!removed || !group.pieceIds?.length) continue;
    if (group.pieceIds.every((id) => removed.has(id))) emptied.push(group.id);
  }
  return emptied;
}

/**
 * Create a new FilesystemWriteManager instance.
 *
 * @param {object} deps - All external dependencies (Tauri wrappers, domains, utilities)
 * @returns {{ moveFile, moveFolder, deleteFile, deleteFolder, deleteEmptyFolder, writeFile, createDirectory, batch }}
 */
export function createFilesystemWriteManager(deps) {
  const {
    // Tauri invoke wrappers (from storage.js)
    moveProjectPath,
    writeProjectFile,
    removeEmptyDirectory,
    createProjectDirectory,
    deleteProjectPath,

    // Project context
    getRootPath,

    // Domain accessors (read-only, called at operation time)
    getPiecesById,
    getPiecesByFilename,
    getPieces,
    getGroups,
    getGroupByPieceId,

    // Piece state mutations
    updatePieceFilenames,
    deletePieces,

    // Tab mutations
    updateTabFilename,
    closeTab,

    // Group mutations
    getGroupDomain,
    removePiecesFromGroups,

    // Connection mutations
    removeConnectionsForPieces,

    // Syntax domain mutations
    unregisterFile,
    notifyFileChanged,

    // Scaffold refresh
    bumpScaffoldRefresh,

    // Path utilities
    normalizePath,
    getBasename,

    // File content reader (for delete journal)
    readProjectFile,
  } = deps;

  // ---- Delete journal ------------------------------------------------------
  // Stashes file content before deletion so undo can restore files to disk.
  const deleteJournal = new Map();

  // ---- Pending folder groups ----------------------------------------------
  // Folders whose group was auto-created by a pipeline run whose state write
  // may not be visible to getGroups() yet (groupsRef syncs in an effect).
  // Consulted by buildMembershipPlan so a second move into the same new
  // folder upserts into the same group instead of minting a duplicate;
  // entries are dropped as soon as a fresh read shows the group.
  const pendingFolderGroups = new Map();

  // ---- Result helpers -----------------------------------------------------

  function ok() {
    return { success: true };
  }

  function fail(error, code = 'fs.operation_failed') {
    return { success: false, error, code };
  }

  // ---- Move pipeline ------------------------------------------------------

  /**
   * Internal move pipeline. Shared by moveFile and moveFolder.
   *
   * @param {string} sourcePath - relative path (forward slashes)
   * @param {string} destPath   - relative path (forward slashes)
   * @param {boolean} isDir     - true if moving a directory
   * @param {object} [opts]     - { skipManifest, skipScaffold } for batch use
   * @returns {Promise<{success: boolean, error?: string, code?: string, updates?: Array}>}
   */
  async function movePipeline(sourcePath, destPath, isDir, opts = {}) {
    const rootPath = getRootPath();
    if (!rootPath) return fail('No project root path available', 'fs.no_root');

    const reserved = reservedNameFailure(destPath);
    if (reserved) return reserved;

    // Step 1: Filesystem move
    const moved = await moveProjectPath(rootPath, sourcePath, destPath);
    if (!moved) return fail(`Cannot move "${sourcePath}" to "${destPath}"`, 'fs.move_failed');

    const piecesByFilename = getPiecesByFilename();
    if (!piecesByFilename) return ok(); // No piece tracking available

    // Step 2: Identify affected pieces
    const affected = collectAffectedPieces(piecesByFilename, normalizePath, sourcePath, isDir);
    if (affected.length === 0) {
      if (!opts.skipScaffold) bumpScaffoldRefresh();
      return ok();
    }

    // Step 3: Update piece filenames
    const updates = buildFilenameUpdates(affected, normalizePath, sourcePath, destPath);
    updatePieceFilenames(updates);

    // Step 4: Update tab filenames
    if (updateTabFilename) {
      for (const entry of updates) {
        updateTabFilename(entry.pieceId, entry.path);
      }
    }

    // Step 5: group sync — folderPath fixups for moved folders + the
    // membership plan, applied as ONE domain command. State re-reads within
    // a tick are stale (groupsRef syncs in an effect), so the corrected
    // folder paths are carried locally as overrides into the plan builder —
    // never read back through getGroups() to see this run's own writes.
    const groups = getGroups();
    const groupByPieceId = getGroupByPieceId();
    const groupDomain = getGroupDomain();
    if (!opts.skipGroupSync && groupDomain && groups) {
      const folderPathUpdates = [];
      const folderPathOverrides = new Map();
      if (isDir) {
        const normalizedSource = normalizePath(sourcePath);
        const normalizedDest = normalizePath(destPath);
        for (const group of groups) {
          if (!group.folderPath) continue;
          const normalizedFolder = normalizePath(group.folderPath);
          if (normalizedFolder === normalizedSource) {
            // Exact match — the moved folder IS this group's folder
            folderPathUpdates.push({ groupId: group.id, folderPath: normalizedDest });
            folderPathOverrides.set(group.id, normalizedDest);
          } else if (normalizedFolder.startsWith(normalizedSource + '/')) {
            // Nested group — its folder is a child of the moved folder
            const newFolder = normalizedDest + normalizedFolder.substring(normalizedSource.length);
            folderPathUpdates.push({ groupId: group.id, folderPath: newFolder });
            folderPathOverrides.set(group.id, newFolder);
          }
        }
      }

      const plan = buildMembershipPlan({
        affected,
        normalizePath,
        getBasename,
        sourcePath,
        destPath,
        groups,
        groupByPieceId,
        folderPathOverrides,
        pendingFolderGroups,
        allocateGroupId: groupDomain.commands.allocateGroupId
          ? () => groupDomain.commands.allocateGroupId()
          : null,
      });

      if (folderPathUpdates.length || plan.removals.length || plan.additions.length || plan.upserts.length) {
        groupDomain.commands.applyFsSyncPlan({
          folderPathUpdates,
          removals: plan.removals,
          additions: plan.additions,
          upserts: plan.upserts,
        });
      }
      for (const { groupId, folderPath } of folderPathUpdates) {
        dbUpdateGroup(groupId, { folderPath }).catch(() => {});
      }
      // Auto-created groups persist like reconciler-created ones: the group
      // row is what makes them exist on the next launch (membership rows are
      // a fallback cache — hydration derives membership from folderPath).
      for (const created of plan.creations) {
        dbCreateGroup({
          id: created.groupId,
          name: created.name,
          folderPath: created.folderPath,
          isCollapsed: false,
          parentId: created.parentId ?? null,
          color: null,
        }).then(() => {
          for (const pieceId of created.pieceIds) {
            dbAddPieceToGroup(created.groupId, pieceId).catch(() => {});
          }
        }).catch(() => {});
      }
      // Folder groups the plan emptied get culled from state by keepGroup —
      // persist the deletion too, or the row ghosts until next launch.
      for (const emptiedId of collectEmptiedFolderGroups(groups, plan.removals)) {
        dbDeleteGroup(emptiedId).catch(() => {});
      }
    }

    // Step 6: Syntax domain — unregister old paths, re-register new paths
    if (unregisterFile) {
      for (const piece of affected) {
        const oldPath = normalizePath(piece.filename);
        unregisterFile(oldPath);
      }
    }
    // Note: re-registration happens when the file is next opened in the editor.
    // The syntax domain's edge reconciliation (marking edges broken on unregister)
    // handles the connection path update concern from the PRD.

    // Step 7: Persistence update (SQLite — always, even in batch mode since
    // individual row updates are cheap).
    for (const entry of updates) {
      dbUpdatePiece(entry.pieceId, { filePath: entry.path, label: getBasename(entry.path) }).catch(() => {});
    }

    // Step 8: Scaffold refresh
    if (!opts.skipScaffold) bumpScaffoldRefresh();

    return { success: true, updates };
  }

  /**
   * Move a single file. Runs the full move pipeline.
   */
  async function moveFile(sourcePath, destPath) {
    return movePipeline(sourcePath, destPath, false);
  }

  /**
   * Move a folder and all its contents. Runs the full move pipeline.
   */
  async function moveFolder(sourcePath, destPath) {
    return movePipeline(sourcePath, destPath, true);
  }

  /**
   * Move a file, or materialize it at the destination when the move fails
   * because the source was never written to disk (canvas-created pieces).
   * The move branch is the full move pipeline; the materialize branch writes
   * `fallbackContents` (preferring disk content when the source is readable)
   * and runs the same single-piece state sync the pipeline would have.
   *
   * @param {string} sourcePath
   * @param {string} destPath
   * @param {string} fallbackContents - written when the source can't be read
   * @param {object} [opts] - { skipGroupSync, skipScaffold }
   */
  async function moveOrWriteFile(sourcePath, destPath, fallbackContents, opts = {}) {
    const moveResult = await movePipeline(sourcePath, destPath, false, opts);
    if (moveResult.success || moveResult.code !== 'fs.move_failed') {
      return { ...moveResult, materialized: false };
    }

    const rootPath = getRootPath();
    let contents = null;
    if (readProjectFile) {
      try {
        const existing = await readProjectFile(rootPath, sourcePath);
        if (typeof existing === 'string') contents = existing;
      } catch (_) {
        // Source unreadable — expected for never-written pieces.
      }
    }
    if (contents == null) contents = fallbackContents ?? '';

    const written = await writeProjectFile(rootPath, destPath, contents);
    if (!written) return fail(`Cannot write "${destPath}"`, 'fs.write_failed');

    const normalizedDest = normalizePath(destPath);
    const piecesByFilename = getPiecesByFilename();
    const piece = piecesByFilename?.get(sourcePath)
      ?? piecesByFilename?.get(normalizePath(sourcePath))
      ?? null;
    if (piece) {
      updatePieceFilenames([{ pieceId: piece.id, path: normalizedDest }]);
      if (updateTabFilename) updateTabFilename(piece.id, normalizedDest);
      if (unregisterFile) unregisterFile(normalizePath(piece.filename));
      dbUpdatePiece(piece.id, { filePath: normalizedDest, label: getBasename(normalizedDest) }).catch(() => {});

      const groups = getGroups();
      const groupByPieceId = getGroupByPieceId();
      const groupDomain = getGroupDomain();
      if (!opts.skipGroupSync && groupDomain && groups && groupByPieceId) {
        const plan = buildMembershipPlan({
          affected: [piece],
          normalizePath,
          getBasename,
          sourcePath,
          destPath,
          groups,
          groupByPieceId,
          folderPathOverrides: null,
          pendingFolderGroups,
          allocateGroupId: groupDomain.commands.allocateGroupId
            ? () => groupDomain.commands.allocateGroupId()
            : null,
        });
        if (plan.removals.length || plan.additions.length || plan.upserts.length) {
          groupDomain.commands.applyFsSyncPlan({
            removals: plan.removals,
            additions: plan.additions,
            upserts: plan.upserts,
          });
        }
        for (const created of plan.creations) {
          dbCreateGroup({
            id: created.groupId,
            name: created.name,
            folderPath: created.folderPath,
            isCollapsed: false,
            parentId: created.parentId ?? null,
            color: null,
          }).then(() => {
            for (const pieceId of created.pieceIds) {
              dbAddPieceToGroup(created.groupId, pieceId).catch(() => {});
            }
          }).catch(() => {});
        }
        for (const emptiedId of collectEmptiedFolderGroups(groups, plan.removals)) {
          dbDeleteGroup(emptiedId).catch(() => {});
        }
      }
    }
    if (notifyFileChanged) notifyFileChanged(normalizedDest, contents);

    if (!opts.skipScaffold) bumpScaffoldRefresh();
    return { success: true, materialized: true };
  }

  // ---- Delete pipeline ----------------------------------------------------

  /**
   * Internal delete pipeline. Shared by deleteFile and deleteFolder.
   *
   * @param {string} path    - relative path (forward slashes)
   * @param {boolean} isDir  - true if deleting a directory
   * @param {object} [opts]  - { skipManifest, skipScaffold } for batch use
   * @returns {Promise<{success: boolean, error?: string, code?: string}>}
   */
  async function deletePipeline(path, isDir, opts = {}) {
    const rootPath = getRootPath();
    if (!rootPath) return fail('No project root path available', 'fs.no_root');

    // Step 0: Stash file content before deletion (for undo restore)
    if (!isDir && readProjectFile) {
      try {
        const content = await readProjectFile(rootPath, path);
        if (content != null) {
          deleteJournal.set(normalizePath(path), { content, rootPath, path });
        }
      } catch (_) {
        // Best-effort stash — don't block deletion if read fails
      }
    }

    // Step 1: Filesystem delete
    const deleted = await deleteProjectPath(rootPath, path);
    if (!deleted) {
      deleteJournal.delete(normalizePath(path));
      return fail(`Cannot delete "${path}"`, 'fs.delete_failed');
    }
    if (isDir) {
      // Any auto-created-group bookkeeping under this folder is now moot.
      const normalizedDir = normalizePath(path);
      for (const key of [...pendingFolderGroups.keys()]) {
        if (key === normalizedDir || key.startsWith(normalizedDir + '/')) {
          pendingFolderGroups.delete(key);
        }
      }
    }

    const piecesByFilename = getPiecesByFilename();
    if (!piecesByFilename) {
      if (!opts.skipScaffold) bumpScaffoldRefresh();
      return ok();
    }

    // Step 2: Identify affected pieces
    const affected = collectAffectedPieces(piecesByFilename, normalizePath, path, isDir);
    if (affected.length === 0) {
      // Might be a folder delete that removes a group
      if (isDir) {
        const groups = getGroups();
        const normalizedPath = normalizePath(path);
        const matchingGroup = groups
          ? groups.find((g) => g.folderPath && normalizePath(g.folderPath) === normalizedPath)
          : null;
        if (matchingGroup) {
          const groupDomain = getGroupDomain();
          if (groupDomain) {
            groupDomain.commands.deleteGroup(matchingGroup.id);
            dbDeleteGroup(matchingGroup.id).catch(() => {});
          }
        }
      }
      if (!opts.skipScaffold) bumpScaffoldRefresh();
      return ok();
    }

    const pieceIds = affected.map((p) => p.id);

    // Step 3: Close open editor tabs
    if (closeTab) {
      const piecesById = getPiecesById();
      for (const piece of affected) {
        // closeTab expects a tabId; tabs are keyed by pieceId in the editor session
        closeTab(piece.id);
      }
    }

    // Step 4: Remove connections
    if (removeConnectionsForPieces) {
      removeConnectionsForPieces(pieceIds);
    }

    // Step 5: Syntax domain cleanup
    if (unregisterFile) {
      for (const piece of affected) {
        unregisterFile(normalizePath(piece.filename));
      }
    }

    // Step 6: Remove pieces from state (with filesystem restore on undo)
    const piecesById = getPiecesById();
    const pieces = getPieces();
    if (deletePieces && piecesById && pieces) {
      // Build filesystem restore actions for the undo group
      const extraActions = [];
      for (const piece of affected) {
        const normalizedPath = normalizePath(piece.filename);
        const stashed = deleteJournal.get(normalizedPath);
        if (stashed) {
          const capturedPath = stashed.path;
          const capturedContent = stashed.content;
          extraActions.push({
            label: `Restore file ${capturedPath}`,
            do: () => {
              // On redo: re-delete the file, then refresh scaffold
              const currentRoot = getRootPath();
              if (currentRoot) {
                deleteProjectPath(currentRoot, capturedPath).then(() => bumpScaffoldRefresh());
              }
            },
            undo: () => {
              // On undo: restore the file from stashed content, then refresh scaffold
              const currentRoot = getRootPath();
              if (currentRoot && writeProjectFile) {
                writeProjectFile(currentRoot, capturedPath, capturedContent).then(() => bumpScaffoldRefresh());
              }
            }
          });
          deleteJournal.delete(normalizedPath);
        }
      }
      deletePieces({ ids: pieceIds, piecesById, pieces, extraActions });
    }

    // Step 7: Remove pieces from groups
    // Also check if a folder-backed group's folder was deleted
    if (removePiecesFromGroups) {
      // Persist deletion of folder groups this removal empties (the state
      // cull alone would leave a ghost row until next launch) — computed
      // against the pre-removal snapshot.
      const groupByPieceId = getGroupByPieceId();
      if (groupByPieceId) {
        const removals = pieceIds
          .map((pid) => ({ groupId: groupByPieceId.get(pid), pieceId: pid }))
          .filter((entry) => entry.groupId);
        for (const emptiedId of collectEmptiedFolderGroups(getGroups(), removals)) {
          dbDeleteGroup(emptiedId).catch(() => {});
        }
      }
      removePiecesFromGroups(pieceIds);
    }
    if (isDir) {
      const groups = getGroups();
      const normalizedPath = normalizePath(path);
      const matchingGroup = groups
        ? groups.find((g) => g.folderPath && normalizePath(g.folderPath) === normalizedPath)
        : null;
      if (matchingGroup) {
        const groupDomain = getGroupDomain();
        if (groupDomain) {
          groupDomain.commands.deleteGroup(matchingGroup.id);
          dbDeleteGroup(matchingGroup.id).catch(() => {});
        }
      }
    }

    // Step 8: Persistence update (SQLite — CASCADE handles group_pieces + connections).
    // Always fire, even in batch mode since individual DELETEs are cheap.
    for (const pid of pieceIds) {
      dbDeletePiece(pid).catch(() => {});
    }

    // Step 9: Scaffold refresh
    if (!opts.skipScaffold) bumpScaffoldRefresh();

    return ok();
  }

  /**
   * Remove pieces from the canvas WITHOUT touching their files — the
   * demotion half of the promote/demote staircase (owner-ratified
   * 2026-07-18, wire-arc live-verify E). Mirrors deletePath's canvas
   * cascade (tabs, connections, state, groups, SQLite rows) but performs
   * NO filesystem operation and keeps the file registered with the syntax
   * domain (it still exists on disk).
   *
   * Reversal is re-placement, not undo: the scaffold refresh re-runs
   * discovery, so imports pointing at the demoted file surface as
   * off-canvas badge entries — badge-click or a scaffold drag brings the
   * piece back and re-wires it.
   */
  async function removeFromCanvas(pieceIdsInput) {
    const ids = Array.isArray(pieceIdsInput) ? pieceIdsInput : [pieceIdsInput];
    const piecesById = getPiecesById();
    const pieces = getPieces();
    const affected = ids.map((id) => piecesById?.get(id)).filter(Boolean);
    if (affected.length === 0) return ok();
    const pieceIds = affected.map((p) => p.id);

    if (closeTab) {
      for (const piece of affected) closeTab(piece.id);
    }
    if (removeConnectionsForPieces) {
      removeConnectionsForPieces(pieceIds);
    }
    if (deletePieces && piecesById && pieces) {
      deletePieces({ ids: pieceIds, piecesById, pieces, extraActions: [] });
    }
    if (removePiecesFromGroups) {
      // Same ghost-row persistence as the delete pipeline: demoting a
      // group's last piece culls the group from state; the row must go too.
      const groupByPieceId = getGroupByPieceId();
      if (groupByPieceId) {
        const removals = pieceIds
          .map((pid) => ({ groupId: groupByPieceId.get(pid), pieceId: pid }))
          .filter((entry) => entry.groupId);
        for (const emptiedId of collectEmptiedFolderGroups(getGroups(), removals)) {
          dbDeleteGroup(emptiedId).catch(() => {});
        }
      }
      removePiecesFromGroups(pieceIds);
    }
    // SQLite CASCADE clears group_pieces + connections rows.
    for (const pid of pieceIds) {
      dbDeletePiece(pid).catch(() => {});
    }
    bumpScaffoldRefresh();
    return ok();
  }

  /**
   * Delete a single file. Runs the full delete pipeline.
   */
  async function deleteFile(path) {
    return deletePipeline(path, false);
  }

  /**
   * Delete a folder and all contents. Runs the full delete pipeline.
   */
  async function deleteFolder(path) {
    return deletePipeline(path, true);
  }

  /**
   * Delete a folder only if it is empty. Does not affect pieces or groups.
   */
  async function deleteEmptyFolder(folderPath) {
    const rootPath = getRootPath();
    if (!rootPath) return fail('No project root path available', 'fs.no_root');

    const removed = await removeEmptyDirectory(rootPath, folderPath);
    if (!removed) return fail(`Cannot delete folder "${folderPath}" (it may not be empty)`, 'fs.dir_not_empty');
    bumpScaffoldRefresh();
    return ok();
  }

  // ---- Write pipeline -----------------------------------------------------

  /**
   * Write or create a file. Updates syntax domain if file maps to a piece.
   *
   * Content-owning callers (editor save, syntax adapter) manage their own
   * syntax notification and never change the tree — they pass
   * `{ notify: false, skipScaffold: true }` so routing through the manager
   * changes ownership, not behavior.
   *
   * @param {string} filePath - relative path (forward slashes)
   * @param {string} contents
   * @param {object} [opts] - { notify = true, skipScaffold = false }
   */
  async function writeFile(filePath, contents, opts = {}) {
    const { notify = true, skipScaffold = false } = opts;
    const rootPath = getRootPath();
    if (!rootPath) return fail('No project root path available', 'fs.no_root');

    const reserved = reservedNameFailure(filePath);
    if (reserved) return reserved;

    const written = await writeProjectFile(rootPath, filePath, contents);
    if (!written) return fail(`Cannot write "${filePath}"`, 'fs.write_failed');

    // If this file maps to a piece, notify syntax domain
    if (notify && notifyFileChanged) {
      notifyFileChanged(normalizePath(filePath), contents);
    }

    if (!skipScaffold) bumpScaffoldRefresh();
    return ok();
  }

  /**
   * Create a directory. No piece sync needed.
   *
   * @param {string} dirPath - relative path (forward slashes)
   * @param {object} [opts] - { skipScaffold } for batch use
   */
  async function createDir(dirPath, opts = {}) {
    const rootPath = getRootPath();
    if (!rootPath) return fail('No project root path available', 'fs.no_root');

    const reserved = reservedNameFailure(dirPath);
    if (reserved) return reserved;

    const created = await createProjectDirectory(rootPath, dirPath);
    if (!created) return fail(`Cannot create directory "${dirPath}"`, 'fs.mkdir_failed');
    if (!opts.skipScaffold) bumpScaffoldRefresh();
    return ok();
  }

  // ---- Batch operations ---------------------------------------------------

  const BATCH_OPS = {
    moveFile:          (args) => movePipeline(args.from, args.to, false, { skipManifest: true, skipScaffold: true }),
    moveFolder:        (args) => movePipeline(args.from, args.to, true, { skipManifest: true, skipScaffold: true }),
    deleteFile:        (args) => deletePipeline(args.path, false, { skipManifest: true, skipScaffold: true }),
    deleteFolder:      (args) => deletePipeline(args.path, true, { skipManifest: true, skipScaffold: true }),
    deleteEmptyFolder: (args) => {
      const rootPath = getRootPath();
      if (!rootPath) return Promise.resolve(fail('No project root path available', 'fs.no_root'));
      return removeEmptyDirectory(rootPath, args.path).then(
        (removed) => removed ? ok() : fail(`Cannot delete folder "${args.path}" (it may not be empty)`, 'fs.dir_not_empty')
      );
    },
    writeFile:         (args) => writeFile(args.path, args.contents ?? '', { notify: false, skipScaffold: true }),
    createDirectory:   (args) => createDir(args.path, { skipScaffold: true }),
  };

  /**
   * Run multiple operations sequentially. Manifest update and scaffold refresh
   * happen once at the end. Individual failures do not abort the batch.
   *
   * @param {Array<{op: string, ...args}>} operations
   * @returns {Promise<{results: Array, successCount: number, failureCount: number}>}
   */
  async function batch(operations) {
    if (!Array.isArray(operations) || operations.length === 0) {
      return { results: [], successCount: 0, failureCount: 0 };
    }

    const results = [];
    let successCount = 0;
    let failureCount = 0;

    for (const entry of operations) {
      const handler = BATCH_OPS[entry.op];
      if (!handler) {
        const result = fail(`Unknown operation "${entry.op}"`, 'fs.unknown_op');
        results.push(result);
        failureCount++;
        continue;
      }

      const result = await handler(entry);
      results.push(result);

      if (result.success) {
        successCount++;
      } else {
        failureCount++;
      }
    }

    // Note: individual ops skipManifest=true above, but the underlying
    // dbUpdatePiece/dbDeletePiece calls still fired inside each op.
    // A single scaffold refresh at the end.
    bumpScaffoldRefresh();

    return { results, successCount, failureCount };
  }

  // ---- Public API ---------------------------------------------------------

  return {
    moveFile,
    moveFolder,
    moveOrWriteFile,
    deleteFile,
    deleteFolder,
    deleteEmptyFolder,
    removeFromCanvas,
    writeFile,
    createDirectory: createDir,
    batch,
  };
}
