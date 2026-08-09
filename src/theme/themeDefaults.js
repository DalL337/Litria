export const GLASS_THEME_VERSION = 3;

// ── Semantic tokens (every theme must implement) ────────────────────
// These define what the three visual channels communicate.
// Glass-specific material tokens follow below.

export const GLASS_THEME_TOKEN_DEFAULTS = Object.freeze({
  // ── Material dispatch ──
  // Selects the surface draw strategy in PuzzlePiece. 'glass' = frosted blur +
  // refraction rim + Snell corner highlights; 'matte' = flat opaque fill + solid
  // border, no light effects. Color is orthogonal: any nodeSurfaceTint / edge /
  // accent hue is rendered *through* the active material's finish, never as a raw
  // fill. See docs/plans/ideas/theme-material-system.md (color ⊥ material).
  nodeMaterial: 'glass',          // 'glass' | 'matte'

  // ── Node surface ──
  nodeSurfaceAlpha: '0',           // 0 = fully transparent, 0.4 = visible tint
  nodeSurfaceTint: '#141824',      // dark tint color applied at nodeSurfaceAlpha
  nodeCornerRadius: '12',          // px
  nodeSelectedStroke: '#00BFFF',
  nodeText: '#f3f6ff',
  nodeTextMode: 'auto',           // 'auto' = contrast-calc, 'manual' = use nodeText as-is
  nodeTextShadowBlur: '8',        // px — shadow behind label for contrast on glass

  // ── Corner LED (system-driven health) ──
  nodeLedStyle: 'dot',            // 'dot' = radial ball, 'arc' = L-shaped catchpoint
  nodeLedSize: '28',              // px — diameter for dot, arm length for arc
  ledEmpty: 'rgba(180, 180, 190, 0.5)',
  ledBlue: 'rgba(60, 140, 255, 0.95)',
  ledGreen: 'rgba(50, 205, 100, 0.9)',
  ledAmber: 'rgba(240, 180, 40, 0.9)',
  ledRed: 'rgba(240, 60, 60, 0.95)',
  ledBluePulse: '2.5',            // seconds
  ledRedPulse: '2.0',             // seconds

  // ── Edge assignment (group-inherited categorization) ──
  // Edge color is inherited from parent group at runtime, not stored here.
  // These control the gradient rendering:
  edgeAssignmentHeight: '2',      // px
  edgeAssignmentInset: '16',      // px from left/right edges
  // Live/Calm energy axis (static). Identity = Live (color rendered as picked).
  // Calm overrides these to scale the left-edge color into a soft pastel.
  nodeEdgeSaturation: '1',        // saturation multiplier (0–1); <1 desaturates
  nodeEdgeLightness: '1',         // lightness multiplier (1–2); >1 lightens
  nodeEdgeMaxLightness: '1',      // lightness ceiling (0–1); 1 = no cap (Live)

  // ── Glass material tokens (nodeMaterial: 'glass') ──
  glassBlurRadius: '6',           // px — backdrop blur intensity
  glassRimWidth: '1.5',           // px — refraction rim border
  glassRimColor: 'rgba(255, 255, 255, 0.15)',
  glassRefractiveIndex: '1.5',    // Snell approximation coefficient (1.0–2.0)
  glassFrostedAlpha: '0.75',      // surface alpha when editor is open
  glassSpecularIntensity: '0.9',  // corner LED brightness multiplier

  // ── Matte material tokens (nodeMaterial: 'matte') ──
  // Flat opaque surface: nodeSurfaceTint painted at nodeSurfaceAlpha (presets set
  // alpha '1'), plus a solid border. Blur/rim/Snell are skipped by the renderer.
  matteBorderColor: 'rgba(255, 255, 255, 0.14)',
  matteBorderWidth: '1.5',        // px — solid border width (0 = borderless)

  // ── Canvas ──
  canvasGridOpacity: '0.03',      // subtle reference grid behind glass tiles
  canvasGridAccentOpacity: '0.06',

  // ── Connections ──
  connectionValid: '#4CAF50',
  connectionWarning: '#FFC107',
  connectionError: '#F44336',
  connectionStroke: '#42a5f5',    // accent for drag line
  // Neutral rest color for healthy wires (ADR-025 §5: rest = topology,
  // green retires at rest) — desaturated slate that reads on dark glass.
  connectionNeutral: '#6b7386',

  // ── Selection ──
  selectionGroupOutline: 'rgba(120, 180, 255, 0.7)',

  // ── Group pills ──
  groupPillFill: 'rgba(30, 30, 30, 0.75)',
  groupPillStroke: '#5c6bc0',
  groupPillSelectedStroke: '#2979ff',
  groupPillText: '#e6e6e6',
  groupPillHoverStroke: '#7986cb',
  groupPillHoverGlow: 'rgba(121, 134, 203, 0.30)',
  groupPillSelectedFill: 'rgba(41, 121, 255, 0.08)',
  groupPillSelectedGlow: 'rgba(41, 121, 255, 0.35)',
  groupPillDivider: 'rgba(92, 107, 192, 0.4)',
  groupPillCountText: '#7986cb',

  // ── Deprecated (v2 compat, resolved by migration) ──
  // pieceBaseFill, pieceBaseAlpha, pieceStroke, pieceHighlightAlpha,
  // pieceHighlightThicknessPx, pieceTabFill, pieceTabStroke,
  // pieceSlotStroke, pieceSlotFillFallback, edgeGlow, dragLine
});

