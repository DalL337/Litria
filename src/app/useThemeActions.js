import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  createThemeDomain,
  applyEnergyLevel,
  THEME_ACCENT_SWATCHES,
  THEME_ACCENT_TOKEN_KEYS
} from './themeDomain';
import {
  prefsLoadGlobal,
  prefsSaveGlobal,
  prefsLoadProject,
  prefsSaveProject,
  prefsClearProject
} from '../preferences/preferencesStore.js';
import { normalizePath } from '../utils/path';
import { PREF_KEYS } from '../preferences/registry.js';

/**
 * useThemeActions — owns all theme state, mutation handlers, and the
 * per-element color handlers (piece, group, scaffold folder).
 *
 * Manages projectAppearance state, appearance loading from SQLite
 * preferences, themeDomain creation, and the full set of theme, accent,
 * and color action callbacks consumed by the workspace UI.
 *
 * @param {object} opts
 * @param {object|null} opts.projectInstance
 * @param {object} opts.pieceDomain - source for handleSetPieceColor
 * @param {object} opts.groupDomain - source for handleSetGroupColor and handleSetFolderColor
 * @param {string|null} opts.targetGroupId - currently selected group target
 * @param {Array} opts.groups - current groups list (for folder-path lookup)
 */
export function useThemeActions({ projectInstance, pieceDomain, groupDomain, targetGroupId, groups }) {
  const [projectAppearance, setProjectAppearance] = useState(null);
  // Live / Calm energy axis (static intensity, no animation), two layers
  // (ADR-019 Slice 2): the global preference plus an optional per-project
  // override. Effective = override ?? global.
  const [globalEnergyLevel, setGlobalEnergyLevel] = useState('live');
  const [projectEnergyLevel, setProjectEnergyLevel] = useState(null);

  // Load preferences (ADR-019). Runs at boot AND on project open: energy is
  // truly global so the launcher reflects it too; appearance and the project
  // override layer apply only inside a project.
  useEffect(() => {
    let isMounted = true;
    const rootPath = projectInstance?.rootPath ?? null;

    (async () => {
      try {
        const prefs = await prefsLoadGlobal();
        if (!isMounted) return;
        setGlobalEnergyLevel(prefs?.energyLevel === 'calm' ? 'calm' : 'live');
        setProjectAppearance(rootPath ? (prefs?.appearance ?? null) : null);
      } catch {
        if (isMounted) setProjectAppearance(null);
      }

      if (!rootPath) {
        if (isMounted) setProjectEnergyLevel(null);
        return;
      }
      try {
        const projectPrefs = await prefsLoadProject(rootPath);
        if (!isMounted) return;
        const override = projectPrefs?.energyLevel;
        setProjectEnergyLevel(override === 'calm' || override === 'live' ? override : null);
      } catch {
        if (isMounted) setProjectEnergyLevel(null);
      }
    })();

    return () => { isMounted = false; };
  }, [projectInstance?.instanceId, projectInstance?.rootPath]);

  const energyLevel = projectEnergyLevel ?? globalEnergyLevel;

  // Ambient toggles (status-bar pill) edit the layer that is currently
  // effective: with an override present, toggling updates the override —
  // writing global instead would visibly do nothing.
  const toggleEnergyLevel = useCallback(() => {
    const next = energyLevel === 'calm' ? 'live' : 'calm';
    if (projectEnergyLevel !== null && projectInstance?.rootPath) {
      setProjectEnergyLevel(next);
      prefsSaveProject(projectInstance.rootPath, PREF_KEYS.energyLevel, next).catch(() => {});
    } else {
      setGlobalEnergyLevel(next);
      prefsSaveGlobal(PREF_KEYS.energyLevel, next).catch(() => {});
    }
  }, [energyLevel, projectEnergyLevel, projectInstance?.rootPath]);

  // Set the GLOBAL energy level and persist it. Awaitable so callers can
  // guarantee the write lands before a project open re-reads preferences
  // (otherwise the reload would clobber the new value).
  const setEnergyLevel = useCallback(async (level) => {
    const next = level === 'calm' ? 'calm' : 'live';
    setGlobalEnergyLevel(next);
    await prefsSaveGlobal(PREF_KEYS.energyLevel, next).catch(() => {});
  }, []);

  // Set or clear (null) the project-layer energy override. Preferences-panel
  // territory — deliberate scoping, unlike the ambient toggle.
  const setProjectEnergyOverride = useCallback(async (levelOrNull) => {
    if (!projectInstance?.rootPath) return;
    if (levelOrNull === null) {
      setProjectEnergyLevel(null);
      await prefsClearProject(projectInstance.rootPath, PREF_KEYS.energyLevel).catch(() => {});
      return;
    }
    const next = levelOrNull === 'calm' ? 'calm' : 'live';
    setProjectEnergyLevel(next);
    await prefsSaveProject(projectInstance.rootPath, PREF_KEYS.energyLevel, next).catch(() => {});
  }, [projectInstance?.rootPath]);

  const themeDomain = useMemo(
    () => createThemeDomain({ appearance: projectAppearance }),
    [projectAppearance]
  );

  const activeTheme = themeDomain.selectors.getActiveTheme();
  const { activeThemeId, activeThemeName, canDeleteActiveTheme } = themeDomain.selectors.getSettingsSummary();
  const themeOptions = themeDomain.selectors.listThemes();
  const activeAccentColor = activeTheme?.tokens?.connectionStroke ?? THEME_ACCENT_SWATCHES[0];

  // Theme as rendered on the canvas — the active theme with the energy-level
  // overrides applied. Theme-settings UI keeps using activeTheme (the real one).
  const canvasTheme = useMemo(
    () => applyEnergyLevel(activeTheme, energyLevel),
    [activeTheme, energyLevel]
  );

  const persistAppearance = useCallback((nextAppearance) => {
    if (!nextAppearance || !projectInstance?.rootPath) return;
    setProjectAppearance(nextAppearance);
    prefsSaveGlobal(PREF_KEYS.appearance, nextAppearance).catch(() => {});
  }, [projectInstance?.rootPath]);

  const handleSetActiveTheme = useCallback((themeId) => {
    if (!projectInstance?.rootPath || typeof themeId !== 'string') return;
    persistAppearance(themeDomain.commands.setActiveTheme({ themeId }));
  }, [persistAppearance, projectInstance?.rootPath, themeDomain]);

  const handleCreateTheme = useCallback((name) => {
    if (!projectInstance?.rootPath) return;
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) return;
    persistAppearance(themeDomain.commands.createThemeFromBase({
      baseThemeId: activeThemeId,
      name: trimmedName
    }));
  }, [activeThemeId, persistAppearance, projectInstance?.rootPath, themeDomain]);

  const handleRenameActiveTheme = useCallback((name) => {
    if (!projectInstance?.rootPath) return;
    const trimmedName = typeof name === 'string' ? name.trim() : '';
    if (!trimmedName) return;
    persistAppearance(themeDomain.commands.renameTheme({
      themeId: activeThemeId,
      name: trimmedName
    }));
  }, [activeThemeId, persistAppearance, projectInstance?.rootPath, themeDomain]);

  const handleDeleteActiveTheme = useCallback(() => {
    if (!projectInstance?.rootPath) return;
    persistAppearance(themeDomain.commands.deleteCustomTheme({ themeId: activeThemeId }));
  }, [activeThemeId, persistAppearance, projectInstance?.rootPath, themeDomain]);

  const handleSelectAccentColor = useCallback((nextColor) => {
    if (!projectInstance?.rootPath || typeof nextColor !== 'string') return;
    const normalizedColor = nextColor.trim();
    if (!normalizedColor) return;
    const patch = Object.fromEntries(
      THEME_ACCENT_TOKEN_KEYS.map((key) => [key, normalizedColor])
    );
    persistAppearance(themeDomain.commands.updateThemeTokens({ themeId: activeThemeId, patch }));
  }, [activeThemeId, persistAppearance, projectInstance?.rootPath, themeDomain]);

  const handleResetThemeAccent = useCallback(() => {
    if (!projectInstance?.rootPath) return;
    persistAppearance(themeDomain.commands.resetThemeTokens({
      themeId: activeThemeId,
      keys: THEME_ACCENT_TOKEN_KEYS
    }));
  }, [activeThemeId, persistAppearance, projectInstance?.rootPath, themeDomain]);

  const handleUpdateThemeToken = useCallback((key, value) => {
    if (!projectInstance?.rootPath || typeof key !== 'string') return;
    const patch = { [key]: typeof value === 'string' ? value : String(value) };
    persistAppearance(themeDomain.commands.updateThemeTokens({ themeId: activeThemeId, patch }));
  }, [activeThemeId, persistAppearance, projectInstance?.rootPath, themeDomain]);

  // ---------------------------------------------------------------------------
  // Per-element color handlers (piece, group, scaffold folder)
  // ---------------------------------------------------------------------------

  const handleSetPieceColor = useCallback((pieceId, color) => {
    pieceDomain.commands.setPieceColor({ id: pieceId, color });
  }, [pieceDomain]);

  const handleSetGroupColor = useCallback((color) => {
    if (targetGroupId) groupDomain.commands.setGroupColor(targetGroupId, color);
  }, [groupDomain, targetGroupId]);

  // Scaffold folder color: find group by folderPath, set its color.
  const handleSetFolderColor = useCallback((folderPath, color) => {
    const normalized = normalizePath(folderPath);
    const group = groups.find((g) => g.folderPath === normalized);
    if (group) {
      groupDomain.commands.setGroupColor(group.id, color);
    }
  }, [groupDomain, groups]);

  const getFolderColor = useCallback((folderPath) => {
    const normalized = normalizePath(folderPath);
    const group = groups.find((g) => g.folderPath === normalized);
    return group?.color ?? null;
  }, [groups]);

  return {
    themeDomain,
    activeTheme,
    canvasTheme,
    energyLevel,
    globalEnergyLevel,
    projectEnergyLevel,
    toggleEnergyLevel,
    setEnergyLevel,
    setProjectEnergyOverride,
    activeThemeId,
    activeThemeName,
    canDeleteActiveTheme,
    themeOptions,
    activeAccentColor,
    handleSetActiveTheme,
    handleCreateTheme,
    handleRenameActiveTheme,
    handleDeleteActiveTheme,
    handleSelectAccentColor,
    handleResetThemeAccent,
    handleUpdateThemeToken,
    handleSetPieceColor,
    handleSetGroupColor,
    handleSetFolderColor,
    getFolderColor
  };
}
