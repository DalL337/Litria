// Pure menu descriptors for MenuBar. React-free so enablement logic is
// unit-testable under node --test (test/domains/menuBarItems.test.mjs).
//
// Item shapes understood by MenuBar's renderer:
//   { separator: true }
//   { label, shortcut?, onClick?, disabled? }
//   { type: 'checkbox', label, checked, onClick, shortcut?, disabled? }
//   { type: 'submenu', label, disabled?, onOpen?, items: [...] }
//   { type: 'radioGroup', label?, value, onValueChange, options: [{ value, label }] }
//   { type: 'colorPicker', label, currentColor, showClear, onApply }
//   { type: 'swatchGrid', label, swatches, activeColor, onSelect, onReset? }
//   { type: 'nodeRenameForm', label?, piece, onRenameFile, onSetLabel }
//   { type: 'groupRenameForm', label?, value, onChange, onConfirm, onOpen }

export function buildFileMenu(ctx) {
  const labels = ctx.shortcutLabels ?? {};
  // Scaffold-create items open the scaffold drawer first so the inline name
  // input the request triggers is actually visible.
  const inScaffold = (fn) => () => {
    ctx.openDrawer?.('scaffold');
    fn?.();
  };
  return [
    // Disabled until an in-workspace wizard exists (today it lives on the
    // launcher only); a null handler must gray out, not crash.
    { label: 'New Project', onClick: ctx.onNewProject, disabled: !ctx.onNewProject },
    { label: 'Open Project…', onClick: ctx.onOpenProject },
    { separator: true },
    { label: 'New File', onClick: inScaffold(ctx.onNewFile) },
    { label: 'New Folder', onClick: inScaffold(ctx.onNewFolder) },
    { label: 'New Node…', onClick: ctx.onNewNode },
    { label: 'New Group', onClick: inScaffold(ctx.onNewGroup) },
    { separator: true },
    { label: 'Save', shortcut: labels.save, onClick: ctx.onSave, disabled: !ctx.canSave },
    { label: 'Save All', shortcut: labels.saveAll, onClick: ctx.onSaveAll, disabled: !ctx.canSaveAll },
    { separator: true },
    // Preferences: global + this-project scopes (ADR-019 Slice 2).
    { label: 'Preferences…', onClick: ctx.onOpenPreferences },
    { separator: true },
    // "Exit to Launcher", not "Close Project": the label says where you land
    // (legibility over status-quo muscle memory — owner decision, see
    // docs/plans/ideas/brief-exit-to-launcher.md).
    { label: 'Exit to Launcher', onClick: ctx.onExitToLauncher },
    { separator: true },
    // Exit stays dead last — bottom-of-File-menu placement is load-bearing
    // Windows convention.
    { label: 'Exit', onClick: ctx.onExit }
  ];
}

export function buildEditMenu(ctx) {
  const labels = ctx.shortcutLabels ?? {};
  return [
    { label: 'Undo', shortcut: labels.undo, onClick: ctx.onUndo, disabled: !ctx.canUndo },
    { label: 'Redo', shortcut: labels.redo, onClick: ctx.onRedo, disabled: !ctx.canRedo },
    { separator: true },
    { label: 'Select All', shortcut: labels.selectAll, onClick: ctx.onSelectAll, disabled: !ctx.canSelectAll },
    { label: 'Deselect All', onClick: ctx.onDeselectAll, disabled: !ctx.canDeselect },
    { separator: true },
    { label: 'Delete', onClick: ctx.onDelete, disabled: !ctx.canDelete }
  ];
}

export function buildViewMenu(ctx) {
  const labels = ctx.shortcutLabels ?? {};
  const isScaffoldOpen = Boolean(ctx.isDrawerOpen && ctx.activeDrawerId === 'scaffold');
  return [
    { label: 'Fit All Content', shortcut: labels.fitContent, onClick: ctx.onFitContent },
    { label: 'Fit Selection', shortcut: labels.fitSelection, onClick: ctx.onFitSelection },
    { label: 'Home', onClick: ctx.onNavigateHome },
    { separator: true },
    { label: 'Zoom In', onClick: ctx.onZoomIn, disabled: !ctx.canZoomIn },
    { label: 'Zoom Out', onClick: ctx.onZoomOut, disabled: !ctx.canZoomOut },
    { label: 'Reset View', onClick: ctx.onResetView },
    { separator: true },
    { type: 'checkbox', label: 'Minimap', checked: Boolean(ctx.isMinimapVisible), onClick: ctx.onToggleMinimap },
    { type: 'checkbox', label: 'Quick Actions', shortcut: labels.hudToggle, checked: Boolean(ctx.isHudVisible), onClick: ctx.onToggleHud },
    { type: 'checkbox', label: 'Edit Mode', shortcut: labels.editMode, checked: Boolean(ctx.isEditMode), onClick: ctx.onToggleEditMode },
    { separator: true },
    { label: 'Find Node…', shortcut: labels.findNode, onClick: ctx.onOpenNodeSearch },
    { separator: true },
    { type: 'checkbox', label: 'Scaffold Drawer', checked: isScaffoldOpen, onClick: () => ctx.toggleDrawer?.('scaffold') },
    { type: 'checkbox', label: 'Editor Panel', checked: Boolean(ctx.isEditorOpen), onClick: ctx.onToggleEditor, disabled: !ctx.canToggleEditor },
    { label: 'Split Editor', shortcut: labels.split, onClick: ctx.onSplitEditor, disabled: !ctx.canSplitEditor }
  ];
}

/**
 * Actions menu — mirrors the canvas Actions pill (GroupMenuOverlay) cluster
 * for cluster. Unlike the contextual pill, which hides inapplicable clusters,
 * the menu bar renders every submenu and disables the ones that don't apply
 * (standard menubar discoverability).
 */
