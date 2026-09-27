/**
 * gridWidgetModel.js — the words and numbers the canvas HUD's Grid widget
 * shows (ADR-030 playground-review ruling: the playground's panel ships as
 * is). Pure: no React, no I/O.
 */

import { deriveGridSteps } from '../utils/gridGeometry.js';
import { PIECE_WIDTH, PIECE_HEIGHT } from '../utils/pieceDimensions.js';
import { WIRE_NUDGE_SEAM } from '../utils/wireNudge.js';
import { WIRE_CORRIDOR_SPACING } from '../utils/wireSpacing.js';
import { adjacencyFadeFactor } from '../utils/wireAppearance.js';

// Node scale steps (the Node subsection, the Edit menu and the status bar).
// The range is the app's 25–150%.
export const NODE_SCALE_STEP = 0.25;
export const NODE_SCALE_PRESETS = Object.freeze([0.25, 0.5, 0.75, 1, 1.25, 1.5]);

const EPSILON = 1e-6;
const whole = (value) => Math.abs(value - Math.round(value)) < EPSILON;
const fmt = (value) => {
  const rounded = Math.round(value * 10) / 10;
  return String(Object.is(rounded, -0) ? 0 : rounded);
};

/** "100" for a square step, "100×130" for a rectangular one. */
export function stepText(x, y) {
  return Math.abs(x - y) < EPSILON ? fmt(x) : `${fmt(x)}×${fmt(y)}`;
}

/** How many wires fit side by side in a gap (seam, then a corridor each). */
export function wiresThatFit(gap) {
  if (gap < WIRE_NUDGE_SEAM - EPSILON) return 0;
  return Math.floor((gap - WIRE_NUDGE_SEAM) / WIRE_CORRIDOR_SPACING + EPSILON) + 1;
}

function gapReadout(gap) {
  if (gap < EPSILON) return 'flush';
  const fits = wiresThatFit(gap);
  const ink = Math.round(adjacencyFadeFactor(gap) * 100);
  return `${fmt(gap)} (${fits} wire${fits === 1 ? '' : 's'}, ${ink}% ink)`;
}

/**
 * The Grid spacing subsection's readout for a definition: the three steps,
 * the gaps Strict leaves between neighbors, and any warnings.
 */
export function describeSpacing(definition) {
  const steps = deriveGridSteps(definition);
  const pitch = (size, step) => Math.ceil((size - EPSILON) / step) * step;
  const strictGapX = pitch(PIECE_WIDTH, steps.majorX) - PIECE_WIDTH;
  const strictGapY = pitch(PIECE_HEIGHT, steps.majorY) - PIECE_HEIGHT;
  const warnings = [];
  if (![steps.minorX, steps.minorY, steps.subX, steps.subY].every(whole)) {
    warnings.push('A derived step is not a whole number.');
  }
  if (!whole(10 / steps.subX) || !whole(10 / steps.subY)) {
    warnings.push("The sub step doesn't divide 10, so a flush dock in Flex lands off the lattice (180 and 110 share 10).");
  }
  return {
    steps,
    label: [
      stepText(steps.majorX, steps.majorY),
      stepText(steps.minorX, steps.minorY),
      stepText(steps.subX, steps.subY),
    ].join('·'),
    strictSideBySide: gapReadout(strictGapX),
    strictStacked: gapReadout(strictGapY),
    warnings,
  };
}

/** The Node subsection's value for a selection: '' (none), 'Mixed' or a percent. */
export function scaleReadout(selectedPieces) {
  if (!selectedPieces?.length) return '';
  const scales = new Set(selectedPieces.map((piece) => (Number.isFinite(piece?.scale) ? piece.scale : 1)));
  if (scales.size > 1) return 'Mixed';
  return `${Math.round([...scales][0] * 100)}%`;
}

/** The selection's shared scale, or null when it is empty or mixed. */
export function uniformScale(selectedPieces) {
  if (!selectedPieces?.length) return null;
  const scales = new Set(selectedPieces.map((piece) => (Number.isFinite(piece?.scale) ? piece.scale : 1)));
  return scales.size === 1 ? [...scales][0] : null;
}

/**
 * The status bar's landing readout while a drag is in flight: where the
 * dragged set will land and why, or null outside a drag. (The owner ruled
 * the on-canvas reticle out; the coordinate lives here.)
 */
export function formatLandingReadout(preview) {
  if (!preview) return null;
  if (preview.reason === 'blocked' || !preview.anchor) return '→ no free spot nearby';
  const at = `(${fmt(preview.anchor.x)}, ${fmt(preview.anchor.y)})`;
  const why = preview.reason === 'dock'
    ? 'dock'
    : preview.reason === 'guide'
      ? `aligned · ${preview.level}`
      : preview.level;
  return `→ ${at} · ${why}`;
}

/** The chip each folded subsection shows. */
export function gridSectionChips({ preferences, definition, selectedPieces, themeName, energyLevel }) {
  return {
    placement: `${preferences.snapMode === 'strict' ? 'Strict' : 'Flex'}${preferences.smartGuides ? ' · guides' : ''}`,
    spacing: describeSpacing(definition).label,
    settle: preferences.reduceMotion || preferences.settleMs <= 0 ? 'instant' : `${preferences.settleMs} ms`,
    node: scaleReadout(selectedPieces),
    look: `${themeName ?? 'Theme'} · ${energyLevel === 'calm' ? 'Calm' : 'Live'}`,
  };
}
