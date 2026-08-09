import { useEffect, useRef, useState } from 'react';
import { NODE_MATERIALS, resolveMaterialId, parametersForMaterial } from '../theme/materialParams.js';

/**
 * DrawerContentSettings — the Settings drawer after the ADR-019 Slice 3
 * refit: three pills (Theme / Accent / Material) plus one contextual
 * parameter area.
 *
 * - Pills show the current value at rest; their panels do selection only.
 * - Theme create/rename/delete moved to Preferences' Library room (File →
 *   Preferences…); the Theme panel keeps a door there. Selection stays at
 *   the point of use; definition and management live in Preferences.
 * - The parameter area renders whatever the ACTIVE material declares
 *   (materialParams.js) — glass knobs exist only while glass is active.
 *
 * Protected zone (ADR-008): no shadcn/Radix — pills are native buttons with
 * in-flow panels, one open at a time, outside-click to close.
 */

function PillPanel({ children }) {
  return <div className="drawer-pill-panel">{children}</div>;
}

function DrawerContentSettings({
  activeThemeId,
  activeThemeName,
  activeThemeTokens,
  accentSwatches = [],
  activeAccentColor,
  onSelectAccentColor,
  onResetThemeAccent,
  onUpdateThemeToken,
  themeOptions = [],
  onSetActiveTheme,
  onOpenPreferences
}) {
  const [openPill, setOpenPill] = useState(null);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!openPill) return undefined;
    const onPointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) setOpenPill(null);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [openPill]);

  const tokens = activeThemeTokens ?? {};
  const materialId = resolveMaterialId(tokens);
  const materialLabel = NODE_MATERIALS.find((m) => m.id === materialId)?.label ?? materialId;
  const parameters = parametersForMaterial(materialId);

  const togglePill = (pill) => setOpenPill((prev) => (prev === pill ? null : pill));

  const renderPill = (pill, label, value) => (
    <button
      type="button"
      className={`drawer-pill ${openPill === pill ? 'is-open' : ''}`}
      aria-expanded={openPill === pill}
      onClick={() => togglePill(pill)}
    >
      <span className="drawer-pill-label">{label}</span>
      <span className="drawer-pill-value">{value} ▾</span>
    </button>
  );

  const renderParameter = (param) => {
    if (param.type === 'choice') {
      const current = tokens[param.token] ?? param.options[0];
      return (
        <div key={param.token}>
          <label className="drawer-label">{param.label}</label>
          <div className="drawer-inline">
            {param.options.map((option) => (
              <button
                key={option}
                type="button"
                className={`drawer-button ${current === option ? 'drawer-button-active' : ''}`}
                onClick={() => onUpdateThemeToken?.(param.token, option)}
              >
                {option.charAt(0).toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
        </div>
      );
    }
    const value = Number(tokens[param.token] ?? param.min);
    return (
      <div key={param.token}>
        <label className="drawer-label">
          {param.label}
          <span className="drawer-label-value">
            {value.toFixed(param.decimals)}{param.unit ?? ''}
          </span>
        </label>
        <input
          type="range"
          min={param.min}
          max={param.max}
          step={param.step}
          value={value}
          onChange={(e) => onUpdateThemeToken?.(param.token, Number(e.target.value).toFixed(param.decimals))}
          className="drawer-range"
        />
      </div>
    );
  };

  return (
    <div className="drawer-section" ref={rootRef}>
      <div className="drawer-section-title">Appearance</div>

      <div className="drawer-pill-row">
        {renderPill('theme', 'Theme', activeThemeName || 'Glass')}
        {renderPill('accent', 'Accent', '')}
        {renderPill('material', 'Material', materialLabel)}
      </div>

      {openPill === 'theme' && (
        <PillPanel>
          {themeOptions.map((theme) => (
            <button
              key={theme.id}
              type="button"
              className={`drawer-button drawer-pill-option ${theme.id === activeThemeId ? 'drawer-button-active' : ''}`}
              onClick={() => { onSetActiveTheme?.(theme.id); setOpenPill(null); }}
            >
              {theme.name}
            </button>
          ))}
          <div className="drawer-pill-divider" />
          <button
            type="button"
            className="drawer-button drawer-button-ghost drawer-pill-option"
            onClick={() => { setOpenPill(null); onOpenPreferences?.(); }}
          >
            Edit themes in Preferences…
          </button>
        </PillPanel>
      )}

      {openPill === 'accent' && (
        <PillPanel>
          <div className="drawer-swatch-grid" role="list" aria-label="Theme accent swatches">
            {accentSwatches.map((swatch) => {
              const isActive = activeAccentColor?.toLowerCase?.() === swatch.toLowerCase();
              return (
                <button
                  key={swatch}
                  type="button"
                  className={`drawer-swatch-button ${isActive ? 'is-active' : ''}`}
                  style={{ backgroundColor: swatch }}
                  aria-label={`Set accent ${swatch}`}
                  aria-pressed={isActive}
                  onClick={() => onSelectAccentColor?.(swatch)}
                />
              );
            })}
          </div>
          <button
            type="button"
            className="drawer-button drawer-button-ghost drawer-pill-option"
            onClick={() => onResetThemeAccent?.()}
          >
            Reset theme accent
          </button>
        </PillPanel>
      )}

      {openPill === 'material' && (
        <PillPanel>
          {NODE_MATERIALS.map((material) => (
            <button
              key={material.id}
              type="button"
              className={`drawer-button drawer-pill-option ${material.id === materialId ? 'drawer-button-active' : ''}`}
              onClick={() => { onUpdateThemeToken?.('nodeMaterial', material.id); setOpenPill(null); }}
            >
              {material.label}
            </button>
          ))}
        </PillPanel>
      )}

      <div className="drawer-section-title drawer-params-title">{materialLabel} Parameters</div>
      {parameters.map(renderParameter)}
    </div>
  );
}

export default DrawerContentSettings;
