import { useCallback, useMemo } from 'react';
import { describeSpacing, formatLandingReadout, gridSectionChips, scaleReadout, uniformScale } from './gridWidgetModel.js';
import { resolveGridPaint } from '../theme/gridPaint.js';

/**
 * useGridWidget — the canvas HUD Grid widget's prop bag (ADR-030
 * playground-review ruling: the playground's panel ships as a HUD section).
 * Mirrors the bindings-hook pattern (useWorkspaceStageBindings): it only
 * assembles values and callbacks the owning hooks already provide. The
 * widget is a window onto their owners (ADR-019), never a second one:
 * spacing → GridDomain (useGridActions), settings → preferences, theme and
 * energy → the theme actions, scale → the one scale command.
 */
export function useGridWidget({
  grid,
  canvasHud,
  canvasTheme,
  energyLevel,
  toggleEnergyLevel,
  themeOptions,
  activeThemeId,
  onSetActiveTheme,
  selectedIds,
  piecesById,
  scaleSelectedPieces,
  placementPreview = null,
}) {
  const { gridState, gridPreferences, setGridPreference, setGridPaintOverride, applyGridDefinition, canEditGrid } = grid;
  const selectedPieces = useMemo(
    () => (selectedIds ?? []).map((id) => piecesById.get(id)).filter(Boolean),
    [selectedIds, piecesById]
  );
  const themeName = themeOptions?.find((theme) => theme.id === activeThemeId)?.name ?? null;
  const themeTokens = canvasTheme?.tokens ?? null;
  const themeId = canvasTheme?.id ?? activeThemeId ?? null;
  const ink = gridPreferences.ink;
  const paint = useMemo(
    () => resolveGridPaint(themeTokens ?? {}, { ink, themeId, energyLevel, overrides: gridPreferences.paintOverrides }),
    [themeTokens, ink, themeId, energyLevel, gridPreferences.paintOverrides]
  );
  const setPaint = useCallback(
    (levels, options) => setGridPaintOverride({ themeId, energyLevel, ink }, levels, options),
    [setGridPaintOverride, themeId, energyLevel, ink]
  );

  return useMemo(() => ({
    preferences: gridPreferences,
    setPreference: setGridPreference,
    definition: gridState.definition,
    spacing: describeSpacing(gridState.definition),
    canEditSpacing: canEditGrid,
    gridSource: gridState.source,
    applyDefinition: applyGridDefinition,
    chips: gridSectionChips({
      preferences: gridPreferences,
      definition: gridState.definition,
      selectedPieces,
      themeName,
      energyLevel,
    }),
    collapsed: canvasHud.hudCollapsed,
    setCollapsed: canvasHud.setHudSectionsCollapsed,
    paint,
    setPaint,
    themes: themeOptions ?? [],
    activeThemeId,
    onSetActiveTheme,
    energyLevel,
    onToggleEnergy: toggleEnergyLevel,
    selectionCount: selectedPieces.length,
    scaleText: scaleReadout(selectedPieces),
    nodeScale: uniformScale(selectedPieces),
    onScale: scaleSelectedPieces,
    // The status bar's drag readout (no on-canvas reticle).
    landingReadout: formatLandingReadout(placementPreview),
  }), [
    activeThemeId, applyGridDefinition, canEditGrid, canvasHud.hudCollapsed, canvasHud.setHudSectionsCollapsed,
    energyLevel, gridPreferences, gridState.definition, gridState.source, onSetActiveTheme, paint, placementPreview, scaleSelectedPieces,
    selectedPieces, setGridPreference, setPaint, themeName, themeOptions, toggleEnergyLevel,
  ]);
}
