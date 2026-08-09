import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFileMenu,
  buildEditMenu,
  buildViewMenu,
  buildActionsMenu,
  buildSettingsMenu,
  buildMenuSections
} from '../../src/components/menuBarItems.js';

const noop = () => {};

const baseCtx = {
  // File
  onNewProject: noop,
  onOpenProject: noop,
  onNewFile: noop,
  onNewFolder: noop,
  onNewNode: noop,
  onNewGroup: noop,
  onSave: noop,
  canSave: true,
  onSaveAll: noop,
  canSaveAll: true,
  onExitToLauncher: noop,
  onExit: noop,
  onOpenPreferences: noop,
  // Edit
  onUndo: noop,
  onRedo: noop,
  canUndo: true,
  canRedo: true,
  onDelete: noop,
  canDelete: true,
  onDeselectAll: noop,
  canDeselect: true,
  onSelectAll: noop,
  canSelectAll: true,
  // View
  onFitContent: noop,
  onFitSelection: noop,
  onNavigateHome: noop,
  onZoomIn: noop,
  canZoomIn: true,
  onZoomOut: noop,
  canZoomOut: true,
  onResetView: noop,
  isMinimapVisible: true,
  onToggleMinimap: noop,
  isEditMode: false,
  onToggleEditMode: noop,
  onOpenNodeSearch: noop,
  isEditorOpen: false,
  onToggleEditor: noop,
  canToggleEditor: true,
  onSplitEditor: noop,
  canSplitEditor: true,
  // Actions (canvas pill mirror)
  singleSelectedPiece: null,
  targetGroupId: null,
  selectedCount: 0,
  selectedConnectionId: null,
  isNodeDirty: false,
  isGroupDirty: false,
  onSavePiece: noop,
  onSaveGroup: noop,
  onSetPieceColor: noop,
  onSetPieceLabel: noop,
  onRenamePieceFile: noop,
  renameGroupValue: '',
  onRenameGroupValueChange: noop,
  onOpenRenameGroup: noop,
  onConfirmRenameGroup: noop,
  targetGroupColor: null,
  onSetGroupColor: noop,
  themeOptions: [{ id: 'glass', name: 'Glass' }, { id: 'obsidian', name: 'Obsidian' }],
  targetGroupThemeId: null,
  onAssignGroupTheme: noop,
  onToggleCollapseGroup: noop,
  onExpandGroup: noop,
  onCreateFolderGroup: noop,
  onAddSymbolToWire: noop,
  // Settings
  activeThemeId: 'glass',
  onSetActiveTheme: noop,
  energyLevel: 'live',
  onSetEnergyLevel: noop,
  accentSwatches: ['#ef5350', '#42a5f5'],
  activeAccentColor: '#42a5f5',
  onSelectAccentColor: noop,
  onResetThemeAccent: noop,
  // Drawer context (supplied by MenuBar via useDrawers)
  openDrawer: noop,
  toggleDrawer: noop,
  activeDrawerId: null,
  isDrawerOpen: false,
  shortcutLabels: {
    save: 'Ctrl+S',
    saveAll: 'Ctrl+Shift+S',
    undo: 'Ctrl+Z',
    redo: 'Ctrl+Y',
    fitContent: 'Ctrl+0',
    fitSelection: 'Ctrl+Shift+0',
    findNode: 'Ctrl+P',
    selectAll: 'Ctrl+A',
    editMode: 'E',
    hudToggle: 'H',
    split: 'Ctrl+\\'
  }
};

// Labels only — layout assertions ignore separators so reordering/streamlining
// of dividers doesn't break tests.
const labelsOf = (items) => items.filter((i) => !i.separator).map((i) => i.label);

test('buildMenuSections returns File, Edit, View, Actions, Settings in order', () => {
  const sections = buildMenuSections(baseCtx);
  assert.deepEqual(sections.map((s) => s.label), ['File', 'Edit', 'View', 'Actions', 'Settings']);
});

test('File menu has project, create, save, and exit actions wired', () => {
  const items = buildFileMenu(baseCtx);
  assert.deepEqual(labelsOf(items), [
    'New Project', 'Open Project…',
    'New File', 'New Folder', 'New Node…', 'New Group',
    'Save', 'Save All',
    'Preferences…',
    'Exit to Launcher', 'Exit'
  ]);
  for (const item of items.filter((i) => !i.separator)) {
    assert.equal(typeof item.onClick, 'function', `${item.label} must be wired`);
  }
});

