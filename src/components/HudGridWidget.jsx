import { useEffect, useState } from 'react';
import { PREF_KEYS } from '../preferences/registry.js';
import { GRID_LIMITS, GRID_PRESETS, sameGridDefinition } from '../utils/gridGeometry';
import { NODE_SCALE_STEP } from '../app/gridWidgetModel';

/**
 * HudGridWidget — the canvas HUD's Grid section (ADR-030 playground-review
 * ruling: the playground's panel ships as is). Five collapsible subsections;
 * a folded one keeps its current value in a chip. Everything here is a
 * window onto its owner — the bindings (useGridWidget) carry the calls.
 */

function Subsection({ id, title, chip, collapsed, onToggle, children }) {
  return (
    <div className={`hud-grid-sub${collapsed ? ' is-collapsed' : ''}`} data-section={id}>
      <button
        type="button"
        className="hud-grid-sub-title"
        aria-expanded={!collapsed}
        onClick={() => onToggle(id, !collapsed)}
      >
        <span className="hud-grid-chev" aria-hidden="true" />
        <span className="hud-grid-sub-name">{title}</span>
        {collapsed && chip ? <span className="hud-grid-chip">{chip}</span> : null}
      </button>
      {!collapsed && <div className="hud-grid-sub-body">{children}</div>}
    </div>
  );
}

function Segmented({ value, options, onChange, label }) {
  return (
    <div className="hud-grid-seg" role="radiogroup" aria-label={label}>
      {options.map(([optionValue, optionLabel]) => (
        <button
          key={optionValue}
          type="button"
          role="radio"
          aria-checked={value === optionValue}
          className={value === optionValue ? 'is-active' : ''}
          onClick={() => onChange(optionValue)}
        >
          {optionLabel}
        </button>
      ))}
    </div>
  );
}

function Check({ checked, onChange, children }) {
  return (
    <label className="hud-grid-check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {children}
    </label>
  );
}

/** A number field that applies on Enter or blur, clamped to its limits. */
function NumberField({ id, label, value, min, max, step, disabled, onCommit }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  const commit = () => {
    const parsed = Math.round(Number(draft));
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, parsed));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };
  return (
    <>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </>
  );
}

/** A slider that shows while dragging and saves once on release. */
function Slider({ label, value, min, max, step, format, onChange }) {
  return (
    <>
      <span>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value), { persist: false })}
        onPointerUp={(e) => onChange(Number(e.currentTarget.value), { persist: true })}
        onKeyUp={(e) => onChange(Number(e.currentTarget.value), { persist: true })}
      />
      <span className="hud-grid-num">{format(value)}</span>
    </>
  );
}

