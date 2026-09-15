/**
 * persistenceNotices — pure state for ADR-026 decision 3 (slice 4).
 *
 * Two facts the canvas must show instead of swallowing:
 *   1. the workspace opened read-only (`ProjectState.readOnly`, probed by the
 *      Rust adapter at open) — a persistent pill while the flag is set;
 *   2. a persistence write failed — a rate-limited notice carrying the
 *      backend's classified message (`db.read_only`, `db.busy`, `db.corrupt`,
 *      or anything else), latest message wins inside the window.
 *
 * No React, no I/O: `usePersistenceNotices` drives this from the write-failure
 * observer in `persistenceFailures.js`, and `useProjectPersistence` uses
 * `canPersist` to skip its debounced database writes on a read-only instance.
 * File saves use the same observer but remain available in read-only-layout
 * mode. Node-tested in
 * test/domains/persistenceNotices.test.mjs.
 *
 * Owner rulings (brief §4, 2026-09-14): pill at the canvas top edge; read-only
 * skips persistence ONLY — every gesture stays, zoom and pan are never gated.
 */

/** One notice per window; a notice also expires after the same window. */
export const NOTICE_RATE_LIMIT_MS = 10_000;

export const READ_ONLY_PILL_TEXT = "Read-only workspace — layout changes won't be saved.";

/** Backend error codes from src-tauri/src/db/mod.rs (ADR-026 decision 5). */
export const DB_CODE_READ_ONLY = 'db.read_only';
export const DB_CODE_BUSY = 'db.busy';
export const DB_CODE_CORRUPT = 'db.corrupt';

// Every mutating command in src/project/dbStorage.js starts with one of
// these verbs; reads (db_load_*, db_list_*) and the lifecycle trio
// (open/bootstrap/close, surfaced by the launcher) are deliberately excluded.
const WRITE_COMMAND = /^db_(create|update|delete|batch|add|remove|save|register|pin)_/;

export function isPersistenceWrite(command) {
  return typeof command === 'string' && WRITE_COMMAND.test(command);
}

/**
 * Can this project instance persist canvas state to its workspace database?
 * False for the launcher's single-file session (no workspace attached), for a
 * missing root, and for a read-only workspace.
 */
export function canPersist(projectInstance) {
  if (!projectInstance) return false;
  if (!projectInstance.rootPath || !projectInstance.instanceId) return false;
  if (projectInstance.manifestPath === null) return false;
  return projectInstance.readOnly !== true;
}

function errorParts(error) {
  if (error && typeof error === 'object') {
    const code = typeof error.code === 'string' ? error.code : null;
    const message = typeof error.message === 'string' && error.message.trim()
      ? error.message.trim()
      : null;
    const relativePath = typeof error.relativePath === 'string' && error.relativePath.trim()
      ? error.relativePath.trim()
      : null;
    return { code, message, relativePath };
  }
  if (typeof error === 'string' && error.trim()) {
    return { code: null, message: error.trim(), relativePath: null };
  }
  return { code: null, message: null, relativePath: null };
}

/**
 * Turn a rejected write into `{ code, message, command }` with user-facing
 * wording. Tauri rejects with the serialized `CommandError` (`{ category,
 * code, message }`); anything else degrades to its text.
 */
export function describeWriteFailure(command, error) {
  const { code, message, relativePath } = errorParts(error);
  const detail = message ?? 'unknown error';
  let text;
  if (command === 'file.save') {
    const path = relativePath ?? 'unknown file';
    const reason = detail.replace(/[.!?]+$/, '');
    return {
      command,
      code,
      message: `Couldn't save "${path}": ${reason}. Your edits are still in the editor.`
    };
  }
  switch (code) {
    case DB_CODE_READ_ONLY:
      text = 'Layout change not saved: the workspace is read-only.';
      break;
    case DB_CODE_BUSY:
      text = 'Layout change not saved: the workspace database is busy. It will retry on the next change.';
      break;
    case DB_CODE_CORRUPT:
      // The backend's message already ends with the recovery step.
      text = `Layout change not saved: ${detail}`;
      break;
    default:
      text = `Layout change not saved: ${detail}`;
  }
  return { command: command ?? null, code, message: text };
}

export function createNoticeState() {
  return { notice: null, lastShownAt: null };
}

/**
 * Record a write failure. Pure: `now` is injected.
 *
 * - On a read-only workspace a `db.read_only` failure is expected and the
 *   pill already explains it — no notice.
 * - Outside the rate window a fresh notice is shown (`at = now`).
 * - Inside the window the visible notice keeps its slot but takes the latest
 *   message and counts the suppressed repeats — latest wins, one slot per
 *   10 s, no flicker.
 */
export function reduceWriteFailure(state, failure, { now, readOnly = false } = {}) {
  if (!failure) return state;
  if (readOnly && failure.command !== 'file.save' && failure.code === DB_CODE_READ_ONLY) return state;

  const withinWindow = state.lastShownAt !== null
    && now - state.lastShownAt < NOTICE_RATE_LIMIT_MS;

  if (withinWindow && state.notice) {
    return {
      ...state,
      notice: {
        ...state.notice,
        code: failure.code,
        message: failure.message,
        command: failure.command,
        suppressed: state.notice.suppressed + 1
      }
    };
  }

  return {
    lastShownAt: now,
    notice: {
      code: failure.code,
      message: failure.message,
      command: failure.command,
      at: now,
      suppressed: 0
    }
  };
}

/** A notice ages out after the rate window; the rate window itself stays. */
export function expireNotice(state, now) {
  if (!state.notice) return state;
  if (now - state.notice.at < NOTICE_RATE_LIMIT_MS) return state;
  return { ...state, notice: null };
}

export function dismissNotice(state) {
  if (!state.notice) return state;
  return { ...state, notice: null };
}

/** Project switch: nothing from the previous workspace may linger. */
export function clearNotices() {
  return createNoticeState();
}