test('Exit items dispatch their own handlers, and Exit sits dead last', () => {
  const calls = [];
  const items = buildFileMenu({
    ...baseCtx,
    onExitToLauncher: () => calls.push('exitToLauncher'),
    onExit: () => calls.push('exit')
  });
  items.find((i) => i.label === 'Exit to Launcher').onClick();
  items.find((i) => i.label === 'Exit').onClick();
  assert.deepEqual(calls, ['exitToLauncher', 'exit']);
  // Bottom-of-File-menu Exit is load-bearing Windows convention.
  assert.equal(items[items.length - 1].label, 'Exit');
  // Both exit items are fenced off from the save cluster by separators.
  const exitIdx = items.findIndex((i) => i.label === 'Exit to Launcher');
  assert.equal(items[exitIdx - 1].separator, true);
  assert.equal(items[exitIdx + 1].separator, true);
});

test('File scaffold-create items open the scaffold drawer before requesting', () => {
  const calls = [];
  const ctx = {
    ...baseCtx,
    openDrawer: (id) => calls.push(['openDrawer', id]),
    onNewFile: () => calls.push(['onNewFile']),
    onNewGroup: () => calls.push(['onNewGroup'])
  };
  const items = buildFileMenu(ctx);
  items.find((i) => i.label === 'New File').onClick();
  assert.deepEqual(calls, [['openDrawer', 'scaffold'], ['onNewFile']]);
  calls.length = 0;
  items.find((i) => i.label === 'New Group').onClick();
  assert.deepEqual(calls, [['openDrawer', 'scaffold'], ['onNewGroup']]);
});

test('Save and Save All track dirty state', () => {
  const clean = buildFileMenu({ ...baseCtx, canSave: false, canSaveAll: false });
  assert.equal(clean.find((i) => i.label === 'Save').disabled, true);
  assert.equal(clean.find((i) => i.label === 'Save All').disabled, true);
  const dirty = buildFileMenu(baseCtx);
  assert.equal(dirty.find((i) => i.label === 'Save').disabled, false);
  assert.equal(dirty.find((i) => i.label === 'Save All').disabled, false);
  assert.equal(dirty.find((i) => i.label === 'Save').shortcut, 'Ctrl+S');
  assert.equal(dirty.find((i) => i.label === 'Save All').shortcut, 'Ctrl+Shift+S');
});

test('Edit menu propagates canUndo/canRedo into disabled', () => {
  const enabled = buildEditMenu(baseCtx);
  assert.equal(enabled.find((i) => i.label === 'Undo').disabled, false);
  assert.equal(enabled.find((i) => i.label === 'Redo').disabled, false);

  const disabled = buildEditMenu({ ...baseCtx, canUndo: false, canRedo: false });
  assert.equal(disabled.find((i) => i.label === 'Undo').disabled, true);
  assert.equal(disabled.find((i) => i.label === 'Redo').disabled, true);
});

test('Edit menu shows platform accelerator labels', () => {
  const items = buildEditMenu(baseCtx);
  assert.equal(items.find((i) => i.label === 'Undo').shortcut, 'Ctrl+Z');
  assert.equal(items.find((i) => i.label === 'Redo').shortcut, 'Ctrl+Y');
});

test('Edit selection actions gate on selection state', () => {
  const items = buildEditMenu(baseCtx);
  assert.deepEqual(labelsOf(items), ['Undo', 'Redo', 'Select All', 'Deselect All', 'Delete']);

  const empty = buildEditMenu({
    ...baseCtx, canDelete: false, canDeselect: false, canSelectAll: false
  });
  assert.equal(empty.find((i) => i.label === 'Delete').disabled, true);
  assert.equal(empty.find((i) => i.label === 'Deselect All').disabled, true);
  assert.equal(empty.find((i) => i.label === 'Select All').disabled, true);
});

test('View menu has fit actions with accelerators', () => {
  const items = buildViewMenu(baseCtx);
  assert.deepEqual(labelsOf(items), [
    'Fit All Content', 'Fit Selection', 'Home',
    'Zoom In', 'Zoom Out', 'Reset View',
    'Minimap', 'Quick Actions', 'Edit Mode',
    'Find Node…',
    'Scaffold Drawer', 'Editor Panel', 'Split Editor'
  ]);
  assert.equal(items.find((i) => i.label === 'Fit All Content').shortcut, 'Ctrl+0');
  assert.equal(items.find((i) => i.label === 'Fit Selection').shortcut, 'Ctrl+Shift+0');
  assert.equal(items.find((i) => i.label === 'Find Node…').shortcut, 'Ctrl+P');
});