export default function HudGridWidget({ gridWidget }) {
  const w = gridWidget;
  const isRectangular = Boolean(w && w.definition.majorX !== w.definition.majorY);
  // The rectangular toggle is UI state: on with equal steps until Y changes.
  const [rect, setRect] = useState(isRectangular);
  useEffect(() => {
    if (isRectangular) setRect(true);
  }, [isRectangular]);
  if (!w) return null;
  const { preferences: p, definition, spacing, collapsed, chips } = w;
  const toggle = (id, next) => w.setCollapsed({ [id]: next });

  const apply = (patch) => w.applyDefinition({ ...definition, ...patch });
  const strict = p.snapMode === 'strict';
  const noSelection = w.selectionCount === 0;
  const opacity = (level) => Math.round(w.paint[level] * 1000) / 1000;
  const setLevel = (level) => (value, options) => w.setPaint({
    major: w.paint.major, minor: w.paint.minor, sub: w.paint.sub, [level]: value,
  }, options);

  return (
    <div className="hud-grid">
      <Subsection id="placement" title="Placement" chip={chips.placement} collapsed={collapsed.placement} onToggle={toggle}>
        <Segmented
          label="Placement"
          value={p.snapMode}
          options={[['strict', 'Strict'], ['flex', 'Flex']]}
          onChange={(mode) => w.setPreference(PREF_KEYS.gridSnapMode, mode)}
        />
        <p className="hud-grid-hint">
          {strict
            ? 'Major intersections only. Never docks flush; a drop onto a neighbor takes the nearest free intersection.'
            : 'Docks flush to a neighbor within 40, otherwise settles on the finest intersection.'}
        </p>
        <Check checked={p.smartGuides} onChange={(on) => w.setPreference(PREF_KEYS.gridSmartGuides, on)}>
          Smart guides
        </Check>
        {p.smartGuides && (
          <p className="hud-grid-hint">
            {strict
              ? 'Shown while dragging, but the grid always wins: they never pull.'
              : 'Grab the nearest face of another node within 6 px — after docking, before the lattice.'}
          </p>
        )}
      </Subsection>

      <Subsection id="spacing" title="Grid spacing" chip={chips.spacing} collapsed={collapsed.spacing} onToggle={toggle}>
        <div className="hud-grid-presets">
          {GRID_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              disabled={!w.canEditSpacing}
              className={sameGridDefinition(preset, definition) ? 'is-active' : ''}
              onClick={() => {
                setRect(false);
                apply(preset);
              }}
            >
              {preset.label}
            </button>
          ))}
        </div>
        <div className="hud-grid-fields">
          <NumberField
            id="hud-grid-major-x"
            label={rect ? 'Major step X' : 'Major step'}
            value={definition.majorX}
            min={GRID_LIMITS.minMajor}
            max={GRID_LIMITS.maxMajor}
            step={5}
            disabled={!w.canEditSpacing}
            onCommit={(value) => apply(rect ? { majorX: value } : { majorX: value, majorY: value })}
          />
          <NumberField
            id="hud-grid-major-y"
            label="Major step Y"
            value={definition.majorY}
            min={GRID_LIMITS.minMajor}
            max={GRID_LIMITS.maxMajor}
            step={5}
            disabled={!w.canEditSpacing || !rect}
            onCommit={(value) => apply({ majorY: value })}
          />
          <NumberField
            id="hud-grid-minor"
            label="Minor divisions"
            value={definition.minorDivisions}
            min={GRID_LIMITS.minDivisions}
            max={GRID_LIMITS.maxDivisions}
            step={1}
            disabled={!w.canEditSpacing}
            onCommit={(value) => apply({ minorDivisions: value })}
          />
          <NumberField
            id="hud-grid-sub"
            label="Sub divisions"
            value={definition.subDivisions}
            min={GRID_LIMITS.minDivisions}
            max={GRID_LIMITS.maxDivisions}
            step={1}
            disabled={!w.canEditSpacing}
            onCommit={(value) => apply({ subDivisions: value })}
          />
        </div>
        <Check
          checked={rect}
          onChange={(on) => {
            setRect(on);
            if (!on && definition.majorY !== definition.majorX) apply({ majorY: definition.majorX });
          }}
        >
          Rectangular major step
        </Check>
        <div className="hud-grid-readout">
          <div>major <b>{spacing.label.split('·')[0]}</b> · minor <b>{spacing.label.split('·')[1]}</b> · sub <b>{spacing.label.split('·')[2]}</b></div>
          <div>Strict side by side: gap <b>{spacing.strictSideBySide}</b></div>
          <div>Strict stacked: gap <b>{spacing.strictStacked}</b></div>
        </div>
        {spacing.warnings.map((warning) => <p key={warning} className="hud-grid-warn">{warning}</p>)}
        {!w.canEditSpacing && (
          <p className="hud-grid-hint">
            {w.gridSource === 'fallback'
              ? "This workspace's saved grid can't be read, so it is kept as is."
              : 'This workspace is read-only; its grid can be viewed, not changed.'}
          </p>
        )}
      </Subsection>

      <Subsection id="settle" title="Settle" chip={chips.settle} collapsed={collapsed.settle} onToggle={toggle}>
        <div className="hud-grid-sliders">
          <Slider
            label="Time"
            value={p.settleMs}
            min={0}
            max={400}
            step={10}
            format={(ms) => `${ms} ms`}
            onChange={(ms, options) => w.setPreference(PREF_KEYS.gridSettleMs, ms, options)}
          />
        </div>
        <select
          className="hud-grid-select"
          aria-label="Settle easing"
          value={p.settleEasing}
          onChange={(e) => w.setPreference(PREF_KEYS.gridSettleEasing, e.target.value)}
        >
          <option value="cubic">Ease-out (cubic)</option>
          <option value="quint">Ease-out (quint, snappier)</option>
          <option value="sine">Ease-out (sine, softer)</option>
          <option value="linear">Linear</option>
        </select>
        <select
          className="hud-grid-select"
          aria-label="Reduce motion"
          value={p.reduceMotionSetting}
          onChange={(e) => w.setPreference(PREF_KEYS.gridReduceMotion, e.target.value)}
        >
          <option value="system">Reduce motion: follow system</option>
          <option value="always">Reduce motion: always</option>
          <option value="never">Reduce motion: never</option>
        </select>
      </Subsection>

      <Subsection id="node" title="Node" chip={chips.node} collapsed={collapsed.node} onToggle={toggle}>
        <div className={`hud-grid-scale${noSelection ? ' is-disabled' : ''}`}>
          <button type="button" aria-label="Scale down" disabled={noSelection} onClick={() => w.onScale((s) => s - NODE_SCALE_STEP)}>−</button>
          <span className="hud-grid-scale-value">{noSelection ? '—' : w.scaleText}</span>
          <button type="button" aria-label="Scale up" disabled={noSelection} onClick={() => w.onScale((s) => s + NODE_SCALE_STEP)}>+</button>
          <button type="button" disabled={noSelection} onClick={() => w.onScale(() => 1)}>Reset</button>
        </div>
        <p className="hud-grid-hint">
          {noSelection ? 'Select a node to scale it.' : "Grows from each node's top-left corner."}
        </p>
      </Subsection>

      <Subsection id="look" title="Look" chip={chips.look} collapsed={collapsed.look} onToggle={toggle}>
        <select
          className="hud-grid-select"
          aria-label="Theme"
          value={w.activeThemeId ?? ''}
          onChange={(e) => w.onSetActiveTheme?.(e.target.value)}
        >
          {w.themes.map((theme) => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
        </select>
        <Segmented
          label="Energy"
          value={w.energyLevel === 'calm' ? 'calm' : 'live'}
          options={[['live', 'Live'], ['calm', 'Calm']]}
          onChange={(level) => { if (level !== w.energyLevel) w.onToggleEnergy?.(); }}
        />
        <Segmented
          label="Grid line color"
          value={p.ink}
          options={[['theme', 'Theme ink'], ['neutral', 'Neutral']]}
          onChange={(ink) => w.setPreference(PREF_KEYS.gridInk, ink)}
        />
        <div className="hud-grid-checks">
          <Check checked={p.showMajor} onChange={(on) => w.setPreference(PREF_KEYS.gridShowMajor, on)}>Major</Check>
          <Check checked={p.showMinor} onChange={(on) => w.setPreference(PREF_KEYS.gridShowMinor, on)}>Minor</Check>
          <Check checked={p.showSub} onChange={(on) => w.setPreference(PREF_KEYS.gridShowSub, on)}>Sub</Check>
        </div>
        <div className="hud-grid-sliders">
          <Slider label="Major" value={opacity('major')} min={0} max={0.25} step={0.005} format={(v) => v.toFixed(3)} onChange={setLevel('major')} />
          <Slider label="Minor" value={opacity('minor')} min={0} max={0.25} step={0.005} format={(v) => v.toFixed(3)} onChange={setLevel('minor')} />
          <Slider label="Sub" value={opacity('sub')} min={0} max={0.25} step={0.005} format={(v) => v.toFixed(3)} onChange={setLevel('sub')} />
        </div>
        <div className="hud-grid-row">
          <button type="button" className="hud-grid-link" disabled={!w.paint.overridden} onClick={() => w.setPaint(null)}>
            Reset to theme
          </button>
          <Check checked={p.showOrigin} onChange={(on) => w.setPreference(PREF_KEYS.gridShowOrigin, on)}>Origin</Check>
        </div>
        <p className="hud-grid-hint">Theme ink is luma-matched: tinted lines are as visible as white ones.</p>
      </Subsection>
    </div>
  );
}
