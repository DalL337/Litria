// breadcrumbs.js — runtime breadcrumb store: in-memory ring + event-driven
// debounced mirror to the Rust side (crash_append_breadcrumbs).
//
// Content-free by construction: kind + name only, never args, file contents,
// keystrokes, or selection text. The debounce timer is armed ONLY when a
// crumb arrives — an idle app performs zero IPC and zero disk writes.

import { pushCrumb, serializeRingJsonl, RING_CAP } from './crashDomain.js';
import { invokeSafe } from './invoke.js';

const FLUSH_DEBOUNCE_MS = 5000;

const crumbs = [];
let flushTimer = null;
let dirty = false;

export function crumb(kind, name) {
  if (typeof kind !== 'string' || typeof name !== 'string') return;
  pushCrumb(crumbs, { t: new Date().toISOString(), kind, name: name.slice(0, 120) }, RING_CAP);
  dirty = true;
  if (flushTimer === null) {
    // globalThis: the store is imported by modules that node tests also
    // load — timers must not assume a window.
    flushTimer = globalThis.setTimeout(() => {
      flushTimer = null;
      if (dirty) flushNow();
    }, FLUSH_DEBOUNCE_MS);
  }
}

export function snapshotCrumbs() {
  return crumbs.slice();
}

/** Immediate mirror write — called on error capture and shutdown ritual. */
export function flushNow() {
  dirty = false;
  if (flushTimer !== null) {
    globalThis.clearTimeout(flushTimer);
    flushTimer = null;
  }
  return invokeSafe('crash_append_breadcrumbs', { lines: serializeRingJsonl(crumbs) });
}