test('Split Editor gates on canSplitEditor and shows the reserved accelerator', () => {
  const enabled = buildViewMenu(baseCtx).find((i) => i.label === 'Split Editor');
  assert.equal(enabled.disabled, false);
  assert.equal(enabled.shortcut, 'Ctrl+\\');
  const disabled = buildViewMenu({ ...baseCtx, canSplitEditor: false }).find((i) => i.label === 'Split Editor');
  assert.equal(disabled.disabled, true);
});

test('View toggles reflect current state as checkboxes', () => {
  const items = buildViewMenu({
    ...baseCtx,
    isMinimapVisible: false,
    isEditMode: true,
    isEditorOpen: true,
    isDrawerOpen: true,
    activeDrawerId: 'scaffold'
  });
  const byLabel = (label) => items.find((i) => i.label === label);
  assert.equal(byLabel('Minimap').type, 'checkbox');
  assert.equal(byLabel('Minimap').checked, false);
  assert.equal(byLabel('Edit Mode').checked, true);
  assert.equal(byLabel('Scaffold Drawer').checked, true);
  assert.equal(byLabel('Editor Panel').checked, true);

  const settingsOpen = buildViewMenu({
    ...baseCtx, isDrawerOpen: true, activeDrawerId: 'settings'
  });
  assert.equal(settingsOpen.find((i) => i.label === 'Scaffold Drawer').checked, false);
});

test('View zoom items gate on clamp bounds', () => {
  const atMax = buildViewMenu({ ...baseCtx, canZoomIn: false });
  assert.equal(atMax.find((i) => i.label === 'Zoom In').disabled, true);
  assert.equal(atMax.find((i) => i.label === 'Zoom Out').disabled, false);
  const atMin = buildViewMenu({ ...baseCtx, canZoomOut: false });
  assert.equal(atMin.find((i) => i.label === 'Zoom Out').disabled, true);
});

test('Actions menu renders all four selection clusters, disabled without selection', () => {
  const submenus = buildActionsMenu(baseCtx).filter((i) => i.type === 'submenu');
  assert.deepEqual(submenus.map((i) => i.label), ['Node', 'Group', 'Selection', 'Wire', 'Logs']);
  for (const submenu of submenus.filter((i) => i.label !== 'Logs')) {
    assert.equal(submenu.disabled, true, `${submenu.label} must be disabled with nothing selected`);
  }
});

test('Actions Logs cluster stays available with nothing selected', () => {
  // Diagnostics are not a selection action — a failed build is exactly when
  // there is no selection to speak of.
  const logs = buildActionsMenu(baseCtx).find((i) => i.label === 'Logs');
  assert.ok(logs, 'Logs submenu must exist');
  assert.notEqual(logs.disabled, true);
  assert.deepEqual(logs.items.map((i) => i.label), ['View Build Logs', 'View Crash Logs']);
});

test('Actions Node cluster mirrors the pill when a single piece is selected', () => {
  const piece = { id: 42, filename: 'src/a.py', label: 'A', color: '#ff0000' };
  const items = buildActionsMenu({ ...baseCtx, singleSelectedPiece: piece, selectedCount: 1 });
  const nodeMenu = items.find((i) => i.label === 'Node');
  assert.equal(nodeMenu.disabled, false);
  // Pill parity: GroupMenuOverlay Node cluster = Delete, Deselect, Rename, Save, Node Color.
  assert.deepEqual(
    nodeMenu.items.map((i) => i.label ?? i.type),
    ['Delete', 'Deselect', 'nodeRenameForm', 'Save', 'Node Color']
  );
  assert.equal(nodeMenu.items.find((i) => i.label === 'Save').disabled, true, 'Save gated on isNodeDirty');
  const colorItem = nodeMenu.items.find((i) => i.label === 'Node Color');
  assert.equal(colorItem.currentColor, '#ff0000');
  assert.equal(colorItem.showClear, true);
});

