import { useCallback, useEffect, useState } from 'react';
import { Minus, Square, X, Copy } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuCheckboxItem,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { usePlatformConfig } from '../platform/usePlatformConfig';
import { useDrawers } from '../drawers/DrawerContext';
import { NodeRenameForm, GroupRenameForm, ColorSubmenu } from './ActionMenuForms';
import { buildMenuSections } from './menuBarItems';

/* ── Window controls (minimize / maximize / close) ── */
function WindowControls() {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    let unlisten;
    (async () => {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      setIsMaximized(await win.isMaximized());
      unlisten = await win.onResized(async () => {
        setIsMaximized(await win.isMaximized());
      });
    })();
    return () => { unlisten?.(); };
  }, []);

  const handleMinimize = useCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    getCurrentWindow().minimize();
  }, []);

  const handleToggleMaximize = useCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    getCurrentWindow().toggleMaximize();
  }, []);

  const handleClose = useCallback(async () => {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    getCurrentWindow().close();
  }, []);

  return (
    <div className="window-controls">
      <button className="window-control" onClick={handleMinimize} aria-label="Minimize">
        <Minus size={12} />
      </button>
      <button className="window-control" onClick={handleToggleMaximize} aria-label={isMaximized ? 'Restore' : 'Maximize'}>
        {isMaximized ? <Copy size={10} /> : <Square size={10} />}
      </button>
      <button className="window-control window-control-close" onClick={handleClose} aria-label="Close">
        <X size={14} />
      </button>
    </div>
  );
}

/* ── Item renderer ──
   Maps the declarative descriptors from menuBarItems.js onto Radix dropdown
   primitives. `closeMenu` closes the whole top-level menu; forms hosted in
   submenus call it after committing (same pattern as the Actions pill). */
function renderMenuItem(item, index, closeMenu) {
  if (item.separator) return <DropdownMenuSeparator key={`sep-${index}`} />;

  switch (item.type) {
    case 'checkbox':
      return (
        <DropdownMenuCheckboxItem
          key={item.label}
          checked={item.checked}
          disabled={item.disabled}
          onSelect={item.onClick}
        >
          <span>{item.label}</span>
          {item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
        </DropdownMenuCheckboxItem>
      );

    case 'submenu':
      return (
        <DropdownMenuSub key={item.label}>
          <DropdownMenuSubTrigger
            disabled={item.disabled}
            onClick={item.onOpen}
            onPointerEnter={item.onOpen}
          >
            {item.label}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {item.items.map((sub, i) => renderMenuItem(sub, i, closeMenu))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );

    case 'radioGroup':
      return (
        <DropdownMenuRadioGroup
          key={item.label ?? `radio-${index}`}
          value={item.value}
          onValueChange={item.onValueChange}
        >
          {item.label && <DropdownMenuLabel>{item.label}</DropdownMenuLabel>}
          {item.options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              // keepOpen: preventing default keeps the menu open on select
              // (theme/energy preview) — onValueChange still fires.
              onSelect={item.keepOpen ? (event) => event.preventDefault() : undefined}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      );

    case 'colorPicker':
      return (
        <ColorSubmenu
          key={item.label}
          label={item.label}
          currentColor={item.currentColor}
          showClear={item.showClear}
          onApply={item.onApply}
          onClose={closeMenu}
        />
      );

    case 'swatchGrid':
      return (
        <DropdownMenuSub key={item.label}>
          <DropdownMenuSubTrigger>{item.label}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="cm-menu-swatches">
            <div className="cm-menu-swatch-grid">
              {item.swatches.map((color) => {
                const isActive = item.activeColor?.toLowerCase?.() === color.toLowerCase();
                return (
                  <button
                    key={color}
                    type="button"
                    className={`cm-menu-swatch${isActive ? ' is-active' : ''}`}
                    style={{ background: color }}
                    onClick={() => { item.onSelect?.(color); }}
                    aria-label={`Accent color ${color}`}
                    aria-pressed={isActive}
                  />
                );
              })}
            </div>
            {item.onReset && (
              <DropdownMenuItem onSelect={() => item.onReset()}>
                Reset to theme default
              </DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );

    case 'nodeRenameForm':
      return (
        <DropdownMenuSub key={item.label ?? 'Rename'}>
          <DropdownMenuSubTrigger>{item.label ?? 'Rename'}</DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <NodeRenameForm
              piece={item.piece}
              onRenameFile={item.onRenameFile}
              onSetLabel={item.onSetLabel}
              onClose={closeMenu}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );

    case 'groupRenameForm':
      return (
        <DropdownMenuSub key={item.label ?? 'Rename'}>
          <DropdownMenuSubTrigger onClick={item.onOpen} onPointerEnter={item.onOpen}>
            {item.label ?? 'Rename'}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <GroupRenameForm
              value={item.value}
              onChange={item.onChange}
              onConfirm={() => { item.onConfirm?.(); closeMenu(); }}
            />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      );

    default:
      return (
        <DropdownMenuItem
          key={item.label}
          disabled={item.disabled}
          onSelect={item.onClick}
        >
          <span>{item.label}</span>
          {item.shortcut && <DropdownMenuShortcut>{item.shortcut}</DropdownMenuShortcut>}
        </DropdownMenuItem>
      );
  }
}

function MenuDropdown({ label, items, openMenu, setOpenMenu }) {
  const id = label.toLowerCase();
  const isOpen = openMenu === id;

  const handleOpenChange = useCallback((open) => {
    setOpenMenu(open ? id : null);
  }, [id, setOpenMenu]);

  const handleMouseEnter = useCallback(() => {
    if (openMenu && openMenu !== id) setOpenMenu(id);
  }, [id, openMenu, setOpenMenu]);

  const closeMenu = useCallback(() => setOpenMenu(null), [setOpenMenu]);

  return (
    <div className="menu-item" onMouseEnter={handleMouseEnter}>
      <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
        <DropdownMenuTrigger asChild>
          <button className="menu-item-btn">
            {label}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={2}
          // Menu items hand focus elsewhere (scaffold inline inputs, modals).
          // Radix's default focus-restore to the trigger would immediately
          // blur those targets — the scaffold's InlineNameInput cancels on
          // blur, so New File/Folder/Group would silently no-op.
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {items.map((item, i) => renderMenuItem(item, i, closeMenu))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function MenuBar({ bindings }) {
  const [openMenu, setOpenMenu] = useState(null);
  const { showWindowControls, shortcutLabels } = usePlatformConfig();
  // Drawer state is read here (not in the bindings hook): App renders above
  // the DrawerProvider, MenuBar renders inside it.
  const { openDrawer, toggleDrawer, activeId: activeDrawerId, isOpen: isDrawerOpen } = useDrawers();

  const sections = buildMenuSections({
    ...bindings,
    shortcutLabels,
    openDrawer,
    toggleDrawer,
    activeDrawerId,
    isDrawerOpen,
  });

  return (
    <div className="menu-bar">
      <div className="menu-bar-left">
        {sections.map((section) => (
          <MenuDropdown
            key={section.label}
            label={section.label}
            items={section.items}
            openMenu={openMenu}
            setOpenMenu={setOpenMenu}
          />
        ))}
      </div>
      <div className="menu-bar-drag" data-tauri-drag-region />
      {showWindowControls && <WindowControls />}
    </div>
  );
}
