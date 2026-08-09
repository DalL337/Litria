import { useMemo } from 'react';
import { FolderTree, Settings } from 'lucide-react';

import DrawerContentSettings from '../drawers/DrawerContentSettings';
import DrawerContentScaffold from '../drawers/DrawerContentScaffold';

export function useAppDrawers({
  handleOpenCreatePieceModal,
  handleScaffoldOpenEntry,
  handleScaffoldSelectEntry,
  handleToggleScaffoldVisibility,
  hiddenScaffoldPaths,
  listProjectTree,
  projectInstance,
  scaffoldFocusPath,
  scaffoldRefreshToken,
  scaffoldPendingRequest,
  handleScaffoldDrop,
  handleScaffoldFileDropOnPane,
  handleContextRename,
  handleContextDelete,
  handleContextNewFile,
  handleContextNewFolder,
  activeThemeId,
  activeThemeName,
  accentSwatches,
  activeAccentColor,
  onSelectAccentColor,
  onResetThemeAccent,
  themeOptions,
  onSetActiveTheme,
  activeThemeTokens,
  onUpdateThemeToken,
  onOpenPreferences,
  onSetFolderColor,
  getFolderColor
}) {
  const drawers = useMemo(() => ([
    {
      id: 'settings',
      label: 'Settings',
      icon: Settings,
      content: (
        <DrawerContentSettings
          activeThemeId={activeThemeId}
          activeThemeName={activeThemeName}
          accentSwatches={accentSwatches}
          activeAccentColor={activeAccentColor}
          onSelectAccentColor={onSelectAccentColor}
          onResetThemeAccent={onResetThemeAccent}
          themeOptions={themeOptions}
          onSetActiveTheme={onSetActiveTheme}
          activeThemeTokens={activeThemeTokens}
          onUpdateThemeToken={onUpdateThemeToken}
          onOpenPreferences={onOpenPreferences}
        />
      )
    },
    {
      id: 'scaffold',
      label: 'Scaffold',
      icon: FolderTree,
      content: (
        <DrawerContentScaffold
          projectInstance={projectInstance}
          listTree={listProjectTree}
          onSelectEntry={handleScaffoldSelectEntry}
          onOpenEntry={handleScaffoldOpenEntry}
          onToggleVisibility={handleToggleScaffoldVisibility}
          selectedPath={scaffoldFocusPath ?? null}
          hiddenPaths={hiddenScaffoldPaths}
          refreshToken={scaffoldRefreshToken}
          pendingRequest={scaffoldPendingRequest}
          onScaffoldDrop={handleScaffoldDrop}
          onFileDropOnPane={handleScaffoldFileDropOnPane}
          onContextRename={handleContextRename}
          onContextDelete={handleContextDelete}
          onContextNewFile={handleContextNewFile}
          onContextNewFolder={handleContextNewFolder}
          onSetFolderColor={onSetFolderColor}
          getFolderColor={getFolderColor}
          onDragToCanvas={handleScaffoldOpenEntry}
          onCreateNode={handleOpenCreatePieceModal}
        />
      )
    }
  ]), [
    handleOpenCreatePieceModal,
    handleScaffoldOpenEntry,
    handleScaffoldSelectEntry,
    handleToggleScaffoldVisibility,
    hiddenScaffoldPaths,
    listProjectTree,
    projectInstance,
    scaffoldFocusPath,
    scaffoldRefreshToken,
    scaffoldPendingRequest,
    handleScaffoldDrop,
    handleScaffoldFileDropOnPane,
    handleContextRename,
    handleContextDelete,
    handleContextNewFile,
    handleContextNewFolder,
    activeThemeId,
    activeThemeName,
    accentSwatches,
    activeAccentColor,
    onSelectAccentColor,
    onResetThemeAccent,
    themeOptions,
    onSetActiveTheme,
    // Live token values drive the contextual parameter area — omitting them
    // froze the pre-refit sliders' displayed values.
    activeThemeTokens,
    onUpdateThemeToken,
    onOpenPreferences
  ]);

  return { drawers };
}
