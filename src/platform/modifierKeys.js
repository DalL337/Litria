// modifierKeys.js
// Platform-aware modifier key detection.
// Single source of truth — replaces ad-hoc isMac/ctrlOrCmd checks scattered
// across App.jsx, usePieceUiActions.js, and useKeyboardModifiers.js.

import PLATFORM_DEFAULTS from './platformDefaults';

// Detect platform once at module load — the OS won't change at runtime.
const detectedOS = navigator.platform.toUpperCase().includes('MAC') ? 'macos'
  : navigator.platform.toUpperCase().includes('LINUX') ? 'linux'
  : 'windows';

const config = PLATFORM_DEFAULTS[detectedOS] || PLATFORM_DEFAULTS.windows;

/**
 * True when the platform's primary modifier is held on a DOM event.
 * macOS → metaKey (Cmd), Windows/Linux → ctrlKey.
 *
 * Accepts raw DOM events or Konva event wrappers (reads .evt automatically).
 */
export function isPrimaryModifier(event) {
  const e = event?.evt ?? event;
  if (!e) return false;
  return config.modifierKeyCode === 'Meta' ? !!e.metaKey : !!e.ctrlKey;
}

/**
 * Read the primary modifier flag from an event's modifier booleans.
 * Same logic as isPrimaryModifier but for the { ctrlKey, metaKey } shape
 * returned by keyboard events in useKeyboardModifiers.
 */
export function primaryModifierFromFlags(ctrlKey, metaKey) {
  return config.modifierKeyCode === 'Meta' ? !!metaKey : !!ctrlKey;
}

/** The detected platform config for direct access when needed. */
export { config as platformConfig, detectedOS };
