// Project API owner bridge — the JavaScript half of the `project-api-bridge`
// contract family (src-tauri/contracts/project-api-bridge/v1/; contract brief
// §4.3, §5, §8; build plan P2).
//
// Rust asks; this answers. Rust emits `project-api://bridge-request` with
// `{ requestId, epoch, generation, op, request }`, and this module replies
// exactly once through `project_api_bridge_reply`. It is an adapter, not a
// domain: it holds no project state, reads owners through injected selector
// ports, and never touches the editor engine.
//
// Trust rules this module keeps:
// - It answers only after it is READY for a project instance (hydration
//   finished) and attached under that instance's epoch. A request is answered
//   only when its epoch, the ready epoch and the frontend's current workspace
//   epoch all agree; otherwise it is refused as `workspaceChanged`. A reply
//   therefore never describes another project, even in the window where the
//   global epoch has moved on and the owners still hold the old project.
// - It does not know the disclosure policy. Rust asks only for paths it has
//   allowed and filters every path a reply lists.
// - Replies never exceed the bridge reply ceiling: pages shrink or defer.
//
// The factory is pure and tested under node --test with the transport and the
// owner ports mocked (test/domains/projectApiBridge.test.mjs), against the
// committed fixtures. `useProjectApiBridge.js` wires it to Tauri and React.

export const BRIDGE_REQUEST_EVENT = 'project-api://bridge-request';
export const BRIDGE_OPS = Object.freeze({
  documents: 'editor.documents',
  bufferIndex: 'editor.bufferIndex'
});
/** Encoded size of one reply (contract brief §10); the catalog publishes it. */
export const MAX_REPLY_BYTES = 512 * 1024;
/** The smallest per-document budget that always holds one character. */
const MIN_PAGE_BUDGET = 4;
const MAX_QUERIES = 20;
const MAX_INDEX_ENTRIES = 500;
const REMEMBERED_REQUESTS = 256;
/** Rust's pending ceiling: no more requests than this can be waiting. */
const HELD_WHILE_ATTACHING = 32;

const REFUSALS = Object.freeze({
  workspaceChanged: "the editor's state belongs to another workspace",
  unknownOperation: 'the editor does not know this operation',
  invalidRequest: 'the editor could not read the request',
  internal: 'the editor could not answer the request'
});

// ─── Text measures ─────────────────────────────────────────────────────────

/** UTF-8 byte length of a JavaScript string (lone surrogates count as 3). */
export function utf8Length(text) {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) bytes += 1;
    else if (unit < 0x800) bytes += 2;
    else if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

function encodedLength(value) {
  return utf8Length(JSON.stringify(value));
}

/** The longest prefix of `text` within `budget` UTF-8 bytes, cut between characters. */
function cutToBytes(text, budget) {
  let bytes = 0;
  let index = 0;
  while (index < text.length) {
    const point = text.codePointAt(index);
    const width = point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
    if (bytes + width > budget) break;
    bytes += width;
    index += point >= 0x10000 ? 2 : 1;
  }
  return text.slice(0, index);
}

function lineEnd(text, from) {
  const newline = text.indexOf('\n', from);
  return newline === -1 ? text.length : newline + 1;
}

function countLines(text) {
  let newlines = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    newlines += 1;
  }
  return newlines + (text.length > 0 && !text.endsWith('\n') ? 1 : 0);
}

/**
 * Lines `startLine..endLine` (1-based, inclusive) within `budget` UTF-8
 * bytes — the same rules as the Rust reader (contract brief §5): lines keep
 * their terminators; a read that does not fit stops at a line boundary
 * (`truncated`); a first line that alone exceeds the budget is cut between
 * characters (`lineCut`); when not one character fits, nothing is returned.
 * The budget is strict.
 */
