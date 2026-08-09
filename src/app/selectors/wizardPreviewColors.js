import { resolveNodeEdgeColor } from './workspaceSelectors.js';
import { pastelizeColor, parseColorToRgb } from '../../utils/color.js';
import { CALM_TOKEN_OVERRIDES } from '../themeDomain.js';
import { BUILTIN_THEME_PRESETS, mergeGlassThemeTokens } from '../../theme/themeDefaults.js';

// Calm pastel scales — the SAME values the canvas applies to the left edge, so
// the wizard preview can't drift from what a project actually renders.
const CALM_EDGE_SCALES = Object.freeze({
  saturationScale: CALM_TOKEN_OVERRIDES.nodeEdgeSaturation,
  lightnessScale: CALM_TOKEN_OVERRIDES.nodeEdgeLightness,
  maxLightness: CALM_TOKEN_OVERRIDES.nodeEdgeMaxLightness
});

/**
 * Pure resolver for WizardStylePreview: given the wizard state, return the
 * colors the preview should paint.
 *
 * The Live/Calm toggle (state.energyLevel) is a *viewing* lens — Calm renders
 * the chosen colors as their pastel equivalents but never mutates the stored
 * project colors. Pick neon green, preview Calm, see pastel green; the project
 * still stores neon green.
 */
export function resolveWizardPreviewColors(state) {
  const calm = state?.energyLevel === 'calm';
  const lens = (color) => (color && calm ? pastelizeColor(color, CALM_EDGE_SCALES) : color);

  const groupColor = lens(state?.groupColor ?? null);
  const nodeDefault = state?.nodeColorMode === 'custom' ? lens(state?.nodeColor ?? null) : null;

  // Group member: no ad-hoc color, IS in a group → inherits the group color.
  const memberEdge = resolveNodeEdgeColor({ id: 'm', color: null }, new Map([['m', groupColor]]), null);
  // Standalone: no group → falls to the ungrouped default (custom node color, or none).
  const standaloneEdge = resolveNodeEdgeColor({ id: 's', color: null }, new Map(), nodeDefault);

  return { groupColor, memberEdge, standaloneEdge };
}

function clampNum(raw, min, max, fallback) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function withAlpha(color, alpha) {
  const rgb = parseColorToRgb(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

/**
 * Resolve the preview node's *material finish* from the chosen base preset.
 *
 * Reads the SAME merged token bag the canvas resolves (BUILTIN_THEME_PRESETS →
 * mergeGlassThemeTokens), so the preview can't drift from what a project renders:
 * matte → opaque tint + solid border + hard-ish corners + manual ink; glass →
 * translucent frosted tint + rim + blur. Color ⊥ material — the user's edge hue
 * (from resolveWizardPreviewColors) still paints on top of whichever finish.
 *
 * Note: glass surfaceAlpha is 0 on the live canvas (invisible over content); the
 * preview tile floors it to a representative frost so "glass" reads as glass. That
 * floor is a display choice, not a token — every color here comes from the preset.
 */
export function resolveWizardPreviewSurface(themeId) {
  const presetId = BUILTIN_THEME_PRESETS[themeId] ? themeId : 'glass';
  const tokens = mergeGlassThemeTokens(BUILTIN_THEME_PRESETS[presetId].tokens);
  const material = tokens.nodeMaterial === 'matte' ? 'matte' : 'glass';
  const tint = tokens.nodeSurfaceTint;
  const borderRadius = `${clampNum(tokens.nodeCornerRadius, 2, 24, 12)}px`;
  // Manual ink (Parchment/Terminal) is used verbatim; auto presets (Glass/Obsidian)
  // sit on the dark canvas → light ink, matching getAutoContrastTextColor.
  const color = tokens.nodeTextMode === 'manual' ? tokens.nodeText : '#f3f6ff';
  const ledColor = tokens.ledGreen;

  if (material === 'matte') {
    return {
      material,
      background: tint,
      border: `${clampNum(tokens.matteBorderWidth, 0, 4, 1.5)}px solid ${tokens.matteBorderColor}`,
      borderRadius,
      color,
      ledColor,
      backdropFilter: 'none'
    };
  }

  const previewAlpha = Math.max(clampNum(tokens.nodeSurfaceAlpha, 0, 1, 0), 0.5);
  return {
    material,
    background: withAlpha(tint, previewAlpha),
    border: `${clampNum(tokens.glassRimWidth, 0.5, 3, 1.5)}px solid ${tokens.glassRimColor}`,
    borderRadius,
    color,
    ledColor,
    backdropFilter: `blur(${clampNum(tokens.glassBlurRadius, 0, 30, 6)}px)`
  };
}
