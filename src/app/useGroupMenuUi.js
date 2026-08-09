import { useCallback, useEffect, useMemo } from 'react';

// Geometry of the .group-menu column (toggle + panel) — see context-menus.css.
const TOGGLE_SIZE = 36;       // .group-menu-toggle height
const COLUMN_GAP = 6;         // .group-menu flex gap between toggle and panel
const VIEWPORT_MARGIN = 12;   // breathing room from the desk edges
const MIN_PANEL_HEIGHT = 160; // never collapse the panel below this; scroll instead

export function useGroupMenuUi({
  selectedCount,
  selectedGroupId,
  anchorBounds,
  deskWidth,
  deskHeight,
  isGroupMenuOpen,
  isRenameGroupOpen,
  setIsRenameGroupOpen,
  setRenameGroupValue,
  // Expanded groups carry a collapse button ON the outline's top-right corner
  // (canvas-space, so it scales with zoom). When present, the toggle clears it
  // by the button's scaled extent instead of nesting against it.
  anchorHasCornerControl = false,
  viewportScale = 1
}) {
  useEffect(() => {
    if (isGroupMenuOpen) return;
    if (!isRenameGroupOpen) return;
    setIsRenameGroupOpen(false);
    setRenameGroupValue('');
  }, [isGroupMenuOpen, isRenameGroupOpen, setIsRenameGroupOpen, setRenameGroupValue]);

  const showGroupMenu = useMemo(
    () => selectedCount > 0 || Boolean(selectedGroupId),
    [selectedCount, selectedGroupId]
  );

  const groupMenuStyle = useMemo(() => {
    // Corner-control clearance: the collapse button's center sits at
    // (maxX + pad) canvas units with radius 9; worst-case (nested) pad is 20,
    // so its screen extent past maxX is 29 * scale. +8 keeps a visible gap so
    // the toggle reads as a sibling control, not a child of the button.
    const anchorGap = anchorHasCornerControl ? 29 * viewportScale + 8 : 12;
    const left = anchorBounds
      ? Math.min(deskWidth - 54, anchorBounds.maxX + anchorGap)
      : deskWidth - 54;
    const rawTop = anchorBounds
      ? Math.max(VIEWPORT_MARGIN, anchorBounds.minY - 12)
      : VIEWPORT_MARGIN;
    // Pull the menu up if anchoring here wouldn't leave room for the panel, so a
    // selection near the canvas bottom doesn't push the panel off-screen.
    const maxTop = Math.max(
      VIEWPORT_MARGIN,
      deskHeight - TOGGLE_SIZE - COLUMN_GAP - MIN_PANEL_HEIGHT - VIEWPORT_MARGIN
    );
    return { left, top: Math.min(rawTop, maxTop) };
  }, [anchorBounds, anchorHasCornerControl, viewportScale, deskWidth, deskHeight]);

  // Cap the panel to the space between it and the desk bottom; it scrolls when
  // the content (rename + theme + color picker all open) exceeds that height.
  const groupMenuPanelStyle = useMemo(() => {
    const panelTop = groupMenuStyle.top + TOGGLE_SIZE + COLUMN_GAP;
    const maxHeight = Math.max(MIN_PANEL_HEIGHT, deskHeight - panelTop - VIEWPORT_MARGIN);
    return { maxHeight, overflowY: 'auto' };
  }, [groupMenuStyle.top, deskHeight]);

  const handleRenameGroupValueChange = useCallback((event) => {
    setRenameGroupValue(event.target.value);
  }, [setRenameGroupValue]);

  return {
    showGroupMenu,
    groupMenuStyle,
    groupMenuPanelStyle,
    handleRenameGroupValueChange
  };
}
