// Pure state helpers for the canvas quick-action HUD (ADR-018 Phase A).
// React-free so the visibility-set model, clamping, and persistence
// round-trip are unit-testable under node --test (test/domains/hudState.test.mjs).
//
// The container contract is { id, title, defaultVisible } — rendering for each
// widget id lives in src/components/CanvasHud.jsx. The checkbox menu and the
// section list are both generated from this registry, so adding widget N+1
// (ADR-018 Phases B/C) is append-one-entry here plus a renderer in the component.

export const HUD_WIDGETS = [
  { id: 'create', title: 'Create', defaultVisible: true },
  { id: 'panzoom', title: 'Pan & Zoom', defaultVisible: true },
  // defaultVisible resolves the ADR-018 open question: checked on first
  // sight (the knownIds migration auto-checks it for existing prefs),
  // persisted off forever once the user clears it.
  { id: 'help', title: 'Help — Shortcuts', defaultVisible: true },
];

// Registry ids that existed before persisted state carried `knownIds`.
// A legacy pref (Phase A) can't tell "user unchecked it" from "it didn't
// exist yet" — this list is the registry as of that era, so anything not
// in it is treated as newly introduced.
const LEGACY_KNOWN_IDS = ['create'];

export const HUD_DEFAULT_POSITION = { x: 16, y: 16 };
export const HUD_CLAMP_MARGIN = 8;
export const HUD_PREF_KEY = 'hudState';

export function getDefaultVisibleIds(widgets = HUD_WIDGETS) {
  return widgets.filter((w) => w.defaultVisible).map((w) => w.id);
}

/** Toggle one widget id in the visible set. Returns a new array. */
export function toggleVisibleId(visibleIds, id) {
  const ids = Array.isArray(visibleIds) ? visibleIds : [];
  return ids.includes(id) ? ids.filter((v) => v !== id) : [...ids, id];
}

/**
 * Clamp the HUD position so the pill can never be stranded outside the
 * canvas area (ADR-018: clamp on drag, on resize, and on restore).
 * Degenerate containers (smaller than the HUD) pin to the margin.
 */
export function clampHudPosition(position, { hudWidth, hudHeight, containerWidth, containerHeight, margin = HUD_CLAMP_MARGIN }) {
  const x = Number.isFinite(position?.x) ? position.x : HUD_DEFAULT_POSITION.x;
  const y = Number.isFinite(position?.y) ? position.y : HUD_DEFAULT_POSITION.y;
  const maxX = Math.max(margin, (containerWidth ?? 0) - (hudWidth ?? 0) - margin);
  const maxY = Math.max(margin, (containerHeight ?? 0) - (hudHeight ?? 0) - margin);
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
  };
}

/**
 * Normalize a raw (possibly corrupt / stale) persisted value into a valid
 * HUD state. Unknown widget ids are dropped (a widget may be removed between
 * versions); missing fields fall back to defaults. Never throws.
 */
export function normalizeHudState(raw, widgets = HUD_WIDGETS) {
  const knownIds = new Set(widgets.map((w) => w.id));
  const fallbackVisible = getDefaultVisibleIds(widgets);
  if (!raw || typeof raw !== 'object') {
    return {
      x: HUD_DEFAULT_POSITION.x,
      y: HUD_DEFAULT_POSITION.y,
      visibleIds: fallbackVisible,
      hidden: false,
    };
  }
  // A widget introduced AFTER this state was saved should appear with its
  // default visibility rather than silently unchecked — the persisted set
  // only records choices the user could actually have made. `knownIds`
  // (saved alongside the set) is the registry as the user last saw it.
  const knownAtSave = new Set(
    Array.isArray(raw.knownIds) ? raw.knownIds : LEGACY_KNOWN_IDS
  );
  const savedVisible = Array.isArray(raw.visibleIds)
    ? raw.visibleIds.filter((id) => knownIds.has(id))
    : fallbackVisible;
  const withNewDefaults = [
    ...savedVisible,
    ...widgets
      .filter((w) => w.defaultVisible && !knownAtSave.has(w.id) && !savedVisible.includes(w.id))
      .map((w) => w.id),
  ];
  return {
    x: Number.isFinite(raw.x) ? raw.x : HUD_DEFAULT_POSITION.x,
    y: Number.isFinite(raw.y) ? raw.y : HUD_DEFAULT_POSITION.y,
    visibleIds: withNewDefaults,
    hidden: raw.hidden === true,
  };
}

/** Parse the persisted JSON pref. Corrupt JSON yields defaults, never throws. */
export function parseHudState(json, widgets = HUD_WIDGETS) {
  if (typeof json !== 'string' || !json) return normalizeHudState(null, widgets);
  try {
    return normalizeHudState(JSON.parse(json), widgets);
  } catch {
    return normalizeHudState(null, widgets);
  }
}

export function serializeHudState({ x, y, visibleIds, hidden }, widgets = HUD_WIDGETS) {
  return JSON.stringify({
    x,
    y,
    visibleIds,
    hidden: Boolean(hidden),
    // Registry snapshot: lets a future load distinguish "user unchecked
    // this widget" from "this widget didn't exist when they last saved".
    knownIds: widgets.map((w) => w.id),
  });
}