export function sliceLines(text, startLine, endLine, budget) {
  const totalLines = countLines(text);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(endLine ?? totalLines, totalLines);
  const empty = (truncated) => ({ text: '', range: null, totalLines, truncated, lineCut: false });
  if (start > end) return empty(false);

  let offset = 0;
  for (let line = 1; line < start; line += 1) offset = lineEnd(text, offset);
  const firstEnd = lineEnd(text, offset);
  const first = text.slice(offset, firstEnd);
  const firstBytes = utf8Length(first);
  if (firstBytes > budget) {
    const cut = cutToBytes(first, budget);
    if (!cut) return empty(true);
    return { text: cut, range: [start, start], totalLines, truncated: true, lineCut: true };
  }

  const parts = [first];
  let used = firstBytes;
  let last = start;
  let position = firstEnd;
  while (last < end) {
    const next = lineEnd(text, position);
    const line = text.slice(position, next);
    const bytes = utf8Length(line);
    if (used + bytes > budget) break;
    parts.push(line);
    used += bytes;
    last += 1;
    position = next;
  }
  return { text: parts.join(''), range: [start, last], totalLines, truncated: last < end, lineCut: false };
}

/**
 * Buffer revision (contract brief §4.5): a synchronous, non-cryptographic
 * 128-bit hash of the whole session text, prefixed `b1-`. Synchronous because
 * the write increment compares and applies in one turn; the same function
 * will check edit preconditions. Opaque to callers: equality only.
 */
export function bufferRevision(text) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    h1 = h2 ^ Math.imul(h1 ^ unit, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ unit, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ unit, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ unit, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return `b1-${[h1, h2, h3, h4].map((h) => (h >>> 0).toString(16).padStart(8, '0')).join('')}`;
}

/** Text as JSON can carry it: a lone surrogate becomes U+FFFD (Rust rejects them). */
function wellFormed(text) {
  return typeof text.toWellFormed === 'function' ? text.toWellFormed() : text;
}

// ─── Readiness ─────────────────────────────────────────────────────────────

/**
 * The epoch the bridge may answer for: the epoch of the project instance's
 * own load (`_dbState.workspaceEpoch`), and only once the persistence hook
 * reports that load fully hydrated (`sessionReadyFor` is that same load
 * token). Never the global epoch alone: it moves before React has replaced
 * the owners' state (contract brief §4.3).
 */
export function deriveReadyEpoch(projectInstance, sessionReadyFor) {
  const token = projectInstance?._dbState ?? null;
  if (!token || sessionReadyFor !== token) return null;
  const epoch = token.workspaceEpoch;
  return typeof epoch === 'string' && epoch ? epoch : null;
}

/**
 * Gives a transport one queue shared by every bridge in this realm. A bridge
 * runs each whole attach/detach reconciliation through it, so a StrictMode
 * remount or a fast project switch reaches Rust in order: an earlier bridge's
 * detach can never land after a later bridge's attach. (The transport's own
 * calls stay unqueued — they run inside a queued reconciliation.)
 */
export function serializeAttachments(transport) {
  let tail = Promise.resolve();
  return {
    attach: (epoch) => transport.attach(epoch),
    detach: (generation) => transport.detach(generation),
    reply: (...args) => transport.reply(...args),
    enqueue(work) {
      const run = tail.then(() => work());
      tail = run.catch(() => {});
      return run;
    }
  };
}

// ─── Operations ────────────────────────────────────────────────────────────

function refusal(code) {
  return { kind: 'error', code, message: REFUSALS[code] };
}

function isQuery(query) {
  return query && typeof query === 'object'
    && typeof query.path === 'string'
    && Number.isInteger(query.maxBytes) && query.maxBytes >= 0
    && (query.startLine === undefined || Number.isInteger(query.startLine))
    && (query.endLine === undefined || Number.isInteger(query.endLine));
}

function createRevisions() {
  // Per tab: the text last hashed and its revision. The session replaces its
  // text string on every edit, so an unchanged buffer is the same string.
  const cache = new Map();
  return (doc) => {
    const cached = cache.get(doc.tabId);
    if (cached && cached.text === doc.text) return cached.revision;
    const revision = bufferRevision(doc.text);
    cache.set(doc.tabId, { text: doc.text, revision });
    return revision;
  };
}

/**
 * `editor.documents`: one entry per query, in order. The text budget
 * (`maxTextBytes`) is spent in order; each slice is strict to its own
 * `maxBytes`. The page never exceeds `ceiling`: the first buffer shrinks to
 * fit (fewer lines, then a cut line), and once a later buffer cannot fit,
 * it and every query after it are `deferred` for Rust to ask again.
 */
