// errorCapture.js — hooks #1/#2 runtime: window handlers, React 19 root
// options, record assembly, and the write path to the Rust side.
//
// React 19 capture matrix (research 2026-07-06):
//   - uncaught render errors → onUncaughtError (custom handler REPLACES the
//     default reportError call, so window handlers see nothing — dedupe is
//     belt-and-braces, not load-bearing, for this path)
//   - boundary-caught render errors → onCaughtError ONLY (never window)
//   - event handlers / rAF / Konva / promises → window handlers

import {
  buildCrashRecord,
  dedupeKey,
  isDuplicate,
  normalizeErrorLike,
  shouldCaptureRejection
} from './crashDomain.js';
import { crumb, flushNow, snapshotCrumbs } from './breadcrumbs.js';
import { invokeSafe } from './invoke.js';

const session = {
  id: (globalThis.crypto?.randomUUID?.() ?? `s-${Date.now()}`),
  startedAt: Date.now(),
  projectName: null,
  version: 'unknown',
  os: 'unknown'
};

const recentErrors = new Map();
let lastRecord = null;
let lastRecordPath = null;

export function setCrashAppInfo({ version, os }) {
  if (typeof version === 'string' && version) session.version = version;
  if (typeof os === 'string' && os) session.os = os;
}

export function setCrashProjectName(name) {
  session.projectName = typeof name === 'string' && name ? name : null;
}

export function getLastCrash() {
  return { record: lastRecord, path: lastRecordPath };
}

async function writeRecord(record) {
  lastRecord = record;
  lastRecordPath = null;
  await flushNow();
  lastRecordPath = await invokeSafe('crash_write_js_record', { record });
  return lastRecordPath;
}

export function captureError(layer, errorLike, extra = {}) {
  const { message, stack } = normalizeErrorLike(errorLike);
  const key = dedupeKey(message, stack);
  if (isDuplicate(recentErrors, key, Date.now())) return null;

  crumb('crash', `${layer}: ${message.slice(0, 80)}`);
  const record = buildCrashRecord({
    layer,
    message,
    stack,
    source: extra.source ?? null,
    componentStack: extra.componentStack ?? null,
    breadcrumbs: snapshotCrumbs(),
    session: {
      id: session.id,
      uptimeSecs: Math.round((Date.now() - session.startedAt) / 1000),
      projectName: session.projectName
    },
    litriaVersion: session.version,
    os: session.os
  });
  return writeRecord(record);
}

let installed = false;

/** Install the global window handlers once (main.jsx). */
export function installGlobalHandlers() {
  if (installed) return;
  installed = true;

  window.addEventListener('error', (event) => {
    const source = event.filename
      ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}`
      : null;
    captureError('js', event.error ?? event.message, { source });
  });

  window.addEventListener('unhandledrejection', (event) => {
    if (!shouldCaptureRejection(event.reason)) return;
    captureError('js', event.reason ?? 'unhandled promise rejection', {
      source: 'unhandledrejection'
    });
  });
}

/** React 19 root options — pass to createRoot(container, reactRootOptions). */
export const reactRootOptions = {
  onUncaughtError(error, errorInfo) {
    captureError('react', error, { componentStack: errorInfo?.componentStack ?? null });
  },
  onCaughtError(error, errorInfo) {
    captureError('react', error, { componentStack: errorInfo?.componentStack ?? null });
  }
};
