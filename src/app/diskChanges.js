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

/**
 * Piece updates after a decision: the new baseline and stamp, by kind. A
 * deleted file's piece stays, marked missing (T3b, owner ruling 2026-10-15),
 * and any version on disk clears the mark.
 */
export function pieceAfter(piece, kind, read) {
  switch (kind) {
    case 'touched':
      return { ...piece, diskStamp: read.stamp ?? null, diskMissing: false };
    case 'reload':
      return { ...piece, code: read.text, workingCode: read.text, diskStamp: read.stamp ?? null, diskMissing: false };
    // The choice is the person's; the stamp is recorded so the same version
    // is not read (or offered) again.
    case 'conflict':
      return { ...piece, diskStamp: read.stamp ?? null, diskMissing: false };
    case 'deleted':
    case 'gone':
      return { ...piece, diskStamp: null, diskMissing: true };
    default:
      return piece;
  }
}

/** The most newly listed files one check reads to look for renames. */
export const MAX_RENAME_CANDIDATES = 256;

/**
 * Pair files that went missing with files that appeared (track T slice T3b;
 * owner ruling 2026-10-15: follow another program's rename when it is
 * unambiguous). A missing piece follows a newly listed file whose text is
 * exactly the text the piece was read as. A text that more than one missing
 * piece holds, or that more than one new file holds, pairs nothing; nor does
 * an empty text, which too many files share.
 *
 * @param {Array<{ id: unknown, filename: string, code: string }>} missing
 * @param {Array<{ path: string, text: string }>} appeared
 * @returns {Array<{ pieceId: unknown, from: string, to: string }>}
 */
export function pairRenames(missing, appeared) {
  const byText = (items, textOf) => {
    const grouped = new Map();
    for (const item of items) {
      const text = textOf(item);
      if (typeof text !== 'string' || text === '') continue;
      grouped.set(text, [...(grouped.get(text) ?? []), item]);
    }
    return grouped;
  };
  const appearedByText = byText(appeared, (file) => file.text);
  const pairs = [];
  for (const [text, pieces] of byText(missing, (piece) => piece.code)) {
    const files = appearedByText.get(text);
    if (pieces.length === 1 && files?.length === 1 && pieces[0].filename !== files[0].path) {
      pairs.push({ pieceId: pieces[0].id, from: pieces[0].filename, to: files[0].path });
    }
  }
  return pairs;
}
