import {
  DEFAULT_THEME_ID,
  DEFAULT_THEME_NAME,
  normalizeAppearance
} from '../project/manifest.js';
import { mergeGlassThemeTokens, isBuiltinThemeId } from '../theme/themeDefaults.js';

export const THEME_ACCENT_SWATCHES = Object.freeze([
  '#ef5350', '#ec407a', '#ab47bc', '#7e57c2',
  '#5c6bc0', '#42a5f5', '#26c6da', '#26a69a',
  '#66bb6a', '#9ccc65', '#d4e157', '#ffca28',
  '#ffa726', '#ff7043', '#8d6e63', '#78909c'
]);

// Token keys that are updated together when the user picks an accent colour.
export const THEME_ACCENT_TOKEN_KEYS = Object.freeze([
  'connectionValid',
  'connectionStroke'
]);

// ── Live / Calm energy axis (ADR-014 amendment). STATIC intensity only — no
// animation, ever. Live = the theme's default (vivid) values; Calm = a
// low-stimulus override set (softer glass, dimmer LEDs, calmer grid) for
// accessibility / sensory comfort / the VR endpoint. Layered on whatever theme
// is active. These are first-pass values — tune to taste.
export const CALM_TOKEN_OVERRIDES = Object.freeze({
  glassRefractiveIndex: 1.12,
  glassRimColor: 'rgba(255, 255, 255, 0.07)',
  glassRimWidth: 1,
  nodeLedSize: 20,
  nodeTextShadowBlur: 4,
  // Left-edge organizational color → soft pastel (flat, no glow). Desaturate
  // and lighten whatever color the user picked. Keep enough saturation that warm
  // hues (red/orange/yellow, near-max saturation at source) stay distinct, and
  // cap lightness so they can't wash toward white where hues converge.
  nodeEdgeSaturation: 0.58,
  nodeEdgeLightness: 1.2,
  nodeEdgeMaxLightness: 0.82,
  canvasGridOpacity: 0.02,
  canvasGridAccentOpacity: 0.035,
  ledEmpty: 'rgba(180, 180, 190, 0.32)',
  ledBlue: 'rgba(60, 140, 255, 0.7)',
  ledGreen: 'rgba(50, 205, 100, 0.62)',
  ledAmber: 'rgba(240, 180, 40, 0.68)',
  ledRed: 'rgba(240, 60, 60, 0.72)'
});

/**
 * Apply the energy level to a resolved theme's tokens. Live is the identity;
 * Calm merges the low-stimulus override set on top. Returns a new theme object
 * with merged tokens (or the same theme for live). Static only.
 */
export function applyEnergyLevel(theme, energyLevel) {
  if (!theme || energyLevel !== 'calm') return theme;
  return { ...theme, tokens: { ...(theme.tokens ?? {}), ...CALM_TOKEN_OVERRIDES } };
}

function mergeThemeTokens(rawTokens) {
  return mergeGlassThemeTokens(rawTokens);
}

