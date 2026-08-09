import { useCallback, useRef } from 'react';

import { isUntitledSession, UNTITLED_FILENAME } from '../project/untitledSession.js';
import { splitPathAtLastSeparator, findReservedDeviceSegment } from '../utils/path';

/**
 * useUntitledSaveAs — Save As resolver for launcher "New File" sessions.
 *
 * While a session is untitled (single-file mode, isUntitled flag, empty
 * rootPath), the editor session's save paths hand dirty tabs to
 * `resolveUntitledSave` instead of the normal optimistic write. The resolver:
 *   1. root already materialized (an earlier resolve this session) — writes
 *      through the normal storage path and syncs the piece, no dialog;
 *   2. no root yet — native Save As dialog; on confirm it writes the file,
 *      renames the piece + tab to the chosen basename, and materializes
 *      rootPath on the project instance (same shape as "Open File" mode,
 *      isUntitled flipped off).
 *
 * Resolves false (tab stays dirty) on: dialog canceled, picker unavailable,
 * or failed disk write. Resolves true only after a confirmed write.
 *
 * Returned as `resolveUntitledSave: fn | null` — null whenever the session
 * is not untitled, so consumers can install it directly as the save gate.
 *
 * RATIFIED EXCEPTION to the filesystem-write-manager compliance rule
 * (2026-07-28 write-pipeline pass): this hook writes through the raw
 * storage wrapper deliberately. The manager is scoped to a project root,
 * and this hook's job is to CREATE that root — its writes happen before
 * any root exists (branch 2) or before React state carrying the root has
 * propagated (branch 1, which is why instanceRef exists). Routing through
 * the root-scoped manager is semantically impossible here; once the root
 * materializes, every subsequent save takes the managed path via
 * useProjectPersistence.
 *
 * Because this bypasses the manager, it must re-apply the manager's
 * reserved-Windows-name rule itself (the native Save As dialog does not:
 * verbatim paths let `con.py` through) — the one policy check this
 * exception carries locally.
 */
export function useUntitledSaveAs({
  projectInstance,
  setProjectInstance,
  setPieces,
  updateTabFilename,
  writeProjectFile,
  showToast
}) {
  // Latest-instance ref: sequential resolves within one tick must see the
  // root materialized by an earlier resolve before React re-renders.
  const instanceRef = useRef(projectInstance);
  instanceRef.current = projectInstance;

  // Serialization queue: concurrent save entry points (Ctrl+S + menubar,
  // group-menu save loops) must not open two Save As dialogs racing on
  // setProjectInstance. Each call waits for the previous one to settle; a
  // second call issued while the dialog is up then sees the materialized
  // root and takes the plain-write branch.
  const queueRef = useRef(Promise.resolve());

  const syncPieceAfterSave = useCallback((tab, filename, contents) => {
    // The gate bypasses persistSavedTab, which normally baselines the piece
    // after a save — do the same here so piece.code matches disk.
    setPieces((prev) => prev.map((piece) => (
      String(piece.id) === String(tab.pieceId)
        ? { ...piece, filename, label: filename, code: contents, workingCode: contents }
        : piece
    )));
  }, [setPieces]);

  const resolveOne = useCallback(async (tab) => {
    if (!tab) return false;
    const current = instanceRef.current;
    if (!current) return false;

    const contents = tab.workingCode ?? '';

    if (current.rootPath) {
      // Root materialized earlier in this save sequence — plain write.
      const ok = await writeProjectFile(current.rootPath, tab.filename, contents);
      if (ok !== true) return false;
      syncPieceAfterSave(tab, tab.filename, contents);
      return true;
    }

    let selected = null;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      selected = await save({
        title: 'Save File As',
        defaultPath: tab.filename || UNTITLED_FILENAME
      });
    } catch {
      // Picker unavailable (e.g. plugin missing in a test shell) — leave dirty.
      return false;
    }
    if (typeof selected !== 'string' || !selected.trim()) return false;

    const { dir, base } = splitPathAtLastSeparator(selected.trim());
    if (!dir || !base) return false;

    if (findReservedDeviceSegment(base)) {
      showToast?.(`"${base}" is a reserved name on Windows — pick another filename`, { severity: 'error' });
      return false;
    }

    const ok = await writeProjectFile(dir, base, contents);
    if (ok !== true) return false;

    syncPieceAfterSave(tab, base, contents);
    updateTabFilename(tab.id, base);

    // Materialize the root LAST: isUntitled flips off, so the reconfigured
    // persistence drops the gate and later saves take the normal path
    // against the new root. Same instanceId — no session reset.
    const nextInstance = {
      ...current,
      name: base,
      rootPath: dir,
      isUntitled: false,
      updatedAt: new Date().toISOString()
    };
    instanceRef.current = nextInstance;
    setProjectInstance(nextInstance);
    return true;
  }, [setProjectInstance, showToast, syncPieceAfterSave, updateTabFilename, writeProjectFile]);

  const resolveUntitledSave = useCallback((tab) => {
    const run = queueRef.current.then(() => resolveOne(tab));
    // Keep the queue alive even if a resolve rejects unexpectedly.
    queueRef.current = run.catch(() => {});
    return run;
  }, [resolveOne]);

  return {
    resolveUntitledSave: isUntitledSession(projectInstance) ? resolveUntitledSave : null
  };
}