export function answerDocuments(request, documents, revisionOf, ceiling = MAX_REPLY_BYTES) {
  const queries = request?.documents;
  if (!Array.isArray(queries) || queries.length < 1 || queries.length > MAX_QUERIES
    || !queries.every(isQuery) || !Number.isInteger(request.maxTextBytes)) {
    return refusal('invalidRequest');
  }
  const reserves = queries.map(
    (query) => encodedLength({ kind: 'notBuffered', path: query.path, state: 'closedClean' }) + 1
  );
  let reservedAfter = reserves.reduce((sum, bytes) => sum + bytes, 0);
  let used = encodedLength({ kind: 'result', result: { documents: [] } });
  let textLeft = request.maxTextBytes;
  let deferring = false;
  const entries = [];

  queries.forEach((query, index) => {
    reservedAfter -= reserves[index];
    const doc = documents.get(query.path);
    let entry;
    if (deferring) {
      entry = { kind: 'deferred', path: query.path };
    } else if (!doc || doc.state === 'closedClean') {
      entry = { kind: 'notBuffered', path: query.path, state: doc ? 'closedClean' : 'none' };
    } else {
      const room = ceiling - used - reservedAfter - 1;
      entry = fitBuffer(query, doc, revisionOf(doc), Math.min(query.maxBytes, textLeft), room, index === 0);
      if (entry) {
        textLeft -= utf8Length(entry.text);
      } else {
        deferring = true;
        entry = { kind: 'deferred', path: query.path };
      }
    }
    used += encodedLength(entry) + 1;
    entries.push(entry);
  });
  return { kind: 'result', result: { documents: entries } };
}

function fitBuffer(query, doc, revision, budget, room, shrink) {
  const text = wellFormed(doc.text);
  for (;;) {
    const slice = sliceLines(text, query.startLine, query.endLine, budget);
    const entry = {
      kind: 'buffer',
      path: query.path,
      state: doc.state,
      dirty: doc.dirty,
      revision,
      text: slice.text,
      totalLines: slice.totalLines,
      truncated: slice.truncated,
      lineCut: slice.lineCut
    };
    if (slice.range) entry.range = { startLine: slice.range[0], endLine: slice.range[1] };
    if (encodedLength(entry) <= room) return entry;
    if (!shrink || budget <= MIN_PAGE_BUDGET) return null;
    budget = Math.max(MIN_PAGE_BUDGET, Math.floor(budget / 2));
  }
}

/**
 * `editor.bufferIndex`: every open or unsaved buffer, without text, in path
 * order, up to `maxEntries` and within the ceiling; the rest are counted as
 * `omitted`.
 */
export function answerBufferIndex(request, documents, revisionOf, ceiling = MAX_REPLY_BYTES) {
  const maxEntries = request?.maxEntries;
  if (!Number.isInteger(maxEntries) || maxEntries < 0) return refusal('invalidRequest');
  const limit = Math.min(maxEntries, MAX_INDEX_ENTRIES);
  const buffered = [...documents.values()]
    .filter((doc) => doc.state !== 'closedClean')
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  // Room for the largest possible `omitted` count, then entries in order.
  let used = encodedLength({ kind: 'result', result: { entries: [], omitted: 4294967295 } });
  const entries = [];
  for (const doc of buffered) {
    if (entries.length >= limit) break;
    const entry = {
      path: doc.path,
      state: doc.state,
      dirty: doc.dirty,
      revision: revisionOf(doc),
      byteLength: utf8Length(doc.text)
    };
    const bytes = encodedLength(entry) + 1;
    if (used + bytes > ceiling) break;
    used += bytes;
    entries.push(entry);
  }
  return { kind: 'result', result: { entries, omitted: buffered.length - entries.length } };
}

// ─── The bridge ────────────────────────────────────────────────────────────

/**
 * @param {object} deps
 * @param {{ sessionDocuments: () => Map<string, {tabId:any, path:string, state:string, dirty:boolean, text:string}> }} deps.ports
 *   Read-only owner ports (EditorDomain's `getSessionDocumentsByPath`).
 * @param {{ attach: (epoch: string) => Promise<string>, detach: (generation: string) => Promise<unknown>,
 *   reply: (requestId: string, generation: string, reply: string) => Promise<unknown> }} deps.transport
 *   Use `serializeAttachments` around the raw Tauri calls.
 * @param {() => (string|null)} deps.getWorkspaceEpoch  The frontend's current epoch (dbStorage).
 */