function toThemeId(value) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function ensureUniqueThemeId(preferredId, themes) {
  const base = preferredId || 'theme';
  if (!themes[base]) return base;
  let suffix = 2;
  while (themes[`${base}-${suffix}`]) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function resolveTheme(appearance) {
  const normalized = normalizeAppearance(appearance);
  const activeTheme = normalized.themes[normalized.activeThemeId] ?? normalized.themes[DEFAULT_THEME_ID];
  const resolvedId = activeTheme?.id ?? DEFAULT_THEME_ID;
  const resolvedName = activeTheme?.name ?? DEFAULT_THEME_NAME;
  const resolvedTokens = mergeThemeTokens(activeTheme?.tokens);

  return {
    id: resolvedId,
    name: resolvedName,
    tokens: resolvedTokens
  };
}

export function createThemeDomain({ appearance: initialAppearance } = {}) {
  let appearance = normalizeAppearance(initialAppearance);

  const applyTokenPatch = ({ themeId, patch }) => {
    const resolvedThemeId = typeof themeId === 'string' && appearance.themes[themeId]
      ? themeId
      : appearance.activeThemeId;
    const targetTheme = appearance.themes[resolvedThemeId];
    if (!targetTheme || !patch || typeof patch !== 'object') return appearance;

    const nextTokens = { ...(targetTheme.tokens ?? {}) };
    Object.entries(patch).forEach(([key, value]) => {
      if (typeof key !== 'string' || !key.trim()) return;
      if (value == null) {
        delete nextTokens[key];
        return;
      }
      if (typeof value !== 'string') return;
      nextTokens[key] = value;
    });

    appearance = {
      ...appearance,
      themes: {
        ...appearance.themes,
        [resolvedThemeId]: {
          ...targetTheme,
          tokens: nextTokens
        }
      }
    };
    return appearance;
  };

  return {
    commands: {
      initializeFromProject({ appearance: projectAppearance }) {
        appearance = normalizeAppearance(projectAppearance);
        return appearance;
      },
      setActiveTheme({ themeId }) {
        if (typeof themeId !== 'string' || !appearance.themes[themeId]) return appearance;
        appearance = {
          ...appearance,
          activeThemeId: themeId
        };
        return appearance;
      },
      updateThemeTokens({ themeId, patch }) {
        return applyTokenPatch({ themeId, patch });
      },
      resetThemeTokens({ themeId, keys }) {
        const normalizedKeys = Array.isArray(keys)
          ? keys.filter((key) => typeof key === 'string' && key.trim())
          : [];
        if (!normalizedKeys.length) return appearance;
        const patch = Object.fromEntries(normalizedKeys.map((key) => [key, null]));
        return applyTokenPatch({ themeId, patch });
      },
      createThemeFromBase({ baseThemeId, newThemeId, name }) {
        const sourceThemeId = typeof baseThemeId === 'string' && appearance.themes[baseThemeId]
          ? baseThemeId
          : appearance.activeThemeId;
        const sourceTheme = appearance.themes[sourceThemeId] ?? appearance.themes[DEFAULT_THEME_ID];
        if (!sourceTheme) return appearance;

        const providedId = toThemeId(newThemeId);
        const derivedId = providedId || toThemeId(name);
        const nextThemeId = ensureUniqueThemeId(derivedId || 'theme', appearance.themes);
        const nextThemeName = typeof name === 'string' && name.trim()
          ? name.trim()
          : `Theme ${nextThemeId}`;

        appearance = {
          ...appearance,
          activeThemeId: nextThemeId,
          themes: {
            ...appearance.themes,
            [nextThemeId]: {
              ...sourceTheme,
              id: nextThemeId,
              name: nextThemeName,
              tokens: { ...(sourceTheme.tokens ?? {}) }
            }
          }
        };
        return appearance;
      },
      renameTheme({ themeId, name }) {
        if (typeof themeId !== 'string') return appearance;
        if (isBuiltinThemeId(themeId)) return appearance;
        const targetTheme = appearance.themes[themeId];
        if (!targetTheme) return appearance;
        const nextName = typeof name === 'string' ? name.trim() : '';
        if (!nextName) return appearance;

        appearance = {
          ...appearance,
          themes: {
            ...appearance.themes,
            [themeId]: {
              ...targetTheme,
              name: nextName
            }
          }
        };
        return appearance;
      },
      deleteCustomTheme({ themeId }) {
        if (typeof themeId !== 'string') return appearance;
        if (isBuiltinThemeId(themeId)) return appearance;
        if (!appearance.themes[themeId]) return appearance;

        const nextThemes = { ...appearance.themes };
        delete nextThemes[themeId];
        const nextActiveId = appearance.activeThemeId === themeId
          ? DEFAULT_THEME_ID
          : appearance.activeThemeId;
        appearance = normalizeAppearance({
          ...appearance,
          activeThemeId: nextActiveId,
          themes: nextThemes
        });
        return appearance;
      }
    },
    selectors: {
      getAppearance() {
        return appearance;
      },
      getActiveTheme() {
        return resolveTheme(appearance);
      },
      getSettingsSummary() {
        const activeTheme = resolveTheme(appearance);
        return {
          activeThemeId: activeTheme.id,
          activeThemeName: activeTheme.name,
          canDeleteActiveTheme: !isBuiltinThemeId(activeTheme.id)
        };
      },
      listThemes() {
        const entries = Object.values(appearance.themes ?? {}).map((theme) => ({
          id: theme.id,
          name: theme.name
        }));
        entries.sort((a, b) => {
          if (a.id === DEFAULT_THEME_ID) return -1;
          if (b.id === DEFAULT_THEME_ID) return 1;
          return a.name.localeCompare(b.name);
        });
        return entries;
      },
      getThemeById(themeId) {
        if (typeof themeId !== 'string' || !appearance.themes[themeId]) return null;
        const theme = appearance.themes[themeId];
        return {
          id: theme.id,
          name: theme.name,
          tokens: mergeThemeTokens(theme.tokens)
        };
      },
      resolveGroupTokens(group) {
        const groupThemeId = typeof group?.themeId === 'string' && group.themeId.trim()
          ? group.themeId
          : appearance.activeThemeId;
        const theme = appearance.themes[groupThemeId];
        if (theme) return mergeThemeTokens(theme.tokens);
        return resolveTheme(appearance).tokens ?? null;
      }
    }
  };
}
