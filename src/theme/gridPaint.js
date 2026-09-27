/**
 * gridPaint.js — how a theme paints the structural grid (ADR-030 addendum,
 * owner rulings 2026-09-27: themes paint, the workspace owns spacing).
 *
 * Tokens a theme may carry (all strings, like every theme token):
 *   canvasGridOpacity        minor-level line opacity (existing)
 *   canvasGridAccentOpacity  major-level line opacity (existing)
 *   canvasGridSubOpacity     sub-level line opacity; absent means
 *                            GRID_SUB_OPACITY_RATIO × the minor opacity
 *   canvasGridColor          line ink; absent means the theme's wire color
 *                            (connectionStroke), so a custom theme gets a
 *                            tinted grid without declaring one
 *
 * Tinted ink is darker than white, so at white's opacity it nearly vanishes
 * (a blue accent draws about half as bright). The opacity is therefore scaled
 * by the luma ratio against the canvas background: a tinted line stays
 * exactly as visible as the white line the token describes, and only its hue
 * changes. Neutral ink is white at the token's opacity, as before the grid.
 *
 * A personal override (the Grid widget's sliders) replaces the three
 * opacities for one theme, energy and ink; it is the actual line opacity,
 * already including any luma gain. Changing any of the three shows that
 * combination's own values, as the playground's sliders did.
 *
 * Pure: no React, Konva or DOM imports.
 */

import { parseColorToRgb } from '../utils/color.js';

// The canvas background fill (CanvasGrid). Luma matching is measured against it.
export const CANVAS_BACKGROUND = '#0d0f14';

export const GRID_SUB_OPACITY_RATIO = 0.6;

export const GRID_INK_OPTIONS = Object.freeze(['theme', 'neutral']);

const WHITE = Object.freeze({ r: 255, g: 255, b: 255 });

// Fallbacks when a token is missing or unusable (today's CanvasGrid values).
const DEFAULT_MINOR = 0.03;
const DEFAULT_MAJOR = 0.06;

const luma = ({ r, g, b }) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** A finite opacity in [0, 1] from a token string, or the fallback. Zero is kept. */
export function readOpacity(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** The ink a theme paints its grid with, as {r, g, b}. */
export function gridInkColor(tokens, ink = 'theme') {
  if (ink === 'neutral') return WHITE;
  return parseColorToRgb(tokens?.canvasGridColor)
    ?? parseColorToRgb(tokens?.connectionStroke)
    ?? WHITE;
}

/**
 * The factor that keeps a line of this ink as visible as a white one at the
 * same opacity, over the canvas background. 1 for white.
 */
export function gridInkGain(color, background = CANVAS_BACKGROUND) {
  const bg = luma(parseColorToRgb(background) ?? { r: 0, g: 0, b: 0 });
  // White measured by the same function, so its gain is exactly 1.
  return (luma(WHITE) - bg) / Math.max(1, luma(color) - bg);
}

/** The theme's own line opacities for its ink, before any personal override. */
export function themeGridOpacities(tokens, ink = 'theme') {
  const gain = gridInkGain(gridInkColor(tokens, ink));
  const minor = readOpacity(tokens?.canvasGridOpacity, DEFAULT_MINOR);
  const major = readOpacity(tokens?.canvasGridAccentOpacity, DEFAULT_MAJOR);
  const sub = readOpacity(tokens?.canvasGridSubOpacity, minor * GRID_SUB_OPACITY_RATIO);
  const clamp = (value) => Math.min(1, value * gain);
  return { major: clamp(major), minor: clamp(minor), sub: clamp(sub) };
}

/** The key a personal paint override is stored under: one per theme, energy and ink. */
export function gridPaintOverrideKey(themeId, energyLevel, ink = 'theme') {
  return `${themeId ?? 'glass'}:${energyLevel === 'calm' ? 'calm' : 'live'}:${ink === 'neutral' ? 'neutral' : 'theme'}`;
}

function readOverride(override) {
  if (!override || typeof override !== 'object') return null;
  const levels = ['major', 'minor', 'sub'];
  if (!levels.every((level) => Number.isFinite(override[level]))) return null;
  return Object.fromEntries(levels.map((level) => [level, Math.min(1, Math.max(0, override[level]))]));
}

/**
 * Everything CanvasGrid needs to paint: the ink and each level's opacity.
 * `overrides` is the stored map of personal overrides; the entry for this
 * theme, energy and ink, when valid, replaces the theme's opacities.
 */
export function resolveGridPaint(tokens, {
  ink = 'theme',
  themeId = null,
  energyLevel = 'live',
  overrides = null,
} = {}) {
  const color = gridInkColor(tokens, ink);
  const override = readOverride(overrides?.[gridPaintOverrideKey(themeId, energyLevel, ink)]);
  return {
    color,
    ...(override ?? themeGridOpacities(tokens, ink)),
    overridden: Boolean(override),
  };
}

/** `rgba(...)` for a resolved ink at an opacity. */
export function gridStrokeStyle(color, opacity) {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${opacity})`;
}
