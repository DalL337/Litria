import { useCallback, useState } from 'react';
import { THEME_ACCENT_SWATCHES } from '../app/themeDomain';

export default function ColorPickerPopup({ currentColor, onApply, onCancel, showClear }) {
  const [selected, setSelected] = useState(currentColor ?? null);

  const handleApply = useCallback(() => {
    onApply(selected);
  }, [onApply, selected]);

  const handleClear = useCallback(() => {
    onApply(null);
  }, [onApply]);

  return (
    <div className="color-picker-popup">
      <div className="color-picker-swatches">
        {THEME_ACCENT_SWATCHES.map((swatch) => (
          <button
            key={swatch}
            type="button"
            className={`color-picker-swatch${selected === swatch ? ' is-selected' : ''}`}
            style={{ backgroundColor: swatch }}
            onClick={() => setSelected(swatch)}
            aria-label={`Select color ${swatch}`}
          />
        ))}
      </div>
      <div className="color-picker-actions">
        {showClear && (
          <button type="button" className="color-picker-btn" onClick={handleClear}>
            Clear
          </button>
        )}
        <span className="color-picker-spacer" />
        <button type="button" className="color-picker-btn" onClick={onCancel}>
          Cancel
        </button>
        <button
          type="button"
          className="color-picker-btn is-primary"
          onClick={handleApply}
          disabled={!selected}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
