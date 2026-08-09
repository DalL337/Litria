/**
 * Toast.jsx — Minimal, app-wide transient notifications.
 *
 * A tiny module-level store + a `<ToastViewport/>` rendered once near the app
 * root. Any code can fire a toast with the imported `showToast(message, opts)`
 * — no context/provider wiring needed.
 *
 * Distinct from PillNotification, which is terminal-coupled (terminal icon,
 * click-opens-terminal). Use toasts for generic canvas/editor feedback such as
 * "Already imported".
 *
 *   import { showToast } from './components/Toast';
 *   showToast('Already imported', { severity: 'info' });
 */

import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';

const DEFAULT_DURATION_MS = 4000;

let toasts = [];
let listeners = new Set();
let nextId = 1;

function emit() {
  for (const fn of listeners) fn();
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function getSnapshot() {
  return toasts;
}

/**
 * Show a transient toast.
 * @param {string} message
 * @param {{ severity?: 'info'|'success'|'error', duration?: number }} [opts]
 *   duration ≤ 0 keeps it until manually dismissed.
 * @returns {number} toast id
 */
export function showToast(message, { severity = 'info', duration = DEFAULT_DURATION_MS } = {}) {
  if (!message) return -1;
  const id = nextId++;
  toasts = [...toasts, { id, message, severity }];
  emit();
  if (duration > 0) {
    setTimeout(() => dismissToast(id), duration);
  }
  return id;
}

/** Dismiss a toast by id. */
export function dismissToast(id) {
  const next = toasts.filter((t) => t.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

/** Render-once viewport. Mount near the app root. */
export function ToastViewport() {
  const items = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  if (items.length === 0) return null;

  return (
    <div className="toast-viewport">
      {items.map((t) => (
        <div key={t.id} className={`toast toast-${t.severity}`} role="status">
          <span className="toast-text">{t.message}</span>
          <button
            className="toast-dismiss"
            type="button"
            aria-label="Dismiss"
            onClick={() => dismissToast(t.id)}
          >
            <X size={10} />
          </button>
        </div>
      ))}
    </div>
  );
}

export default ToastViewport;