export function createProjectApiBridge({ ports, transport, getWorkspaceEpoch, ceiling = MAX_REPLY_BYTES }) {
  // `attaching`: an attach in flight, with the requests that arrived for its
  // epoch before its generation was known (Rust records the attach, and may
  // emit, before the attach call returns here).
  const state = { readyEpoch: null, attached: null, attaching: null, disposed: false };
  const replied = new Set();
  const revisionOf = createRevisions();
  const enqueue = transport.enqueue ?? ((work) => work());

  async function reconcile() {
    const wanted = state.disposed ? null : state.readyEpoch;
    if (state.attached && state.attached.epoch === wanted) return;
    if (state.attached) {
      const { generation } = state.attached;
      // Cleared first: a request arriving while the detach is in flight is
      // addressed to a generation this bridge no longer answers for.
      state.attached = null;
      await transport.detach(generation).catch(() => {});
    }
    if (!wanted) return;
    const attaching = { epoch: wanted, held: [] };
    state.attaching = attaching;
    let generation;
    try {
      generation = await transport.attach(wanted);
    } catch {
      generation = null; // refused (the workspace moved on): stay detached until ready again
    } finally {
      state.attaching = null;
    }
    if (typeof generation !== 'string') return;
    if (state.disposed || state.readyEpoch !== wanted) {
      await transport.detach(generation).catch(() => {});
      return;
    }
    state.attached = { epoch: wanted, generation };
    // Each held request still passes every check, now against the known generation.
    for (const event of attaching.held) handleRequest(event);
  }

  function schedule() {
    return enqueue(reconcile);
  }

  /**
   * Answer one bridge request event. Returns false, without replying, when
   * the event is not addressed to this bridge's current generation (another
   * listener's, or one from before a re-attach) or was already answered. A
   * request for the epoch being attached right now is held until the attach
   * returns its generation, then checked like any other.
   */
  function handleRequest(event) {
    if (!event || typeof event !== 'object' || typeof event.requestId !== 'string') return false;
    const generation = state.attached?.generation;
    if (!generation) {
      const attaching = state.attaching;
      if (attaching && event.epoch === attaching.epoch && attaching.held.length < HELD_WHILE_ATTACHING) {
        attaching.held.push(event);
        return true;
      }
      return false;
    }
    if (event.generation !== generation) return false;
    if (replied.has(event.requestId)) return false;
    replied.add(event.requestId);
    if (replied.size > REMEMBERED_REQUESTS) replied.delete(replied.values().next().value);

    let reply;
    try {
      const epoch = event.epoch;
      reply = epoch === state.readyEpoch && epoch === state.attached.epoch && epoch === getWorkspaceEpoch()
        ? answer(event.op, event.request)
        : refusal('workspaceChanged');
    } catch {
      reply = refusal('internal');
    }
    let text = JSON.stringify(reply);
    if (utf8Length(text) > ceiling) text = JSON.stringify(refusal('internal'));
    transport.reply(event.requestId, generation, text).catch(() => {});
    return true;
  }

  function answer(op, request) {
    const documents = ports.sessionDocuments();
    switch (op) {
      case BRIDGE_OPS.documents:
        return answerDocuments(request, documents, revisionOf, ceiling);
      case BRIDGE_OPS.bufferIndex:
        return answerBufferIndex(request, documents, revisionOf, ceiling);
      default:
        return refusal('unknownOperation');
    }
  }

  return {
    /** The epoch this bridge may answer for, or null (not hydrated). */
    setReadyEpoch(epoch) {
      const next = typeof epoch === 'string' && epoch ? epoch : null;
      if (next === state.readyEpoch) return Promise.resolve();
      state.readyEpoch = next;
      return schedule();
    },

    handleRequest,

    dispose() {
      state.disposed = true;
      return schedule();
    },

    /** For tests and diagnostics. */
    snapshot() {
      return {
        readyEpoch: state.readyEpoch,
        attachedEpoch: state.attached?.epoch ?? null,
        generation: state.attached?.generation ?? null
      };
    }
  };
}
