import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem
} from '@/components/ui/dropdown-menu';
import { NodeRenameForm, GroupRenameForm, ColorSubmenu } from './ActionMenuForms';

function GroupMenuOverlay({
  showGroupMenu,
  groupMenuStyle,
  isGroupMenuOpen,
  onMenuOpenChange,
  selectedCount,
  targetGroupId,
  renameGroupValue,
  handleDeselectAll,
  handleDeleteSelected,
  handleRemoveFromCanvas,
  handleCreateFolderGroup,
  mergeTargets,
  onMergeInto,
  handleToggleCollapseGroup,
  handleExpandGroup,
  handleOpenRenameGroup,
  handleRenameGroupValueChange,
  handleConfirmRenameGroup,
  themeOptions,
  targetGroupThemeId,
  handleAssignGroupTheme,
  targetGroupColor,
  onSetGroupColor,
  singleSelectedPiece,
  onSetPieceColor,
  onSetPieceLabel,
  onRenamePieceFile,
  onSavePiece,
  onSaveGroup,
  isNodeDirty,
  isGroupDirty
}) {
  if (!showGroupMenu) return null;

  const closeMenu = () => onMenuOpenChange?.(false);
  const hasNode = Boolean(singleSelectedPiece);
  const hasGroup = Boolean(targetGroupId);
  // Multi-select with no single-node / group context: offer selection actions.
  const showSelectionCluster = !hasNode && !hasGroup && selectedCount > 0;

  return (
    <div className="group-menu" style={groupMenuStyle}>
      <DropdownMenu open={isGroupMenuOpen} onOpenChange={onMenuOpenChange}>
        <DropdownMenuTrigger asChild>
          <button className="group-menu-toggle" type="button" title="Actions">
            ...
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="cm-action-menu" align="start" sideOffset={4}>
          {/* ── Node (single piece) ── */}
          {hasNode && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Node</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={handleDeleteSelected}>Delete</DropdownMenuItem>
                {/* Demotion (wire-arc E): off the canvas, file kept — distinct
                    intent from Delete, deliberately adjacent to it. */}
                <DropdownMenuItem onSelect={handleRemoveFromCanvas}>Remove from canvas</DropdownMenuItem>
                <DropdownMenuItem onSelect={handleDeselectAll}>Deselect</DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Rename</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <NodeRenameForm
                      piece={singleSelectedPiece}
                      onRenameFile={onRenamePieceFile}
                      onSetLabel={onSetPieceLabel}
                      onClose={closeMenu}
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem
                  disabled={!isNodeDirty}
                  onSelect={() => onSavePiece?.(singleSelectedPiece.id)}
                >
                  Save
                </DropdownMenuItem>
                <ColorSubmenu
                  label="Node Color"
                  currentColor={singleSelectedPiece.color}
                  showClear={Boolean(singleSelectedPiece.color)}
                  onApply={(color) => onSetPieceColor?.(singleSelectedPiece.id, color)}
                  onClose={closeMenu}
                />
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {/* ── Group ── */}
          {hasGroup && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Group</DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                <DropdownMenuItem onSelect={handleDeleteSelected}>Delete</DropdownMenuItem>
                <DropdownMenuItem onSelect={handleDeselectAll}>Deselect</DropdownMenuItem>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger
                    onClick={handleOpenRenameGroup}
                    onPointerEnter={handleOpenRenameGroup}
                  >
                    Rename
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <GroupRenameForm
                      value={renameGroupValue}
                      onChange={handleRenameGroupValueChange}
                      onConfirm={() => { handleConfirmRenameGroup(); closeMenu(); }}
                    />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuItem disabled={!isGroupDirty} onSelect={() => onSaveGroup?.()}>
                  Save All
                </DropdownMenuItem>
                <ColorSubmenu
                  label="Group Color"
                  currentColor={targetGroupColor}
                  showClear={Boolean(targetGroupColor)}
                  onApply={(color) => onSetGroupColor?.(color)}
                  onClose={closeMenu}
                />
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Group Theme</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={targetGroupThemeId ?? ''}
                      onValueChange={(value) => handleAssignGroupTheme?.(value)}
                    >
                      <DropdownMenuRadioItem value="">Use active project theme</DropdownMenuRadioItem>
                      {(themeOptions ?? []).map((theme) => (
                        <DropdownMenuRadioItem key={theme.id} value={theme.id}>
                          {theme.name}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                {/* Merge lives here as a deliberate menu action (owner ruling
                    2026-07-25): the drag path is a silent mode-gated NEST,
                    and merge — irreversible, dissolves the source group — is
                    not a mirror of any node action, so it gets an explicit
                    pick-one target list instead. */}
                {(mergeTargets?.length ?? 0) > 0 && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Merge Into</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {mergeTargets.map((group) => (
                        <DropdownMenuItem
                          key={group.id}
                          onSelect={() => onMergeInto?.(group.id)}
                        >
                          {group.name}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuItem onSelect={handleToggleCollapseGroup}>
                  Collapse Folder Group
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={handleExpandGroup}>
                  Expand Folder Group
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          )}

          {/* ── Multi-selection (loose pieces) ── */}
          {showSelectionCluster && (
            <>
              <DropdownMenuItem onSelect={handleDeselectAll}>Deselect</DropdownMenuItem>
              <DropdownMenuItem onSelect={handleDeleteSelected}>Delete</DropdownMenuItem>
            </>
          )}

          {/* Bridge action — turn the current selection into a folder group. */}
          {selectedCount > 0 && (
            <DropdownMenuItem onSelect={handleCreateFolderGroup}>
              Create Folder Group
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default GroupMenuOverlay;