export function normalizeStringTokenMap(rawTokens) {
  if (!rawTokens || typeof rawTokens !== 'object') {
    return {};
  }
  const normalized = {};
  Object.entries(rawTokens).forEach(([key, value]) => {
    if (typeof value !== 'string') return;
    normalized[key] = value;
  });
  return normalized;
}

export function migrateGlassThemeTokens(rawTokens, { fromVersion = 1 } = {}) {
  const tokens = normalizeStringTokenMap(rawTokens);
  const migrated = { ...tokens };

  // v1 → v2: older builds used pieceSelectedStroke as accent source.
  if (fromVersion < 2 && !migrated.pieceStroke && typeof migrated.pieceSelectedStroke === 'string') {
    migrated.pieceStroke = migrated.pieceSelectedStroke;
  }

  // v2 → v3: Glass Material System — remap old piece tokens to new semantic tokens.
  if (fromVersion < 3) {
    // Surface: pieceBaseAlpha → nodeSurfaceAlpha (default changes from 0.9 to 0)
    // Don't migrate the old value — the new default (transparent) is intentional.
    // If user had a custom pieceBaseFill, map it to nodeSurfaceTint.
    if (migrated.pieceBaseFill && migrated.pieceBaseFill !== '#090b10') {
      migrated.nodeSurfaceTint = migrated.pieceBaseFill;
    }

    // Accent: pieceStroke → connectionStroke (accent color for drag lines)
    if (migrated.pieceStroke) {
      migrated.connectionStroke = migrated.connectionStroke ?? migrated.pieceStroke;
    }

    // Selection: pieceSelectedStroke → nodeSelectedStroke
    if (migrated.pieceSelectedStroke) {
      migrated.nodeSelectedStroke = migrated.nodeSelectedStroke ?? migrated.pieceSelectedStroke;
    }

    // Text: pieceText → nodeText, pieceTextMode → nodeTextMode
    if (migrated.pieceText) {
      migrated.nodeText = migrated.nodeText ?? migrated.pieceText;
    }
    if (migrated.pieceTextMode) {
      migrated.nodeTextMode = migrated.nodeTextMode ?? migrated.pieceTextMode;
    }

    // dragLine → connectionStroke
    if (migrated.dragLine) {
      migrated.connectionStroke = migrated.connectionStroke ?? migrated.dragLine;
    }

    // Clean up deprecated keys so they don't accumulate in storage
    const deprecated = [
      'pieceSurfaceFallback', 'pieceBaseFill', 'pieceBaseAlpha',
      'pieceHighlightAlpha', 'pieceHighlightThicknessPx',
      'pieceStroke', 'pieceSelectedStroke', 'pieceText', 'pieceTextMode',
      'pieceTabFill', 'pieceTabStroke', 'pieceSlotStroke', 'pieceSlotFillFallback',
      'edgeGlow', 'dragLine'
    ];
    for (const key of deprecated) {
      delete migrated[key];
    }
  }

  return migrated;
}

export function mergeGlassThemeTokens(rawTokens) {
  return {
    ...GLASS_THEME_TOKEN_DEFAULTS,
    ...normalizeStringTokenMap(rawTokens)
  };
}

