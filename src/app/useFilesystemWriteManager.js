import { useCallback, useEffect, useMemo, useRef } from 'react';
import { createFilesystemWriteManager } from './filesystemWriteManager';
import { removeEmptyDirectory, createProjectDirectory } from '../project/storage.js';
import { normalizePath, getBasename } from '../utils/path';

/**
 * useManagerFileWriter — identity-stable content writer backed by the
 * filesystem write manager.
 *
 * The manager memo rebuilds on every pieces/groups change, but two of its
 * write consumers sit EARLIER in App's composition and are identity-
 * sensitive: the syntax adapter memo (a new writer function would recreate
 * the adapter and wipe its Monaco model registry) and the persistence save
 * path. This hook returns a writer whose identity never changes, closing
 * over a ref that useFilesystemWriteManager keeps pointed at the latest
 * manager instance.
 *
 * Signature matches the storage-layer writer these call sites previously
 * received — (rootPath, relativePath, contents) → boolean — so it drops in
 * under the same prop. The rootPath argument is ignored: the manager
 * resolves its own root, and every consumer's root is the same
 * projectInstance.rootPath the manager reads. Writes opt out of syntax
 * notification and scaffold refresh ({ notify: false, skipScaffold: true }):
 * these callers own file CONTENT (editor saves, import-line edits, piece
 * seed content) — they notify the syntax domain themselves where needed and
 * never change the tree shape.
 */
export function useManagerFileWriter() {
  const managerRef = useRef(null);
  const writeContentFile = useCallback(async (_rootPath, relativePath, contents) => {
    const manager = managerRef.current;
    if (!manager) return false;
    const result = await manager.writeFile(relativePath, contents, { notify: false, skipScaffold: true });
    return result.success === true;
  }, []);
  return { managerRef, writeContentFile };
}

/**
 * useFilesystemWriteManager — wraps the centralized filesystem write
 * manager construction in a memoized hook.
 *
 * Extracted from App.jsx (Session 1, Group B) to keep the app shell
 * composition-only. The factory `createFilesystemWriteManager` lives
 * one directory over (./filesystemWriteManager); this hook just owns
 * the React-side memoization and dependency wiring.
 *
 * @param {object} opts - input bag of all dependencies the manager needs;
 *   `managerRef` (optional) is kept pointed at the latest manager instance
 *   for identity-stable consumers (see useManagerFileWriter).
 * @returns the constructed filesystem write manager
 */
export function useFilesystemWriteManager({
  managerRef = null,
  moveProjectPath,
  writeProjectFile,
  deleteProjectPath,
  readProjectFile,
  pieceDomain,
  groupDomain,
  connectionDomain,
  syntaxDomain,
  piecesById,
  piecesByFilename,
  pieces,
  groups,
  groupByPieceId,
  updateTabFilename,
  closeTab,
  bumpScaffoldRefresh,
  projectInstance,
}) {
  const manager = useMemo(() => createFilesystemWriteManager({
    moveProjectPath: (rootPath, from, to) => moveProjectPath(rootPath, from, to),
    writeProjectFile: (rootPath, path, contents) => writeProjectFile(rootPath, path, contents),
    removeEmptyDirectory,
    createProjectDirectory,
    deleteProjectPath: (rootPath, path) => deleteProjectPath(rootPath, path),
    getRootPath: () => projectInstance?.rootPath ?? null,
    getPiecesById: () => piecesById,
    getPiecesByFilename: () => piecesByFilename,
    getPieces: () => pieces,
    getGroups: () => groups,
    getGroupByPieceId: () => groupByPieceId,
    getGroupDomain: () => groupDomain,
    updatePieceFilenames: (updates) => pieceDomain.commands.updatePieceFilenames(updates),
    deletePieces: (args) => pieceDomain.commands.deletePieces(args),
    updateTabFilename,
    closeTab,
    removePiecesFromGroups: (ids) => groupDomain.commands.removePieces(ids),
    removeConnectionsForPieces: (ids) => connectionDomain.commands.removeConnectionsForPieces(ids),
    unregisterFile: syntaxDomain?.commands?.unregisterFile ?? null,
    notifyFileChanged: syntaxDomain?.commands?.notifyFileChanged ?? null,
    bumpScaffoldRefresh,
    normalizePath,
    getBasename,
    readProjectFile: (rootPath, path) => readProjectFile(rootPath, path),
  }), [
    moveProjectPath, writeProjectFile, deleteProjectPath, readProjectFile,
    pieceDomain, groupDomain, connectionDomain, syntaxDomain,
    piecesById, piecesByFilename, pieces, groups, groupByPieceId,
    updateTabFilename, closeTab, bumpScaffoldRefresh,
    projectInstance?.rootPath,
  ]);

  useEffect(() => {
    if (managerRef) managerRef.current = manager;
  }, [manager, managerRef]);

  return manager;
}
