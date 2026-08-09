// crashDomain.js — pure logic for the crash-capture system (node-tested).
//
// Runtime concerns (listeners, invoke, debounce timers) live in
// breadcrumbs.js / errorCapture.js; everything here is data-in → data-out.

export const RING_CAP = 100;
export const REPORT_URL_MAX = 7000; // stay under ~8KB browser URL limits
export const REPO_ISSUE_BASE = 'https://github.com/DalL337/litria/issues/new';

// ── Breadcrumb ring ─────────────────────────────────────────────────────────

/** Append a crumb, evicting the oldest past `cap`. Mutates and returns arr. */
export function pushCrumb(arr, crumb, cap = RING_CAP) {
  arr.push(crumb);
  if (arr.length > cap) {
    arr.splice(0, arr.length - cap);
  }
  return arr;
}

/** One JSONL line per crumb — the on-disk mirror format the Rust side stores. */
export function serializeRingJsonl(crumbs) {
  return crumbs.map((c) => JSON.stringify(c)).join('\n');
}

// ── Capture filters & dedupe ────────────────────────────────────────────────

/** Monaco cancellations leak as unhandled rejections by design — not crashes. */
export function shouldCaptureRejection(reason) {
  if (reason && typeof reason === 'object' && reason.name === 'Canceled') return false;
  return true;
}

/**
 * Dedupe between the window-handler path and the React root-option path
 * (React 19 reports uncaught render errors via BOTH reportError→window and
 * onUncaughtError). Key by message+first stack line inside a short window.
 */
export function dedupeKey(message, stack) {
  const firstStackLine = typeof stack === 'string' ? stack.split('\n', 2).join('|') : '';
  return `${message}::${firstStackLine}`;
}

export function isDuplicate(recentMap, key, nowMs, windowMs = 2000) {
  const last = recentMap.get(key);
  recentMap.set(key, nowMs);
  // Opportunistic cleanup so the map can't grow unbounded.
  if (recentMap.size > 50) {
    for (const [k, t] of recentMap) {
      if (nowMs - t > windowMs) recentMap.delete(k);
    }
  }
  return typeof last === 'number' && nowMs - last < windowMs;
}

// ── Crash record ────────────────────────────────────────────────────────────

export function buildCrashRecord({
  layer,
  message,
  stack = null,
  source = null,
  componentStack = null,
  breadcrumbs = [],
  session = {},
  litriaVersion = 'unknown',
  os = 'unknown',
  timestamp = new Date().toISOString()
}) {
  const error = {
    message: typeof message === 'string' && message ? message.slice(0, 4000) : 'unknown error'
  };
  if (typeof stack === 'string' && stack) error.stack = stack.slice(0, 16000);
  if (typeof source === 'string' && source) error.source = source.slice(0, 500);
  if (typeof componentStack === 'string' && componentStack) {
    error.componentStack = componentStack.slice(0, 8000);
  }
  return {
    schema: 1,
    timestamp,
    litriaVersion,
    os,
    layer,
    error,
    breadcrumbs: breadcrumbs.slice(-RING_CAP),
    session
  };
}

/** Normalize whatever a handler received into { message, stack }. */
export function normalizeErrorLike(errorLike, fallbackMessage = 'unknown error') {
  if (errorLike instanceof Error) {
    return { message: errorLike.message || fallbackMessage, stack: errorLike.stack || null };
  }
  if (errorLike && typeof errorLike === 'object') {
    const message = typeof errorLike.message === 'string' && errorLike.message
      ? errorLike.message
      : fallbackMessage;
    const stack = typeof errorLike.stack === 'string' ? errorLike.stack : null;
    return { message, stack };
  }
  if (typeof errorLike === 'string' && errorLike) {
    return { message: errorLike, stack: null };
  }
  return { message: fallbackMessage, stack: null };
}

// ── Report assembly (the ONLY place scrubbing happens — local logs keep
//    full fidelity; the pre-filled issue is where text goes public) ─────────

export function scrubText(text, { home = '', projectRoot = '' } = {}) {
  if (typeof text !== 'string' || !text) return text;
  let out = text;
  const variants = (p) => (p ? [p, p.replace(/\\/g, '/'), p.replace(/\//g, '\\')] : []);
  for (const root of variants(projectRoot)) {
    if (root) out = out.split(root).join('<project>');
  }
  for (const h of variants(home)) {
    if (h) out = out.split(h).join('~');
  }
  return out;
}

export function buildIssueUrl({
  record,
  filePath = '',
  home = '',
  projectRoot = '',
  base = REPO_ISSUE_BASE,
  maxLen = REPORT_URL_MAX
}) {
  const scrub = (t) => scrubText(t ?? '', { home, projectRoot });
  const message = scrub(record?.error?.message ?? 'Litria crash');
  const title = `[crash][${record?.layer ?? '?'}] ${message}`.slice(0, 120);

  const crumbTail = (record?.breadcrumbs ?? [])
    .slice(-10)
    .map((c) => `- ${c.t ?? ''} ${c.kind ?? ''}: ${scrub(String(c.name ?? ''))}`)
    .join('\n');

  const bodyParts = [
    `**Layer**: ${record?.layer ?? 'unknown'}`,
    `**Litria**: ${record?.litriaVersion ?? '?'} · **OS**: ${record?.os ?? '?'}`,
    `**When**: ${record?.timestamp ?? '?'}`,
    '',
    '**Error**',
    '```',
    scrub([record?.error?.message, record?.error?.source, record?.error?.stack]
      .filter(Boolean)
      .join('\n'))
      .slice(0, 2500),
    '```',
    crumbTail ? `**Recent actions**\n${crumbTail}` : '',
    '',
    '---',
    `Full crash file (please attach it): \`${scrub(filePath) || '~/.litria/logs/crashes/'}\``
  ].filter((p) => p !== '');

  let body = bodyParts.join('\n');
  let url = `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  // Loop: trimming raw chars only guarantees ≥1 encoded char each, and the
  // appended suffix itself percent-encodes to ~66 chars — a single pass can
  // land over the cap. Bounded: body shrinks strictly every iteration.
  const suffix = '\n…(truncated — see attached file)';
  while (url.length > maxLen && body.length > 200) {
    const overshoot = url.length - maxLen;
    const keep = Math.max(160, body.length - overshoot - suffix.length);
    body = body.slice(0, keep) + suffix;
    url = `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
    if (keep === 160) break; // floor reached; title alone can't exceed the cap
  }
  return url;
}
