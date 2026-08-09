/**
 * materialParams.js — declarative material parameter contract (ADR-019
 * Slice 3).
 *
 * Each node material declares which theme tokens it exposes as editable
 * parameters. Settings surfaces render `parametersForMaterial(activeMaterial)`
 * instead of hardcoding sliders, so a material's knobs appear only while that
 * material is active, and a future material brings its own parameters with
 * zero surface edits.
 *
 * Until now this mapping was implicit in the renderer (PuzzlePiece.jsx's
 * glass/matte branches); this file makes it a contract. Param shape:
 * - token     theme token key (must exist in GLASS_THEME_TOKEN_DEFAULTS)
 * - label     display name
 * - type      'range' (min/max/step/decimals[/unit]) | 'choice' (options)
 */

import { GLASS_THEME_TOKEN_DEFAULTS } from './themeDefaults.js';

export const NODE_MATERIALS = [
  { id: 'glass', label: 'Glass' },
  { id: 'matte', label: 'Matte' }
];

/** Coerce a theme's nodeMaterial token to a known material id (renderer rule). */
export function resolveMaterialId(tokens) {
  return tokens?.nodeMaterial === 'matte' ? 'matte' : 'glass';
}

const SHARED_PARAMETERS = [
  { token: 'nodeSurfaceAlpha', label: 'Surface Alpha', type: 'range', min: 0, max: 1, step: 0.01, decimals: 2 },
  { token: 'nodeCornerRadius', label: 'Corner Radius', type: 'range', min: 2, max: 24, step: 1, decimals: 0, unit: 'px' },
  { token: 'nodeLedSize', label: 'LED Size', type: 'range', min: 12, max: 50, step: 1, decimals: 0, unit: 'px' },
  { token: 'nodeLedStyle', label: 'LED Style', type: 'choice', options: ['dot', 'arc'] }
];

const MATERIAL_PARAMETERS = {
  glass: [
    { token: 'glassBlurRadius', label: 'Blur Radius', type: 'range', min: 0, max: 30, step: 1, decimals: 0, unit: 'px' },
    { token: 'glassRimWidth', label: 'Rim Width', type: 'range', min: 0.5, max: 3, step: 0.1, decimals: 1, unit: 'px' }
  ],
  matte: [
    { token: 'matteBorderWidth', label: 'Border Width', type: 'range', min: 0, max: 4, step: 0.5, decimals: 1, unit: 'px' }
  ]
};

/**
 * The parameters a settings surface renders for a material: the material's
 * own knobs first, then the shared node parameters.
 */
export function parametersForMaterial(materialId) {
  return [...(MATERIAL_PARAMETERS[materialId] ?? []), ...SHARED_PARAMETERS];
}

/** Test seam: every declared token must exist in the theme token defaults. */
export function listDeclaredTokens() {
  const all = [...SHARED_PARAMETERS, ...Object.values(MATERIAL_PARAMETERS).flat()];
  return all.map((p) => p.token);
}

export function tokenExistsInDefaults(token) {
  return Object.prototype.hasOwnProperty.call(GLASS_THEME_TOKEN_DEFAULTS, token);
}
