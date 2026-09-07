/**
 * search.js — finding a setting in the Preferences panel
 * (brief-preferences-panel-v2.md, slice 4).
 *
 * Preferences is the exhaustive home for every setting (ADR-019's
 * completeness invariant), so it has to be searchable. This module is the
 * pure half: it matches registry entries by label and caption, filters
 * rooms without dropping them (the rail keeps a dimmed room so the shape
 * of the panel never jumps), and splits text into highlight segments.
 * No React, no DOM.
 */

export function normalizeQuery(query) {
  return String(query ?? '').trim().toLowerCase();
}

/** Case-insensitive substring match; an empty query matches everything. */
export function textMatches(text, query) {
  const q = normalizeQuery(query);
  if (!q) return true;
  return String(text ?? '').toLowerCase().includes(q);
}

/** A registry entry matches on its label or its always-visible caption. */
export function entryMatches(entry, query) {
  return textMatches(entry?.label, query) || textMatches(entry?.caption, query);
}

/**
 * Rooms with their entries narrowed to the query. Every room comes back
 * (with `total` = its unfiltered count) so the rail can show "0/4" and dim
 * the room instead of removing it.
 */
export function filterRooms(rooms, query) {
  return rooms.map((room) => ({
    ...room,
    total: room.entries.length,
    entries: room.entries.filter((entry) => entryMatches(entry, query))
  }));
}

/**
 * Text split into segments for highlighting: [{ text, hit }]. Matching is
 * case-insensitive; the original casing is preserved in the segments. An
 * empty query yields one non-hit segment.
 */
export function highlight(text, query) {
  const source = String(text ?? '');
  const q = normalizeQuery(query);
  if (!q || !source) return [{ text: source, hit: false }];
  const lower = source.toLowerCase();
  const segments = [];
  let cursor = 0;
  let index = lower.indexOf(q, cursor);
  while (index >= 0) {
    if (index > cursor) segments.push({ text: source.slice(cursor, index), hit: false });
    segments.push({ text: source.slice(index, index + q.length), hit: true });
    cursor = index + q.length;
    index = lower.indexOf(q, cursor);
  }
  if (cursor < source.length) segments.push({ text: source.slice(cursor), hit: false });
  return segments;
}