export function buildActionsMenu(ctx) {
  const node = ctx.singleSelectedPiece;
  const hasGroup = Boolean(ctx.targetGroupId);
  const hasSelection = (ctx.selectedCount ?? 0) > 0;
  const hasWire = Boolean(ctx.selectedConnectionId);

  return [
    {
      type: 'submenu',
      label: 'Node',
      disabled: !node,
      items: node ? [
        { label: 'Delete', onClick: ctx.onDelete },
        { label: 'Deselect', onClick: ctx.onDeselectAll },
        {
          type: 'nodeRenameForm',
          piece: node,
          onRenameFile: ctx.onRenamePieceFile,
          onSetLabel: ctx.onSetPieceLabel
        },
        { label: 'Save', disabled: !ctx.isNodeDirty, onClick: () => ctx.onSavePiece?.(node.id) },
        {
          type: 'colorPicker',
          label: 'Node Color',
          currentColor: node.color,
          showClear: Boolean(node.color),
          onApply: (color) => ctx.onSetPieceColor?.(node.id, color)
        }
      ] : []
    },
    {
      type: 'submenu',
      label: 'Group',
      disabled: !hasGroup,
      items: hasGroup ? [
        { label: 'Delete', onClick: ctx.onDelete },
        { label: 'Deselect', onClick: ctx.onDeselectAll },
        {
          type: 'groupRenameForm',
          value: ctx.renameGroupValue,
          onChange: ctx.onRenameGroupValueChange,
          onConfirm: ctx.onConfirmRenameGroup,
          onOpen: ctx.onOpenRenameGroup
        },
        { label: 'Save All', disabled: !ctx.isGroupDirty, onClick: ctx.onSaveGroup },
        {
          type: 'colorPicker',
          label: 'Group Color',
          currentColor: ctx.targetGroupColor,
          showClear: Boolean(ctx.targetGroupColor),
          onApply: ctx.onSetGroupColor
        },
        {
          type: 'submenu',
          label: 'Group Theme',
          items: [{
            type: 'radioGroup',
            value: ctx.targetGroupThemeId ?? '',
            onValueChange: ctx.onAssignGroupTheme,
            options: [
              { value: '', label: 'Use active project theme' },
              ...(ctx.themeOptions ?? []).map((theme) => ({ value: theme.id, label: theme.name }))
            ]
          }]
        },
        { separator: true },
        { label: 'Collapse Folder Group', onClick: ctx.onToggleCollapseGroup },
        { label: 'Expand Folder Group', onClick: ctx.onExpandGroup }
      ] : []
    },
    {
      type: 'submenu',
      label: 'Selection',
      disabled: !hasSelection,
      items: [
        { label: 'Deselect', onClick: ctx.onDeselectAll },
        { label: 'Delete', onClick: ctx.onDelete },
        { label: 'Create Folder Group', onClick: ctx.onCreateFolderGroup }
      ]
    },
    {
      type: 'submenu',
      label: 'Wire',
      disabled: !hasWire,
      items: [
        { label: 'Add Symbol…', onClick: ctx.onAddSymbolToWire },
        { label: 'Delete Wire', onClick: ctx.onDelete }
      ]
    },
    { separator: true },
    // Diagnostics. Build logs and crash logs are separate catalogs on
    // purpose: a scaffold that fails leaves the app healthy, so the crash
    // system never records it.
    {
      type: 'submenu',
      label: 'Logs',
      items: [
        { label: 'View Build Logs', onClick: ctx.onViewBuildLogs },
        { label: 'View Crash Logs', onClick: ctx.onViewCrashLogs }
      ]
    }
  ];
}

/**
 * Settings menu — inline quick controls for the theme system (presets, the
 * Live/Calm energy axis, accent color), plus a deep link into the Settings
 * drawer for full editing. Theme create/rename/delete and material sliders
 * stay drawer-only per docs/plans/ideas/theme-material-system.md (the drawer
 * is the canonical editor; materials remain internal).
 * Theme/energy radios keep the menu open (keepOpen) for rapid preview.
 */
export function buildSettingsMenu(ctx) {
  return [
    {
      type: 'radioGroup',
      label: 'Theme',
      keepOpen: true,
      value: ctx.activeThemeId ?? '',
      onValueChange: ctx.onSetActiveTheme,
      options: (ctx.themeOptions ?? []).map((theme) => ({ value: theme.id, label: theme.name }))
    },
    { separator: true },
    {
      type: 'radioGroup',
      label: 'Energy',
      keepOpen: true,
      value: ctx.energyLevel ?? 'live',
      onValueChange: ctx.onSetEnergyLevel,
      options: [
        { value: 'live', label: 'Live' },
        { value: 'calm', label: 'Calm' }
      ]
    },
    { separator: true },
    {
      type: 'swatchGrid',
      label: 'Accent Color',
      swatches: ctx.accentSwatches ?? [],
      activeColor: ctx.activeAccentColor,
      onSelect: ctx.onSelectAccentColor,
      onReset: ctx.onResetThemeAccent
    },
    { separator: true },
    { label: 'Open Theme Editor…', onClick: () => ctx.openDrawer?.('settings') }
  ];
}

export function buildMenuSections(ctx) {
  return [
    { label: 'File', items: buildFileMenu(ctx) },
    { label: 'Edit', items: buildEditMenu(ctx) },
    { label: 'View', items: buildViewMenu(ctx) },
    { label: 'Actions', items: buildActionsMenu(ctx) },
    { label: 'Settings', items: buildSettingsMenu(ctx) }
  ];
}
