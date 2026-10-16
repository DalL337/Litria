// useDiskChanges (track T slice T3a): files changed outside Litria.
//
// Another program (an agent's own file tools, another editor, git) can change
// a project file Litria holds. Once a second this hook asks Rust for the
// stamps (size and modification time) of every file on the canvas, reads
// again only the files whose stamp moved, and judges each against the text
// the file was read as (`diskChanges.judgeDiskChange`):
// - nothing unsaved: the file reloads, and syntax and the graph follow;
// - unsaved changes: a pill offers the choice, and both versions are kept
//   until the person makes it (their version loads with mine one undo away,
//   or mine is saved over theirs with theirs one undo away);
// - a save that finds a newer version on disk (`diskConflicts`) gets the same
//   pill; nothing was written.
//
// It checks while Litria has focus too: the person may be watching an agent
// inside Litria. A check never crosses projects: each runs for one load and
// stops when another begins. Files with a save in flight are skipped, and the
// text Litria itself just saved is never taken for another program's.

import { useEffect, useRef } from 'react';
import { useEditorSession } from '../editor/EditorSessionContext';
import { MAX_STAMPED_PATHS, describeConflict, describeDeleted, judgeDiskChange, pieceAfter, stampMoved } from './diskChanges.js';
import { forgetSavedTexts, isSaving, onDiskConflict, wasSavedText } from '../project/diskConflicts.js';
import { toProjectAbsPath } from '../utils/path.js';

const CHECK_INTERVAL_MS = 1000;

