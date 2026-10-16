/**
 * Files changed outside Litria (track T slice T3a): what to do about one file
 * whose stamp moved. Pure, so every case is tested without an app.
 *
 * A piece holds the exact text its saved state was read from disk as (`code`)
 * and the file's stamp then (`diskStamp`). When the stamp moves, the file is
 * read again and judged against that text:
 * - the same text, or the text Litria itself just saved: only the stamp moved;
 * - other text, and nothing unsaved: the file reloads;
 * - other text, with unsaved changes: the person chooses (both are kept);
 * - gone, with unsaved changes: the person chooses whether to save it again;
 * - gone, with nothing unsaved: nothing to protect here (the file tree
 *   following deletions is slice T3b).
 */
import { areEditorTextsEqual } from '../editor/editorSessionDomain.js';

/** The most files one check asks about (Rust's `MAX_STAMPED_PATHS`). */
export const MAX_STAMPED_PATHS = 2048;

/** Whether the file's text in Litria has unsaved changes. */
export function hasUnsavedChanges({ piece, tab }) {
  if (tab) return !areEditorTextsEqual(tab.workingCode, tab.code);
  if (typeof piece?.workingCode === 'string' && typeof piece?.code === 'string') {
    return !areEditorTextsEqual(piece.workingCode, piece.code);
  }
  return false;
}

/** Whether the stamp check says this piece's file should be read again. */
export function stampMoved(piece, stamp) {
  if (stamp === null) return piece.diskStamp !== null;
  return piece.diskStamp !== stamp;
}

/**
 * @param {{ piece: object, tab: object | null, read: { text: string, stamp: string | null } | null,
 *   savedByLitria: boolean }} input  `read` null: nothing readable has the name.
 * @returns {{ kind: 'touched' | 'reload' | 'conflict' | 'deleted' | 'gone' }}
 */
export function judgeDiskChange({ piece, tab, read, savedByLitria = false }) {
  const unsaved = hasUnsavedChanges({ piece, tab });
  if (!read) return { kind: unsaved ? 'deleted' : 'gone' };
  if (read.text === piece.code || savedByLitria) return { kind: 'touched' };
  return { kind: unsaved ? 'conflict' : 'reload' };
}

/** The notice for a file changed under unsaved changes. */
export function describeConflict(filename) {
  return `“${filename}” changed on disk while it had unsaved changes. Click to load the version on disk (yours stays one undo away), or keep yours.`;
}

/** The notice for a file deleted under unsaved changes. */
export function describeDeleted(filename) {
  return `“${filename}” was deleted on disk while it had unsaved changes. Click to save yours again, or dismiss to keep it unsaved.`;
}

/** Piece updates after a decision: the new baseline and stamp, by kind. */
export function pieceAfter(piece, kind, read) {
  switch (kind) {
    case 'touched':
      return { ...piece, diskStamp: read.stamp ?? null };
    case 'reload':
      return { ...piece, code: read.text, workingCode: read.text, diskStamp: read.stamp ?? null };
    // The choice is the person's; the stamp is recorded so the same version
    // is not read (or offered) again.
    case 'conflict':
      return { ...piece, diskStamp: read.stamp ?? null };
    case 'deleted':
    case 'gone':
      return { ...piece, diskStamp: null };
    default:
      return piece;
  }
}
