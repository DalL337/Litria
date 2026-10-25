/**
 * The Program Status Protocol (OSC 7501), terminal side, revision 0.4
 * (2026-10-10): https://www.superlogical.com/rex/docs/build/program-status
 *
 * A program reports what it is doing (`idle`, `working`, `done`, `blocked`,
 * `error`) as records the terminal keeps; Litria shows them on the session's
 * tab (track T slice T2a-2). Everything in a report is untrusted input from a
 * program that already controls the screen: a report over a limit, with bad
 * base64 or with a control character in its text is discarded whole, and text
 * shown outside the terminal is stripped of invisible formatting characters.
 * The only thing Litria ever writes back is the feature reply.
 */

/** The feature-detection reply: Litria shows every state and kind. A program
 * that gets this before its DA1 answer reports its status (Claude Code
 * >= 2.1.295 asks; it sends nothing to a terminal that does not answer). */
export const PROGRAM_STATUS_REPLY =
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\';

const STATES = new Set(['idle', 'working', 'done', 'blocked', 'error']);
const KINDS = new Set(['permission', 'question', 'auth']);
const KEY = /^[a-z]+$/;
const VALUE = /^[A-Za-z0-9_.,+/=-]*$/;
const ID_SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const INVISIBLE = /\p{Cf}/gu;

/** The whole sequence, ESC ] 7501 ; through its terminator. */
export const MAX_SEQUENCE_BYTES = 4096;
/** ESC ] 7501 ; and the shortest terminator (BEL). */
const FRAMING_BYTES = ']7501;'.length + 1;

const LIMITS = Object.freeze({
  key: 16,
  app: 32,
  id: 128,
  idSegments: 8,
  titleEncoded: 256,
  titleDecoded: 192,
  msgEncoded: 2732,
  msgDecoded: 2048
});

/** Records a terminal keeps (the spec allows 256 and requires 64). */
export const MAX_RECORDS = 256;

/** Which record a session's tab shows when there are several. */
const PRIORITY = { blocked: 5, error: 4, done: 3, working: 2, idle: 1 };

const DISCARD = Symbol('discard');

const utf8Length = (text) => new TextEncoder().encode(text).length;

/** Standard base64 of UTF-8, padding optional; DISCARD when it does not decode
 * to control-free text within `maxBytes`. */
function decodeText(value, maxEncoded, maxBytes) {
  if (value.length > maxEncoded || !BASE64.test(value)) return DISCARD;
  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return DISCARD;
  let bytes;
  try {
    const binary = atob(unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4));
    bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return DISCARD;
  }
  if (bytes.length > maxBytes) return DISCARD;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return DISCARD;
  }
  return CONTROL.test(text) ? DISCARD : text;
}

function validId(id) {
  if (id.length > LIMITS.id) return false;
  const segments = id.split('/');
  return segments.length <= LIMITS.idSegments && segments.every((s) => ID_SEGMENT.test(s));
}

/**
 * Parses a report's body (what follows `7501;`). Returns the report, or null
 * when the protocol says to ignore or discard it.
 *
 * @returns {{state: string, id: string, kind: string|null, progress: number|null,
 *   app: string|null, title: string|null, msg: string|null}|null}
 */
export function parseProgramStatus(body) {
  if (typeof body !== 'string' || utf8Length(body) + FRAMING_BYTES > MAX_SEQUENCE_BYTES) return null;
  const pairs = new Map();
  for (const raw of body.split(':')) {
    const eq = raw.indexOf('=');
    if (eq < 0) continue;
    const key = raw.slice(0, eq).trim();
    const value = raw.slice(eq + 1).trim();
    if (!key || !KEY.test(key)) continue;
    if (key.length > LIMITS.key) return null;
    if (!VALUE.test(value)) continue;
    pairs.set(key, value);
  }

  const state = pairs.get('state');
  if (state !== 'clear' && !STATES.has(state)) return null;

  const id = pairs.get('id') ?? '';
  if (pairs.has('id') && !validId(id)) return null;

  const app = pairs.get('app') ?? null;
  if (app !== null && app.length > LIMITS.app) return null;

  let title = null;
  if (pairs.has('title')) {
    title = decodeText(pairs.get('title'), LIMITS.titleEncoded, LIMITS.titleDecoded);
    if (title === DISCARD) return null;
  }
  let msg = null;
  if (pairs.has('msg')) {
    msg = decodeText(pairs.get('msg'), LIMITS.msgEncoded, LIMITS.msgDecoded);
    if (msg === DISCARD) return null;
  }

  const kind = state === 'blocked' && KINDS.has(pairs.get('kind')) ? pairs.get('kind') : null;
  let progress = null;
  if ((state === 'working' || state === 'blocked') && /^\d{1,3}$/.test(pairs.get('progress') ?? '')) {
    progress = Math.min(100, Number(pairs.get('progress')));
  }

  return { state, id, kind, progress, app, title, msg };
}

/** Text from a record, fit to show outside the terminal: invisible formatting
 * (bidirectional overrides included) removed, whitespace collapsed, capped. */
export function displayText(text, max = 200) {
  if (typeof text !== 'string') return null;
  const clean = text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  if (!clean) return null;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * One session's records. Each report replaces its record (by id; no id is the
 * root record); `clear` removes a record and its children, or every record.
 * Past MAX_RECORDS the least recently updated record goes.
 */
export function createProgramStatusRecords({ maxRecords = MAX_RECORDS } = {}) {
  const records = new Map();

  const removeWhere = (test) => {
    let changed = false;
    for (const [id, record] of records) {
      if (test(id, record)) {
        records.delete(id);
        changed = true;
      }
    }
    return changed;
  };

  return {
    /** Applies a parsed report. */
    apply(report) {
      if (!report) return false;
      if (report.state === 'clear') {
        if (!report.id) {
          const had = records.size > 0;
          records.clear();
          return had;
        }
        return removeWhere((id) => id === report.id || id.startsWith(`${report.id}/`));
      }
      const { id, ...record } = report;
      records.delete(id);
      records.set(id, record);
      while (records.size > maxRecords) records.delete(records.keys().next().value);
      return true;
    },
    /** The attached program exited, or a new prompt began: what it was doing
     * is over. `done` and `error` stay until the person has seen them. */
    endActivity() {
      return removeWhere((_, record) => record.state !== 'done' && record.state !== 'error');
    },
    /** The person has seen the session: its finished results are read. */
    acknowledge() {
      return removeWhere((_, record) => record.state === 'done' || record.state === 'error');
    },
    /** RIS: every record goes. */
    reset() {
      const had = records.size > 0;
      records.clear();
      return had;
    },
    /** The record the tab shows: the most pressing one, the newest on ties. */
    summary() {
      let top = null;
      for (const record of records.values()) {
        if (!top || PRIORITY[record.state] >= PRIORITY[top.state]) top = record;
      }
      return top;
    }
  };
}