test('Actions Group cluster mirrors the pill when a group is targeted', () => {
  const items = buildActionsMenu({
    ...baseCtx,
    targetGroupId: 'group-1',
    targetGroupColor: '#00ff00',
    targetGroupThemeId: 'obsidian',
    isGroupDirty: true
  });
  const groupMenu = items.find((i) => i.label === 'Group');
  assert.equal(groupMenu.disabled, false);
  assert.deepEqual(
    groupMenu.items.filter((i) => !i.separator).map((i) => i.label ?? i.type),
    ['Delete', 'Deselect', 'groupRenameForm', 'Save All', 'Group Color', 'Group Theme',
     'Collapse Folder Group', 'Expand Folder Group']
  );
  assert.equal(groupMenu.items.find((i) => i.label === 'Save All').disabled, false);
  const themeMenu = groupMenu.items.find((i) => i.label === 'Group Theme');
  const radio = themeMenu.items[0];
  assert.equal(radio.type, 'radioGroup');
  assert.equal(radio.value, 'obsidian');
  assert.deepEqual(
    radio.options.map((o) => o.label),
    ['Use active project theme', 'Glass', 'Obsidian']
  );
});

test('Actions Selection and Wire clusters gate on their selections', () => {
  const multi = buildActionsMenu({ ...baseCtx, selectedCount: 3 });
  const selection = multi.find((i) => i.label === 'Selection');
  assert.equal(selection.disabled, false);
  assert.deepEqual(selection.items.map((i) => i.label), ['Deselect', 'Delete', 'Create Folder Group']);
  assert.equal(multi.find((i) => i.label === 'Wire').disabled, true);

  const wired = buildActionsMenu({ ...baseCtx, selectedConnectionId: 7 });
  const wire = wired.find((i) => i.label === 'Wire');
  assert.equal(wire.disabled, false);
  assert.deepEqual(wire.items.map((i) => i.label), ['Add Symbol…', 'Delete Wire']);
});

test('Settings menu exposes theme, energy, accent, and the drawer deep link', () => {
  const items = buildSettingsMenu(baseCtx);
  const themeRadio = items.find((i) => i.label === 'Theme');
  assert.equal(themeRadio.type, 'radioGroup');
  assert.equal(themeRadio.value, 'glass');
  assert.equal(themeRadio.keepOpen, true, 'theme radio keeps the menu open for preview');
  assert.deepEqual(themeRadio.options.map((o) => o.label), ['Glass', 'Obsidian']);

  const energyRadio = items.find((i) => i.label === 'Energy');
  assert.equal(energyRadio.value, 'live');
  assert.deepEqual(energyRadio.options.map((o) => o.value), ['live', 'calm']);

  const swatches = items.find((i) => i.label === 'Accent Color');
  assert.equal(swatches.type, 'swatchGrid');
  assert.equal(swatches.activeColor, '#42a5f5');
  assert.equal(typeof swatches.onReset, 'function');

  assert.ok(items.find((i) => i.label === 'Open Theme Editor…'));
});

test('Settings drawer deep link opens the settings drawer', () => {
  const calls = [];
  const items = buildSettingsMenu({ ...baseCtx, openDrawer: (id) => calls.push(id) });
  items.find((i) => i.label === 'Open Theme Editor…').onClick();
  assert.deepEqual(calls, ['settings']);
});

test('builders tolerate a missing shortcutLabels map', () => {
  const { shortcutLabels, ...bare } = baseCtx;
  assert.doesNotThrow(() => buildMenuSections(bare));
});

// Drift guard: menu accelerator hints must come from shortcutLabels (the
// per-OS registry in platformDefaults.js), never hardcoded in a builder.
// A label that isn't in the map is either a typo or an unbound accelerator.
test('every emitted shortcut string exists in shortcutLabels', () => {
  const known = new Set(Object.values(baseCtx.shortcutLabels));
  const walk = (items) => {
    for (const item of items) {
      if (item.separator) continue;
      if (item.shortcut !== undefined) {
        assert.ok(known.has(item.shortcut), `unknown shortcut "${item.shortcut}" on "${item.label}"`);
      }
      if (Array.isArray(item.items)) walk(item.items);
    }
  };
  const richCtx = {
    ...baseCtx,
    singleSelectedPiece: { id: 1, filename: 'a.py', color: null },
    targetGroupId: 'group-1',
    selectedCount: 2,
    selectedConnectionId: 3
  };
  for (const section of buildMenuSections(richCtx)) walk(section.items);
});
