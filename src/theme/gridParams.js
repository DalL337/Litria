/**
 * gridParams.js — declarative grid paint parameters for the theme editor
 * (ADR-030: themes paint the grid; brief §6 "Theme and preference
 * editing"). Same contract as materialParams.js: the Settings drawer renders
 * this list instead of hard-coding sliders.
 *
 * Opacities are the theme's line visibility, stated as white-line opacity;
 * tinted ink is luma-matched at render time (gridPaint.js), so a value means
 * the same visibility whatever the grid's color.
 */

import { GRID_SUB_OPACITY_RATIO, readOpacity } from './gridPaint.js';

export const GRID_COLOR_TOKEN = 'canvasGridColor';

export const GRID_PARAMETERS = Object.freeze([
  { token: 'canvasGridAccentOpacity', label: 'Major lines', type: 'range', min: 0, max: 0.25, step: 0.005, decimals: 3 },
  { token: 'canvasGridOpacity', label: 'Minor lines', type: 'range', min: 0, max: 0.25, step: 0.005, decimals: 3 },
  {
    token: 'canvasGridSubOpacity',
    label: 'Sub lines',
    type: 'range',
    min: 0,
    max: 0.25,
    step: 0.005,
    decimals: 3,
    // Unset, the sub level follows the minor level.
    fallbackValue: (tokens) => readOpacity(tokens?.canvasGridOpacity, 0.03) * GRID_SUB_OPACITY_RATIO,
  },
]);
