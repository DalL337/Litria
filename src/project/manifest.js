export const DEFAULT_THEME_ID = 'glass';
export const DEFAULT_THEME_NAME = 'Glass';
export const APPEARANCE_SCHEMA_VERSION = 1;

import {
  GLASS_THEME_VERSION,
  migrateGlassThemeTokens,
  normalizeStringTokenMap,
  BUILTIN_THEME_PRESETS,
  BUILTIN_THEME_IDS
} from '../theme/themeDefaults.js';

export function createProjectInstanceId() {
  return `project_${Date.now()}`;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function normalizeThemeName(themeId, rawName) {
  if (typeof rawName === 'string' && rawName.trim()) {
    return rawName.trim();
  }
  return themeId === DEFAULT_THEME_ID ? DEFAULT_THEME_NAME : `Theme ${themeId}`;
}

function normalizeThemeConfig(themeId, rawTheme) {
  const raw = isPlainObject(rawTheme) ? rawTheme : {};
  const rawVersion = Number.isFinite(raw.version) ? raw.version : 1;
  const normalizedVersion = Math.max(1, rawVersion);
  const normalizedTokens = normalizeStringTokenMap(raw.tokens);
  const isGlassTheme = themeId === DEFAULT_THEME_ID;
  const tokens = isGlassTheme
    ? migrateGlassThemeTokens(normalizedTokens, { fromVersion: normalizedVersion })
    : normalizedTokens;
  const version = isGlassTheme
    ? Math.max(GLASS_THEME_VERSION, normalizedVersion)
    : normalizedVersion;

  return {
    id: themeId,
    name: normalizeThemeName(themeId, raw.name),
    version,
    tokens
  };
}

export function normalizeAppearance(rawAppearance) {
  const raw = isPlainObject(rawAppearance) ? rawAppearance : {};
  const rawThemes = isPlainObject(raw.themes) ? raw.themes : {};
  const normalizedThemes = {};

  Object.entries(rawThemes).forEach(([rawThemeId, rawTheme]) => {
    const themeId = typeof rawThemeId === 'string' ? rawThemeId.trim() : '';
    if (!themeId) return;
    normalizedThemes[themeId] = normalizeThemeConfig(themeId, rawTheme);
  });

  // Seed the built-in material presets (Glass/Obsidian/Parchment/Terminal) that
  // aren't already present. Additive and idempotent: a user's forked/edited copy
  // of a built-in is left untouched (it already exists in normalizedThemes); only
  // genuinely-absent presets are seeded from the catalog. This upgrades older
  // appearance blobs (which only carried 'glass') in place, with no migration.
  BUILTIN_THEME_IDS.forEach((builtinId) => {
    if (normalizedThemes[builtinId]) return;
    const preset = BUILTIN_THEME_PRESETS[builtinId];
    normalizedThemes[builtinId] = normalizeThemeConfig(builtinId, {
      name: preset.name,
      tokens: preset.tokens
    });
  });

  const activeThemeId = typeof raw.activeThemeId === 'string'
    && normalizedThemes[raw.activeThemeId]
    ? raw.activeThemeId
    : DEFAULT_THEME_ID;

  return {
    schemaVersion: APPEARANCE_SCHEMA_VERSION,
    activeThemeId,
    themes: normalizedThemes
  };
}
