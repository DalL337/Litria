import { useEffect, useRef } from 'react';
import { uniqueFolderSegment, findReservedDeviceSegment } from '../utils/path.js';
import { dbUpdateGroup } from '../project/dbStorage.js';

/**
 * useGroupPhysicalityMigration — DP2 (brief-group-physicality, owner-ruled
 * 2026-08-01): ghost groups (folderPath: null — ADR-018 Stage-1 manual
 * groups) are rectified SILENTLY on project open, with a one-line
 * informational pill after the fact. Notification, not consent — "we did
 * this so Litria doesn't eat itself or the workspace.db doesn't burn down
 * and you find out later."
 *
 * Rectification = the promote flow, automated: uniquified root-level folder
 * named after the group, member files moved in via the write manager
 * (empty ghosts just create the folder), folderPath persisted. Groups that
 * cannot rectify (duplicate member basenames, reserved folder name) are
 * skipped and logged — they stay ghosts until renamed, and the next open
 * retries.
 *
 * Runs once per project open (loadToken), sequential per group (file moves
 * await between state commands, so same-tick clobber cannot occur).
 */

/**
 * Pure planner: which ghosts rectify, to which folders, moving which files.
 *
 * @returns {{ promotions: Array<{groupId, name, folderPath, moves: Array<{from, to, code}>}>, skipped: Array<{groupId, reason}> }}
 */
export function planGhostRectification({ groups, pieces, piecesById, normalizePath, getBasename, getDirname }) {
  const ghosts = (groups ?? []).filter((group) => !group.folderPath);
  const promotions = [];
  const skipped = [];
  if (!ghosts.length) return { promotions, skipped };

  // Uniquify against every folder already in play — other groups' folders,
  // every piece's parent dir, and folders minted earlier in this same plan.
  const takenPaths = [
    ...(groups ?? []).map((group) => group.folderPath).filter(Boolean),
    ...(pieces ?? []).map((piece) => getDirname(normalizePath(piece?.filename ?? ''))).filter(Boolean),
  ];

  for (const ghost of ghosts) {
    const members = (ghost.pieceIds ?? [])
      .map((pieceId) => piecesById.get(pieceId))
      .filter((piece) => piece?.filename);
    const basenames = members.map((piece) => getBasename(piece.filename).toLowerCase());
    if (new Set(basenames).size !== basenames.length) {
      skipped.push({ groupId: ghost.id, reason: 'duplicate member filenames' });
      continue;
    }
    const folderPath = uniqueFolderSegment(ghost.name || 'group', takenPaths);
    if (findReservedDeviceSegment(folderPath)) {
      skipped.push({ groupId: ghost.id, reason: 'reserved folder name' });
      continue;
    }
    takenPaths.push(folderPath);
    promotions.push({
      groupId: ghost.id,
      name: ghost.name,
      folderPath,
      moves: members
        .map((piece) => ({
          from: normalizePath(piece.filename),
          to: `${folderPath}/${getBasename(piece.filename)}`,
          code: piece.code ?? '',
        }))
        .filter((move) => move.from !== move.to),
    });
  }
  return { promotions, skipped };
}

export function useGroupPhysicalityMigration({
  groups,
  pieces,
  piecesById,
  groupDomain,
  fsManager,
  pillDomain,
  projectId = null,
  projectRootPath = null,
  loadToken = null,
  normalizePath,
  getBasename,
  getDirname,
  bumpScaffoldRefresh = null,
}) {
  const ranForTokenRef = useRef(null);

  useEffect(() => {
    if (!groupDomain || !fsManager || !projectRootPath) return;
    if (loadToken == null || ranForTokenRef.current === loadToken) return;
    if (!Array.isArray(groups) || groups.length === 0) return;
    ranForTokenRef.current = loadToken;

    const { promotions, skipped } = planGhostRectification({
      groups, pieces, piecesById, normalizePath, getBasename, getDirname,
    });
    if (skipped.length) {
      console.warn('[groups] physicality rectification skipped:', skipped);
    }
    if (!promotions.length) return;

    let cancelled = false;
    (async () => {
      let rectified = 0;
      for (const promo of promotions) {
        if (cancelled) return;
        try {
          groupDomain.commands.promoteToFolderGroup({ groupId: promo.groupId, folderPath: promo.folderPath });
          if (promo.moves.length === 0) {
            // Empty ghost: no file moves to materialize the folder — create it.
            await fsManager.createDirectory(promo.folderPath);
          } else {
            for (const move of promo.moves) {
              await fsManager.moveOrWriteFile(move.from, move.to, move.code, {
                skipGroupSync: true,
                skipScaffold: true,
              });
            }
          }
          dbUpdateGroup(promo.groupId, { name: promo.name, folderPath: promo.folderPath }).catch(() => {});
          rectified += 1;
        } catch (e) {
          console.warn(`[groups] physicality rectification failed for "${promo.name}":`, e);
        }
      }
      if (cancelled || rectified === 0) return;
      bumpScaffoldRefresh?.();
      pillDomain?.commands?.addPill?.({
        projectId,
        message: rectified === 1
          ? `Created a folder for "${promotions[0].name}" — it had none, so its group now exists on disk`
          : `Created ${rectified} folders for groups that had none — groups and disk now match`,
        severity: 'info',
      });
    })();

    return () => { cancelled = true; };
  }, [loadToken, groups, pieces, piecesById, groupDomain, fsManager, pillDomain, projectId, projectRootPath, normalizePath, getBasename, getDirname, bumpScaffoldRefresh]);
}