export function useDiskChanges({
  projectInstance,
  sessionReadyFor,
  pieces,
  setPieces,
  projectDomain,
  syntaxDomain = null,
  pillDomain = null,
  bumpScaffoldRefresh = null,
  intervalMs = CHECK_INTERVAL_MS
}) {
  const session = useEditorSession();
  const latest = useRef(null);
  latest.current = { pieces, session, setPieces, projectDomain, syntaxDomain, pillDomain, bumpScaffoldRefresh };

  const token = projectInstance?._dbState ?? null;
  const rootPath = projectInstance?.rootPath ?? null;
  const ready = Boolean(token && rootPath && sessionReadyFor === token);

  useEffect(() => {
    if (!ready) return undefined;
    const projectId = projectInstance?.instanceId ?? null;
    let stopped = false;
    let timer = null;
    // The pill shown for each piece, and the disk version it is about.
    const notices = new Map();

    const pieceOf = (id) => latest.current.pieces.find((piece) => piece.id === id) ?? null;
    const tabOf = (id) => latest.current.session.tabsById?.[id] ?? null;
    const updatePiece = (id, update) => {
      latest.current.setPieces((prev) => prev.map((piece) => (piece.id === id ? update(piece) : piece)));
    };
    const readDisk = (filename) => latest.current.projectDomain.commands.readFileWithRevision(rootPath, filename);

    const notifySyntax = (filename, read) => {
      const domain = latest.current.syntaxDomain;
      const absPath = toProjectAbsPath(rootPath, filename);
      if (!domain?.commands?.notifyFileChanged || !absPath) return;
      domain.commands.notifyFileChanged(absPath, read.text, { source: 'disk', revision: read.revision });
    };

    const dismissNotice = (pieceId) => {
      const shown = notices.get(pieceId);
      if (shown) latest.current.pillDomain?.commands?.dismissPill?.(shown.pillId);
      notices.delete(pieceId);
    };

    // The version on disk now replaces the tab's saved text: theirs shown,
    // or mine kept on top and saved over it.
    const takeTheirs = async (pieceId, { keepMine }) => {
      dismissNotice(pieceId);
      const piece = pieceOf(pieceId);
      if (stopped || !piece) return;
      const read = await readDisk(piece.filename);
      if (stopped || !read) return;
      const tab = tabOf(pieceId);
      if (tab) latest.current.session.takeDiskVersion(tab.id, { code: read.text, keepMine });
      updatePiece(pieceId, (current) => ({
        ...current,
        code: read.text,
        workingCode: keepMine ? current.workingCode : read.text,
        diskStamp: read.stamp ?? null
      }));
      if (keepMine && tab) {
        // Their version is the base this save expects on disk: if it changed
        // again meanwhile, the save writes nothing and a new pill asks.
        await latest.current.session.saveTab(tab.id, { diskBase: { kind: 'text', text: read.text } });
      } else {
        notifySyntax(piece.filename, read);
        latest.current.bumpScaffoldRefresh?.();
      }
    };

    const saveAgain = async (pieceId) => {
      dismissNotice(pieceId);
      const tab = tabOf(pieceId);
      if (stopped || !tab) return;
      await latest.current.session.saveTab(tab.id, { diskBase: { kind: 'absent' } });
    };

    const showConflict = (piece, version) => {
      if (notices.get(piece.id)?.version === version) return;
      dismissNotice(piece.id);
      const pills = latest.current.pillDomain?.commands;
      if (!pills?.addPill) return;
      const pillId = pills.addPill({
        projectId,
        message: describeConflict(piece.filename),
        severity: 'info',
        action: () => { notices.delete(piece.id); takeTheirs(piece.id, { keepMine: false }); },
        secondary: { label: 'Keep mine', run: () => takeTheirs(piece.id, { keepMine: true }) }
      });
      notices.set(piece.id, { pillId, version });
    };

    const showDeleted = (piece) => {
      if (notices.get(piece.id)?.version === 'deleted') return;
      dismissNotice(piece.id);
      const pills = latest.current.pillDomain?.commands;
      if (!pills?.addPill) return;
      const pillId = pills.addPill({
        projectId,
        message: describeDeleted(piece.filename),
        severity: 'info',
        action: () => { notices.delete(piece.id); saveAgain(piece.id); }
      });
      notices.set(piece.id, { pillId, version: 'deleted' });
    };

    // One file whose stamp moved: read it again and act on the judgement.
    const examine = async (pieceId, stamp) => {
      const before = pieceOf(pieceId);
      if (!before?.filename) return;
      const read = stamp === null ? null : await readDisk(before.filename);
      if (stopped) return;
      // The file exists but could not be read just now (another program can
      // hold it locked mid-write): not a deletion. The stamp stays, so the
      // next check reads it again.
      if (stamp !== null && !read) return;
      const piece = pieceOf(pieceId);
      if (!piece || piece.filename !== before.filename || isSaving(pieceId)) return;
      const tab = tabOf(pieceId);
      const savedByLitria = Boolean(read) && wasSavedText(pieceId, read.text);
      const { kind } = judgeDiskChange({ piece, tab, read, savedByLitria });
      if (kind === 'reload' && tab && !latest.current.session.takeDiskVersion(tab.id, { code: read.text, onlyIfClean: true })) {
        // Changes were typed meanwhile: leave the stamp, so the next check
        // offers the choice instead.
        return;
      }
      updatePiece(pieceId, (current) => pieceAfter(current, kind, read));
      if (kind === 'touched') {
        // Back to the text Litria has (an outside change undone): nothing to
        // choose any more.
        dismissNotice(pieceId);
      } else if (kind === 'reload') {
        dismissNotice(pieceId);
        notifySyntax(piece.filename, read);
        latest.current.bumpScaffoldRefresh?.();
      } else if (kind === 'conflict') {
        showConflict(piece, read.stamp ?? read.revision);
      } else if (kind === 'deleted') {
        showDeleted(piece);
      }
    };

    const check = async () => {
      const watched = latest.current.pieces
        .filter((piece) => typeof piece.filename === 'string' && piece.filename && !isSaving(piece.id))
        .slice(0, MAX_STAMPED_PATHS);
      if (!watched.length) return;
      const stamps = await latest.current.projectDomain.commands.filesStamps(
        rootPath,
        watched.map((piece) => piece.filename)
      );
      if (stopped || !Array.isArray(stamps)) return;
      for (let index = 0; index < watched.length; index += 1) {
        const stamp = stamps[index]?.stamp ?? null;
        const piece = watched[index];
        if (stamps[index]?.path === piece.filename && stampMoved(piece, stamp)) {
          await examine(piece.id, stamp);
          if (stopped) return;
        }
      }
    };

    const tick = async () => {
      try {
        await check();
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn('[disk-changes] check failed:', error);
      } finally {
        if (!stopped) timer = setTimeout(tick, intervalMs);
      }
    };
    timer = setTimeout(tick, intervalMs);

    // A save that found a newer version on disk wrote nothing: offer the
    // choice now, rather than at the next check.
    const stopListening = onDiskConflict(async ({ pieceId, disk }) => {
      const piece = pieceOf(pieceId);
      if (stopped || !piece) return;
      if (disk === null) {
        showDeleted(piece);
        return;
      }
      const read = await readDisk(piece.filename);
      if (stopped || !read) return;
      updatePiece(pieceId, (current) => ({ ...current, diskStamp: read.stamp ?? null }));
      showConflict(piece, read.stamp ?? read.revision);
    });

    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopListening();
      for (const pieceId of [...notices.keys()]) dismissNotice(pieceId);
      forgetSavedTexts();
    };
  }, [ready, rootPath, token, projectInstance?.instanceId, intervalMs]);
}
