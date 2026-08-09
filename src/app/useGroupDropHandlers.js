import { useMemo } from 'react';

import {
  dbUpdateGroup,
  dbDeleteGroup,
  dbAddPieceToGroup,
  dbRemovePieceFromGroup,
} from '../project/dbStorage.js';
import { normalizePath, getBasename } from '../utils/path';

import {
  createHandlePieceGroupDrop,
  createHandleGroupStructureDrop,
} from './groupDropHandlers';
import { createGroupStructureOps } from './groupStructureOps';

/**
 * useGroupDropHandlers — memoization wiring for the canvas group/piece drop
 * handlers (originally extracted from App.jsx in Session 2 of the app-shell
 * refactor).
 *
 * Pure logic lives in ./groupDropHandlers and ./groupStructureOps (no
 * React); this hook only provides the memoized instances. groupStructureOps
 * is returned so other surfaces (group menu's Merge Into…) share the same
 * FSM-backed ops instance.
 */
export function useGroupDropHandlers({
  piecesById,
  groups,
  projectInstance,
  fsManager,
  pillDomain,
  groupDomain,
}) {
  const handlePieceGroupDrop = useMemo(() => createHandlePieceGroupDrop({
    piecesById,
    groups,
    projectInstance,
    fsManager,
    pillDomain,
    groupDomain,
    normalizePath,
    getBasename,
    dbRemovePieceFromGroup,
  }), [groupDomain, groups, piecesById, projectInstance, fsManager, pillDomain]);

  const groupStructureOps = useMemo(() => createGroupStructureOps({
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
  }), [piecesById, fsManager, groupDomain, pillDomain, projectInstance]);

  const handleGroupStructureDrop = useMemo(() => createHandleGroupStructureDrop({
    groups,
    projectInstance,
    groupStructureOps,
  }), [groups, projectInstance, groupStructureOps]);

  return {
    handlePieceGroupDrop,
    handleGroupStructureDrop,
    groupStructureOps,
  };
}
