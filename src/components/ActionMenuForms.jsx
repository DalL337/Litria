import { useState } from 'react';
import {
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '@/components/ui/dropdown-menu';
import ColorPickerPopup from './ColorPickerPopup';
import { findReservedDeviceSegment } from '../utils/path';

// Shared form/submenu pieces hosted inside Radix dropdown menus. Used by both
// the canvas Actions pill (GroupMenuOverlay) and the menu bar (MenuBar), so
// the two surfaces stay pixel- and behavior-identical.

// Radix menus capture keystrokes for typeahead/navigation. Stop propagation on
// inputs hosted inside menu content so typing (incl. space/letters) works.
export const stopMenuKeys = (event) => event.stopPropagation();

function basenameOf(path) {
  if (typeof path !== 'string') return '';
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || normalized;
}

/**
 * Node rename form (file name and/or label). Brings label editing onto the
 * canvas (parity with the scaffold). File rename runs through the FSM, which
 * resets label → basename, so we apply the rename first and the custom label
 * after, letting the explicit label win.
 */
export function NodeRenameForm({ piece, onRenameFile, onSetLabel, onClose }) {
  const currentBasename = basenameOf(piece?.filename);
  const [fileName, setFileName] = useState(currentBasename);
  const [label, setLabel] = useState(piece?.label ?? '');
  const [fileError, setFileError] = useState(null);

  const save = async () => {
    const nextFile = fileName.trim();
    if (nextFile && nextFile !== currentBasename) {
      // The manager would refuse a reserved name anyway — surface it here
      // so the form stays open instead of silently not renaming.
      if (findReservedDeviceSegment(nextFile)) {
        setFileError(`"${nextFile}" is a reserved name on Windows`);
        return;
      }
      await onRenameFile?.(piece.id, nextFile);
    }
    // Empty label clears back to the (possibly renamed) filename.
    onSetLabel?.(piece.id, label);
    onClose?.();
  };

  return (
    <div className="cm-menu-form" onKeyDown={stopMenuKeys}>
      <label className="cm-menu-form-label">File name</label>
      <input
        className="cm-menu-form-input"
        value={fileName}
        onChange={(event) => { setFileName(event.target.value); setFileError(null); }}
        spellCheck={false}
        autoFocus
      />
      {fileError && <div className="cm-menu-form-error">{fileError}</div>}
      <label className="cm-menu-form-label">Label</label>
      <input
        className="cm-menu-form-input"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="(uses file name)"
        spellCheck={false}
      />
      <div className="cm-menu-form-actions">
        <button className="cm-menu-form-btn is-primary" type="button" onClick={save}>
          Save
        </button>
      </div>
    </div>
  );
}

export function GroupRenameForm({ value, onChange, onConfirm }) {
  return (
    <div className="cm-menu-form" onKeyDown={stopMenuKeys}>
      <label className="cm-menu-form-label">Group name</label>
      <input
        className="cm-menu-form-input"
        value={value}
        onChange={onChange}
        placeholder="Group name"
        spellCheck={false}
        autoFocus
      />
      <div className="cm-menu-form-actions">
        <button
          className="cm-menu-form-btn is-primary"
          type="button"
          onClick={onConfirm}
          disabled={!value.trim()}
        >
          Save
        </button>
      </div>
    </div>
  );
}

export function ColorSubmenu({ label, currentColor, showClear, onApply, onClose }) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>{label}</DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="cm-menu-color">
        <ColorPickerPopup
          currentColor={currentColor ?? null}
          showClear={showClear}
          onApply={(color) => { onApply?.(color); onClose?.(); }}
          onCancel={onClose}
        />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
