// path.js — pure path utilities (POSIX/Windows agnostic)
//
// Extracted from App.jsx during the app-shell refactor (Session 1, Group A).
// Previously these lived as useCallback wrappers in App.jsx; they have zero
// state dependency, so they belong as module-level pure functions.

export function normalizePath(path) {
  return typeof path === 'string'
    ? path.replace(/\\/g, '/').replace(/^\/+/, '')
    : '';
}

export function getBasename(path) {
  const normalized = normalizePath(path);
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

export function getDirname(path) {
  const normalized = normalizePath(path);
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '';
  return normalized.slice(0, index);
}

export function toFolderSegment(value) {
  const normalized = typeof value === 'string'
    ? value.trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-')
    : '';
  const trimmed = normalized.replace(/^-+|-+$/g, '');
  return trimmed || 'group';
}

// Derive a root-level folder path from a display name, uniquified against
// paths already in use (case-insensitive — Windows filesystems are). Used by
// group promotion so "utils" as a group name can't merge into an existing
// utils/ folder and swallow its files into the new group.
export function uniqueFolderSegment(name, takenPaths) {
  const base = toFolderSegment(name);
  const taken = new Set();
  for (const path of takenPaths ?? []) {
    const normalized = normalizePath(path).toLowerCase();
    if (normalized) taken.add(normalized);
  }
  let candidate = base;
  let counter = 2;
  while (taken.has(candidate.toLowerCase())) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

// Windows reserves DOS device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9) as
// path components — bare or with any extension (`con.py` parses as the CON
// device). Litria's Rust layer writes through \\?\-verbatim paths, which
// BYPASS that reservation (live-verified 2026-07-28: con.py created fine),
// so without this check the app can mint files most other Windows tools
// cannot open, rename, or delete. Enforced on every platform — a project
// authored on macOS/Linux breaks for a Windows collaborator at clone time.
// The stem is the segment up to the FIRST dot (Windows device parsing);
// a leading dot means an empty stem, so `.con` is legal.
const RESERVED_DEVICE_STEM = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

// Returns the first path segment that collides with a reserved Windows
// device name, or null when the path is clean. Accepts full relative paths
// (checks every segment) or single names.
export function findReservedDeviceSegment(path) {
  if (typeof path !== 'string') return null;
  for (const rawSegment of path.replace(/\\/g, '/').split('/')) {
    const segment = rawSegment.trim();
    if (!segment) continue;
    const stem = segment.split('.', 1)[0].trim();
    if (RESERVED_DEVICE_STEM.test(stem)) return segment;
  }
  return null;
}

// Split an absolute OS path at its last separator, preserving the original
// separator style (unlike getDirname/getBasename, which normalize to '/').
// Used where the directory half is handed back to the OS as-is (e.g. the
// single-file launch flows). No separator -> { dir: '', base: path }.
export function splitPathAtLastSeparator(path) {
  const value = typeof path === 'string' ? path : '';
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'));
  if (index < 0) return { dir: '', base: value };
  let dir = value.slice(0, index);
  // Keep the separator when the parent is a filesystem root: 'C:' alone is
  // drive-RELATIVE on Windows (resolves against the drive's CWD) and ''
  // would drop a POSIX root entirely.
  if (dir === '' || /^[A-Za-z]:$/.test(dir)) {
    dir = value.slice(0, index + 1);
  }
  return { dir, base: value.slice(index + 1) };
}

// Number.isFinite is a static method that doesn't depend on `this`,
// so a direct alias is safe and avoids a wrapper closure.
export const isFiniteNumber = Number.isFinite;