// ── Built-in material presets ───────────────────────────────────────
// Two dispatched materials, four presets (see theme-material-system.md).
// Each entry is an OVERRIDE bag layered over GLASS_THEME_TOKEN_DEFAULTS at
// resolve time — only the deltas from the Glass baseline live here. Values must
// be strings (non-strings are dropped by normalizeStringTokenMap). All four are
// fully editable in the Settings theme editor; these are just the seeds.
//
//   Glass material (effect):  glass (default) · obsidian (dark smoked glass)
//   Matte material (flat):    parchment (warm light) · terminal (flat green)
export const BUILTIN_THEME_PRESETS = Object.freeze({
  glass: {
    name: 'Glass',
    // The Glass baseline IS the token defaults — no overrides needed.
    tokens: {}
  },
  obsidian: {
    name: 'Obsidian',
    // Dark smoked glass: still refracts (blur + rim), purple-slate tint.
    tokens: {
      nodeMaterial: 'glass',
      nodeSurfaceTint: '#1b1626',
      nodeSurfaceAlpha: '0.38',
      glassRimColor: 'rgba(154, 120, 224, 0.24)',
      nodeSelectedStroke: '#9a78e0',
      nodeText: '#ded6f2',
      connectionStroke: '#9a78e0',
      connectionValid: '#7c5cd6',
      groupPillFill: 'rgba(40, 34, 58, 0.72)',
      groupPillStroke: '#7c5cd6',
      groupPillText: '#ded6f2',
      groupPillCountText: '#9a78e0',
      // Selection / hover / outline chrome — kept in-palette so selecting a group
      // stays purple, not the Glass blue default.
      groupPillSelectedFill: 'rgba(124, 92, 214, 0.14)',
      groupPillSelectedStroke: '#9a78e0',
      groupPillSelectedGlow: 'rgba(154, 120, 224, 0.35)',
      groupPillHoverStroke: '#9a78e0',
      groupPillHoverGlow: 'rgba(154, 120, 224, 0.28)',
      groupPillDivider: 'rgba(124, 92, 214, 0.40)',
      selectionGroupOutline: 'rgba(154, 120, 224, 0.70)'
    }
  },
  parchment: {
    name: 'Parchment',
    // Matte, warm light — "illuminated page on the dark canvas." First light
    // preset; tannin ink is set manually for warmth (auto-contrast would give
    // cold near-black). Flat: opaque fill + tannin border, no gloss.
    tokens: {
      nodeMaterial: 'matte',
      nodeSurfaceTint: '#f2e4c4',
      nodeSurfaceAlpha: '1',
      nodeCornerRadius: '8',
      glassBlurRadius: '0',
      matteBorderColor: 'rgba(138, 106, 60, 0.55)',
      matteBorderWidth: '1.5',
      nodeTextMode: 'manual',
      nodeText: '#3b2a14',
      nodeSelectedStroke: '#b07d2e',
      connectionStroke: '#b07d2e',
      connectionValid: '#a8722a',
      groupPillFill: 'rgba(255, 250, 238, 0.9)',
      groupPillStroke: '#a8722a',
      groupPillText: '#3b2a14',
      groupPillCountText: '#a8722a',
      // Selection / hover / outline chrome — warm ochre, not Glass blue. Selected
      // fill deepens the parchment slightly so it reads as "picked" while staying light.
      groupPillSelectedFill: 'rgba(234, 214, 170, 0.92)',
      groupPillSelectedStroke: '#b07d2e',
      groupPillSelectedGlow: 'rgba(176, 125, 46, 0.35)',
      groupPillHoverStroke: '#b07d2e',
      groupPillHoverGlow: 'rgba(176, 125, 46, 0.25)',
      groupPillDivider: 'rgba(138, 106, 60, 0.40)',
      selectionGroupOutline: 'rgba(176, 125, 46, 0.70)'
    }
  },
  terminal: {
    name: 'Terminal',
    // Matte, flat green — the *idea* of a terminal, not phosphor emulation.
    // No scanlines/glow. Opaque dark-green surface, hard corners, dim-green
    // border, phosphor-green ink. Monospace label deferred (no fontFamily token).
    tokens: {
      nodeMaterial: 'matte',
      nodeSurfaceTint: '#12220f',
      nodeSurfaceAlpha: '1',
      nodeCornerRadius: '4',
      glassBlurRadius: '0',
      matteBorderColor: 'rgba(62, 207, 90, 0.45)',
      matteBorderWidth: '1',
      nodeTextMode: 'manual',
      nodeText: '#8affa0',
      nodeSelectedStroke: '#4fff70',
      connectionStroke: '#3ecf5a',
      connectionValid: '#1f9e3a',
      groupPillFill: 'rgba(20, 45, 22, 0.7)',
      groupPillStroke: '#1f9e3a',
      groupPillText: '#8affa0',
      groupPillCountText: '#3ecf5a',
      // Selection / hover / outline chrome — phosphor green, not Glass blue.
      groupPillSelectedFill: 'rgba(31, 158, 58, 0.14)',
      groupPillSelectedStroke: '#4fff70',
      groupPillSelectedGlow: 'rgba(62, 207, 90, 0.35)',
      groupPillHoverStroke: '#3ecf5a',
      groupPillHoverGlow: 'rgba(62, 207, 90, 0.25)',
      groupPillDivider: 'rgba(31, 158, 58, 0.45)',
      selectionGroupOutline: 'rgba(79, 255, 112, 0.70)'
    }
  }
});

export const BUILTIN_THEME_IDS = Object.freeze(Object.keys(BUILTIN_THEME_PRESETS));

export function isBuiltinThemeId(themeId) {
  return typeof themeId === 'string' && BUILTIN_THEME_IDS.includes(themeId);
}
